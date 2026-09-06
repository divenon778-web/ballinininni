#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNKS = path.join(ROOT, 'public', '_next', 'static', 'chunks');
const files = fs.readdirSync(CHUNKS).filter(file => file.endsWith('.js')).map(file => path.join(CHUNKS, file));
let changed = 0;

function replaceChecked(file, needle, replacement, required = false) {
  let source = fs.readFileSync(file, 'utf8');
  if (replacement && source.includes(replacement)) return false;
  if (!source.includes(needle)) {
    if (required) throw new Error(`Expected frontend contract was not found in ${path.basename(file)}`);
    return false;
  }
  source = source.split(needle).join(replacement);
  fs.writeFileSync(file, source);
  changed++;
  return true;
}

// Remove Shop from the captured desktop/mobile profile menu arrays themselves.
for (const file of files) {
  replaceChecked(file, ',{title:"Shop",pageUrl:"shop",authedRoute:!0}', '');
}

// Keep the original profile page and markup, but expose only Transactions.
const profile = path.join(CHUNKS, '3ac39832ab3b6408.js');
replaceChecked(
  profile,
  'ex={transactions:0,deposits:1,withdrawals:2,settings:3,"buy-xp":4},ey={transactions:"Transactions",deposits:"Deposits",withdrawals:"Withdrawals",settings:"Settings","buy-xp":"Buy XP"}',
  'ex={transactions:0},ey={transactions:"Transactions"}',
  true
);

// Every captured route has its own Turbopack copy of the shared layout. Expose
// that route's real Redux store so the single local realtime adapter can feed
// server-authoritative wallet deltas into the existing WALLET_CHANGE reducer.
let storeCopies = 0;
const storeNeedle = 'u.default.dispatch((0,o.loadUser)());let e=async()=>';
const storeReplacement = 'globalThis.__BLOXFLIP_LOCAL_STORE__=u.default,u.default.dispatch((0,o.loadUser)());let e=async()=>';
for (const file of files) {
  if (fs.readFileSync(file, 'utf8').includes(storeReplacement)) storeCopies++;
  else if (replaceChecked(file, storeNeedle, storeReplacement)) storeCopies++;
}
if (storeCopies < 1) throw new Error('No shared layout Redux store copies were patched');

const realtime = path.join(CHUNKS, '66aefdd6807fa704.js');
replaceChecked(
  realtime,
  'dispatch(e,t){let s=this.handlers.get(e);if(s)for(let i of [...s])try{i(t)}catch(e){console.error("[LOCAL REALTIME] handler",e)}}',
  'dispatch(e,t){if("string"==typeof e&&e.startsWith("wallet:transactions#")){let e=()=>{let e=globalThis.__BLOXFLIP_LOCAL_STORE__;e?.dispatch?.({type:"WALLET_CHANGE",payload:{id:t?._id||t?.id,amount:Number(t?.amount)||0,currency:t?.currency||"FLIPCOINS"}})},s=Math.max(0,Number(t?.announceDelay||t?.delay)||0);s?setTimeout(e,s):e()}let s=this.handlers.get(e);if(s)for(let i of [...s])try{i(t)}catch(e){console.error("[LOCAL REALTIME] handler",e)}}',
  true
);

// The exported dynamic route shells have the right page component, but the
// local Next router can briefly expose an empty query during client-side
// navigation. The preserved pages must still load their identifier instead of
// rendering only the background / an endless loader.
const singleCase = path.join(CHUNKS, 'e15bc82a2ad73d96.js');
replaceChecked(
  singleCase,
  'J=E.query?.caseIdentifier,',
  'J=E.query?.caseIdentifier||("undefined"!=typeof window?decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop()||""):""),',
  true
);

const battlePage = path.join(CHUNKS, '1c99d7e8ae08d4fb.js');
replaceChecked(
  battlePage,
  'A=w.query.battleId,',
  'A=w.query.battleId||("undefined"!=typeof window?decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop()||""):""),',
  true
);

// The export did not contain profile.html even though the route loader and
// production profile component were present. Build a direct/F5 shell from an
// existing empty Next export shell and let the saved build manifest load the
// original /profile chunk.
const profileHtml = path.join(ROOT, 'public', 'profile.html');
const shellHtml = path.join(ROOT, 'public', 'plinko.html');
if (!fs.existsSync(profileHtml)) {
  const source = fs.readFileSync(shellHtml, 'utf8');
  const output = source.replace('"page":"/plinko"', '"page":"/profile"');
  if (output === source) throw new Error('Could not create the direct profile route shell');
  fs.writeFileSync(profileHtml, output);
  changed++;
}

console.log(`Patched ${changed} frontend chunk edits (${storeCopies} route store copies).`);
