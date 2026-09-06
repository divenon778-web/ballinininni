const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const store = require('./src/store');
const games = require('./src/games');
const fair = require('./src/fairness');

const ROOT=__dirname, PUBLIC=path.join(ROOT,'public');
const PORT=Number(process.env.PORT||3000), HOST=process.env.HOST||'0.0.0.0';
const clients=new Set();
const clientBalance=new Map();
const exactRuntime={crashPhase:null,crashRound:null,slideCountdownTimer:null};
const AVATAR_DIR=path.join(PUBLIC,'local-avatars'); fs.mkdirSync(AVATAR_DIR,{recursive:true});

const BUILD_MANIFEST_FILE=path.join(PUBLIC,'_next','static','s5EPMxqGbmg4yH_UPXzyq','_buildManifest.js');
let buildManifestRoutes={};
try{
  const sandbox={self:{}};
  vm.runInNewContext(fs.readFileSync(BUILD_MANIFEST_FILE,'utf8'),sandbox,{timeout:1000});
  buildManifestRoutes=sandbox.self.__BUILD_MANIFEST||{};
}catch(e){console.warn('[route-manifest] unable to load build manifest:',e?.message||e);}
function routeKeyForPath(pathname){
  let p=String(pathname||'/').split('?')[0].replace(/\/+$/,'')||'/';
  if(p.endsWith('.html'))p=p.slice(0,-5)||'/';
  if(buildManifestRoutes[p])return p;
  if(/^\/cases\/[^/]+$/.test(p)&&!p.startsWith('/cases/community'))return '/cases/[caseIdentifier]';
  if(/^\/case-battles\/[^/]+$/.test(p)&&p!=='/case-battles/create-battle')return '/case-battles/[battleId]';
  if(/^\/community-cases\/[^/]+$/.test(p))return '/community-cases/[caseIdentifier]';
  return null;
}
function injectRouteChunks(html,pathname){
  const key=routeKeyForPath(pathname),chunks=key&&buildManifestRoutes[key];
  if(!Array.isArray(chunks)||!chunks.length)return html;
  const tags=chunks.filter(x=>String(x).endsWith('.js')).filter(x=>!html.includes('/_next/'+x)).map(x=>`<script defer src="/_next/${x}" type="text/javascript"></script>`).join('');
  if(!tags)return html;
  return html.includes('</head>')?html.replace('</head>',tags+'</head>'):tags+html;
}

const chatRate=new Map();
const SESSION_COOKIE='bf_session';
const SITE_KEY_COOKIE='bf_site_key';
const SITE_KEY_SESSION_COOKIE='bf_site_key_session';
const siteKeyCookie=token=>`${SITE_KEY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
const siteKeySessionCookie=token=>`${SITE_KEY_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
const json=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));};
const ok=(res,data={},headers={})=>json(res,200,{ok:true,...data},headers);
const fail=(res,e,status=400)=>json(res,status,{ok:false,error:e instanceof Error?e.message:String(e)});
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));
const currentUser=req=>store.userBySession(cookies(req).bf_session);
const requireUser=req=>{const u=currentUser(req);if(!u)throw Object.assign(new Error('Log in first'),{status:401});if(u.banned)throw Object.assign(new Error('Account is disabled'),{status:403});return u;};
async function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6){reject(new Error('Request too large'));req.destroy();}});req.on('end',()=>{if(!s)return resolve({});try{resolve(JSON.parse(s))}catch{reject(new Error('Invalid JSON'))}});req.on('error',reject);});}
function broadcast(channel,data,userId=null){const payload=`data: ${JSON.stringify({channel,data})}\n\n`;for(const c of clients){if(!userId||c.userId===userId){try{c.res.write(payload)}catch{}}}
  // Translate the shared-round state updates used by the local engine to the original BloxFlip realtime channels.
  if(channel==='crash'&&data){
    const rid=String(data.roundId||'');
    if(data.phase==='betting'){
      if(exactRuntime.crashRound!==rid||exactRuntime.crashPhase!=='betting') broadcast('crash:starting',{message:rid,_id:rid,status:2,startingAt:data.bettingEndsAt,committedEosBlock:Number(data.roundId||0)+100});
    }else if(data.phase==='running'){
      if(exactRuntime.crashPhase!=='running') broadcast('crash:started',{_id:rid,publicSeed:data.proof?.clientSeed||'local-public-seed',startedAt:data.phaseStartedAt,status:3});
      broadcast('crash:point',{message:`${Number(data.multiplier||1).toFixed(2)}x`});
    }else if(data.phase==='crashed'){
      if(exactRuntime.crashPhase!=='crashed') broadcast('crash:game-end',{_id:rid,status:4,crashPoint:Number(data.crashPoint||1),multiplier:Math.round(Number(data.crashPoint||1)*100),players:data.bets||[]});
    }
    exactRuntime.crashPhase=data.phase; exactRuntime.crashRound=rid;
  }
}
function wallet(u,reason='local',announceDelay=0){const prev=clientBalance.get(u.id);clientBalance.set(u.id,u.balance);if(prev===undefined)return null;const delta=Math.round((u.balance-prev)*100)/100;if(Math.abs(delta)<=0.000001)return null;if(delta>0&&announceDelay>0)store.lockBalanceCredit(u,delta,announceDelay);const id=store.id('rtx'),event={id,_id:id,amount:delta,currency:'FLIPCOINS',reason,...(announceDelay>0?{announceDelay}: {})};broadcast(`wallet:transactions#${u.id}`,event,u.id);return event;}
function exactFeedRow(row={}){const game=row.gamemode||row.game||'';return {...row,userId:row.userId||'',gamemode:game==='case-battles'?'casebattles':(game==='cases'?'single_case':game),currency:row.currency||'FLIPCOINS',bet:Number(row.bet??row.amount??0)||0,winnings:Number(row.winnings??(Number(row.payout)>0?row.payout:-Number(row.amount??row.bet??0)))||0,multiplier:Number(row.multiplier)||0,created:Number(row.created)||Date.now()};}
function feed(){for(const row of store.state.liveFeed.slice(0,1))broadcast('feed:new-bet',exactFeedRow(row));}
function afterUserGame(u){wallet(u);feed();}

function globalFloat(label,nonce){const f=store.state.globalFairness;const h=crypto.createHmac('sha256',f.serverSeed).update(`${f.clientSeed}:${nonce}:${label}`).digest('hex');return parseInt(h.slice(0,13),16)/0x10000000000000;}
function nextGlobal(label){const f=store.state.globalFairness;const nonce=f.nonce++;const value=globalFloat(label,nonce);store.saveSoon();return {value,nonce,serverSeedHash:f.serverSeedHash,clientSeed:f.clientSeed};}

function crashNewRound(){const c=store.state.crash,now=Date.now();c.roundId++;c.phase='betting';c.phaseStartedAt=now;c.bettingEndsAt=now+7000;c.crashAt=null;c.multiplier=1;c.bets={};const r=nextGlobal(`crash:${c.roundId}`);let point;if(r.value<.01)point=1;else point=Math.floor((0.99/(1-r.value))*100)/100;c.crashPoint=Math.max(1,Math.min(100000,point));c.proof=r;store.saveSoon();broadcast('crash',crashPublic());}
function crashPublic(){const c=store.state.crash;return {roundId:c.roundId,phase:c.phase,phaseStartedAt:c.phaseStartedAt,bettingEndsAt:c.bettingEndsAt,multiplier:c.multiplier,crashPoint:c.phase==='crashed'?c.crashPoint:null,history:c.history||[],bets:Object.values(c.bets||{}).map(b=>({username:b.username,bet:b.bet,cashout:b.cashout,payout:b.payout,autoCashout:b.autoCashout})),proof:c.phase==='crashed'?c.proof&&{serverSeedHash:c.proof.serverSeedHash,clientSeed:c.proof.clientSeed,nonce:c.proof.nonce}:undefined};}
function crashTick(){const c=store.state.crash,now=Date.now();if(c.phase==='betting'&&now>=c.bettingEndsAt){c.phase='running';c.phaseStartedAt=now;c.multiplier=1;store.saveSoon();broadcast('crash',crashPublic());return;}if(c.phase==='running'){const elapsed=now-c.phaseStartedAt;c.multiplier=Math.max(1,Math.floor(Math.exp(elapsed/7000)*100)/100);for(const b of Object.values(c.bets||{})){if(!b.cashout&&b.autoCashout&&b.autoCashout>=1.01&&c.multiplier>=b.autoCashout&&b.autoCashout<c.crashPoint){const u=store.state.users[b.userId];if(u){b.cashout=b.autoCashout;b.payout=games.round2(b.bet*b.cashout);games.record(u,'crash',b.bet,b.payout,b.cashout,{roundId:c.roundId,crashPoint:c.crashPoint,auto:true,proof:c.proof});wallet(u);}}}if(c.multiplier>=c.crashPoint){c.multiplier=c.crashPoint;c.phase='crashed';c.crashAt=now;c.history=[c.crashPoint,...(c.history||[])].slice(0,20);for(const b of Object.values(c.bets||{})){if(!b.cashout){const u=store.state.users[b.userId];if(u){store.recordGame(u,'crash',b.bet,0,0,{roundId:c.roundId,crashPoint:c.crashPoint,proof:c.proof});wallet(u);}}}store.saveSoon();feed();broadcast('crash',crashPublic());return;}broadcast('crash',crashPublic());}else if(c.phase==='crashed'&&now-c.crashAt>=3000)crashNewRound();}

function slideOutcome(){const r=nextGlobal(`slide:${store.state.slide.roundId}`);const x=r.value;let result=0;if(x<.019)result=50;else if(x<.095)result=10;else if(x<.19)result=5;else if(x<.3167)result=3;else if(x<.475)result=2;return {result,proof:r};}
function slidePublic(){const s=store.state.slide;return {roundId:s.roundId,phase:s.phase,phaseStartedAt:s.phaseStartedAt,bettingEndsAt:s.bettingEndsAt,result:s.phase==='settled'?s.result:null,history:s.history||[],bets:Object.values(s.bets||{}).map(b=>({username:b.username,bet:b.bet,target:b.target,payout:b.payout||0}))};}
function slideNew(){const s=store.state.slide,n=Date.now();s.roundId++;s.phase='betting';s.phaseStartedAt=n;s.bettingEndsAt=n+7000;s.result=null;s.bets={};s.proof=null;store.saveSoon();broadcast('slide',slidePublic());}
function slideTick(){const s=store.state.slide,n=Date.now();if(s.phase==='betting'&&n>=s.bettingEndsAt){s.phase='spinning';s.phaseStartedAt=n;const o=slideOutcome();s.result=o.result;s.proof=o.proof;store.saveSoon();broadcast('slide',slidePublic());return;}if(s.phase==='spinning'&&n-s.phaseStartedAt>=3600){s.phase='settled';s.phaseStartedAt=n;s.history=[s.result,...(s.history||[])].slice(0,20);for(const b of Object.values(s.bets||{})){const u=store.state.users[b.userId];if(!u)continue;const win=s.result>=b.target&&s.result>0,payout=win?games.round2(b.bet*b.target):0;b.payout=payout;if(payout)store.adjustBalance(u,payout,'SLIDE_PAYOUT',{roundId:s.roundId});store.recordGame(u,'slide',b.bet,payout,b.target,{roundId:s.roundId,result:s.result,target:b.target,proof:s.proof});wallet(u);}store.saveSoon();feed();broadcast('slide',slidePublic());return;}if(s.phase==='settled'&&n-s.phaseStartedAt>=3000)slideNew();}

function cupsPublic(){return Object.values(store.state.cupsRooms).filter(r=>Date.now()-(r.created||0)<3600000).sort((a,b)=>b.created-a.created).map(r=>({id:r.id,bet:r.bet,maxPlayers:r.maxPlayers,status:r.status,players:r.players.map(p=>({_id:p.bot?1:p.userId,userId:p.userId,robloxId:p.bot?1:(p.robloxId??p.userId),avatar:p.bot?'/_next/image%20(2).webp':(p.avatar||''),username:p.username,bot:!!p.bot,winner:!!p.winner})),created:r.created,winner:r.winner||null}));}
function settleCup(room){if(room.status!=='rolling')return;const r=nextGlobal(`cups:${room.id}`),idx=Math.floor(r.value*room.players.length),winner=room.players[idx];winner.winner=true;room.winner=winner.username;room.status='finished';room.finishedAt=Date.now();const pot=games.round2(room.bet*room.players.length*.95);if(!winner.bot){const u=store.state.users[winner.userId];if(u){store.adjustBalance(u,pot,'CUPS_PAYOUT',{roomId:room.id});store.recordGame(u,'cups',room.bet,pot,pot/room.bet,{roomId:room.id,winner:room.winner,players:room.players.map(x=>x.username),proof:r});wallet(u);}}for(const p of room.players){if(p.bot||p===winner)continue;const u=store.state.users[p.userId];if(u){store.recordGame(u,'cups',room.bet,0,0,{roomId:room.id,winner:room.winner,players:room.players.map(x=>x.username),proof:r});wallet(u);}}store.saveSoon();feed();broadcast('cups',cupsPublic());}
function cupMaybeStart(room){if(room.players.length>=room.maxPlayers&&room.status==='waiting'){room.status='rolling';room.rollStartedAt=Date.now();store.saveSoon();broadcast('cups',cupsPublic());setTimeout(()=>settleCup(room),2600);}}

function resetStale(){
  const now=Date.now();
  // Persistent single-player games (Mines, Towers, Blackjack) can safely resume after a restart.
  store.state.activeMines=store.state.activeMines||{};
  store.state.activeTowers=store.state.activeTowers||{};
  store.state.activeBlackjack=store.state.activeBlackjack||{};
  store.state.cupsRooms=store.state.cupsRooms||{};

  // Shared timed rounds cannot resume from an arbitrary process downtime. Refund unsettled bets,
  // then start a clean round so a restart never silently eats a player's FLIPCOINS.
  const oldCrash=store.state.crash;
  if(oldCrash?.bets){
    for(const b of Object.values(oldCrash.bets)){
      if(b.cashout)continue;
      const u=store.state.users[b.userId];
      if(u)store.adjustBalance(u,b.bet,'CRASH_RESTART_REFUND',{roundId:oldCrash.roundId});
    }
  }
  const crashHistory=oldCrash?.history||[];
  store.state.crash={roundId:Number(oldCrash?.roundId||0),phase:'crashed',crashAt:0,history:crashHistory,bets:{}};
  crashNewRound();

  const oldSlide=store.state.slide;
  if(oldSlide?.bets){
    for(const b of Object.values(oldSlide.bets)){
      const u=store.state.users[b.userId];
      if(u)store.adjustBalance(u,b.bet,'SLIDE_RESTART_REFUND',{roundId:oldSlide.roundId});
    }
  }
  const slideHistory=oldSlide?.history||[];
  store.state.slide={roundId:Number(oldSlide?.roundId||0),phase:'settled',phaseStartedAt:0,history:slideHistory,bets:{}};
  slideNew();

  for(const room of Object.values(store.state.cupsRooms)){
    if(room.status==='rolling'){
      for(const p of room.players||[]){
        if(p.bot)continue;
        const u=store.state.users[p.userId];
        if(u)store.adjustBalance(u,room.bet,'CUPS_RESTART_REFUND',{roomId:room.id});
      }
      room.status='cancelled';
      room.finishedAt=now;
      room.winner=null;
    }
  }
  store.saveSoon();
}
resetStale();setInterval(crashTick,120);setInterval(slideExactTick,150);setInterval(settleRains,500);
setInterval(()=>{const now=Date.now();for(const [id,r] of Object.entries(store.state.cupsRooms))if(['finished','cancelled'].includes(r.status)&&now-(r.finishedAt||r.created)>20*60*1000)delete store.state.cupsRooms[id];store.saveSoon();},60000);

function userHistory(user,game){return store.state.history.filter(x=>x.userId===user.id&&(!game||x.game===game)).slice(0,100);}
function caseCompact(c){return {name:c.name,slug:c.slug,price:c.price,image:c.image,imageVariation:c.imageVariation,community:!!c.community,creator:c.creator||null,commission:c.commission||0,totalOpens:c.totalOpens||0,totalDirectOpens:c.totalDirectOpens||0,totalWagered:c.totalWagered||0,creatorEarningsTotal:c.creatorEarningsTotal||0,createdAt:c.createdAt||0,updatedAt:c.updatedAt||0,slots:c.slots};}
function communityStats(cases){return {caseCount:cases.length,totalOpens:games.round2(cases.reduce((n,c)=>n+(c.totalOpens||0),0)),totalDirectOpens:games.round2(cases.reduce((n,c)=>n+(c.totalDirectOpens||0),0)),totalWagered:games.round2(cases.reduce((n,c)=>n+(c.totalWagered||0),0)),creatorEarningsTotal:games.round2(cases.reduce((n,c)=>n+(c.creatorEarningsTotal||0),0)),creatorEarningsCredited:games.round2(cases.reduce((n,c)=>n+(c.creatorEarningsCredited||0),0))};}

const PUBLIC_CASE_DOCS=path.join(ROOT,'data','public-cases-docs.json');
const COMMUNITY_DOCS=path.join(ROOT,'data','community-cases-docs.json');
const ITEM_CATALOG=path.join(ROOT,'data','item-catalog.json');
let publicCaseDocs={docs:[]},communityDocs={docs:[]},itemCatalogDocs=[];
try{publicCaseDocs=JSON.parse(fs.readFileSync(PUBLIC_CASE_DOCS,'utf8'))}catch{}
try{communityDocs=JSON.parse(fs.readFileSync(COMMUNITY_DOCS,'utf8'))}catch{}
try{itemCatalogDocs=JSON.parse(fs.readFileSync(ITEM_CATALOG,'utf8'))}catch{}
const txEvent=(amount,reason='game',announceDelay)=>{const id=store.id('gev');return {_id:id,id,amount:games.round2(amount),currency:'FLIPCOINS',reason,...(announceDelay?{announceDelay}: {})};};
const publishWalletEvent=(user,event)=>{if(Number(event?.amount)>0&&Number(event?.announceDelay)>0)store.lockBalanceCredit(user,Number(event.amount),Number(event.announceDelay));clientBalance.set(user.id,user.balance);broadcast(`wallet:transactions#${user.id}`,event,user.id);return event;};
const deltaEvent=(before,user,reason='game',announceDelay)=>publishWalletEvent(user,txEvent(games.round2(user.balance-before),reason,announceDelay));
function ensureLocalSession(req){const u=currentUser(req);if(!u)throw Object.assign(new Error('Authentication required'),{status:401});return {user:u,setCookie:null};}
const sessionCookie=token=>`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
function hasValidSiteKey(req) {
  const c = cookies(req);
  if (store.verifySiteKey(c[SITE_KEY_COOKIE])) return true;
  if (store.verifySiteKeySession(c[SITE_KEY_SESSION_COOKIE])) return true;
  return false;
}
function exactUser(user){
  const p=store.publicUser(user),rid=user.robloxId??user.id,rname=user.robloxUsername||user.username,display=user.displayName||rname,avatar=user.avatar||`/api/user/avatar/${encodeURIComponent(rid)}`,created=Number(user.created)||Date.now();
  const profile={id:user.id,_id:user.id,userId:user.id,robloxId:rid,username:rname,robloxUsername:rname,displayName:display,name:display,avatar,avatarUrl:avatar,headshotUrl:avatar,identity:1,rank:10,level:10,nextLevelPercentage:0,privacyEnabled:false,created,createdAt:new Date(created).toISOString(),wallet:Number(user.balance)||0,bonusWallet:0,lumber:Number(user.wagered)||0,email:null,emailVerified:false};
  return {
    success:true,profile,user:profile,
    wallet:{balances:{FLIPCOINS:Number(user.balance)||0,KEYS:0,XP:0},playRequirements:{FLIPCOINS:0},rakeback:{FLIPCOINS:0}},
    rates:{coinsToRobux:1,robuxToCoins:1},tokens:{livechat2:'local'},stats:{wagered:Number(user.wagered)||0,won:Number(user.won)||0,totalPlayed:Number(user.wagered)||0,rainWins:0,nextUpdate:Date.now()+86400000},fairness:p.fairness
  };
}
function exactSite(){return {success:true,geo:'LOCAL',fcBlock:false,online:Math.max(1,Object.keys(store.state.users).length),stats:{players:Math.max(1,Object.keys(store.state.users).length)},announcements:[],maintenance:false};}
function compactCaseExact(c){return {displayName:c.name,name:c.name,slug:c.slug,image:c.image||`/images/community-cases/variation_${c.imageVariation||1}.png`,price:c.price,color:'#3656FF',active:true,communityCase:!!c.community,items:(c.slots||[]).map(s=>({assetId:s.assetId||s.id||s.name,assetName:s.name,value:s.value,winningChance:Number(s.chance||0)/100,iconUrl:s.image||'',ticketRange:{min:0,max:0}})),totalOpens:c.totalOpens||0,totalWagered:c.totalWagered||0,totalDirectOpens:c.totalDirectOpens||0,creator:c.creator||''};}
function mineExact(g){if(!g)return null;const pub=games.minesPublic(g,false),mult=pub.multiplier||1;return {id:g.id,_id:g.id,uuid:g.uuid||g.id,active:true,currency:'FLIPCOINS',betAmount:g.bet,bet:g.bet,mines:g.mines,grid:g.grid||5,gridSize:g.cells||((g.grid||5)*(g.grid||5)),uncoveredLocations:[...(g.revealed||[])],mineLocations:undefined,badMineUncovered:null,exploded:false,multiplier:mult,winnings:(g.revealed||[]).length?games.round2(g.bet*mult):0,serverSeedHash:g.proof?.serverSeedHash,clientSeed:g.proof?.clientSeed,nonce:g.proof?.nonce};}
function mineExactResult(r){if(!r)return null;const grid=Number(r.grid)||5,gridSize=Number(r.gridSize)||grid*grid;return {id:r.id,_id:r.id,uuid:r.uuid||r.id,active:r.active!==false&&!r.finished&&!r.exploded,currency:'FLIPCOINS',betAmount:r.bet,bet:r.bet,mines:r.mines,grid,gridSize,uncoveredLocations:[...(r.uncoveredLocations||r.revealed||[])],mineLocations:r.mineLocations||r.mineList,badMineUncovered:r.badMineUncovered??null,exploded:!!r.exploded,multiplier:r.multiplier||1,winnings:r.winnings||r.payout||0,serverSeedHash:r.proof?.serverSeedHash,clientSeed:r.proof?.clientSeed,nonce:r.proof?.nonce};}
function towerExactResult(r,reveal=false){if(!r)return null;const cfg={easy:{cells:3,safe:2},normal:{cells:2,safe:1},hard:{cells:3,safe:1}}[r.difficulty]||{cells:2,safe:1};const completed=(r.picks||[]).filter(x=>x.safe).map(x=>x.index);const levels=(r.rows||[]).map(safe=>Array.from({length:cfg.cells},(_,i)=>safe.includes(i)?0:1));return {id:r.id,_id:r.id,active:!r.finished&&!r.hit,currency:'FLIPCOINS',betAmount:r.bet,difficulty:r.difficulty,completedLevels:completed,towerLevels:(reveal||r.finished||r.hit)?levels:undefined,exploded:!!r.hit,multiplier:r.multiplier||1,payout:r.payout||0,winnings:r.payout||0,serverSeedHash:r.proof?.serverSeedHash,clientSeed:r.proof?.clientSeed,nonce:r.proof?.nonce};}
function blackjackExactFromPublic(r,user){if(!r)return {id:'',status:'NOT_STARTED'};const fake={id:r.id,dealer:r.dealer||[],hands:r.hands||[],activeHand:r.activeHand??-1,proof:r.proof||null,insuranceBet:r.insuranceBet||0,insuranceTaken:!!r.insuranceTaken,insuranceOffered:!!r.insuranceOffered,insuranceResolved:!!r.insuranceResolved,payout:r.payout||0,done:!!r.done};return blackjackExact(fake,user,!!r.done,false);}
function localCaseToCms(c){let cursor=1;return {id:c.slug,name:c.name,slug:c.slug,description:'',price:c.price,creator:c.creator||'',riskFactor:c.riskFactor||0,packImage:c.image?{url:c.image}:null,imageVariation:c.imageVariation||1,totalOpens:c.totalOpens||0,totalDirectOpens:c.totalDirectOpens||0,totalWagered:c.totalWagered||0,totalProfit:0,creatorEarningsTotal:c.creatorEarningsTotal||0,creatorEarningsCredited:c.creatorEarningsCredited||0,createdAt:new Date(c.createdAt||Date.now()).toISOString(),updatedAt:new Date(c.updatedAt||Date.now()).toISOString(),slots:(c.slots||[]).map(s=>{const min=cursor,max=cursor+Math.max(1,Math.round(Number(s.chance||0)*100000))-1;cursor=max+1;return {item:{id:s.assetId||s.id||s.name,slug:s.assetId||s.id||String(s.name).toLowerCase().replace(/[^a-z0-9]+/g,'-'),name:s.name,value:s.value,rarity:s.rarity||'common',icon:{url:s.image||''}},chance:Number(s.chance||0),ticketRange:{min,max}}})};}
function itemCatalog(){const map=new Map();const stableKey=x=>{const id=String(x?.assetId??x?.id??'').trim().toLowerCase(),slug=String(x?.slug??'').trim().toLowerCase(),name=String(x?.assetName??x?.name??'').trim().toLowerCase().replace(/\s+/g,' '),value=games.round2(Number(x?.value)||0);return id?`id:${id}`:slug?`slug:${slug}`:`nv:${name}:${value}`;};const add=item=>{if(!item)return;const key=stableKey(item),fallback=`nv:${String(item.name||item.assetName||'').trim().toLowerCase()}:${games.round2(Number(item.value)||0)}`;const existing=map.get(key)||map.get(fallback);if(existing){if(!existing.image&&item.image)existing.image=item.image;if(!existing.icon?.url&&item.icon?.url)existing.icon={...(existing.icon||{}),url:item.icon.url};return;}map.set(key,item);if(fallback!==key&&!map.has(fallback))map.set(fallback,item);};for(const item of itemCatalogDocs)add({...item});for(const c of [...store.state.cases,...store.state.communityCases])for(const s of c.slots||[]){const slug=String(s.assetId||s.name).toLowerCase().replace(/[^a-z0-9]+/g,'-');add({id:s.assetId||slug,assetId:s.assetId||null,slug,name:s.name,value:s.value,rarity:s.rarity||'common',icon:{url:s.image||''},image:s.image||''});}return [...new Set(map.values())].sort((a,b)=>Number(a.value||0)-Number(b.value||0));}
function normalizeCommunityCreate(body){const catalog=itemCatalog(),bySlug=new Map(catalog.map(x=>[String(x.slug),x]));const items=Array.isArray(body.items)?body.items:[];return {name:body.name,imageVariation:body.imageVariation,commission:body.commission,slots:items.map(x=>{const src=bySlug.get(String(x.item?.slug))||catalog.find(z=>String(z.id)===String(x.item?.slug));return {name:src?.name||x.item?.slug||'Item',value:src?.value||1,chance:Number(x.chance)||1,rarity:src?.rarity||'common',image:src?.icon?.url||src?.image||'',assetId:src?.id||x.item?.slug};})};}
function towerExact(g,reveal=false){if(!g)return null;const cfg={easy:{cells:3,safe:2},normal:{cells:2,safe:1},hard:{cells:3,safe:1}}[g.difficulty]||{cells:2,safe:1};const completed=(g.picks||[]).filter(x=>x.safe).map(x=>x.index);const towerLevels=(g.rows||[]).map(safe=>Array.from({length:cfg.cells},(_,i)=>safe.includes(i)?0:1));const exploded=(g.picks||[]).some(x=>!x.safe);const mult=(()=>{if(!completed.length)return 1;return games.round2(0.99*Math.pow(cfg.cells/cfg.safe,completed.length));})();return {id:g.id,_id:g.id,active:!reveal&&!exploded,currency:'FLIPCOINS',betAmount:g.bet,difficulty:g.difficulty,completedLevels:completed,towerLevels:reveal||exploded?towerLevels:undefined,exploded,multiplier:mult,payout:games.round2(g.bet*mult)};}
const rankMap={A:'ACE','2':'TWO','3':'THREE','4':'FOUR','5':'FIVE','6':'SIX','7':'SEVEN','8':'EIGHT','9':'NINE','10':'TEN',J:'JACK',Q:'QUEEN',K:'KING'};
const suitMap={'♠':'SPADES','♦':'DIAMONDS','♥':'HEARTS','♣':'CLUBS'};
function exactCard(c,face=true,order=0){if(!face||c?.hidden)return {order,value:'null',type:'null',isFaceUp:false};return {order,value:rankMap[c.rank]||String(c.rank||'TEN'),type:suitMap[c.suit]||'SPADES',isFaceUp:true};}
function cardScore(cards){let t=0,a=0;for(const c of cards||[]){if(c.rank==='A'){t+=11;a++}else if(['J','Q','K'].includes(c.rank))t+=10;else t+=Number(c.rank)||0}while(t>21&&a){t-=10;a--}return t;}
function blackjackExact(g,user,done=false,resumed=false){if(!g)return {id:'',status:'NOT_STARTED'};done=done||!!g.done;const totalBet=games.round2((g.hands||[]).reduce((s,h)=>s+Number(h.bet||0),0)+Number(g.insuranceBet||0)),dealerDone=done,baseBet=Number(g.hands?.[0]?.bet)||25;const hands=(g.hands||[]).map((h,idx)=>{const score=cardScore(h.cards),isCurrent=idx===g.activeHand&&!done&&!h.stood&&score<21;let status='PLAYING';if(done)status=String(h.outcome||'LOSE').toUpperCase();else if(score>21)status='BUSTED';const possible=isCurrent?['HIT','STAND',...(h.cards.length===2&&user.balance>=h.bet?['DOUBLE']:[]),...(h.cards.length===2&&h.cards[0]?.rank===h.cards[1]?.rank&&(g.hands||[]).length<5&&user.balance>=h.bet?['SPLIT']:[])]:[];return {cards:(h.cards||[]).map((c,i)=>exactCard(c,true,i)),bet:Number(h.bet)||baseBet,status,possibleActions:possible,bestAction:null,payout:Number(h.payout)||0};});while(hands.length<5)hands.push({cards:[],bet:baseBet,status:'PLAYING',possibleActions:[],bestAction:null,payout:0});return {id:g.id,_id:g.id,status:done?'ENDED':resumed?'RESUMED':'IN_PROGRESS',totalGameBet:totalBet,currency:'FLIPCOINS',dealer:{hand:{cards:(g.dealer||[]).map((c,i)=>exactCard(c,dealerDone||i===0,i))}},player:{hands},insuranceBet:Number(g.insuranceBet)||0,isInsuranceOffered:!!g.insuranceOffered&&!g.insuranceResolved,isInsuranceTaken:!!g.insuranceTaken,payout:done?Number(g.payout)||hands.reduce((s,h)=>s+(Number(h.payout)||0),0):0,serverSeedHash:g.proof?.serverSeedHash,clientSeed:g.proof?.clientSeed,nonce:g.proof?.nonce,...(done?{serverSeed:g.proof?.serverSeed}: {})};}
function crashExactCurrent(){const c=store.state.crash||{};const status=c.phase==='betting'?2:c.phase==='running'?3:c.phase==='crashed'?4:1;return {_id:String(c.roundId||1),id:String(c.roundId||1),status,startingAt:c.bettingEndsAt||0,startedAt:c.phaseStartedAt||0,currentPayout:c.multiplier||1,crashPoint:c.phase==='crashed'?c.crashPoint:undefined,committedEosBlock:Number(c.roundId||0)+100,players:Object.values(c.bets||{}).map(b=>({playerId:b.userId,username:b.username,playAmount:b.bet,betAmount:b.bet,autoCashOut:b.autoCashout?Math.round(b.autoCashout*100):-1,status:b.cashout?2:1,stoppedAt:b.cashout?Math.round(b.cashout*100):0,winAmount:b.payout||0,winningAmount:b.payout||0}))};}
function crashSchema(){const cur=crashExactCurrent();return {current:cur,gameId:cur._id,active:cur.status===2,players:cur.players,options:{}};}
function crashHistoryExact(){const now=Date.now();return (store.state.crash?.history||[]).map((m,i)=>({id:`crh_${i}_${String(m).replace(/[^0-9.]/g,'')}`,_id:`crh_${i}_${String(m).replace(/[^0-9.]/g,'')}`,multiplier:Math.round(Number(m)*100),crashPoint:Number(m),createdAt:now-i*20000}));}
const slidePayout={red:2,purple:2,yellow:14};
function newSlideSeed(){const privateSeed=crypto.randomBytes(24).toString('hex');return {privateSeed,privateHash:crypto.createHash('sha256').update(privateSeed).digest('hex'),publicSeed:crypto.randomBytes(12).toString('hex')};}
function ensureSlideExact(){let s=store.state.slide;if(!s.exact){const z=newSlideSeed();s.exact={_id:String(s.roundId||1),gameId:String(s.roundId||1),joinable:true,winningColor:null,players:[],publicSeed:z.publicSeed,privateHash:z.privateHash,privateSeed:null,_privateSeed:z.privateSeed,nonce:s.roundId||1,created:Date.now(),ends:Date.now()+8000,committed:false,rolledAt:null};store.saveSoon()}return s.exact;}
function slideSchemaExact(){const cur=ensureSlideExact();return {current:cur,history:(store.state.slide?.historyExact||[]).slice(0,20)};}
function slideNewExact(){const s=store.state.slide,z=newSlideSeed();s.roundId=(s.roundId||0)+1;s.exact={_id:String(s.roundId),gameId:String(s.roundId),joinable:true,winningColor:null,players:[],publicSeed:z.publicSeed,privateHash:z.privateHash,privateSeed:null,_privateSeed:z.privateSeed,nonce:s.roundId,created:Date.now(),ends:Date.now()+8000,committed:false,rolledAt:null};store.saveSoon();broadcast('slide:new-round',s.exact);broadcast('slide:countdown-updated',{message:String(8000)});}
function settleSlideExact(cur){const r=nextGlobal(`slide-exact:${cur._id}`),x=r.value,color=x<0.035?'yellow':x<0.5175?'red':'purple';cur.joinable=false;cur.winningColor=color;cur.privateSeed=cur._privateSeed;cur.rolledAt=Date.now();cur.proof=r;for(const p of cur.players||[]){const u=store.state.users[p.playerID];if(!u)continue;const payout=p.color===color?games.round2(p.betAmount*slidePayout[p.color]):0;if(payout)store.adjustBalance(u,payout,'SLIDE_PAYOUT',{roundId:cur._id,color});store.recordGame(u,'slide',p.betAmount,payout,payout?slidePayout[p.color]:0,{roundId:cur._id,color:p.color,winningColor:color,proof:r});wallet(u,'slide',10000);}store.saveSoon();feed();broadcast('slide:game-rolled',{_id:cur._id,gameId:cur._id,winningColor:color,privateSeed:cur.privateSeed,publicSeed:cur.publicSeed,privateHash:cur.privateHash,nonce:cur.nonce,players:cur.players});}
function slideExactTick(){const cur=ensureSlideExact(),now=Date.now();if(cur.joinable){const left=Math.max(0,cur.ends-now);if(!exactRuntime.slideCountdownTimer||now-exactRuntime.slideCountdownTimer>500){exactRuntime.slideCountdownTimer=now;broadcast('slide:countdown-updated',{message:String(Math.ceil(left/100)*100)});}if(left<=2000&&!cur.committed){cur.committed=true;store.saveSoon();broadcast('slide:eos-commit',{message:String(Number(cur._id)+100)});broadcast('slide:public-seed',{message:cur.publicSeed});}if(left<=0)settleSlideExact(cur);}else if(cur.rolledAt&&now-cur.rolledAt>=10500){const hist={_id:cur._id,gameId:cur._id,winningColor:cur.winningColor,privateSeed:cur.privateSeed,publicSeed:cur.publicSeed,privateHash:cur.privateHash,nonce:cur.nonce,players:cur.players,created:cur.created};store.state.slide.historyExact=[hist,...(store.state.slide.historyExact||[])].slice(0,20);store.saveSoon();broadcast('slide:add-game-to-history',hist);slideNewExact();}}

function cupsExactRoom(r){const colors=['red','blue','purple','yellow'];return {_id:r.id,id:r.id,_creator:r.creatorId,betAmount:r.bet,playerAmount:r.maxPlayers,status:r.status==='waiting'?1:r.status==='rolling'?3:4,players:(r.players||[]).map((p,i)=>({_id:p.userId,robloxId:p.bot?1:(p.robloxId??p.userId),username:p.username,avatar:p.bot?'/_next/image%20(2).webp':(p.avatar||''),color:p.color||colors[i],bot:!!p.bot})),committedEosBlock:r.committedEosBlock||0,winningCup:r.winningColor||null,serverSeedHash:r.proof?.serverSeedHash||null,publicSeed:r.proof?.clientSeed||null,nonce:r.proof?.nonce,ended:r.status==='finished'};}
function exactCupSettle(room){if(room.status!=='rolling')return;const winner=room.players.find(p=>p.color===room.winningColor)||room.players[0],pot=games.round2(room.bet*room.players.length*.95);room.status='finished';room.finishedAt=Date.now();room.winner=winner?.username||null;for(const p of room.players){if(p.bot)continue;const u=store.state.users[p.userId];if(!u)continue;const payout=p===winner?pot:0;if(payout)store.adjustBalance(u,payout,'CUPS_PAYOUT',{roomId:room.id});store.recordGame(u,'cups',room.bet,payout,payout?pot/room.bet:0,{roomId:room.id,winner:room.winner,winningCup:room.winningColor,players:room.players.map(x=>x.username),proof:room.proof});wallet(u,'cups');}store.saveSoon();feed();}
function exactCupMaybeStart(room){if(room.status!=='waiting'||room.players.length<room.maxPlayers)return;room.status='rolling';room.rollStartedAt=Date.now();room.committedEosBlock=Number(String(room.rollStartedAt).slice(-6));const r=nextGlobal(`cups-exact:${room.id}`);room.proof=r;room.winningColor=(room.players[Math.min(room.players.length-1,Math.floor(r.value*room.players.length))]||room.players[0]).color;store.saveSoon();broadcast('cups:eos-commit',{_id:room.id,blockNumber:room.committedEosBlock});setTimeout(()=>{broadcast('cups:game-rolled',cupsExactRoom(room));setTimeout(()=>exactCupSettle(room),5000)},700);}

function exactHistory(user,game,page=0,size=20){let rows=store.state.history.filter(x=>(!user||x.userId===user.id)&&(!game||x.game===game));return {content:rows.slice(page*size,page*size+size),docs:rows.slice(page*size,page*size+size),totalElements:rows.length,totalPages:Math.max(1,Math.ceil(rows.length/size)),page,size};}


function cleanUsername(v){return String(v||'').trim().replace(/^@/,'').slice(0,20);}
function validLocalUsername(v){return /^[A-Za-z0-9_]{3,20}$/.test(String(v||''));}
function localRobloxId(name){const h=crypto.createHash('sha256').update('bloxflip-local:'+String(name||'').toLowerCase()).digest();return 8000000000+h.readUInt32BE(0);}
function botProfile(lookup){const key=String(lookup||'1'),h=crypto.createHash('sha256').update('pvp-bot:'+key).digest(),n=(o,min,max)=>min+(h.readUInt32BE(o)%Math.max(1,max-min+1)),created=Date.UTC(2022,0,1)+n(0,0,900)*86400000;return {success:true,id:key,_id:key,robloxId:1,username:'PvP Bot',displayName:'PvP Bot',avatar:'/_next/image%20(2).webp',created,lumber:n(4,500,250000),identity:1,rank:n(8,1,25),level:n(12,2,80),gamesPlayed:n(16,20,5000),totalPlayed:n(20,1000,500000),rainWinnings:n(24,0,25000),triviaWinnings:0,wagered:n(4,500,250000),won:n(20,500,300000)};}
async function fetchJsonWithTimeout(url,opts={},ms=6500){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),ms);try{const r=await fetch(url,{...opts,signal:ac.signal,headers:{'User-Agent':'BflipX/1.1','Accept':'application/json',...(opts.headers||{})}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(timer)}
}
async function fetchBufferWithTimeout(url,ms=9000){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),ms);try{const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'BflipX/1.1','Accept':'image/png,image/webp,image/jpeg'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return Buffer.from(await r.arrayBuffer());}finally{clearTimeout(timer)}
}
function imageContentType(buf){
  if(buf?.length>=8&&buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
  if(buf?.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return 'image/jpeg';
  if(buf?.length>=12&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
async function robloxHeadshotUrl(robloxId){
  const id=String(robloxId??'').trim();if(!/^\d+$/.test(id))return null;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const thumbs=await fetchJsonWithTimeout(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`,{},7500);
      const thumb=Array.isArray(thumbs?.data)?thumbs.data[0]:null;
      if(thumb?.state==='Completed'&&/^https:\/\//i.test(String(thumb.imageUrl||'')))return thumb.imageUrl;
    }catch{}
    if(attempt<4)await new Promise(resolve=>setTimeout(resolve,350+attempt*200));
  }
  // Roblox also exposes the stable thumbnail batch endpoint. This is a fallback for
  // accounts whose headshot is temporarily pending on the single-user endpoint.
  try{
    const batch=await fetchJsonWithTimeout('https://thumbnails.roblox.com/v1/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([{requestId:`avatar-${id}`,type:'AvatarHeadShot',targetId:Number(id),size:'150x150',format:'Png',isCircular:false}])},7500);
    const thumb=Array.isArray(batch?.data)?batch.data[0]:null;
    if(thumb?.state==='Completed'&&/^https:\/\//i.test(String(thumb.imageUrl||'')))return thumb.imageUrl;
  }catch{}
  return null;
}
async function cacheRobloxHeadshot(user){
  if(!user?.robloxId)return null;
  const imageUrl=await robloxHeadshotUrl(user.robloxId);if(!imageUrl)return null;
  // Keep the CDN URL too. If the local Node process cannot download rbxcdn but the
  // browser can, /api/user/avatar/:id can safely redirect to this exact Roblox URL.
  user.avatar=imageUrl;user.avatarUpdatedAt=Date.now();store.saveSoon();
  try{
    const buf=await fetchBufferWithTimeout(imageUrl,10000),type=imageContentType(buf);
    if(buf.length>100&&type){
      const ext=type==='image/jpeg'?'.jpg':type==='image/webp'?'.webp':'.png',dest=path.join(AVATAR_DIR,`${user.robloxId}${ext}`);
      fs.writeFileSync(dest,buf);user.avatar=`/local-avatars/${user.robloxId}${ext}`;user.avatarUpdatedAt=Date.now();store.saveSoon();return user.avatar;
    }
  }catch{}
  return imageUrl;
}
function caseInitialData(slug){
  const key=String(slug||'');const doc=(publicCaseDocs.docs||[]).find(x=>String(x.slug)===key);
  if(doc)return {displayName:doc.name||'',image:doc.packImage?.url||'',description:doc.description||'',slug:doc.slug||doc.id||key,items:(doc.slots||[]).map(x=>({assetId:x.item?.id??0,assetName:x.item?.name??'',ticketRange:x.ticketRange??{min:0,max:0},value:Number(x.item?.value)||0,winningChance:(Number(x.chance)||0)/100,iconUrl:x.item?.icon?.url||''})),minimumLevel:Number(doc.minimumLevel)||0,active:true,communityCase:false,price:Number(doc.price)||0,color:doc.color||'#3656FF'};
  const c=battleCaseBySlug(key);return c?compactCaseExact(c):null;
}
function nextData(req,res,url){
  if((req.method||'GET')!=='GET')return fail(res,'Method not allowed',405);
  const pathname=decodeURIComponent(url.pathname),build='s5EPMxqGbmg4yH_UPXzyq';
  let m=pathname.match(new RegExp(`^/_next/data/${build.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/cases/([^/]+)\\.json$`));
  if(m){const slug=m[1],initialCaseData=caseInitialData(slug);if(!initialCaseData)return json(res,404,{notFound:true});return json(res,200,{pageProps:{initialCaseData},__N_SSP:true},{'Cache-Control':'no-store'});}
  m=pathname.match(new RegExp(`^/_next/data/${build.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/case-battles/([^/]+)\\.json$`));
  if(m){const id=m[1],battle=store.state.caseBattles?.[id];if(!battle)return json(res,404,{notFound:true});return json(res,200,{pageProps:{},__N_SSP:true},{'Cache-Control':'no-store'});}
  return false;
}
async function resolveRobloxProfile(username){
  const clean=cleanUsername(username);if(!validLocalUsername(clean))throw Object.assign(new Error('Enter a valid username (letters, numbers and underscore only)'),{status:400});
  const cached=store.findUser(clean);if(cached?.robloxId&&cached.avatar?.startsWith('/local-avatars/')){const fp=path.join(PUBLIC,cached.avatar);if(fs.existsSync(fp)&&imageContentType(fs.readFileSync(fp)))return cached;}
  try{
    let row=cached?.robloxId&&Number(cached.robloxId)<8000000000?{id:cached.robloxId,name:cached.robloxUsername||cached.username,displayName:cached.displayName||cached.username}:null;
    if(!row){const lookup=await fetchJsonWithTimeout('https://users.roblox.com/v1/usernames/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usernames:[clean],excludeBannedUsers:false})},1800);row=Array.isArray(lookup?.data)?lookup.data[0]:null;}
    if(row?.id){let avatar=cached?.avatar?.startsWith('/local-avatars/')?cached.avatar:null;const user=store.ensureUser(row.name||clean,{robloxId:row.id,robloxUsername:row.name||clean,displayName:row.displayName||row.name||clean,avatar,avatarUpdatedAt:cached?.avatarUpdatedAt||0});try{avatar=await cacheRobloxHeadshot(user)||avatar;}catch{}if(avatar&&user.avatar!==avatar){user.avatar=avatar;user.avatarUpdatedAt=Date.now();store.saveSoon();}return user;}
  }catch{}
  if(cached)return cached;
  return store.ensureUser(clean,{robloxId:localRobloxId(clean),robloxUsername:clean,displayName:clean,avatar:'/_next/image%20(2).webp'});
}
function chatMessage(user,text,extra={}){const now=Date.now(),id=store.id('chat');return {_id:id,id,userId:user?.id||extra.userId||'local-system',username:user?.username||extra.username||'BflipX',displayName:user?.displayName||extra.displayName||extra.username||'BflipX',avatar:user?.avatar||extra.avatar||'/logo-small.svg',rank:user?.rank||0,level:10,text:String(text||'').slice(0,180),content:String(text||'').slice(0,180),message:String(text||'').slice(0,180),created:now,timestamp:now,system:false,...extra};}
function pushChat(row){store.state.chat.push(row);store.state.chat=store.state.chat.slice(-200);store.saveSoon();broadcast('chat:add-message',row);return row;}
function onlineUserIds(){return [...new Set([...clients].map(c=>c.userId).filter(Boolean))];}
function broadcastOnline(){broadcast('chat:users-online',{count:onlineUserIds().length});}
function settleRains(){
  const now=Date.now();let changed=false;
  for(const [rainId,rain] of Object.entries(store.state.rains||{})){
    if(!rain||!rain.active||now<Number(rain.endsAt||0))continue;
    rain.active=false;rain.endedAt=now;const host=store.state.users[rain.hostId];
    const ids=[...new Set((Array.isArray(rain.players)?rain.players:[]).filter(id=>id!==rain.hostId&&store.state.users[id]))];
    const totalCents=Math.max(0,Math.round(Number(rain.prize||0)*100));
    if(!ids.length){if(host&&totalCents){store.adjustBalance(host,totalCents/100,'RAIN_REFUND',{rainId});wallet(host,'rain-refund');}}
    else{let remain=totalCents;ids.forEach((id,index)=>{const u=store.state.users[id],share=index===ids.length-1?remain:Math.floor(totalCents/ids.length);remain-=share;if(share>0){store.adjustBalance(u,share/100,'RAIN_RECEIVED',{from:rain.hostId,rainId});wallet(u,'rain');}});}
    broadcast('chat:rain-state-changed',{...rain,rainId,players:ids});changed=true;
  }
  if(changed)store.saveSoon();
}
function centsAmount(v,min=.01,max=1e9){const n=Math.round(Number(v)*100);if(!Number.isFinite(n)||n<Math.round(min*100)||n>Math.round(max*100))throw new Error('Invalid amount');return n;}
function battleCaseBySlug(slug){return store.state.cases.find(c=>String(c.slug)===String(slug||''))||null;}
function battleMaxPlayers(mode){return ({'1v1':2,'1v1v1':3,'1v1v1v1':4,'2v2':4})[mode]||2;}
function battleOptions(body){const map=[['crazyMode','crazy_mode'],['terminalMode','terminal_mode'],['sharedMode','shared_mode'],['clutchMode','clutch_mode'],['jackpotMode','jackpot_mode'],['degenMode','degen_mode'],['goldSpins','gold_spins'],['instantSpin','instant_spin'],['privateMode','private_mode'],['quickOpening','quick_open'],['quickOpen','quick_open']];return map.filter(([k])=>!!body[k]).map(([,v])=>v);}
function battleRound(c){return {name:c.name,slug:c.slug,image:c.image||'',background:c.color||'#3656FF',price:Number(c.price)||0,goldSpin:false,items:(c.slots||[]).map(x=>({assetId:x.assetId||x.id||x.name,name:x.name||'',image:x.image||'',chance:Number(x.chance)||0,rarity:x.rarity||'',value:Number(x.value)||0})),result:{}};}
function pickBattleItem(c,r){const slots=c.slots||[];if(!slots.length)return {assetId:'nothing',name:'Nothing',image:'',chance:100,rarity:'common',value:0};let x=Math.max(0,Math.min(.999999999,Number(r)||0))*100,acc=0;for(const it of slots){acc+=Number(it.chance)||0;if(x<=acc)return {assetId:it.assetId||it.id||it.name,name:it.name||'',image:it.image||'',chance:Number(it.chance)||0,rarity:it.rarity||'',value:Number(it.value)||0};}const it=slots[slots.length-1];return {assetId:it.assetId||it.id||it.name,name:it.name||'',image:it.image||'',chance:Number(it.chance)||0,rarity:it.rarity||'',value:Number(it.value)||0};}
function battleItemsExact(items){let cursor=1;return (items||[]).map(x=>{const chance=Math.max(0,Number(x.chance)||0),span=Math.max(1,Math.round(chance*10000)),ticketRange={min:cursor,max:cursor+span-1};cursor+=span;return {assetId:x.assetId||x.id||x.name||'',assetName:x.name||'',name:x.name||'',image:x.image||'',iconUrl:x.image||'',value:Number(x.value)||0,ticketRange,winningChance:chance/100,chance,rarity:x.rarity||''};});}
function battleRoundExact(round){const items=battleItemsExact(round.items),byId=new Map(items.map(x=>[String(x.assetId),x])),byName=new Map(items.map(x=>[String(x.assetName),x])),winnings={};for(const [playerId,won] of Object.entries(round.result||{})){const source=byId.get(String(won.assetId||won.id||''))||byName.get(String(won.name||''));winnings[playerId]=source?{...source}:{...battleItemsExact([won])[0]};}return {itemPack:{displayName:round.name||'',image:round.image||'',color:round.background||'#3656FF',slug:round.slug||'',items,price:Number(round.price)||0},winnings};}
function battlePublic(b){
  const opts=b.options||[],modeMap={'1v1':'SOLO_1V1','1v1v1':'SOLO_1V2','1v1v1v1':'SOLO_1V3','2v2':'TEAM_2V2'},now=Date.now();
  const players=(b.players||[]).slice().sort((a,z)=>(a.slot??99)-(z.slot??99)).map(p=>({id:p.id,_id:String(p.id),robloxId:p.robloxId??p.id,username:p.username||'',avatar:p.avatar||'',currency:p.currency||'FLIPCOINS',sessionId:p.sessionId||'',gameSlot:p.slot??-1,slot:p.slot??-1,payoutFactor:p.payoutFactor??1,amount:Number(p.amount)||0,winnings:p.winnings||[],bot:!!p.bot}));
  return {id:b.id,_id:b.id,status:b.status||1,players,rounds:(b.rounds||[]).map(battleRoundExact),_creator:b.creator||'',_winners:b.winners||[],entryCost:Number(b.cost)||0,currentRound:b.currentRound||0,gameMode:modeMap[b.mode]||b.gameMode||'SOLO_1V1',crazyMode:opts.includes('crazy_mode'),terminalMode:opts.includes('terminal_mode'),sharedMode:opts.includes('shared_mode'),clutchMode:opts.includes('clutch_mode'),jackpotMode:opts.includes('jackpot_mode'),degenMode:opts.includes('degen_mode'),goldSpins:opts.includes('gold_spins'),instantSpin:opts.includes('instant_spin')||!!b.instantSpin,privateMode:opts.includes('private_mode')||!!b.privateMode,quickOpening:!b.instantSpin&&opts.includes('quick_open'),publicSeed:b.fairness?.publicSeed||'',privateSeed:b.fairness?.privateSeed||'',privateHash:b.fairness?.privateHash||'',committedEosBlock:b.fairness?.committedEosBlock||0,readyAt:b.readyAt||0,created:b.createdAt||0,lastModified:b.lastModified||b.createdAt||0,currency:b.currency||'FLIPCOINS',finishedRolling:!!b.finishedRolling,clockOffset:0,serverTime:now};
}
function battleSignal(name,b,payload={}){const data={message:b.id,id:b.id,_id:b.id,...payload};broadcast(`case-battles:${name}`,data);}
function battleCreate(user,body){
  const mode=['1v1','1v1v1','1v1v1v1','2v2'].includes(String(body.mode))?String(body.mode):(['SOLO_1V1','SOLO_1V2','SOLO_1V3','TEAM_2V2'].includes(body.gameMode)?({SOLO_1V1:'1v1',SOLO_1V2:'1v1v1',SOLO_1V3:'1v1v1v1',TEAM_2V2:'2v2'})[body.gameMode]:'1v1');
  const packs=Array.isArray(body.packs)?body.packs:(Array.isArray(body.caseItems)?body.caseItems.map(x=>({slug:x.slug||x.caseSlug||x,quantity:x.quantity||1})):[]);let rounds=[];
  for(const p of packs.slice(0,30)){const c=battleCaseBySlug(p.slug||p);if(!c)throw new Error(`Case not found: ${p.slug||p}`);const qty=Math.max(1,Math.min(25,Math.floor(Number(p.quantity)||1)));for(let i=0;i<qty;i++)rounds.push(battleRound(c));}
  if(!rounds.length)throw new Error('Add at least one case');if(rounds.length>50)throw new Error('Too many cases');
  const cost=games.round2(rounds.reduce((n,r)=>n+Number(r.price||battleCaseBySlug(r.slug)?.price||0),0));if(cost<=0)throw new Error('Invalid battle cost');games.validBet(user,cost);store.adjustBalance(user,-cost,'CASE_BATTLE_BET');
  const priv=crypto.randomBytes(32).toString('hex'),id=crypto.randomUUID(),payoutFactor=Math.max(.01,Math.min(1,Number(body.payoutFactor)||1));
  const battle={id,players:[{id:user.id,robloxId:user.robloxId??user.id,username:user.username,avatar:user.avatar||'',currency:'FLIPCOINS',slot:0,payoutFactor,amount:cost,winnings:[]}],status:1,winners:[],cost,mode,creator:user.id,createdAt:Date.now(),readyAt:0,instantSpin:!!body.instantSpin,options:battleOptions(body),rounds,currentRound:0,finishedRolling:false,currency:'FLIPCOINS',fairness:{publicSeed:'',privateSeed:'',privateHash:crypto.createHash('sha256').update(priv).digest('hex')},_privateSeed:priv,settled:false};
  store.state.caseBattles[id]=battle;store.saveSoon();wallet(user,'case-battle');battleSignal('update',battle);return battle;
}
function battleJoin(user,id,slot=-1,bot=false){const b=store.state.caseBattles[id];if(!b||b.status!==1)throw new Error('Battle is not available');const max=battleMaxPlayers(b.mode);if((b.players||[]).length>=max)throw new Error('Battle is full');let s=Math.floor(Number(slot));if(!Number.isFinite(s)||s<0||s>=max||b.players.some(p=>p.slot===s))s=Array.from({length:max},(_,i)=>i).find(i=>!b.players.some(p=>p.slot===i));if(s==null)throw new Error('No free slot');if(!bot){if(b.players.some(p=>p.id===user.id))throw new Error('You already joined this battle');games.validBet(user,b.cost);store.adjustBalance(user,-b.cost,'CASE_BATTLE_BET',{battleId:b.id});b.players.push({id:user.id,robloxId:user.robloxId??user.id,username:user.username,avatar:user.avatar||'',currency:'FLIPCOINS',slot:s,payoutFactor:1,amount:b.cost,winnings:[]});wallet(user,'case-battle');}else{b.players.push({id:`-${Date.now()}${s}`,robloxId:1,username:'PvP Bot',avatar:'/_next/image%20(2).webp',currency:'FLIPCOINS',slot:s,payoutFactor:1,amount:b.cost,winnings:[],bot:true});}store.saveSoon();battleSignal('update',b);if(b.players.length>=max)battleStart(b);return b;}
function battleStart(b){if(b.status!==1)return;b.status=2;b.readyAt=Date.now()+1200;b.fairness.publicSeed=crypto.randomBytes(12).toString('hex');b.fairness.committedEosBlock=Number(String(Date.now()).slice(-8));const totals={};for(const p of b.players)totals[p.id]=0;for(let ri=0;ri<b.rounds.length;ri++){const c=battleCaseBySlug(b.rounds[ri].slug);for(const p of b.players){const h=crypto.createHmac('sha256',b._privateSeed).update(`${b.fairness.publicSeed}:${ri}:${p.id}`).digest('hex'),r=parseInt(h.slice(0,13),16)/0x10000000000000,it=pickBattleItem(c,r);b.rounds[ri].result[p.id]=it;totals[p.id]+=Number(it.value)||0;p.winnings.push(it);}}
  if(b.options.includes('degen_mode')){const pool=['crazy_mode','shared_mode','terminal_mode','jackpot_mode'],seed=crypto.createHmac('sha256',b._privateSeed).update(`${b.fairness.publicSeed}:degen`).digest();let first=seed[0]%pool.length,second=seed[1]%(pool.length-1);if(second>=first)second++;for(const mode of [pool[first],pool[second]])if(!b.options.includes(mode))b.options.push(mode);}
  const scoreTotals=b.options.includes('terminal_mode')?Object.fromEntries(b.players.map(p=>[p.id,Number(b.rounds[b.rounds.length-1]?.result?.[p.id]?.value)||0])):totals;
  let winningIds=[];
  if(b.options.includes('shared_mode'))winningIds=b.players.map(p=>p.id);
  else if(b.options.includes('jackpot_mode')){const weights=b.players.map(p=>Math.max(0,Number(scoreTotals[p.id])||0)),sum=weights.reduce((n,x)=>n+x,0),h=crypto.createHmac('sha256',b._privateSeed).update(`${b.fairness.publicSeed}:jackpot`).digest('hex'),roll=(parseInt(h.slice(0,13),16)/0x10000000000000)*(sum||b.players.length);let acc=0,index=0;for(let i=0;i<b.players.length;i++){acc+=sum?weights[i]:1;if(roll<=acc){index=i;break}}winningIds=[b.players[index].id];}
  else if(b.mode==='2v2'){const teams=[[0,2],[1,3]],scores=teams.map(ts=>ts.reduce((n,slot)=>{const p=b.players.find(x=>x.slot===slot);return n+(p?scoreTotals[p.id]||0:0)},0)),wantLow=b.options.includes('crazy_mode'),best=wantLow?Math.min(...scores):Math.max(...scores),winningTeams=scores.map((x,i)=>x===best?i:-1).filter(i=>i>=0);winningIds=b.players.filter(p=>winningTeams.some(i=>teams[i].includes(p.slot))).map(p=>p.id);}
  else{const wantLow=b.options.includes('crazy_mode'),vals=b.players.map(p=>scoreTotals[p.id]||0),best=wantLow?Math.min(...vals):Math.max(...vals);winningIds=b.players.filter(p=>(scoreTotals[p.id]||0)===best).map(p=>p.id);}
  b.winners=winningIds;b._totals=totals;b._scoreTotals=scoreTotals;store.saveSoon();battleSignal('ready',b);battleSignal('eos',b,{blockNumber:b.fairness.committedEosBlock});battleSignal('modes',b,{options:b.options});
  setTimeout(()=>{const live=store.state.caseBattles[b.id];if(!live||live.settled)return;live.status=3;store.saveSoon();battleSignal('update',live,{started:true});},1200);
  const perRound=b.instantSpin?650:(b.options.includes('quick_open')?3600:7600),spin=1200+Math.max(perRound,perRound*b.rounds.length)+800;setTimeout(()=>battleFinalize(b.id),spin);
}
function battleFinalize(id){const b=store.state.caseBattles[id];if(!b||b.settled)return;b.settled=true;b.status=3;b.finishedRolling=true;b.currentRound=b.rounds.length;b.fairness.privateSeed=b._privateSeed;const totalLoot=games.round2(Object.values(b._totals||{}).reduce((n,x)=>n+Number(x||0),0));let payouts={};if(b.options.includes('shared_mode')){const share=games.round2(totalLoot/Math.max(1,b.players.length));for(const p of b.players)payouts[p.id]=share;}else{const share=games.round2(totalLoot/Math.max(1,b.winners.length));for(const id of b.winners)payouts[id]=share;}
  for(const p of b.players){if(p.bot)continue;const u=store.state.users[p.id];if(!u)continue;const payout=Number(payouts[p.id]||0);if(payout)store.adjustBalance(u,payout,'CASE_BATTLE_PAYOUT',{battleId:b.id});store.recordGame(u,'case-battles',b.cost,payout,b.cost?payout/b.cost:0,{battleId:b.id,winners:b.winners,rounds:b.rounds.map(r=>r.result),options:b.options});wallet(u,'case-battle',1500);}store.saveSoon();feed();battleSignal('update',b,{finished:true});}


function accessOverlayHtml(){
  return `<div id="bf-access-overlay" style="display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(8,10,24,.88);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px;font-family:Nunito,Arial,sans-serif">
  <div style="width:min(440px,100%);background:#181d3d;border:1px solid #2d355f;border-radius:14px;padding:32px;box-shadow:0 22px 70px rgba(0,0,0,.55);text-align:center;color:#fff">
    <img src="/logo-small.svg" alt="BflipX" style="height:48px;margin-bottom:18px">
    <div style="font-size:26px;font-weight:800;margin-bottom:6px">Private Access</div>
    <div style="font-size:14px;color:#8f98bf;margin-bottom:26px;line-height:1.5">This site is private. Enter your access key to continue.</div>
    <div id="bf-access-success" style="color:#2ecc71;font-size:14px;font-weight:700;margin-bottom:12px;display:none"></div>
    <label style="display:block;color:#aeb5d5;font-size:13px;font-weight:700;margin-bottom:8px;text-align:left">Access Key</label>
    <div style="height:50px;border:1px solid #343d6a;background:#121631;border-radius:9px;display:flex;align-items:center;padding:0 14px;transition:border-color .15s,box-shadow .15s" id="bf-access-input-wrap">
      <input id="bf-access-key" type="text" placeholder="Enter your key" autocomplete="off" spellcheck="false" maxlength="20" style="width:100%;height:100%;border:0;outline:0;background:transparent;color:#fff;font:700 16px Nunito,Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase">
    </div>
    <div id="bf-access-error" style="min-height:21px;margin:8px 1px 4px;color:#ff6f82;font-size:12px;text-align:left"></div>
    <button id="bf-access-submit" style="width:100%;height:46px;border:0;border-radius:9px;background:#5964f2;color:#fff;font:800 15px Nunito,Arial,sans-serif;cursor:pointer;transition:filter .15s,transform .08s;margin-top:4px">Unlock Access</button>
    <div style="margin-top:18px;padding:14px;background:#121631;border:1px solid #343d6a;border-radius:9px">
      <div style="font-size:13px;font-weight:700;color:#aeb5d5;margin-bottom:6px">Need a key?</div>
      <div style="font-size:12px;color:#8f98bf;line-height:1.5">Purchase an access key from the Discord server.</div>
      <a href="https://discord.gg/DQKebpTZ7H" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;padding:8px 18px;background:#5865F2;border-radius:8px;color:#fff;font-weight:700;font-size:13px;text-decoration:none">Join Discord</a>
    </div>
  </div>
</div>
<script>
(function(){
  var key=document.getElementById('bf-access-key'),
      error=document.getElementById('bf-access-error'),
      success=document.getElementById('bf-access-success'),
      submit=document.getElementById('bf-access-submit'),
      overlay=document.getElementById('bf-access-overlay'),
      inputWrap=document.getElementById('bf-access-input-wrap'),
      busy=false;
  overlay.style.display='flex';
  document.body.style.overflow='hidden';
  key.focus();
  key.addEventListener('keydown',function(e){if(e.key==='Enter')submit.click()});
  submit.addEventListener('click',function(){
    if(busy)return;
    var val=key.value.trim();
    error.textContent='';success.style.display='none';
    if(!val){error.textContent='Enter a valid access key.';inputWrap.style.animation='none';void inputWrap.offsetWidth;inputWrap.style.animation='bfshake .4s ease-in-out';return;}
    busy=true;submit.disabled=true;submit.textContent='Verifying...';
    fetch('/api/site-key/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:val})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})
    .then(function(res){
      if(res.ok&&res.data.success){success.textContent='Access granted! Redirecting...';success.style.display='block';error.textContent='';setTimeout(function(){location.reload()},800)}
      else{error.textContent=res.data.error||'Invalid key.';inputWrap.style.animation='none';void inputWrap.offsetWidth;inputWrap.style.animation='bfshake .4s ease-in-out';}
      busy=false;submit.disabled=false;submit.textContent='Unlock Access';
    })
    .catch(function(){error.textContent='Network error. Try again.';busy=false;submit.disabled=false;submit.textContent='Unlock Access';});
  });
})();
</script>
<style>@keyframes bfshake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}</style>`;
}
async function api(req,res,url){
  try{
    const method=req.method||'GET', rawPath=url.pathname, p=rawPath.length>1?rawPath.replace(/\/+$/,''):rawPath, b=method==='GET'?{}:await body(req), u=currentUser(req);

    // ---- Site Key API endpoints ----
    if(method==='POST'&&p==='/api/site-key/verify'){
      const key=String(b.key||'').trim();
      if(!key)return fail(res,'Enter a valid access key');
      if(store.verifySiteKey(key)){
        const sessionToken=store.createSiteKeySession();
        return json(res,200,{success:true},{ 'Set-Cookie': [siteKeyCookie(key), siteKeySessionCookie(sessionToken)] });
      }
      return fail(res,'Invalid access key',403);
    }
    if(method==='POST'&&p==='/api/site-key/generate'){
      const user=currentUser(req);
      if(!user||String(user.username||'').toLowerCase()!=='tinktink0521')
        return fail(res,'Unauthorized',403);
      const newKey=store.createSiteKey();
      return json(res,200,{success:true,key:newKey});
    }
    if(method==='GET'&&p==='/api/site-key/check'){
      return json(res,200,{valid:hasValidSiteKey(req)});
    }
    if(method==='POST'&&p==='/api/site-key/revoke'){
      const user=currentUser(req);
      if(!user||String(user.username||'').toLowerCase()!=='tinktink0521')
        return fail(res,'Unauthorized',403);
      const target=String(b.key||'').trim();
      if(!target)return fail(res,'Enter a key to revoke');
      const ok=store.revokeSiteKey(target);
      return json(res,200,{success:ok});
    }
    if(method==='GET'&&p==='/api/site-key/list'){
      const user=currentUser(req);
      if(!user||String(user.username||'').toLowerCase()!=='tinktink0521')
        return fail(res,'Unauthorized',403);
      const keys=Object.values(store.state.siteKeys).map(k=>({key:k.key,active:k.active,created:k.created,uses:k.uses}));
      return json(res,200,{success:true,keys});
    }

    // ---- Block all site access if no valid site key ----
    if(!hasValidSiteKey(req)){
      if(p.startsWith('/api/site-key/')){} 
      else if(p.startsWith('/api/'))
        return fail(res,'Access denied. Valid site key required.',403);
    }

    // ---- Exact local API adapter for the saved BloxFlip production frontend ----
    if(method==='GET'&&p.startsWith('/api/user/avatar/')){
      const ident=decodeURIComponent(p.split('/').pop()||'');
      if(ident==='1'||ident.startsWith('-')){const botAvatar=path.join(PUBLIC,'_next','image (2).webp');if(fs.existsSync(botAvatar)){const buf=fs.readFileSync(botAvatar);res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public, max-age=86400, immutable'});res.end(buf);return;}}
      let target=store.findUser(ident);
      if(target?.avatar==='/_next/image%20(2).webp'||target?.avatar==='/_next/image (2).webp'){const botAvatar=path.join(PUBLIC,'_next','image (2).webp');if(fs.existsSync(botAvatar)){const buf=fs.readFileSync(botAvatar);res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-cache, must-revalidate'});res.end(buf);return;}}
      const sendCached=()=>{if(!target?.avatar?.startsWith('/local-avatars/'))return false;const fp=path.join(PUBLIC,target.avatar);if(!fs.existsSync(fp))return false;const buf=fs.readFileSync(fp),type=imageContentType(buf);if(!type)return false;res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=86400, immutable'});res.end(buf);return true;};
      if(sendCached())return;
      if(target?.avatar&&/^https:\/\//i.test(target.avatar)){res.writeHead(302,{Location:target.avatar,'Cache-Control':'no-store'});res.end();return;}
      if(target?.robloxId){
        try{await cacheRobloxHeadshot(target);if(sendCached())return;if(target.avatar&&/^https:\/\//i.test(target.avatar)){res.writeHead(302,{Location:target.avatar,'Cache-Control':'no-store'});res.end();return;}}catch{}
      }
      // Do not cache this fallback. A temporary Roblox/API outage must not pin the
      // initials avatar in the browser for an hour after connectivity comes back.
      const label=(target?.username||ident||'P').slice(0,2).toUpperCase();const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#1a1f40"/><circle cx="64" cy="48" r="24" fill="#5964f2"/><path d="M24 116c4-26 20-40 40-40s36 14 40 40" fill="#5964f2"/><text x="64" y="54" font-family="Arial,sans-serif" font-size="17" text-anchor="middle" fill="white">${label}</text></svg>`;res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store, max-age=0'});res.end(svg);return;
    }
    if(method==='GET'&&p.startsWith('/api/local/render/')){const id=decodeURIComponent(p.slice('/api/local/render/'.length)),item=itemCatalog().find(x=>String(x.id)===id||String(x.slug)===id);if(item?.image){res.writeHead(302,{Location:item.image,'Cache-Control':'public, max-age=3600'});res.end();return;}res.writeHead(302,{Location:'/logo-small.svg'});res.end();return;}
    if(method==='GET'&&p==='/api/local/features')return json(res,200,{features:{
      fe_ga_enabled:{defaultValue:false},fe_mixpanel_enabled:{defaultValue:false},fe_posthog_enabled:{defaultValue:false},fe_challenges_enabled:{defaultValue:false},
      gameconfig_blackjack:{defaultValue:{enabled:true,min:0.1,max:50000}},july4promo:{defaultValue:false},crash_v2_enabled:{defaultValue:false},
      autoMinesBetDisabled:{defaultValue:false},autoTowersBetDisabled:{defaultValue:false},caseOpeningModesDisabled:{defaultValue:false},community_cases_enabled:{defaultValue:false},case_battles_enabled:{defaultValue:true}
    }});
    if(method==='GET'&&p.startsWith('/api/local/growthbook'))return json(res,200,{features:{
      fe_ga_enabled:{defaultValue:false},fe_mixpanel_enabled:{defaultValue:false},fe_posthog_enabled:{defaultValue:false},fe_challenges_enabled:{defaultValue:false},
      gameconfig_blackjack:{defaultValue:{enabled:true,min:0.1,max:50000}},july4promo:{defaultValue:false},crash_v2_enabled:{defaultValue:false},
      autoMinesBetDisabled:{defaultValue:false},autoTowersBetDisabled:{defaultValue:false},caseOpeningModesDisabled:{defaultValue:false},community_cases_enabled:{defaultValue:false},case_battles_enabled:{defaultValue:true}
    }});
    if(method==='GET'&&p.startsWith('/api/local/notifications'))return json(res,200,{data:[],notifications:[],count:0});
    if(p.startsWith('/api/local/support'))return json(res,200,{payload:[],data:[],meta:{}});
    if(method==='GET'&&p==='/api/realtime/events'){
      const sess=ensureLocalSession(req),user=sess.user; clientBalance.set(user.id,user.balance);
      const headers={'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'};if(sess.setCookie)headers['Set-Cookie']=sess.setCookie;
      res.writeHead(200,headers);const c={res,userId:user.id};clients.add(c);broadcastOnline();
      const send=(channel,data)=>{try{res.write(`data: ${JSON.stringify({channel,data})}\n\n`)}catch{}};
      send('local:hello',{userId:user.id});
      const cc=crashExactCurrent();if(cc.status===2)send('crash:starting',{message:cc._id,_id:cc._id,startingAt:cc.startingAt,committedEosBlock:cc.committedEosBlock});else if(cc.status===3){send('crash:started',{_id:cc._id,publicSeed:store.state.crash?.proof?.clientSeed||'local-public'});send('crash:point',{message:`${Number(cc.currentPayout||1).toFixed(2)}x`});}
      const slide=ensureSlideExact();send('slide:new-round',slide);settleRains();for(const rain of Object.values(store.state.rains||{}))if(rain?.active)send('chat:rain-state-changed',{...rain,rainId:rain._id||rain.id});
      const ping=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},15000);req.on('close',()=>{clearInterval(ping);clients.delete(c);broadcastOnline()});return;
    }
    // Original BloxFlip login modal adapters. The UI stays untouched; only its network calls are local.
    if(method==='GET'&&p==='/api/rolimons-username'){
      const user=await resolveRobloxProfile(url.searchParams.get('q')||'');
      const avatarUrl=user.avatar||`/api/user/avatar/${encodeURIComponent(user.robloxId??user.id)}`;
      return json(res,200,{username:user.robloxUsername||user.username,displayName:user.displayName||user.username,userId:user.robloxId??user.id,robloxId:user.robloxId??user.id,avatarUrl,headshotUrl:avatarUrl,avatar:avatarUrl});
    }
    if(method==='POST'&&p==='/api/fusion/roblox-auth'){
      let user=store.findUser(b.robloxUserId)||store.findUser(b.username);
      if(!user&&b.username)user=await resolveRobloxProfile(b.username);
      if(!user)throw Object.assign(new Error('Roblox user not found'),{status:404});
      const token=store.createSession(user.id);
      return json(res,200,{success:true,token,refreshToken:token,localToken:`local-${user.robloxId??user.id}`});
    }
    if(method==='POST'&&p==='/api/auth/fusionauth/set-session'){
      const token=String(b.token||'');const user=store.userBySession(token);if(!user)throw Object.assign(new Error('Invalid local session'),{status:401});
      clientBalance.set(user.id,user.balance);return json(res,200,{success:true,user:exactUser(user)},{'Set-Cookie':sessionCookie(token)});
    }
    if(method==='POST'&&(p==='/api/local/login'||p==='/api/auth/login')){const user=await resolveRobloxProfile(b.username);const token=store.createSession(user.id);clientBalance.set(user.id,user.balance);return json(res,200,{success:true,user:store.publicUser(user),...exactUser(user)}, {'Set-Cookie':sessionCookie(token)});}
    if(method==='GET'&&p==='/api/user'){
      const sess=ensureLocalSession(req);clientBalance.set(sess.user.id,sess.user.balance);return json(res,200,exactUser(sess.user));
    }
    if(method==='GET'&&p==='/api/auth/fusionauth/me'){const sess=ensureLocalSession(req);return json(res,200,{id:sess.user.id,userId:sess.user.id,username:sess.user.username,email:null,emailVerified:false});}
    if(method==='POST'&&p==='/api/auth/fusionauth/logout'){store.destroySession(cookies(req).bf_session);return json(res,200,{success:true},{'Set-Cookie':'bf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});}
    if(method==='POST'&&p==='/api/auth/fusionauth/refresh')return json(res,200,{success:true});
    if(method==='GET'&&p==='/api/user/rates')return json(res,200,{coinsToRobux:1,robuxToCoins:1,success:true});
    if(method==='GET'&&p==='/api/site')return json(res,200,exactSite());
    if(method==='GET'&&p==='/api/user'&&url.searchParams.has('cache')){const sess=ensureLocalSession(req);return json(res,200,exactUser(sess.user));}
    const userLookup=p.match(/^\/api\/user\/lookup\/([^/]+)$/);if(method==='GET'&&userLookup){const lookup=decodeURIComponent(userLookup[1]);if(lookup==='1'||lookup.startsWith('-')||/^pvp\s*bot$/i.test(lookup))return json(res,200,botProfile(lookup));const target=lookup.toLowerCase()==='me'?requireUser(req):store.findUser(lookup);if(!target)return json(res,404,{success:false,message:'User not found'});const gamesPlayed=store.state.history.filter(x=>x.userId===target.id).length,totalPlayed=games.round2(store.state.history.filter(x=>x.userId===target.id).reduce((n,x)=>n+Number(x.bet||0),0)),rainWinnings=games.round2(store.state.transactions.filter(x=>x.userId===target.id&&x.reason==='RAIN_RECEIVED').reduce((n,x)=>n+Number(x.amount||0),0));return json(res,200,{success:true,id:target.id,_id:target.id,robloxId:target.robloxId??target.id,username:target.username,displayName:target.displayName||target.username,avatar:target.avatar||`/api/user/avatar/${encodeURIComponent(target.robloxId??target.id)}`,created:Number(target.created)||Date.now(),lumber:Number(target.wagered)||0,identity:1,rank:10,level:10,gamesPlayed,totalPlayed,rainWinnings,triviaWinnings:0,wagered:Number(target.wagered)||0,won:Number(target.won)||0});}
    if(method==='GET'&&p==='/api/user/transactions-history'){
      const user=requireUser(req),page=Math.max(0,Math.floor(Number(url.searchParams.get('page')))||0),size=Math.max(1,Math.min(100,Math.floor(Number(url.searchParams.get('size')))||6)),view=String(url.searchParams.get('view')||'games');
      let rows;
      if(view==='games')rows=store.state.history.filter(x=>x.userId===user.id).map(x=>({id:x.id,title:x.game==='case-battles'?'Case Battle':String(x.game||'Game').replace(/(^|[-_ ])\w/g,m=>m.toUpperCase()).replace(/[-_]/g,' '),timestamp:Number(x.created)||Date.now(),created:Number(x.created)||Date.now(),amount:games.round2(Number(x.payout||0)-Number(x.bet||0)),currency:'FLIPCOINS',gameId:x.id,battleId:x.result?.battleId||null}));
      else rows=store.state.transactions.filter(x=>x.userId===user.id).filter(x=>view==='support_adjustments'||view==='all'||(view==='rain'&&String(x.reason).startsWith('RAIN_'))||(view==='gifts'&&String(x.reason).startsWith('TIP_'))).map(x=>({id:x.id,title:String(x.reason||'Transaction').replace(/_/g,' '),counterparty:'Local account',timestamp:Number(x.created)||Date.now(),created:Number(x.created)||Date.now(),amount:Number(x.amount)||0,currency:'FLIPCOINS'}));
      const totalPages=Math.ceil(rows.length/size),data=rows.slice(page*size,page*size+size);return json(res,200,{success:true,data,content:data,totalElements:rows.length,totalPages,page,size});
    }
    if(method==='GET'&&p==='/api/chat/state')return json(res,200,{success:true,enabled:true,muted:false,slowMode:0,counters:{online:onlineUserIds().length}});
    if(method==='GET'&&p==='/api/chat/history'){settleRains();const rains=Object.values(store.state.rains||{}).filter(r=>r&&r.active).map(r=>({...r,rainId:r._id||r.id}));return json(res,200,{success:true,messages:store.state.chat.slice(-100),history:store.state.chat.slice(-100),rains,siteSettings:{bbStreaming:false,activeFlipAnnouncement:null,rain_capv2_config:{enabled:false}},banners:[]});}
    if(method==='POST'&&p==='/api/chat/send'){
      const user=requireUser(req),now=Date.now(),last=chatRate.get(user.id)||0;if(now-last<500)throw new Error('You are sending messages too quickly');chatRate.set(user.id,now);const text=String(b.text??b.message??'').trim();if(!text)throw new Error('Message is empty');if(text.length>180)throw new Error('Message is too long');
      const tip=text.match(/^\.tip\s+([^\s]+)\s+([0-9]+(?:\.[0-9]{1,2})?)$/i);if(tip){const recipient=store.findUser(tip[1]),cents=centsAmount(tip[2],.01,250000),amount=cents/100;if(!recipient)throw new Error('User not found');if(recipient.id===user.id)throw new Error('You cannot tip yourself');if(store.spendableBalance(user)+1e-9<amount)throw new Error('Insufficient balance');store.adjustBalance(user,-amount,'TIP_SENT',{to:recipient.id});store.adjustBalance(recipient,amount,'TIP_RECEIVED',{from:user.id});wallet(user,'tip');wallet(recipient,'tip');return json(res,200,{success:true,message:`Tipped ${recipient.username} ${amount.toLocaleString('en-US')} FLIPCOINS`,data:null});}
      const rain=text.match(/^\.rain\s+([0-9]+(?:\.[0-9]{1,2})?)$/i);if(rain){const cents=centsAmount(rain[1],.01,10000000),amount=cents/100;if(store.spendableBalance(user)+1e-9<amount)throw new Error('Insufficient balance');if(Object.values(store.state.rains||{}).some(r=>r?.active&&r.hostId===user.id))throw new Error('You already have an active rain');store.adjustBalance(user,-amount,'RAIN_SENT',{rain:true});wallet(user,'rain');const rainId=store.id('rain'),row={_id:rainId,id:rainId,rainId,active:true,prize:amount,currency:'FLIPCOINS',host:user.username,hostId:user.id,players:[],joinToken:'local',createdAt:Date.now(),endsAt:Date.now()+15000};store.state.rains[rainId]=row;store.saveSoon();broadcast('chat:rain-state-changed',row);return json(res,200,{success:true,message:'Rain started!',data:row});}
      const row=pushChat(chatMessage(user,text));return json(res,200,{success:true,message:row});
    }
    if(method==='POST'&&p==='/api/chat/commands/gift'){const user=requireUser(req),recipient=store.findUser(b.recipientUsername||b.recipient||b.username),cents=centsAmount(b.amount,.01,250000),amount=cents/100;if(!recipient)throw new Error('User not found');if(recipient.id===user.id)throw new Error('You cannot tip yourself');if(store.spendableBalance(user)+1e-9<amount)throw new Error('Insufficient balance');store.adjustBalance(user,-amount,'TIP_SENT',{to:recipient.id});store.adjustBalance(recipient,amount,'TIP_RECEIVED',{from:user.id});wallet(user,'tip');wallet(recipient,'tip');return json(res,200,{success:true,message:`Tipped ${recipient.username} ${amount.toLocaleString('en-US')} FLIPCOINS`,data:null});}
    if(method==='POST'&&p==='/api/chat/rain/participate'){const user=requireUser(req);settleRains();const rainId=String(b.rainId||''),rain=store.state.rains?.[rainId];if(!rain||!rain.active)return json(res,200,{success:false,message:'This rain has ended'});if(Date.now()>=Number(rain.endsAt||0)){settleRains();return json(res,200,{success:false,message:'This rain has ended'});}rain.players=Array.isArray(rain.players)?rain.players:[];if(!rain.players.includes(user.id)&&user.id!==rain.hostId){rain.players.push(user.id);store.saveSoon();broadcast('chat:rain-state-added',{rainId,userId:user.id});broadcast('chat:rain-state-changed',{...rain,rainId});}return json(res,200,{success:true,message:user.id===rain.hostId?'Rain host cannot join their own rain':'Joined rain!'});}
    if(method==='GET'&&p.startsWith('/api/live-feed')){let rows=(store.state.liveFeed||[]).map(exactFeedRow);const type=url.searchParams.get('type');if(type==='high')rows=rows.filter(x=>x.high);if(type==='lucky')rows=rows.filter(x=>x.lucky);return json(res,200,rows.slice(0,60));}
    if(method==='POST'&&p==='/api/local/grant'){const user=requireUser(req);if(String(user.username||'').toLowerCase()!=='tinktink0521')throw Object.assign(new Error('You need to join the Discord server to buy balance: https://discord.gg/DQKebpTZ7H'),{status:403});const raw=Number(b.amount);if(!Number.isFinite(raw)||raw<1||raw>10000000)throw new Error('Enter an amount from 1 to 10,000,000');const amount=games.round2(raw);store.adjustBalance(user,amount,'FAKE_COIN_GRANT');wallet(user,'grant');return json(res,200,{success:true,balance:user.balance,amount});}
    if(method==='POST'&&p==='/api/local/clear-feed'){const user=requireUser(req);if(String(user.username||'').toLowerCase()!=='tinktink0521')throw Object.assign(new Error('Unauthorized'),{status:403});store.state.liveFeed=[];store.saveSoon();broadcast('feed:new-bet',null);return json(res,200,{success:true});}

    // Removed product areas still have a few global loaders in the saved frontend. Return empty data so they stay invisible without throwing runtime errors.
    if(method==='GET'&&['/api/race','/api/race/me','/api/raffle','/api/raffles','/api/raffles/me','/api/raffles/history','/api/rewards','/api/rewards/levels','/api/rewards/challenges','/api/rewards/socials','/api/rewards/rakeback','/api/user/freebies','/api/games/bgaming','/api/games/iconic','/api/limiteds'].includes(p))return json(res,200,{success:true,docs:[],content:[],items:[],rewards:[],levels:[],challenges:[],socials:[],games:[],race:null,raffle:null});
    if(method==='GET'&&p==='/api/user/notification-settings')return json(res,200,{success:true,email:false,push:false});
    if(method==='POST'&&p==='/api/user/update-username'){const user=requireUser(req),name=String(b.username||'').trim().slice(0,24);if(name.length<2)throw new Error('Username too short');if(Object.values(store.state.users).some(x=>x.id!==user.id&&x.username.toLowerCase()===name.toLowerCase()))throw new Error('Username is already taken');user.username=name;store.saveSoon();return json(res,200,{success:true,user:exactUser(user),username:name});}
    if(method==='POST'&&p==='/api/user/update-privacy-enabled')return json(res,200,{success:true,privacyEnabled:!!b.privacyEnabled});
    if(method==='GET'&&['/api/user/rblx-agecheck','/api/user/ml-agecheck'].includes(p))return json(res,200,{success:true,verified:true,ageVerified:true});

    // Case Battles - local multiplayer backend for the original production UI
    if(method==='GET'&&p==='/api/games/case-battles'){let rows=Object.values(store.state.caseBattles||{}).filter(x=>!x.privateMode&&!x.options?.includes('private_mode'));rows.sort((a,z)=>(z.createdAt||0)-(a.createdAt||0));return json(res,200,{success:true,battles:rows.map(battlePublic),serverTime:Date.now()});}
    const battleGet=p.match(/^\/api\/games\/case-battles\/([^/]+)$/);if(method==='GET'&&battleGet){const bt=store.state.caseBattles[battleGet[1]];if(!bt)return json(res,404,{success:false,message:'Battle not found'});return json(res,200,{success:true,battle:battlePublic(bt),serverTime:Date.now()});}
    if(method==='POST'&&p==='/api/games/case-battles/create'){const user=requireUser(req),bt=battleCreate(user,b);return json(res,200,{success:true,battle:battlePublic(bt),id:bt.id,_id:bt.id});}
    if(method==='POST'&&p==='/api/games/case-battles/join'){const user=requireUser(req),bt=battleJoin(user,String(b.id||''),b.slot,false);return json(res,200,{success:true,battle:battlePublic(bt)});}
    if(method==='POST'&&p==='/api/games/case-battles/add-bot'){const user=requireUser(req),bt=store.state.caseBattles[String(b.id||'')];if(!bt)throw new Error('Battle not found');if(bt.creator!==user.id)throw new Error('Only the battle creator can add bots');return json(res,200,{success:true,battle:battlePublic(battleJoin(user,bt.id,b.slot,true))});}

    // Cases and Community Cases
    if(method==='GET'&&p==='/api/public-cases')return json(res,200,publicCaseDocs);
    if(method==='GET'&&p==='/api/games/cases')return json(res,200,{cases:store.state.cases.map(compactCaseExact)});
    if(method==='POST'&&p==='/api/games/cases/roll'){
      const user=requireUser(req),result=games.openCase(user,{slug:b.slug||b.caseIdentifier||b.id,count:1}),won=result.wins[0]||{};
      // The original Single Case page intentionally buffers returned gameEvents until the reel animation ends.
      // Send the wager immediately, but return the prize event without broadcasting it so the frontend reveals
      // the payout only after Normal/Fast/Hyper has actually finished.
      publishWalletEvent(user,txEvent(-Number(result.cost||0),'cases'));
      const winEvent=txEvent(Number(result.payout||0),'cases');
      if(result.creatorId&&result.creatorId!==user.id){const creator=store.state.users[result.creatorId];if(creator)wallet(creator,'community-case');}
      feed();return json(res,200,{success:true,itemWon:won.assetId||won.id||won.name,wonItem:won,case:result.case,payout:result.payout,multiplier:result.multiplier,gameEvents:[winEvent]});
    }
    if(method==='GET'&&p==='/api/community-cases'){
      let docs=[...(communityDocs.docs||[])];for(const c of store.state.communityCases||[]){if(c.creatorId)docs.unshift(localCaseToCms(c));}
      const slug=url.searchParams.get('slug');if(slug)docs=docs.filter(x=>String(x.slug)===String(slug));
      const search=(url.searchParams.get('search')||'').toLowerCase();if(search)docs=docs.filter(x=>String(x.name||'').toLowerCase().includes(search));
      const min=Number(url.searchParams.get('minPrice')),max=Number(url.searchParams.get('maxPrice'));if(Number.isFinite(min)&&min>0)docs=docs.filter(x=>Number(x.price)>=min);if(Number.isFinite(max)&&max>0)docs=docs.filter(x=>Number(x.price)<=max);
      const sort=url.searchParams.get('sort')||'newest';if(sort==='price-asc'||sort==='price')docs.sort((a,z)=>Number(a.price)-Number(z.price));else if(sort==='price-desc')docs.sort((a,z)=>Number(z.price)-Number(a.price));else if(sort==='popular')docs.sort((a,z)=>Number(z.totalOpens||0)-Number(a.totalOpens||0));else docs.sort((a,z)=>String(z.createdAt||'').localeCompare(String(a.createdAt||'')));
      const totalDocs=docs.length,page=Math.max(1,Number(url.searchParams.get('page'))||1),limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit'))||20)),start=(page-1)*limit,paged=slug?docs:docs.slice(start,start+limit);
      return json(res,200,{docs:paged,totalDocs,limit,page,totalPages:Math.max(1,Math.ceil(totalDocs/limit)),hasNextPage:start+limit<totalDocs,stats:{totalCases:totalDocs,totalOpens:docs.reduce((s,x)=>s+Number(x.totalOpens||0),0),totalWagered:docs.reduce((s,x)=>s+Number(x.totalWagered||0),0)}});
    }
    if(method==='GET'&&p==='/api/games/community-cases/mine'){const user=requireUser(req),mine=(store.state.communityCases||[]).filter(c=>c.creatorId===user.id);return json(res,200,{cases:mine.map(localCaseToCms),docs:mine.map(localCaseToCms),stats:communityStats(mine)});}
    if(method==='GET'&&p==='/api/games/community-cases/items'){let docs=itemCatalog();const q=(url.searchParams.get('query')||'').toLowerCase();if(q)docs=docs.filter(x=>x.name.toLowerCase().includes(q));const page=Math.max(1,+url.searchParams.get('page')||1),limit=Math.max(1,Math.min(100,+url.searchParams.get('limit')||24)),totalDocs=docs.length;docs=docs.slice((page-1)*limit,page*limit);return json(res,200,{docs,items:docs,totalDocs,page,limit,hasNextPage:page*limit<totalDocs});}
    if(method==='POST'&&p==='/api/games/community-cases/create'){const user=requireUser(req),n=normalizeCommunityCreate(b),c=games.createCommunityCase(user,n);return json(res,200,{success:true,case:localCaseToCms(c),...localCaseToCms(c)});}
    if(method==='PATCH'&&p==='/api/games/community-cases/edit'){const user=requireUser(req),n=normalizeCommunityCreate(b);n.slug=b.slug;const c=games.editCommunityCase(user,n);return json(res,200,{success:true,case:localCaseToCms(c),...localCaseToCms(c)});}

    // Dice / Mines / Towers
    if(method==='POST'&&p==='/api/games/dice/roll'){const user=requireUser(req),before=user.balance,r=games.dice(user,b);feed();return json(res,200,{success:true,...r,gameEvents:[deltaEvent(before,user,'dice')]});}
    const diceGet=p.match(/^\/api\/games\/dice\/([^/]+)$/);if(method==='GET'&&diceGet&&diceGet[1]!=='history'){const user=requireUser(req),id=decodeURIComponent(diceGet[1]),row=store.state.history.find(x=>x.userId===user.id&&x.game==='dice'&&(x.id===id||x.uuid===id));if(!row)return json(res,404,{success:false,message:'Game not found'});return json(res,200,{success:true,game:{...row,_id:row.id,betAmount:row.bet,winningAmount:row.payout,roll:row.result?.roll??row.result?.result??null,serverSeedHash:row.result?.proof?.serverSeedHash,clientSeed:row.result?.proof?.clientSeed,nonce:row.result?.proof?.nonce}});}
    if(method==='GET'&&p==='/api/games/mines'){const user=requireUser(req),g=store.state.activeMines[user.id];return json(res,200,{hasGame:!!g,game:g?mineExact(g):null,multiplier:g?games.minesPublic(g).multiplier:1});}
    if(method==='POST'&&p==='/api/games/mines/create'){const user=requireUser(req),before=user.balance,g=games.minesStart(user,b);return json(res,200,{success:true,game:mineExact(store.state.activeMines[user.id]),multiplier:g.multiplier||1,winnings:0,exploded:false,gameEvents:[deltaEvent(before,user,'mines')]});}
    if(method==='POST'&&p==='/api/games/mines/action'){
      const user=requireUser(req),before=user.balance;
      if(b.cashout){const r=games.minesCashout(user);feed();return json(res,200,{success:true,game:mineExactResult(r),multiplier:r.multiplier,winnings:r.payout||r.winnings||0,exploded:false,gameEvents:[deltaEvent(before,user,'mines')]});}
      const r=games.minesReveal(user,b.mine);if(r.finished)feed();return json(res,200,{success:true,game:mineExactResult(r),multiplier:r.multiplier||1,winnings:r.payout||0,exploded:!!r.exploded,badMineUncovered:r.badMineUncovered,gameEvents:Math.abs(user.balance-before)>1e-9?[deltaEvent(before,user,'mines')]:[]});
    }
    if(method==='GET'&&p==='/api/games/towers'){const user=requireUser(req),g=store.state.activeTowers[user.id];return json(res,200,{hasGame:!!g,game:g?towerExact(g,false):null});}
    if(method==='POST'&&p==='/api/games/towers/create'){const user=requireUser(req),before=user.balance;games.towersStart(user,b);const g=store.state.activeTowers[user.id];return json(res,200,{success:true,game:towerExact(g,false),gameEvents:[deltaEvent(before,user,'towers')]});}
    if(method==='POST'&&p==='/api/games/towers/action'){
      const user=requireUser(req),before=user.balance;
      if(b.cashout){const r=games.towersCashout(user);feed();return json(res,200,{success:true,game:towerExactResult(r,true),winnings:r.payout||0,completedLevels:towerExactResult(r,true).completedLevels,gameEvents:[deltaEvent(before,user,'towers')]});}
      const r=games.towersReveal(user,b.tile);if(r.finished)feed();const ex=towerExactResult(r,!!r.finished);return json(res,200,{success:true,game:ex,completedLevels:ex.completedLevels,towerLevels:ex.towerLevels,exploded:!!r.hit,winnings:r.payout||0,gameEvents:Math.abs(user.balance-before)>1e-9?[deltaEvent(before,user,'towers')]:[]});
    }

    // Blackjack v2
    if(method==='GET'&&p==='/api/games/blackjackv2/my-game'){
      const user=requireUser(req),g=store.state.activeBlackjack[user.id];if(!g)return json(res,404,{message:'No active game'});return json(res,200,{success:true,game:blackjackExact(g,user,false,true),...blackjackExact(g,user,false,true)});
    }
    if(method==='POST'&&p==='/api/games/blackjackv2/join-game'){
      const user=requireUser(req),before=user.balance,r=games.blackjackStart(user,{bet:b.bet});const g=store.state.activeBlackjack[user.id];let ex=g?blackjackExact(g,user,false):blackjackExactFromPublic(r,user);if(!g)feed();return json(res,200,{success:true,game:ex,...ex,gameEvents:[deltaEvent(before,user,'blackjack')]});
    }
    if(method==='POST'&&p==='/api/games/blackjackv2/action'){
      const user=requireUser(req),current=store.state.activeBlackjack[user.id];if(!current)return json(res,404,{message:'No active game'});if(b.gameId&&String(b.gameId)!==String(current.id))return json(res,409,{message:'Game has changed'});const before=user.balance,r=games.blackjackAction(user,String(b.action||'').toLowerCase(),b.handIndex),g=store.state.activeBlackjack[user.id];let ex=g?blackjackExact(g,user,false):blackjackExactFromPublic(r,user);if(!g)feed();return json(res,200,{success:true,game:ex,...ex,gameEvents:Math.abs(user.balance-before)>1e-9?[deltaEvent(before,user,'blackjack')]:[]});
    }
    if(method==='POST'&&p==='/api/games/blackjackv2/insurance'){const user=requireUser(req),current=store.state.activeBlackjack[user.id];if(!current)return json(res,404,{message:'No active game'});if(b.gameId&&String(b.gameId)!==String(current.id))return json(res,409,{message:'Game has changed'});const before=user.balance,r=games.blackjackInsurance(user,!!b.taken),g=store.state.activeBlackjack[user.id],ex=g?blackjackExact(g,user,false):blackjackExactFromPublic(r,user);if(!g)feed();return json(res,200,{success:true,game:ex,...ex,gameEvents:Math.abs(user.balance-before)>1e-9?[deltaEvent(before,user,'blackjack')]:[]});}
    if(method==='DELETE'&&p==='/api/games/blackjackv2/my-game'){const user=requireUser(req),g=store.state.activeBlackjack[user.id];if(g){const refund=games.round2((g.hands||[]).reduce((s,h)=>s+Number(h.bet||0),0)+Number(g.insuranceBet||0));delete store.state.activeBlackjack[user.id];store.adjustBalance(user,refund,'BLACKJACK_CANCEL_REFUND');wallet(user,'blackjack');}return json(res,200,{success:true});}

    // Plinko / Upgrader
    if(method==='GET'&&p==='/api/games/plinko/multipliers'){const payouts=[];for(const rows of [8,9,10,11,12,13,14,15,16])for(const risk of ['low','medium','high'])payouts.push({rows,risk,payouts:games.plinkoTable(rows,risk)});return json(res,200,{success:true,payouts});}
    if(method==='POST'&&p==='/api/games/plinko/roll'){const user=requireUser(req),r=games.plinko(user,b),play=txEvent(-Number(b.amount||b.bet),'plinko'),win=r.payout>0?txEvent(r.payout,'plinko',Math.max(400,Number(r.rows||16)*65)):null;publishWalletEvent(user,play);if(win)publishWalletEvent(user,win);feed();return json(res,200,{success:true,position:r.slot+1,game:{rows:r.rows,risk:r.difficulty},playTransactions:[play],winTransactions:win?[win]:[],multiplier:r.multiplier,payout:r.payout,path:r.path,proof:r.proof,balance:user.balance});}
    if(method==='GET'&&p==='/api/items')return json(res,200,{docs:itemCatalog()});
    if(method==='POST'&&p==='/api/games/upgrader/roll'){const user=requireUser(req),items=itemCatalog(),target=items.find(x=>String(x.id)===String(b.targetAssetId))||items.find(x=>String(x.slug)===String(b.targetAssetId))||items.find(x=>Number(x.value)>=Number(b.bet)*Number(b.multiplier||2))||items[items.length-1],r=games.upgrader(user,{bet:b.bet,targetValue:target?.value||Number(b.bet)*Number(b.multiplier||2),rangeStart:b.rangeStart}),wager=games.round2(r.multiplier>0?r.target/r.multiplier:Number(b.bet)||0),playEvent=txEvent(-wager,'upgrader'),winEvent=r.payout>0?txEvent(r.payout,'upgrader',b.instantMode?2000:7000):null;publishWalletEvent(user,playEvent);if(winEvent)publishWalletEvent(user,winEvent);feed();const game={id:r.id,_id:r.id,uuid:r.uuid,roll:r.roll,targetItem:target,isWin:r.win,win:r.win,won:r.win,payout:r.payout,multiplier:r.multiplier,winChance:r.chance,rangeStart:r.rangeStart,instantMode:!!b.instantMode};return json(res,200,{success:true,game,result:game,data:game,gameEvents:[playEvent,...(winEvent?[winEvent]:[])]});}

    // Provably fair and histories
    if(method==='GET'&&p==='/api/provably-fair'){const user=requireUser(req),f=store.publicUser(user).fairness;return json(res,200,{clientSeed:f.clientSeed,serverSeedHash:f.serverSeedHash,nonce:f.nonce,previous:f.previous||[]});}
    if(method==='POST'&&p==='/api/provably-fair/clientSeed'){const user=requireUser(req),previous=fair.rotate(user,b.clientSeed);store.saveSoon();const f=store.publicUser(user).fairness;return json(res,200,{success:true,clientSeed:f.clientSeed,serverSeedHash:f.serverSeedHash,nonce:f.nonce,previous:[previous,...(f.previous||[])]});}
    const histMatch=p.match(/^\/api\/games\/([^/]+)\/history$/);if(method==='GET'&&histMatch&&histMatch[1]!=='crash'){const user=requireUser(req),page=Math.max(0,+url.searchParams.get('page')||0),size=Math.max(1,Math.min(100,+url.searchParams.get('size')||20));return json(res,200,exactHistory(user,histMatch[1],page,size));}

    // Crash using original realtime event names
    if(method==='GET'&&p==='/api/gm/crash')return json(res,200,crashSchema());
    if(method==='GET'&&p==='/api/games/crash/me'){const user=requireUser(req),bet=store.state.crash?.bets?.[user.id];return json(res,200,bet?{active:true,player:{playerId:user.id,username:user.username,playAmount:bet.bet,autoCashOut:bet.autoCashout?Math.round(bet.autoCashout*100):-1,status:bet.cashout?2:1,stoppedAt:bet.cashout?Math.round(bet.cashout*100):0,winAmount:bet.payout||0}}:{active:false});}
    if(method==='GET'&&p==='/api/games/crash/history')return json(res,200,crashHistoryExact());
    if(method==='POST'&&p==='/api/gm/crash/join'){
      const user=requireUser(req),c=store.state.crash;if(c.phase!=='betting'||Date.now()>=c.bettingEndsAt)throw new Error('Betting is closed');if(c.bets[user.id])throw new Error('You already joined this round');
      const bet=games.validBet(user,b.playAmount??b.bet),raw=Number(b.autoCashOut??b.autoCashout),autoCashout=Number.isFinite(raw)&&raw>0?(raw>100?raw/100:raw):null;store.adjustBalance(user,-bet,'CRASH_BET',{roundId:c.roundId});c.bets[user.id]={userId:user.id,username:user.username,bet,autoCashout,cashout:null,payout:0};store.saveSoon();wallet(user,'crash');const player=crashExactCurrent().players.find(x=>x.playerId===user.id);broadcast('crash:joined',player);broadcast(`crash:success#${user.id}`,{message:'Joined',player},user.id);return json(res,200,{success:true,player});
    }
    if(method==='POST'&&p==='/api/gm/crash/cashout'){
      const user=requireUser(req),c=store.state.crash,bx=c.bets[user.id];if(c.phase!=='running'||!bx||bx.cashout)throw new Error('Nothing to cash out');if(c.multiplier>=c.crashPoint)throw new Error('Too late');bx.cashout=c.multiplier;bx.payout=games.round2(bx.bet*bx.cashout);store.adjustBalance(user,bx.payout,'CRASH_PAYOUT',{roundId:c.roundId});store.recordGame(user,'crash',bx.bet,bx.payout,bx.cashout,{roundId:c.roundId,crashPoint:c.crashPoint,proof:c.proof});store.saveSoon();wallet(user,'crash');feed();broadcast('crash:cash-out',{message:`${user.username} ${bx.cashout.toFixed(2)}x`,playerId:user.id,username:user.username,stoppedAt:Math.round(bx.cashout*100),winAmount:bx.payout});broadcast(`crash:success#${user.id}`,{message:'Cashed out',winAmount:bx.payout},user.id);return json(res,200,{success:true,multiplier:bx.cashout,winAmount:bx.payout});
    }

    // Slide local shared round
    if(method==='GET'&&p==='/api/games/slide')return json(res,200,slideSchemaExact());
    if(method==='POST'&&p==='/api/gm/slide/join'){
      const user=requireUser(req),cur=ensureSlideExact();if(!cur.joinable)throw new Error('Betting is closed');const amount=games.validBet(user,b.amount),color=['red','purple','yellow'].includes(String(b.color))?String(b.color):'red';if(cur.players.some(x=>x.playerID===user.id&&x.color===color))throw new Error('You already bet this color');store.adjustBalance(user,-amount,'SLIDE_BET',{roundId:cur._id});const player={playerID:user.id,username:user.username,betAmount:amount,currency:'FLIPCOINS',color};cur.players.push(player);store.saveSoon();wallet(user,'slide');broadcast('slide:new-player',player);broadcast(`slide:game-join-success#${user.id}`,{message:'Joined',player},user.id);return json(res,200,{success:true,player});
    }

    // Cups local multiplayer rooms
    if(method==='GET'&&p==='/api/games/cups')return json(res,200,Object.values(store.state.cupsRooms||{}).filter(r=>Date.now()-(r.created||0)<3600000).map(cupsExactRoom));
    if(method==='POST'&&p==='/api/games/cups'){
      const user=requireUser(req),bet=games.validBet(user,b.betAmount),maxPlayers=clampInt(b.numberOfPlayers,2,4,2),color=['red','blue','purple','yellow'].includes(String(b.color))?String(b.color):'red';store.adjustBalance(user,-bet,'CUPS_BET');const room={id:store.id('cup'),creatorId:user.id,bet,maxPlayers,status:'waiting',players:[{userId:user.id,username:user.username,color,bot:false}],created:Date.now()};store.state.cupsRooms[room.id]=room;store.saveSoon();wallet(user,'cups');const exact=cupsExactRoom(room);broadcast('cups:new-cups-game',exact);return json(res,200,{success:true,room:exact});
    }
    const exactCup=p.match(/^\/api\/games\/cups\/([^/]+)\/(join|call-bot)$/);if(method==='POST'&&exactCup){const user=requireUser(req),room=store.state.cupsRooms[exactCup[1]];if(!room||room.status!=='waiting')throw new Error('Room is not available');const colors=['red','blue','purple','yellow'],color=colors.includes(String(b.color))?String(b.color):colors.find(c=>!room.players.some(x=>x.color===c));if(room.players.some(x=>x.color===color))throw new Error('Cup color is taken');
      if(exactCup[2]==='join'){if(room.players.some(x=>x.userId===user.id))throw new Error('You are already in this room');if(store.spendableBalance(user)<room.bet)throw new Error('Insufficient balance');store.adjustBalance(user,-room.bet,'CUPS_BET',{roomId:room.id});room.players.push({userId:user.id,username:user.username,color,bot:false});wallet(user,'cups');broadcast('cups:game-joined',{_id:room.id,newPlayer:{_id:user.id,robloxId:user.id,username:user.username,color}});}else{const botId=`-${Date.now()}${room.players.length}`;room.players.push({userId:botId,robloxId:1,username:'PvP Bot',avatar:'/_next/image%20(2).webp',color,bot:true});broadcast('cups:game-joined',{_id:room.id,newPlayer:{_id:1,robloxId:1,username:'PvP Bot',avatar:'/_next/image%20(2).webp',color}});}
      store.saveSoon();exactCupMaybeStart(room);return json(res,200,{success:true,room:cupsExactRoom(room)});
    }

    if(method==='POST'&&p==='/api/auth/logout'){store.destroySession(cookies(req).bf_session);return ok(res,{}, {'Set-Cookie':'bf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});}
    if(method==='GET'&&p==='/api/config')return ok(res,{currency:'FLIPCOINS',startingBalance:100000,caseBattles:true,removed:['slots','raffle','race','affiliates','rewards','withdraw','live-support','rocoins']});
    if(method==='GET'&&p==='/api/events'){
      if(!u)return fail(res,'Log in first',401);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`event: hello\ndata: ${JSON.stringify({user:store.publicUser(u),crash:crashPublic(),slide:slidePublic(),cups:cupsPublic()})}\n\n`);const c={res,userId:u.id};clients.add(c);const ping=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},20000);req.on('close',()=>{clearInterval(ping);clients.delete(c)});return;
    }
    if(method==='POST'&&p==='/api/wallet/grant'){return json(res,410,{success:false,message:'Legacy instant grant is disabled. Use the local deposit window.'});}
    if(method==='GET'&&p==='/api/history'){const user=requireUser(req);return ok(res,{history:userHistory(user,url.searchParams.get('game'))});}
    if(method==='GET'&&p==='/api/live-feed'){let rows=store.state.liveFeed;const t=url.searchParams.get('type');if(t==='high')rows=rows.filter(x=>x.high);if(t==='lucky')rows=rows.filter(x=>x.lucky);return ok(res,{feed:rows.slice(0,60)});}
    if(method==='GET'&&p==='/api/chat')return ok(res,{chat:store.state.chat.slice(-100)});
    if(method==='POST'&&p==='/api/chat'){const user=requireUser(req),text=String(b.message||'').trim();if(!text)throw new Error('Message is empty');const row=pushChat(chatMessage(user,text));return ok(res,{message:row});}
    if(method==='GET'&&p==='/api/fairness'){const user=requireUser(req);return ok(res,{fairness:store.publicUser(user).fairness});}
    if(method==='POST'&&p==='/api/fairness/rotate'){const user=requireUser(req),previous=fair.rotate(user,b.clientSeed);store.saveSoon();return ok(res,{fairness:store.publicUser(user).fairness,previous});}
    if(method==='GET'&&p==='/api/cases'){let rows=[...store.state.cases],sort=url.searchParams.get('sort');if(sort==='price')rows.sort((a,b)=>a.price-b.price);if(sort==='popular')rows.sort((a,b)=>(b.totalOpens||0)-(a.totalOpens||0));return ok(res,{cases:rows.map(caseCompact)});}
    if(method==='GET'&&p==='/api/community-cases'){let rows=[...store.state.communityCases],sort=url.searchParams.get('sort')||'newest';if(sort==='newest')rows.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));if(sort==='popular')rows.sort((a,b)=>(b.totalOpens||0)-(a.totalOpens||0));if(sort==='trending')rows.sort((a,b)=>((b.totalOpens||0)+(b.totalWagered||0)/1000)-((a.totalOpens||0)+(a.totalWagered||0)/1000));return ok(res,{cases:rows.map(caseCompact)});}
    if(method==='GET'&&p==='/api/games/community-cases/mine'){const user=requireUser(req),mine=store.state.communityCases.filter(c=>c.creatorId===user.id);return ok(res,{cases:mine.map(caseCompact),stats:communityStats(mine)});}
    if(method==='POST'&&p==='/api/community-cases/create'){const user=requireUser(req),c=games.createCommunityCase(user,b);return ok(res,{case:caseCompact(c)});}
    if((method==='PATCH'||method==='POST')&&p==='/api/community-cases/edit'){const user=requireUser(req),c=games.editCommunityCase(user,b);return ok(res,{case:caseCompact(c)});}
    if(method==='GET'&&p.startsWith('/api/cases/')){const c=games.findCase(decodeURIComponent(p.slice('/api/cases/'.length)));if(!c)return fail(res,'Case not found',404);return ok(res,{case:caseCompact(c)});}
    if(method==='POST'&&p==='/api/games/cases/open'){const user=requireUser(req),result=games.openCase(user,b);afterUserGame(user);if(result.creatorId&&result.creatorId!==user.id){const creator=store.state.users[result.creatorId];if(creator)wallet(creator);}return ok(res,result);}
    if(method==='POST'&&p==='/api/games/dice/roll'){const user=requireUser(req),result=games.dice(user,b);afterUserGame(user);return ok(res,result);}
    if(method==='GET'&&p==='/api/games/mines/state'){const user=requireUser(req),g=store.state.activeMines[user.id];return ok(res,{game:g?games.minesPublic(g):null});}
    if(method==='POST'&&p==='/api/games/mines/start'){const user=requireUser(req),result=games.minesStart(user,b);wallet(user);return ok(res,{game:result,balance:user.balance});}
    if(method==='POST'&&p==='/api/games/mines/reveal'){const user=requireUser(req),result=games.minesReveal(user,b.index);if(result.finished)afterUserGame(user);return ok(res,{game:result});}
    if(method==='POST'&&p==='/api/games/mines/cashout'){const user=requireUser(req),result=games.minesCashout(user);afterUserGame(user);return ok(res,{game:result});}
    if(method==='GET'&&p==='/api/games/towers/state'){const user=requireUser(req),g=store.state.activeTowers[user.id];return ok(res,{game:g?games.towersPublic(g):null});}
    if(method==='POST'&&p==='/api/games/towers/start'){const user=requireUser(req),result=games.towersStart(user,b);wallet(user);return ok(res,{game:result,balance:user.balance});}
    if(method==='POST'&&p==='/api/games/towers/reveal'){const user=requireUser(req),result=games.towersReveal(user,b.index);if(result.finished)afterUserGame(user);return ok(res,{game:result});}
    if(method==='POST'&&p==='/api/games/towers/cashout'){const user=requireUser(req),result=games.towersCashout(user);afterUserGame(user);return ok(res,{game:result});}
    if(method==='POST'&&p==='/api/games/blackjack/start'){const user=requireUser(req),result=games.blackjackStart(user,b);wallet(user);if(result.done)feed();return ok(res,{game:result});}
    if(method==='POST'&&p==='/api/games/blackjack/action'){const user=requireUser(req),result=games.blackjackAction(user,b.action);wallet(user);if(result.done)feed();return ok(res,{game:result});}
    if(method==='GET'&&p==='/api/games/blackjack/state'){const user=requireUser(req),g=store.state.activeBlackjack[user.id];return ok(res,{game:g?games.blackjackPublic(g,false,user):null});}
    if(method==='POST'&&p==='/api/games/plinko/play'){const user=requireUser(req),result=games.plinko(user,b);afterUserGame(user);return ok(res,result);}
    if(method==='GET'&&p==='/api/upgrader/items')return ok(res,{items:games.upgraderItems()});
    if(method==='POST'&&p==='/api/games/upgrader/play'){const user=requireUser(req),result=games.upgrader(user,b);afterUserGame(user);return ok(res,result);}
    if(method==='GET'&&p==='/api/games/crash/state')return ok(res,{game:crashPublic()});
    if(method==='POST'&&p==='/api/games/crash/bet'){const user=requireUser(req),c=store.state.crash;if(c.phase!=='betting'||Date.now()>=c.bettingEndsAt)throw new Error('Betting is closed');if(c.bets[user.id])throw new Error('You already joined this round');const bet=games.validBet(user,b.bet),autoCashout=b.autoCashout?games.round2(Number(b.autoCashout)):null;if(autoCashout&&autoCashout<1.01)throw new Error('Auto cashout must be at least 1.01x');store.adjustBalance(user,-bet,'CRASH_BET',{roundId:c.roundId});c.bets[user.id]={userId:user.id,username:user.username,bet,autoCashout,cashout:null,payout:0};store.saveSoon();wallet(user);broadcast('crash',crashPublic());return ok(res,{game:crashPublic(),balance:user.balance});}
    if(method==='POST'&&p==='/api/games/crash/cashout'){const user=requireUser(req),c=store.state.crash,bx=c.bets[user.id];if(c.phase!=='running'||!bx||bx.cashout)throw new Error('Nothing to cash out');if(c.multiplier>=c.crashPoint)throw new Error('Too late');bx.cashout=c.multiplier;bx.payout=games.round2(bx.bet*bx.cashout);store.adjustBalance(user,bx.payout,'CRASH_PAYOUT',{roundId:c.roundId});store.recordGame(user,'crash',bx.bet,bx.payout,bx.cashout,{roundId:c.roundId,crashPoint:c.crashPoint,proof:c.proof});store.saveSoon();afterUserGame(user);broadcast('crash',crashPublic());return ok(res,{multiplier:bx.cashout,payout:bx.payout,balance:user.balance});}
    if(method==='GET'&&p==='/api/games/slide/state')return ok(res,{game:slidePublic()});
    if(method==='POST'&&p==='/api/games/slide/bet'){const user=requireUser(req),s=store.state.slide;if(s.phase!=='betting'||Date.now()>=s.bettingEndsAt)throw new Error('Betting is closed');if(s.bets[user.id])throw new Error('You already joined this round');const bet=games.validBet(user,b.bet),target=[2,3,5,10,50].includes(+b.target)?+b.target:2;store.adjustBalance(user,-bet,'SLIDE_BET',{roundId:s.roundId});s.bets[user.id]={userId:user.id,username:user.username,bet,target,payout:0};store.saveSoon();wallet(user);broadcast('slide',slidePublic());return ok(res,{game:slidePublic(),balance:user.balance});}
    if(method==='GET'&&p==='/api/games/cups/rooms')return ok(res,{rooms:cupsPublic()});
    if(method==='POST'&&p==='/api/games/cups/create'){const user=requireUser(req),bet=games.validBet(user,b.bet),maxPlayers=clampInt(b.players,2,4,2);store.adjustBalance(user,-bet,'CUPS_BET');const room={id:store.id('cup'),bet,maxPlayers,status:'waiting',players:[{userId:user.id,username:user.username,bot:false}],created:Date.now()};store.state.cupsRooms[room.id]=room;store.saveSoon();wallet(user);broadcast('cups',cupsPublic());return ok(res,{room});}
    const cupJoin=p.match(/^\/api\/games\/cups\/([^/]+)\/(join|bot)$/);if(method==='POST'&&cupJoin){const user=requireUser(req),room=store.state.cupsRooms[cupJoin[1]];if(!room||room.status!=='waiting')throw new Error('Room is not available');if(cupJoin[2]==='join'){if(room.players.some(x=>x.userId===user.id))throw new Error('You are already in this room');if(store.spendableBalance(user)<room.bet)throw new Error('Insufficient balance');store.adjustBalance(user,-room.bet,'CUPS_BET',{roomId:room.id});room.players.push({userId:user.id,username:user.username,bot:false});wallet(user);}else{while(room.players.length<room.maxPlayers)room.players.push({userId:`-${Date.now()}${room.players.length}`,robloxId:1,username:'PvP Bot',avatar:'/_next/image%20(2).webp',bot:true});}store.saveSoon();broadcast('cups',cupsPublic());cupMaybeStart(room);return ok(res,{room});}
    return fail(res,'API route not found',404);
  }catch(e){return fail(res,e,e.status||400);}
}
function clampInt(v,a,b,d){v=Math.floor(Number(v));return Number.isFinite(v)?Math.max(a,Math.min(b,v)):d;}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp3':'audio/mpeg','.wav':'audio/wav','.woff2':'font/woff2','.ico':'image/x-icon'};
function staticFile(req,res,url){
  let rel=decodeURIComponent(url.pathname), dynamicIdentifier=null;
  if(rel==='/') rel='/index.html';
  else if(!path.extname(rel) && rel!=='/__external/fonts.googleapis.com/css2'){
    const candidate=path.normalize(path.join(PUBLIC,rel+'.html'));
    if(candidate.startsWith(PUBLIC)&&fs.existsSync(candidate)) rel=rel+'.html';
    else {
      let m=rel.match(/^\/cases\/([^/]+)$/);
      if(m){ dynamicIdentifier=m[1]; rel='/cases/[caseIdentifier].html'; }
      else if((m=rel.match(/^\/community-cases\/([^/]+)$/))){ dynamicIdentifier=m[1]; rel='/community-cases/[caseIdentifier].html'; }
      else if((m=rel.match(/^\/case-battles\/([^/]+)$/))&&m[1]!=='create-battle'){ dynamicIdentifier=m[1]; rel='/case-battles/[battleId].html'; }
      else rel='/index.html';
    }
  }
  const file=path.normalize(path.join(PUBLIC,rel));
  if(!file.startsWith(PUBLIC))return fail(res,'Forbidden',403);
  fs.readFile(file,(err,data)=>{
    if(err){
      if(rel.startsWith('/__external/cms-media.bloxflip.com/')||rel.startsWith('/__external/emoji.bloxflip.com/')){
        const fb=path.join(PUBLIC,'logo-small.svg');try{const fallback=fs.readFileSync(fb);res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public, max-age=86400','X-Local-Fallback':'1'});res.end(fallback);return;}catch{}
      }
      if(rel.startsWith('/__external/fonts.gstatic.com/')){
        const fb=path.join(PUBLIC,'__external/fonts.gstatic.com/s/titilliumweb/v19/NaPecZTIAOhVxoMyOr9n_E7fdM3mDbRS.woff2');try{const fallback=fs.readFileSync(fb);res.writeHead(200,{'Content-Type':'font/woff2','Cache-Control':'public, max-age=86400','X-Local-Fallback':'1'});res.end(fallback);return;}catch{}
      }
      return fail(res,'Not found',404);
    }
    let out=data;
    if(path.extname(file)==='.html'){
      let html=data.toString('utf8');
      if(dynamicIdentifier){
        html=html.replace(/__CASE_IDENTIFIER__/g,dynamicIdentifier).replace(/__BATTLE_ID__/g,dynamicIdentifier);
        if(rel==='/cases/[caseIdentifier].html'){
          const initialCaseData=caseInitialData(dynamicIdentifier);
          if(initialCaseData)html=html.replace('"pageProps":{}',`"pageProps":${JSON.stringify({initialCaseData})}`);
        }
      }
      html=html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi,'');
      html=html.replaceAll('https://i.imgur.com/tEREfCm.png','/logo-small.svg');
      html=injectRouteChunks(html,url.pathname);
      if(!hasValidSiteKey(req)){
        html=html.replace('</body>',accessOverlayHtml()+'</body>');
      }
      out=Buffer.from(html);
    }
    const ext=path.extname(file).toLowerCase();const contentType=(rel==='/__external/fonts.googleapis.com/css2'||rel==='/__external/fonts.googleapis.com/css2.css')?'text/css; charset=utf-8':(mime[ext]||'application/octet-stream');
    const isAudio=ext==='.mp3'||ext==='.wav'||ext==='.ogg';const mutableFrontend=ext==='.html'||ext==='.js'||ext==='.css';res.writeHead(200,{'Content-Type':contentType,'Cache-Control':isAudio?'no-store, no-cache, must-revalidate, max-age=0':mutableFrontend?'no-cache, must-revalidate':'public, max-age=86400',...(isAudio?{'Pragma':'no-cache','Expires':'0'}:{})});res.end(out);
  });
}
function nextImage(req,res,url){
  const target=url.searchParams.get('url');
  if(!target)return fail(res,'Missing image url',400);
  let dest=target;
  try{ if(/^https?:/i.test(target)){ const u=new URL(target);if(u.hostname==='bloxflip.com')dest=u.pathname+u.search;else if(['cms-media.bloxflip.com','emoji.bloxflip.com','fonts.gstatic.com','fonts.googleapis.com'].includes(u.hostname))dest=`/__external/${u.hostname}${u.pathname}${u.search}`;else if(u.hostname==='api.bloxflip.com'&&u.pathname.startsWith('/render/'))dest=`/api/local/render/${encodeURIComponent(u.pathname.split('/').pop())}`;} }catch{}
  res.writeHead(302,{Location:dest,'Cache-Control':'no-store'});res.end();
}
const server=http.createServer((req,res)=>{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname==='/_next/image')return nextImage(req,res,url);if(url.pathname.startsWith('/api/'))return api(req,res,url);if(url.pathname.startsWith('/_next/data/')){const handled=nextData(req,res,url);if(handled!==false)return handled;}return staticFile(req,res,url);});
server.listen(PORT,HOST,()=>{console.log(`\nBflipX v1.1 is running at http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`);console.log('Press Ctrl+C to stop.\n');});
process.on('SIGINT',()=>{store.saveNow();process.exit(0)});process.on('SIGTERM',()=>{store.saveNow();process.exit(0)});
