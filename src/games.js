const crypto = require('crypto');
const store = require('./store');
const fair = require('./fairness');

const round2 = n => Math.round(Number(n) * 100) / 100;
const clamp = (n,a,b) => Math.min(b, Math.max(a,n));
const comb = (n,k) => {
  if(k<0||k>n) return 0;
  k=Math.min(k,n-k); let r=1;
  for(let i=1;i<=k;i++) r=r*(n-k+i)/i;
  return r;
};
function validBet(user, value, min=0.1) {
  const bet=round2(value);
  if(!Number.isFinite(bet)||bet<min) throw new Error(`Minimum bet is ${min}`);
  if(bet>store.spendableBalance(user)) throw new Error('Insufficient balance');
  return bet;
}
function shuffledIndices(count, values) {
  const a=Array.from({length:count},(_,i)=>i);
  for(let i=a.length-1,j=0;i>0;i--,j++) {
    const r=values[j%values.length] ?? Math.random();
    const k=Math.floor(r*(i+1)); [a[i],a[k]]=[a[k],a[i]];
  }
  return a;
}
function weighted(items, r) {
  const total=items.reduce((s,x)=>s+Number(x.chance||0),0);
  let x=r*total;
  for(const item of items){ x-=Number(item.chance||0); if(x<=0) return item; }
  return items[items.length-1];
}
function record(user, game, bet, payout, multiplier, result, flags={}) {
  if(payout>0) store.adjustBalance(user,payout,`${game.toUpperCase()}_PAYOUT`,{result});
  return store.recordGame(user,game,bet,payout,multiplier,result,flags.high,flags.lucky);
}

function dice(user, body={}) {
  const bet=validBet(user,body.bet);
  const ranges=Array.isArray(body.ranges)&&body.ranges.length?body.ranges:null;
  let chance=clamp(Number(body.chance)||49.5,1,95), direction=body.direction==='over'?'over':'under';
  let min=0,max=chance;
  if(ranges){min=Number(ranges[0].min);max=Number(ranges[0].max);if(!Number.isFinite(min))min=0;if(!Number.isFinite(max))max=99.99;chance=clamp(max-min,0.01,99.99);direction=min>0?'over':'under';}
  store.adjustBalance(user,-bet,'DICE_BET');
  const roll=fair.nextFloat(user,'dice'); store.saveSoon();
  const number=Math.floor(roll.value*10000)/100;
  const target=direction==='under'?max:min;
  const win=number>=min&&number<=max;
  const multiplier=round2(Number(body.multiplier)||95/chance);
  const payout=win?round2(bet*multiplier):0;
  const rec=record(user,'dice',bet,payout,multiplier,{roll:number,chance,direction,win,proof:roll.proof},{lucky:win&&chance<=10});
  return {id:rec.row.id,_id:rec.row.id,uuid:rec.row.uuid,roll:number,result:number,chance,direction,win,isWin:win,multiplier,payout,balance:user.balance,proof:roll.proof,ranges:ranges||[{min,max}]};
}

function minesMultiplier(mines, opened, cells=25) {
  if(opened<=0) return 1;
  const p=comb(cells-mines,opened)/comb(cells,opened);
  return round2(0.99/p);
}
function minesStart(user, body={}) {
  if(store.state.activeMines[user.id]) throw new Error('Finish your current Mines game first');
  const bet=validBet(user,body.betAmount ?? body.bet);
  const grid=clamp(Math.floor(Number(body.grid)||5),3,10), cells=grid*grid;
  const mines=clamp(Math.floor(Number(body.mines)||3),1,cells-1);
  store.adjustBalance(user,-bet,'MINES_BET');
  const rnd=fair.beginRound(user,'mines',Math.max(256,cells*4)); store.saveSoon();
  const mineList=shuffledIndices(cells,rnd.values).slice(0,mines);
  const game={id:store.id('mines'),uuid:crypto.randomUUID(),bet,mines,grid,cells,mineList,revealed:[],created:Date.now(),proof:rnd.proof,currency:'FLIPCOINS'};
  store.state.activeMines[user.id]=game; store.saveSoon();
  return minesPublic(game);
}
function minesPublic(g, revealAll=false){
  return {id:g.id,uuid:g.uuid||g.id,bet:g.bet,mines:g.mines,grid:g.grid||5,gridSize:g.cells||((g.grid||5)*(g.grid||5)),revealed:g.revealed,uncoveredLocations:[...g.revealed],active:!revealAll,multiplier:minesMultiplier(g.mines,g.revealed.length,g.cells||25),mineList:revealAll?g.mineList:undefined,mineLocations:revealAll?[...g.mineList]:undefined,badMineUncovered:null,exploded:false,currency:g.currency||'FLIPCOINS',proof:g.proof};
}
function minesReveal(user,index){
  const g=store.state.activeMines[user.id]; if(!g) throw new Error('No active Mines game');
  index=Math.floor(Number(index)); if(index<0||index>=(g.cells||25)) throw new Error('Invalid tile');
  if(g.revealed.includes(index)) return {...minesPublic(g),hit:false};
  if(g.mineList.includes(index)) {
    delete store.state.activeMines[user.id]; store.saveSoon();
    store.recordGame(user,'mines',g.bet,0,0,{mines:g.mineList,revealed:g.revealed,hit:index,proof:g.proof});
    return {...minesPublic(g,true),active:false,exploded:true,badMineUncovered:index,hit:true,finished:true,payout:0,balance:user.balance};
  }
  g.revealed.push(index); store.saveSoon();
  if(g.revealed.length===(g.cells||25)-g.mines) return minesCashout(user,true);
  return {...minesPublic(g),hit:false,balance:user.balance};
}
function minesCashout(user,auto=false){
  const g=store.state.activeMines[user.id]; if(!g) throw new Error('No active Mines game');
  if(!g.revealed.length) throw new Error('Reveal at least one tile first');
  const mult=minesMultiplier(g.mines,g.revealed.length,g.cells||25), payout=round2(g.bet*mult);
  delete store.state.activeMines[user.id];
  record(user,'mines',g.bet,payout,mult,{mines:g.mineList,revealed:g.revealed,proof:g.proof,auto}); store.saveSoon();
  return {...minesPublic(g,true),active:false,finished:true,payout,winnings:payout,multiplier:mult,balance:user.balance};
}

const towerCfg={easy:{cells:3,safe:2},normal:{cells:2,safe:1},hard:{cells:3,safe:1}};
function towerMultiplier(diff,level){const c=towerCfg[diff]||towerCfg.normal; return round2(0.99*Math.pow(c.cells/c.safe,level));}
function towersStart(user,body={}){
  if(store.state.activeTowers[user.id]) throw new Error('Finish your current Towers game first');
  const bet=validBet(user,body.betAmount ?? body.bet), difficulty=['easy','normal','hard'].includes(String(body.difficulty||'').toLowerCase())?String(body.difficulty).toLowerCase():'normal';
  store.adjustBalance(user,-bet,'TOWERS_BET');
  const rnd=fair.beginRound(user,'towers',64); store.saveSoon();
  const c=towerCfg[difficulty], rows=[];
  for(let r=0;r<8;r++) rows.push(shuffledIndices(c.cells,rnd.values.slice(r*4,r*4+4)).slice(0,c.safe));
  const g={id:store.id('tower'),bet,difficulty,rows,level:0,picks:[],proof:rnd.proof}; store.state.activeTowers[user.id]=g; store.saveSoon();
  return towersPublic(g);
}
function towersPublic(g,reveal=false){const c=towerCfg[g.difficulty];return {id:g.id,bet:g.bet,difficulty:g.difficulty,cells:c.cells,safe:c.safe,level:g.level,picks:g.picks,multiplier:towerMultiplier(g.difficulty,g.level),rows:reveal?g.rows:undefined,proof:g.proof};}
function towersReveal(user,index){const g=store.state.activeTowers[user.id];if(!g)throw new Error('No active Towers game'); const c=towerCfg[g.difficulty]; index=Math.floor(Number(index)); if(index<0||index>=c.cells)throw new Error('Invalid tile'); const safe=g.rows[g.level].includes(index); g.picks.push({level:g.level,index,safe}); if(!safe){delete store.state.activeTowers[user.id];store.recordGame(user,'towers',g.bet,0,0,{rows:g.rows,picks:g.picks,proof:g.proof});store.saveSoon();return {...towersPublic(g,true),hit:true,finished:true,payout:0,balance:user.balance};} g.level++;store.saveSoon(); if(g.level>=8)return towersCashout(user,true); return {...towersPublic(g),hit:false,balance:user.balance};}
function towersCashout(user,auto=false){const g=store.state.activeTowers[user.id];if(!g)throw new Error('No active Towers game');if(g.level<1)throw new Error('Climb at least one floor first');const mult=towerMultiplier(g.difficulty,g.level),payout=round2(g.bet*mult);delete store.state.activeTowers[user.id];record(user,'towers',g.bet,payout,mult,{rows:g.rows,picks:g.picks,proof:g.proof,auto});store.saveSoon();return {...towersPublic(g,true),finished:true,payout,balance:user.balance};}

const suits=['♠','♥','♦','♣'], ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function cardValue(hand){let total=0,aces=0;for(const c of hand||[]){if(c.rank==='A'){total+=11;aces++;}else if(['J','Q','K'].includes(c.rank))total+=10;else total+=+c.rank;}while(total>21&&aces){total-=10;aces--;}return total;}
function isBlackjack(h){return Array.isArray(h)&&h.length===2&&cardValue(h)===21;}
function makeShoe(values){const deck=[];for(let d=0;d<6;d++)for(const suit of suits)for(const rank of ranks)deck.push({rank,suit});const order=shuffledIndices(deck.length,values);return order.map(i=>deck[i]);}
function dealerPlay(g){while(cardValue(g.dealer)<17)g.dealer.push(g.shoe.shift());}
function nextPlayable(g,from=-1){for(let i=Math.max(0,from+1);i<g.hands.length;i++){const h=g.hands[i];if(!h.stood&&cardValue(h.cards)<21)return i;}return -1;}
function blackjackSettle(user,g){
  dealerPlay(g);const dealerValue=cardValue(g.dealer),dealerBJ=isBlackjack(g.dealer);let payout=0;
  for(const h of g.hands){const pv=cardValue(h.cards),natural=isBlackjack(h.cards)&&!h.fromSplit;let p=0,outcome='LOSE';
    if(pv>21)outcome='BUSTED';
    else if(dealerBJ){if(natural){p=h.bet;outcome='DRAW';}}
    else if(natural){p=round2(h.bet*2.5);outcome='BLACKJACK';}
    else if(dealerValue>21||pv>dealerValue){p=round2(h.bet*2);outcome='WIN';}
    else if(pv===dealerValue){p=h.bet;outcome='DRAW';}
    h.outcome=outcome;h.payout=p;h.stood=true;payout+=p;
  }
  if(g.insuranceTaken&&g.insuranceBet>0&&dealerBJ){g.insurancePayout=round2(g.insuranceBet*3);payout+=g.insurancePayout;}else g.insurancePayout=0;
  const handBet=g.hands.reduce((n,h)=>n+Number(h.bet||0),0),totalBet=round2(handBet+Number(g.insuranceBet||0));
  const totalPayout=round2(payout),mult=totalBet?totalPayout/totalBet:0;g.done=true;g.payout=totalPayout;g.activeHand=-1;
  delete store.state.activeBlackjack[user.id];record(user,'blackjack',totalBet,totalPayout,mult,{dealer:g.dealer,hands:g.hands,insuranceBet:g.insuranceBet||0,insuranceTaken:!!g.insuranceTaken,insurancePayout:g.insurancePayout||0,proof:g.proof});store.saveSoon();return blackjackPublic(g,true,user);
}
function blackjackPublic(g,done=false,user=null){return {id:g.id,bet:g.originalBet,dealer:done?g.dealer:[g.dealer[0],{hidden:true}],hands:g.hands.map(h=>({...h,value:cardValue(h.cards)})),activeHand:g.activeHand,done,proof:g.proof,balance:user?.balance,insuranceBet:g.insuranceBet||0,insuranceOffered:!!g.insuranceOffered,insuranceTaken:!!g.insuranceTaken,insuranceResolved:!!g.insuranceResolved,payout:g.payout||0};}
function blackjackStart(user,body={}){
  if(store.state.activeBlackjack[user.id])throw new Error('Finish your current Blackjack hand first');const bet=validBet(user,body.bet);store.adjustBalance(user,-bet,'BLACKJACK_BET');
  const rnd=fair.beginRound(user,'blackjack',400);store.saveSoon();const shoe=makeShoe(rnd.values);const g={id:store.id('bj'),originalBet:bet,shoe,dealer:[shoe.shift(),shoe.shift()],hands:[{cards:[shoe.shift(),shoe.shift()],bet,stood:false,fromSplit:false,payout:0}],activeHand:0,proof:rnd.proof,created:Date.now(),insuranceBet:0,insuranceTaken:false,insuranceResolved:false,payout:0};
  g.insuranceOffered=g.dealer[0]?.rank==='A';store.state.activeBlackjack[user.id]=g;store.saveSoon();
  const dealerBJ=isBlackjack(g.dealer),playerBJ=isBlackjack(g.hands[0].cards);
  if(!g.insuranceOffered&&(dealerBJ||playerBJ))return blackjackSettle(user,g);
  return blackjackPublic(g,false,user);
}
function blackjackInsurance(user,taken){
  const g=store.state.activeBlackjack[user.id];if(!g)throw new Error('No active Blackjack hand');if(!g.insuranceOffered||g.insuranceResolved)return blackjackPublic(g,false,user);
  g.insuranceResolved=true;g.insuranceTaken=!!taken;
  if(g.insuranceTaken){const amount=round2(g.originalBet/2);if(user.balance<amount)throw new Error('Insufficient balance');store.adjustBalance(user,-amount,'BLACKJACK_INSURANCE');g.insuranceBet=amount;}
  store.saveSoon();if(isBlackjack(g.dealer))return blackjackSettle(user,g);if(isBlackjack(g.hands[0].cards))return blackjackSettle(user,g);return blackjackPublic(g,false,user);
}
function blackjackAction(user,action,handIndex){
  const g=store.state.activeBlackjack[user.id];if(!g)throw new Error('No active Blackjack hand');if(g.insuranceOffered&&!g.insuranceResolved){g.insuranceResolved=true;g.insuranceTaken=false;}
  let idx=Number.isInteger(Number(handIndex))?Math.floor(Number(handIndex)):g.activeHand;if(idx<0||idx>=g.hands.length)idx=g.activeHand;let h=g.hands[idx];
  if(!h||h.stood||cardValue(h.cards)>=21)throw new Error('This hand is not active');g.activeHand=idx;action=String(action||'').toLowerCase();
  if(action==='hit'){h.cards.push(g.shoe.shift());if(cardValue(h.cards)>=21)h.stood=true;}
  else if(action==='stand'){h.stood=true;}
  else if(action==='double'){if(h.cards.length!==2)throw new Error('Double is only available on the first two cards');if(user.balance<h.bet)throw new Error('Insufficient balance');store.adjustBalance(user,-h.bet,'BLACKJACK_DOUBLE');h.bet=round2(h.bet*2);h.cards.push(g.shoe.shift());h.stood=true;}
  else if(action==='split'){if(g.hands.length>=5)throw new Error('Maximum split reached');if(h.cards.length!==2||h.cards[0].rank!==h.cards[1].rank)throw new Error('This hand cannot be split');if(user.balance<h.bet)throw new Error('Insufficient balance');store.adjustBalance(user,-h.bet,'BLACKJACK_SPLIT');const moved=h.cards.pop(),splitAces=h.cards[0]?.rank==='A';h.fromSplit=true;h.cards.push(g.shoe.shift());const nh={cards:[moved,g.shoe.shift()],bet:h.bet,stood:false,fromSplit:true,payout:0};g.hands.splice(idx+1,0,nh);if(splitAces){h.stood=true;nh.stood=true;}}
  else throw new Error('Invalid action');
  const score=cardValue(h.cards);if(score>=21)h.stood=true;const next=nextPlayable(g,idx);if(next<0){const earlier=nextPlayable(g,-1);if(earlier<0)return blackjackSettle(user,g);g.activeHand=earlier;}else g.activeHand=next;store.saveSoon();return blackjackPublic(g,false,user);
}

const plinkoBase={
 low:[5.6,2.1,1.1,1,0.5,1,1.1,2.1,5.6],
 medium:[13,3,1.3,0.7,0.4,0.7,1.3,3,13],
 high:[29,4,1.5,0.3,0.2,0.3,1.5,4,29]
};
function plinkoTable(rows,diff){const base=plinkoBase[diff]||plinkoBase.medium;const len=rows+1,out=[];for(let i=0;i<len;i++){const x=i/rows*(base.length-1),a=Math.floor(x),b=Math.min(base.length-1,Math.ceil(x)),t=x-a;out.push(round2(base[a]*(1-t)+base[b]*t));}if(rows>=12&&diff==='high'){out[0]=out[out.length-1]=rows===16?1000:Math.max(out[0],130);}return out;}
function plinko(user,body={}){const bet=validBet(user,body.amount ?? body.bet);const requestedRows=Math.floor(Number(body.rows));const rows=requestedRows>=8&&requestedRows<=16?requestedRows:16,_risk=String(body.risk ?? body.difficulty ?? 'medium').toLowerCase(),difficulty=['low','medium','high'].includes(_risk)?_risk:'medium';store.adjustBalance(user,-bet,'PLINKO_BET');const rnd=fair.beginRound(user,'plinko',rows);store.saveSoon();const path=rnd.values.slice(0,rows).map(x=>x>=.5?1:0),slot=path.reduce((s,x)=>s+x,0),table=plinkoTable(rows,difficulty),multiplier=table[slot],payout=round2(bet*multiplier);record(user,'plinko',bet,payout,multiplier,{rows,difficulty,path,slot,proof:rnd.proof},{lucky:multiplier>=10});return {path,slot,multiplier,payout,table,rows,difficulty,balance:user.balance,proof:rnd.proof};}

function findCase(slug){return [...store.state.cases,...store.state.communityCases].find(c=>c.slug===slug);}
function openCase(user,body={}){
  const c=findCase(String(body.slug||''));if(!c)throw new Error('Case not found');
  const count=clamp(Math.floor(Number(body.count)||1),1,5),cost=round2(c.price*count);
  validBet(user,cost);store.adjustBalance(user,-cost,'CASE_OPEN',{slug:c.slug,count});
  const rnd=fair.beginRound(user,'cases',count*4);store.saveSoon();
  const wins=[];let payout=0;
  for(let i=0;i<count;i++){const item=weighted(c.slots,rnd.values[i]);wins.push({...item,roll:rnd.values[i]});payout+=Number(item.value||0);}
  payout=round2(payout);const mult=cost?payout/cost:0;
  record(user,'cases',cost,payout,mult,{slug:c.slug,wins,proof:rnd.proof},{lucky:mult>=10});
  c.totalOpens=(c.totalOpens||0)+count;
  c.totalDirectOpens=(c.totalDirectOpens||0)+count;
  c.totalWagered=round2((c.totalWagered||0)+cost);
  let creatorEarning=0;
  if(c.community&&c.creatorId&&c.creatorId!==user.id){
    const creator=store.state.users[c.creatorId], commission=clamp(Number(c.commission)||1,0,10);
    creatorEarning=round2(cost*commission/100);
    if(creator&&creatorEarning>0){
      store.adjustBalance(creator,creatorEarning,'COMMUNITY_CASE_EARNING',{slug:c.slug,opener:user.id,count});
      c.creatorEarningsTotal=round2((c.creatorEarningsTotal||0)+creatorEarning);
      c.creatorEarningsCredited=round2((c.creatorEarningsCredited||0)+creatorEarning);
    }
  }
  store.saveSoon();
  return {case:{name:c.name,slug:c.slug,price:c.price,image:c.image},wins,payout,cost,multiplier:round2(mult),balance:user.balance,proof:rnd.proof,creatorId:c.creatorId||null,creatorEarning};
}
function normalizeCommunitySlots(bodySlots){
  let slots=Array.isArray(bodySlots)?bodySlots:[];
  slots=slots.map(s=>({name:String(s.name||'Item').trim().slice(0,50)||'Item',value:Math.max(1,round2(s.value||1)),chance:Math.max(.01,Number(s.chance)||1),rarity:String(s.rarity||'common'),image:s.image||null,filename:s.filename||null})).slice(0,20);
  if(slots.length<2)throw new Error('Add at least two items');
  const total=slots.reduce((sum,x)=>sum+x.chance,0);if(!Number.isFinite(total)||total<=0)throw new Error('Invalid item chances');
  return slots.map(s=>({...s,chance:round2(s.chance/total*100)}));
}
function createCommunityCase(user,body={}){
  const name=String(body.name||'My Case').trim().slice(0,40)||'My Case',slots=normalizeCommunitySlots(body.slots);
  const expected=slots.reduce((sum,x)=>sum+x.value*x.chance/100,0);
  const price=Math.max(1,round2(Number(body.price)||expected*.95));
  const commission=round2(clamp(Number(body.commission)||1,0,10));
  const c={name,slug:`community-local-${store.id('case')}`,price,image:null,imageVariation:Number(body.imageVariation)||1,community:true,creatorId:user.id,creator:user.username,slots,totalOpens:0,totalDirectOpens:0,totalWagered:0,creatorEarningsTotal:0,creatorEarningsCredited:0,commission,createdAt:Date.now(),updatedAt:Date.now()};
  store.state.communityCases.unshift(c);store.saveSoon();return c;
}
function editCommunityCase(user,body={}){
  const c=findCase(String(body.slug||''));if(!c||!c.community)throw new Error('Community case not found');
  if(c.creatorId!==user.id)throw new Error('You can only edit your own case');
  if(body.name!==undefined)c.name=String(body.name||'My Case').trim().slice(0,40)||'My Case';
  if(Array.isArray(body.slots))c.slots=normalizeCommunitySlots(body.slots);
  if(body.price!==undefined&&Number(body.price)>0)c.price=Math.max(1,round2(body.price));
  if(body.commission!==undefined)c.commission=round2(clamp(Number(body.commission)||0,0,10));
  if(body.imageVariation!==undefined)c.imageVariation=clamp(Math.floor(Number(body.imageVariation)||1),1,4);
  c.updatedAt=Date.now();store.saveSoon();return c;
}

function upgraderItems(){const map=new Map();for(const c of [...store.state.cases,...store.state.communityCases])for(const s of c.slots||[]){const name=String(s.name||'').trim().toLowerCase().replace(/\s+/g,' '),value=round2(Number(s.value)||0),key=`nv:${name}:${value}`;if(!map.has(key))map.set(key,{id:s.assetId||s.id||key,name:s.name,value,image:s.image,rarity:s.rarity});}return [...map.values()].sort((a,b)=>a.value-b.value).slice(-120);}
function upgrader(user,body={}){
  const bet=validBet(user,body.bet),target=Math.max(bet,round2(body.targetValue||bet*2));
  if(target<=bet)throw new Error('Target must be worth more than the bet');
  store.adjustBalance(user,-bet,'UPGRADER_BET');
  // The saved production frontend paints a blue interval starting at rangeStart,
  // with width winChance/100. Keep the server outcome on that exact interval.
  const chance=clamp(bet/target*93,0.00001,95);
  let rangeStart=Number(body.rangeStart);if(!Number.isFinite(rangeStart))rangeStart=0;rangeStart=((rangeStart%1)+1)%1;
  const r=fair.nextFloat(user,'upgrader');store.saveSoon();
  const roll=Math.max(0,Math.min(0.999999999999,Number(r.value)||0)),span=chance/100,end=rangeStart+span;
  const win=end<=1?(roll>=rangeStart&&roll<end):(roll>=rangeStart||roll<(end-1));
  const payout=win?target:0,mult=target/bet;
  const rec=record(user,'upgrader',bet,payout,mult,{target,chance,rangeStart,roll,win,proof:r.proof},{lucky:win&&chance<=10});
  return {id:rec.row.id,_id:rec.row.id,uuid:rec.row.uuid,target,chance,rangeStart,roll,win,payout,multiplier:round2(mult),balance:user.balance,proof:r.proof};
}

module.exports={validBet,dice,minesStart,minesReveal,minesCashout,minesPublic,towersStart,towersReveal,towersCashout,towersPublic,blackjackStart,blackjackAction,blackjackInsurance,blackjackPublic,plinko,plinkoTable,findCase,openCase,createCommunityCase,editCommunityCase,upgraderItems,upgrader,round2,record};
