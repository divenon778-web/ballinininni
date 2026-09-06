(()=>{
  'use strict';

  const removedPaths=['/shop','/raffle','/race','/affiliates','/rewards','/withdraw','/slots','/case-battles-classic','/community-cases','/cases/community','/terms','/privacy-policy','/aml','/faq','/rooms'];
  const hiddenExact=new Set(['shop','withdraw','live support','slots','raffle','race','affiliates','rewards','community cases','open community cases','my cases','faq','terms of service','privacy policy','aml policy','voice rooms','what are the differences?','unavailable']);
  const socialNames=new Set(['twitter','x','discord','twitch','instagram','youtube','telegram','tiktok','facebook','google']);
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
  const hide=el=>{if(el&&el!==document.body&&el!==document.documentElement)el.style.setProperty('display','none','important')};
  const shouldHideHref=href=>{
    if(!href)return false;const raw=String(href).trim();if(/^(mailto:|tel:)/i.test(raw))return true;
    try{const u=new URL(raw,location.origin);if(u.origin!==location.origin)return true;const p=u.pathname.replace(/\/+$/,'')||'/';return removedPaths.some(x=>p===x||p.startsWith(x+'/'));}catch{return false}
  };

  function hideCardByHeading(text){
    const wanted=norm(text);document.querySelectorAll('h1,h2,h3,h4,h5').forEach(el=>{if(norm(el.textContent)!==wanted)return;const card=el.closest('[class*="referralOne"],[class*="rewardsSummaryCard"],[class*="homeSummaryCard"],[class*="dataSection"],section,article,[class*="card" i],[class*="tile" i],[class*="panel" i]');hide(card||el.parentElement||el)});
  }
  function scrubRoCoinsText(){
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const n of nodes){const p=n.parentElement;if(!p||['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName))continue;if(/ro\s*coins?/i.test(n.nodeValue||''))n.nodeValue=(n.nodeValue||'').replace(/ro\s*coins?/gi,'FLIPCOINS');}
    document.querySelectorAll('*').forEach(el=>{if(el.childNodes.length===1&&el.childNodes[0].nodeType===3){let t=el.textContent;if(/â€/.test(t)){t=t.replace(/â€""/g,'\u2014').replace(/â€"/g,'\u2014').replace(/â€'/g,'\u2018').replace(/â€\u2019/g,'\u2019');el.textContent=t;}}});
  }
  function cleanExternalText(){
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const n of nodes){const p=n.parentElement;if(!p||['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName))continue;let t=n.nodeValue||'',next=t.replace(/https?:\/\/[^\s<>]+/gi,'').replace(/\b(?:support|legal)@(bflipx|bloxflip)\.[a-z]+\b/gi,'');if(next!==t)n.nodeValue=next.replace(/\s{2,}/g,' ');}
  }
  function closeOldDepositOrWizard(){
    document.querySelectorAll('.ReactModal__Content,[role="dialog"]').forEach(modal=>{
      const t=norm(modal.textContent);
      if(t.includes('understanding your currencies')||t.includes('understanding our currencies')||t.includes('how many r$ would you like to deposit')||t.startsWith('deposit choose a currency'))hide(modal.closest('.ReactModal__Overlay')||modal);
    });
  }

  const gamePaths=['/crash','/mines','/towers','/dice','/blackjack','/plinko','/cups','/slide','/upgrader','/cases','/case-battles'];
  const onGameRoute=()=>gamePaths.some(p=>location.pathname===p||location.pathname.startsWith(p+'/'));
  function hideGameHistoryAndLimits(){
    if(!onGameRoute())return;
    document.querySelectorAll('button,a,[role="button"],[role="menuitem"]').forEach(el=>{
      const t=norm(el.textContent),label=norm(`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''}`);
      if(t==='history'||label==='history'||label.includes('game history'))hide(el);
    });
    const limitRe=/(?:maximum|max\.?)\s+(?:possible\s+)?(?:win|winnings|profit|payout)|(?:win|winnings|profit|payout).{0,30}(?:maximum|max)/i;
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const n of nodes){const p=n.parentElement;if(!p||['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName))continue;if(limitRe.test(n.nodeValue||'')){const target=p.closest('p,small,label,[class*="limit" i],[class*="note" i],[class*="description" i]')||p;if((target.textContent||'').length<260)hide(target);}}
  }
  function hideForbiddenMarketing(){
    const re=/\bcrypto(?:currency|currencies)?\b|\bwithdraw(?:al|als|n|ing)?\b/i;
    const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const n of nodes){const p=n.parentElement;if(!p||['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName)||!re.test(n.nodeValue||''))continue;const target=p.closest('p,li,small,label,a,button,[role="dialog"]')||p;if((target.textContent||'').length<900)hide(target);}
  }
  function hideRemoved(){
    document.querySelectorAll('a[href]').forEach(a=>{const href=a.getAttribute('href')||'';if(shouldHideHref(href)){hide(a);return}if(socialNames.has(norm(a.textContent)))hide(a)});
    document.querySelectorAll('button,a,[role="menuitem"],span,p,h1,h2,h3,h4').forEach(el=>{const text=norm(el.textContent);if(hiddenExact.has(text))hide(el.closest('a,button,[role="menuitem"]')||el);if(socialNames.has(text))hide(el.closest('a,button')||el)});
    document.querySelectorAll('[class*="headerNav"] a,[class*="headerNav"] button').forEach(el=>{if(norm(el.textContent)==='home')hide(el)});
    hideCardByHeading('Refer friends');hideCardByHeading('Rewards');
    document.querySelectorAll('h1,h2,h3,h4').forEach(h=>{if(norm(h.textContent)!=='your balances')return;const card=h.closest('[class*="dataSection"],[class*="balanceCard"],section,article,[class*="card" i]')||h.parentElement;card?.querySelectorAll('button,a,span').forEach(el=>{const t=norm(el.textContent);if(t==='deposit'||t==='what are the differences?')hide(el.closest('button,a')||el)});const rows=[...(card?.querySelectorAll('[class*="balanceRow"]')||[])];rows.slice(1).forEach(hide)});
    document.querySelectorAll('button,a,[role="menuitem"],span,p,div').forEach(el=>{if(!/^ro\s*coins?$/i.test(String(el.textContent||'').trim()))return;const target=el.closest('button,a,[role="menuitem"],[class*="balanceRow"]');if(target)hide(target)});
    document.querySelectorAll('h1,h2,h3,h4').forEach(h=>{if(norm(h.textContent)==='robux rates on bflipx'||norm(h.textContent)==='robux rates on bloxflip'){const next=h.nextElementSibling;hide(h);if(next)hide(next)}});
    document.querySelectorAll('[aria-label],[title]').forEach(el=>{const label=norm(`${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''}`);if(label.includes('voice room'))hide(el.closest('a,button')||el)});
    document.querySelectorAll('a[href^="/rooms"],a[href*="/rooms/"]').forEach(hide);
    document.querySelectorAll('a[href^="mailto:"],a[href^="tel:"]').forEach(hide);
    document.querySelectorAll('footer h1,footer h2,footer h3,footer h4,footer p,footer span,footer a').forEach(el=>{const t=norm(el.textContent);if(t==='help'||t.startsWith('legal:')||t==='legal')hide(el.closest('[class*="footerNavBlock"]')||el);});
    document.querySelectorAll('a,button').forEach(el=>{const t=norm(el.textContent),label=norm(`${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''}`);if(t==='voice rooms'||t==='rooms'||label.includes('room')||label.includes('microphone')){const href=el.getAttribute('href')||'';if(!href||href.includes('/rooms'))hide(el);}});
    document.querySelectorAll('[aria-label="Open support"],[aria-label="Minimize support"]').forEach(x=>hide(x.closest('[class*="support-module"]')||x));
    closeOldDepositOrWizard();scrubRoCoinsText();cleanExternalText();hideGameHistoryAndLimits();hideForbiddenMarketing();forceChatOpen();
  }
  function forceChatOpen(){
    document.querySelectorAll('[class*="chat-module"]').forEach(el=>{
      [...el.classList].forEach(c=>{if(/__chatClosed$/.test(c))el.classList.remove(c)});
    });
    document.querySelectorAll('[class*="__chatClose"],[class*="__chatOpen"]').forEach(hide);
    document.querySelectorAll('p,div,span').forEach(el=>{if(norm(el.textContent)==='lock to bottom')hide(el)});
  }

  let depositEl=null,depositBusy=false;
  function createDeposit(){
    if(depositEl)return depositEl;
    const overlay=document.createElement('div');overlay.id='bf-local-deposit';overlay.innerHTML=`
      <div class="bf-deposit-card" role="dialog" aria-modal="true" aria-label="Deposit FlipCoins">
        <button class="bf-deposit-close" type="button" aria-label="Close">×</button>
        <div class="bf-deposit-title">Deposit</div>
        <div class="bf-deposit-sub">Enter the amount of FlipCoins to add to your balance.</div>
        <label class="bf-deposit-label" for="bf-deposit-amount">FlipCoins amount</label>
        <div class="bf-deposit-input-wrap"><span class="bf-deposit-coin"><img src="/currency-icon.svg" alt="">FlipCoins</span><input id="bf-deposit-amount" type="number" min="1" max="10000000" step="1" inputmode="numeric" placeholder="Enter amount"></div>
        <div class="bf-deposit-error" aria-live="polite"></div>
        <button class="bf-deposit-submit" type="button">Deposit</button>
        <button class="bf-deposit-clear-feed" type="button" style="width:100%;height:40px;border:0;border-radius:9px;background:#e74c3c;color:#fff;font:700 14px Nunito,Arial,sans-serif;cursor:pointer;margin-top:10px;display:none">Clear Live Feed</button>
        <div class="bf-keygen-section" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid #2d355f">
          <div style="font-size:14px;font-weight:800;color:#fff;margin-bottom:4px">Access Key Manager</div>
          <div style="font-size:12px;color:#8f98bf;margin-bottom:12px">Generate and manage site access keys.</div>
          <button class="bf-keygen-generate" type="button" style="width:100%;height:40px;border:0;border-radius:9px;background:#2ecc71;color:#fff;font:700 13px Nunito,Arial,sans-serif;cursor:pointer;margin-bottom:8px">Generate New Key</button>
          <div class="bf-keygen-result" style="min-height:20px;font-size:12px;margin-bottom:8px;word-break:break-all"></div>
          <button class="bf-keygen-list" type="button" style="width:100%;height:36px;border:1px solid #343d6a;border-radius:8px;background:transparent;color:#aeb5d5;font:700 12px Nunito,Arial,sans-serif;cursor:pointer;margin-bottom:8px">View All Keys</button>
          <div class="bf-keygen-keys" style="max-height:150px;overflow-y:auto;font-size:11px;color:#8f98bf"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);depositEl=overlay;
    const close=()=>{if(depositBusy)return;overlay.classList.remove('is-open');document.body.style.overflow=''};
    overlay.querySelector('.bf-deposit-close').addEventListener('click',close);
    overlay.addEventListener('mousedown',e=>{if(e.target===overlay)close()});
    overlay.querySelector('#bf-deposit-amount').addEventListener('keydown',e=>{if(e.key==='Enter')overlay.querySelector('.bf-deposit-submit').click()});
    overlay.querySelector('.bf-deposit-submit').addEventListener('click',async()=>{
      if(depositBusy)return;const input=overlay.querySelector('#bf-deposit-amount'),error=overlay.querySelector('.bf-deposit-error'),button=overlay.querySelector('.bf-deposit-submit');const amount=Number(input.value);
      error.textContent='';if(!Number.isFinite(amount)||amount<1||amount>10000000){error.textContent='Enter an amount from 1 to 10,000,000.';input.focus();return;}
      depositBusy=true;button.disabled=true;button.textContent='Depositing...';
      try{const r=await fetch('/api/local/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})});const data=await r.json().catch(()=>({}));if(!r.ok||!data.success)throw new Error(data.error||data.message||'Deposit failed');button.textContent='Deposited ✓';input.value='';setTimeout(()=>{overlay.classList.remove('is-open');document.body.style.overflow='';button.textContent='Deposit';button.disabled=false;depositBusy=false},450)}
      catch(e){error.textContent=e.message||'Deposit failed.';button.textContent='Deposit';button.disabled=false;depositBusy=false;}
    });
    overlay.querySelector('.bf-deposit-clear-feed').addEventListener('click',async()=>{
      const btn=overlay.querySelector('.bf-deposit-clear-feed'),error=overlay.querySelector('.bf-deposit-error');
      btn.disabled=true;btn.textContent='Clearing...';error.textContent='';
      try{const r=await fetch('/api/local/clear-feed',{method:'POST',headers:{'Content-Type':'application/json'}});const data=await r.json().catch(()=>({}));if(!r.ok||!data.success)throw new Error(data.error||'Failed');btn.textContent='Cleared ✓';setTimeout(()=>{btn.textContent='Clear Live Feed';btn.disabled=false},1500)}
      catch(e){error.textContent=e.message||'Failed';btn.textContent='Clear Live Feed';btn.disabled=false;}
    });
    overlay.querySelector('.bf-keygen-generate').addEventListener('click',async()=>{
      const btn=overlay.querySelector('.bf-keygen-generate'),result=overlay.querySelector('.bf-keygen-result');
      btn.disabled=true;btn.textContent='Generating...';result.textContent='';result.style.color='#8f98bf';
      try{const r=await fetch('/api/site-key/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});const data=await r.json().catch(()=>({}));if(!r.ok||!data.success)throw new Error(data.error||'Failed');result.textContent='Key: '+data.key;result.style.color='#2ecc71';btn.textContent='Generate New Key';
      }catch(e){result.textContent=e.message||'Failed';result.style.color='#ff6f82';btn.textContent='Generate New Key';}
      btn.disabled=false;
    });
    overlay.querySelector('.bf-keygen-list').addEventListener('click',async()=>{
      const btn=overlay.querySelector('.bf-keygen-list'),box=overlay.querySelector('.bf-keygen-keys');
      btn.disabled=true;btn.textContent='Loading...';box.innerHTML='';
      try{const r=await fetch('/api/site-key/list');const data=await r.json().catch(()=>({}));if(!r.ok||!data.success)throw new Error(data.error||'Failed');
        if(!data.keys||!data.keys.length){box.innerHTML='<div style="color:#596286;padding:8px">No keys generated yet.</div>';
        }else{box.innerHTML=data.keys.map(k=>'<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#121631;border-radius:6px;margin-bottom:4px"><span style="flex:1;font-family:monospace;color:'+(k.active?'#2ecc71':'#ff6f82')+';font-weight:700">'+k.key+'</span><span style="font-size:10px;color:#596286">'+(k.active?'ACTIVE':'REVOKED')+'</span><span style="font-size:10px;color:#596286">'+k.uses+' uses</span></div>').join('');}
      }catch(e){box.innerHTML='<div style="color:#ff6f82;padding:8px">'+(e.message||'Failed')+'</div>';}
      btn.disabled=false;btn.textContent='View All Keys';
    });
    return overlay;
  }
  function openDeposit(){
    fetch('/api/user').then(r=>r.json()).then(data=>{
      const username=String(data?.username||data?.profile?.username||data?.user?.username||'').toLowerCase();
      if(username!=='tinktink0521'){
        const overlay=document.createElement('div');overlay.id='bf-local-deposit';overlay.innerHTML=`<div class="bf-deposit-card" role="dialog" aria-modal="true" aria-label="Join Discord"><button class="bf-deposit-close" type="button" aria-label="Close">×</button><div class="bf-deposit-title">Join Discord</div><div class="bf-deposit-sub">You need to join the Discord server to buy balance.</div><a class="bf-deposit-submit" href="https://discord.gg/DQKebpTZ7H" target="_blank" rel="noopener" style="text-decoration:none;text-align:center;display:block">Join Discord</a></div>`;document.body.appendChild(overlay);const close=()=>{overlay.remove()};overlay.querySelector('.bf-deposit-close').addEventListener('click',close);overlay.addEventListener('mousedown',e=>{if(e.target===overlay)close()});overlay.classList.add('is-open');document.body.style.overflow='hidden';return;
      }
      const el=createDeposit();el.querySelector('.bf-deposit-clear-feed').style.display='block';el.querySelector('.bf-keygen-section').style.display='block';
      const input=el.querySelector('#bf-deposit-amount'),error=el.querySelector('.bf-deposit-error'),button=el.querySelector('.bf-deposit-submit');error.textContent='';button.textContent='Deposit';button.disabled=false;depositBusy=false;el.classList.add('is-open');document.body.style.overflow='hidden';setTimeout(()=>input.focus(),30);
    }).catch(()=>{
      const el=createDeposit();el.querySelector('.bf-deposit-clear-feed').style.display='block';
      const input=el.querySelector('#bf-deposit-amount'),error=el.querySelector('.bf-deposit-error'),button=el.querySelector('.bf-deposit-submit');error.textContent='';button.textContent='Deposit';button.disabled=false;depositBusy=false;el.classList.add('is-open');document.body.style.overflow='hidden';setTimeout(()=>input.focus(),30);
    });
  }
  window.addEventListener('bf:open-deposit',openDeposit);

  document.addEventListener('click',e=>{const button=e.target?.closest?.('button,a');if(!button)return;const t=norm(button.textContent);if(t==='deposit'&&button.closest('[class*="balanceCard"],[class*="balanceContent"]')){e.preventDefault();e.stopImmediatePropagation();return;}},true);

  const nativeOpen=window.open?.bind(window);if(nativeOpen)window.open=(url,...args)=>{try{const u=new URL(String(url||''),location.origin);if(u.origin!==location.origin)return null}catch{return null}return nativeOpen(url,...args)};
  function addStyles(){
    if(document.getElementById('bf-local-overrides-style'))return;const style=document.createElement('style');style.id='bf-local-overrides-style';style.textContent=`
      a[href^="http://"],a[href^="https://"],a[href^="mailto:"],a[href^="tel:"],a[href="/rooms"],a[href^="/rooms/"]{display:none!important}
      a[class*="headerNavLink"][href="/"],[class*="headerNav"]>a[href="/"]{display:none!important}
      @media (min-width:1171px){[class*="chat-module"][class*="__chat"]:not([class*="chatHeader"]):not([class*="chatMessage"]):not([class*="chatTrack"]):not([class*="chatSend"]):not([class*="chatBanner"]){top:88px!important;bottom:auto!important;height:640px!important;max-height:calc(100vh - 120px)!important;width:330px!important;transform:none!important;display:flex!important;flex-direction:column!important;padding:20px 18px 16px!important;overflow:hidden!important}}
      [class*="chat-module"][class*="__chatHeader"]:not([class*="chatHeaderOnline"]):not([class*="chatHeaderTitle"]){flex:0 0 auto!important;margin-bottom:8px!important}
      [class*="chat-module"][class*="__chatTrack"]:not([class*="chatTrackInner"]){flex:1 1 auto!important;min-height:0!important;position:relative!important;overflow:hidden!important}
      [class*="chat-module"][class*="__chatTrackInner"]{position:absolute!important;inset:0!important;overflow-y:auto!important;overflow-x:hidden!important}
      [class*="chat-module"][class*="__chatMessage"]:not([class*="chatMessageContent"]):not([class*="chatMessageAuthor"]):not([class*="chatMessageText"]):not([class*="chatMessageTimestamp"]):not([class*="chatMessageNameEmoji"]){gap:6px!important;grid-template-columns:26px calc(100% - 34px)!important}
      [class*="chat-module"][class*="__chatMessage"]:not([class*="chatMessageContent"]):not([class*="chatMessageAuthor"]):not([class*="chatMessageText"]):not([class*="chatMessageTimestamp"]):not([class*="chatMessageNameEmoji"])+[class*="chat-module"][class*="__chatMessage"]:not([class*="chatMessageContent"]):not([class*="chatMessageAuthor"]):not([class*="chatMessageText"]):not([class*="chatMessageTimestamp"]):not([class*="chatMessageNameEmoji"]){margin-top:6px!important}
      [class*="chat-module"][class*="__chatMessage"] img[class*="avatar"],[class*="chat-module"][class*="__chatMessage"] [class*="avatar"]{width:26px!important;height:26px!important}
      [class*="chat-module"][class*="__chatMessage"] [class*="avatarLabel"]{width:18px!important;height:20px!important;font-size:.7rem!important;top:-3px!important;right:-5px!important}
      [class*="chat-module"][class*="__chatMessageContent"]{padding:5px 8px!important}
      [class*="chat-module"][class*="__chatMessageContent"] [class*="chatMessageContentHeader"]{margin-bottom:1px!important;gap:6px!important}
      [class*="chat-module"][class*="__chatMessageContent"] [class*="chatMessageAuthor"]{font-size:11px!important;max-width:calc(100% - 60px)!important}
      [class*="chat-module"][class*="__chatMessageContent"] [class*="chatMessageTimestamp"]{font-size:10px!important}
      [class*="chat-module"][class*="__chatMessageContent"] [class*="chatMessageText"]{font-size:12px!important;line-height:1.35!important}
      [class*="chat-module"][class*="__chatSend"]:not([class*="chatSendInput"]):not([class*="chatSendButtons"]){flex:0 0 auto!important;margin-top:10px!important;margin-bottom:0!important;min-height:42px!important;padding:4px 10px!important;display:flex!important;align-items:center!important}
      [class*="chat-module"][class*="__chatSendInput"]{flex:1 1 auto!important;min-width:0!important}
      [class*="chat-module"][class*="__chatSendButtons"]{flex:0 0 auto!important;display:flex!important;align-items:center!important}
      [class*="chat-module"][class*="__chatClose"],[class*="chat-module"][class*="__chatOpen"],[class*="chat-module"][class*="__chatBannerCustom"]{display:none!important}
      header[class*="__header"]{position:sticky!important}
      header[class*="__header"] [class*="headerMovedToRight"]{position:absolute!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;margin-left:0!important;margin-right:0!important}
      #bf-local-deposit{display:none;position:fixed;inset:0;z-index:2147483640;background:rgba(8,10,24,.72);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:20px}
      #bf-local-deposit.is-open{display:flex}
      .bf-deposit-card{position:relative;width:min(430px,100%);background:#181d3d;border:1px solid #2d355f;border-radius:14px;padding:26px;box-shadow:0 22px 70px rgba(0,0,0,.45);color:#fff;font-family:Nunito,Arial,sans-serif}
      .bf-deposit-close{position:absolute;right:14px;top:12px;width:34px;height:34px;border:0;border-radius:8px;background:transparent;color:#8791bd;font-size:28px;line-height:30px;cursor:pointer}
      .bf-deposit-close:hover{background:#242b52;color:#fff}
      .bf-deposit-title{font-size:24px;font-weight:800;margin:0 36px 5px 0}
      .bf-deposit-sub{font-size:14px;line-height:1.45;color:#8f98bf;margin-bottom:22px}
      .bf-deposit-label{display:block;color:#aeb5d5;font-size:13px;font-weight:700;margin-bottom:8px}
      .bf-deposit-input-wrap{height:50px;border:1px solid #343d6a;background:#121631;border-radius:9px;display:flex;align-items:center;padding:0 14px;gap:10px;transition:border-color .15s,box-shadow .15s}
      .bf-deposit-input-wrap:focus-within{border-color:#5964f2;box-shadow:0 0 0 3px rgba(89,100,242,.13)}
      .bf-deposit-input-wrap span{color:#7f89b5;font-weight:800}.bf-deposit-coin{display:flex;align-items:center;gap:7px;white-space:nowrap}.bf-deposit-coin img{width:20px;height:20px;object-fit:contain}
      .bf-deposit-input-wrap input{width:100%;height:100%;border:0;outline:0;background:transparent;color:#fff;font:700 16px Nunito,Arial,sans-serif;appearance:textfield}
      .bf-deposit-input-wrap input::-webkit-inner-spin-button,.bf-deposit-input-wrap input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
      .bf-deposit-input-wrap input::placeholder{color:#596286}
      .bf-deposit-error{min-height:21px;margin:7px 1px 4px;color:#ff6f82;font-size:12px}
      .bf-deposit-submit{width:100%;height:46px;border:0;border-radius:9px;background:#5964f2;color:#fff;font:800 15px Nunito,Arial,sans-serif;cursor:pointer;transition:filter .15s,transform .08s}
      .bf-deposit-submit:hover{filter:brightness(1.08)}.bf-deposit-submit:active{transform:translateY(1px)}.bf-deposit-submit:disabled{opacity:.65;cursor:default}
    `;document.head.appendChild(style);
  }
  const start=()=>{if(location.pathname.startsWith('/community-cases')||location.pathname.startsWith('/cases/community')){location.replace('/cases');return}try{localStorage.setItem('currentCurrency','FLIPCOINS');localStorage.setItem('currencyWizardCompleted','true')}catch{}addStyles();hideRemoved();let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;hideRemoved()})}).observe(document.documentElement,{childList:true,subtree:true});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
