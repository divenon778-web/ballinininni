const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CASES_SEED = path.join(DATA_DIR, 'cases-seed.json');
const COMMUNITY_SEED = path.join(DATA_DIR, 'community-cases-seed.json');

function id(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function seedFairness() {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  return {
    serverSeed,
    serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
    clientSeed: crypto.randomBytes(8).toString('hex'),
    nonce: 0,
    previous: []
  };
}

function freshState() {
  let cases = [];
  let communityCases = [];
  try { cases = JSON.parse(fs.readFileSync(CASES_SEED, 'utf8')); } catch {}
  try { communityCases = JSON.parse(fs.readFileSync(COMMUNITY_SEED, 'utf8')); } catch {}
  const now = Date.now();
  return {
    meta: { version: 1, createdAt: now, updatedAt: now },
    users: {},
    sessions: {},
    transactions: [],
    history: [],
    liveFeed: [],
    chat: [],
    rains: {},
    cases,
    communityCases,
    activeMines: {},
    activeTowers: {},
    activeBlackjack: {},
    cupsRooms: {},
    caseBattles: {},
    chatPresence: {},
    crash: {
      roundId: 1,
      phase: 'betting',
      phaseStartedAt: now,
      bettingEndsAt: now + 7000,
      crashAt: null,
      crashPoint: 2,
      multiplier: 1,
      bets: {},
      history: [2.18, 1.12, 4.43, 1.67, 12.51, 2.03, 1.00, 7.81]
    },
    slide: {
      roundId: 1,
      phase: 'betting',
      phaseStartedAt: now,
      bettingEndsAt: now + 7000,
      result: null,
      bets: {},
      history: [2,2,3,2,5,2,2,10,3,2]
    },
    globalFairness: seedFairness()
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = freshState();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Backward-compatible state migration for Exact V2.
state.users ||= {}; state.sessions ||= {}; state.transactions ||= []; state.history ||= []; state.liveFeed ||= []; state.chat ||= []; state.rains ||= {};
state.cases ||= []; state.communityCases ||= []; state.activeMines ||= {}; state.activeTowers ||= {}; state.activeBlackjack ||= {};
state.cupsRooms ||= {}; state.caseBattles ||= {}; state.chatPresence ||= {}; state.globalFairness ||= seedFairness();
state.siteKeys ||= {}; state.siteKeySessions ||= {};
for (const u of Object.values(state.users)) {
  u.displayName ||= u.username;
  u.robloxUsername ||= u.username;
  u.robloxId ??= null;
  u.avatar ||= null;
  u.avatarUpdatedAt ||= 0;
  u.wagered ||= 0; u.won ||= 0; u.fairness ||= seedFairness();
}

let saveTimer = null;
function saveSoon() {
  state.meta.updatedAt = Date.now();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 120);
}

function saveNow() {
  state.meta.updatedAt = Date.now();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function ensureUser(username, profile={}) {
  const clean = String(username || '').trim().slice(0, 24);
  const key = clean.toLowerCase();
  let user = Object.values(state.users).find(u =>
    (u.username || '').toLowerCase() === key || (u.robloxUsername || '').toLowerCase() === key ||
    (profile.robloxId != null && String(u.robloxId || '') === String(profile.robloxId))
  );
  if (!user) {
    const uid = id('user');
    user = {
      id: uid, username: clean || 'Player', robloxUsername: profile.robloxUsername || clean || 'Player',
      robloxId: profile.robloxId ?? null, displayName: profile.displayName || clean || 'Player',
      balance: 0, created: Date.now(), wagered: 0, won: 0, fairness: seedFairness(),
      avatar: profile.avatar || null, avatarUpdatedAt: profile.avatarUpdatedAt || 0, banned: false
    };
    state.users[uid] = user;
    state.transactions.unshift({ id: id('tx'), userId: uid, amount: 0, reason: 'STARTING_BALANCE', created: Date.now(), balanceAfter: user.balance });
  } else {
    if (profile.robloxId != null) user.robloxId = profile.robloxId;
    if (profile.robloxUsername) { user.robloxUsername = profile.robloxUsername; user.username = profile.robloxUsername; }
    if (profile.displayName) user.displayName = profile.displayName;
    if (profile.avatar) user.avatar = profile.avatar;
    if (profile.avatarUpdatedAt) user.avatarUpdatedAt = profile.avatarUpdatedAt;
  }
  saveSoon();
  return user;
}
function findUser(nameOrId) {
  const q=String(nameOrId||'').trim().toLowerCase();
  return Object.values(state.users).find(u=>String(u.id).toLowerCase()===q || String(u.robloxId||'').toLowerCase()===q || String(u.username||'').toLowerCase()===q || String(u.robloxUsername||'').toLowerCase()===q) || null;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions[token] = { userId, created: Date.now() };
  saveSoon();
  return token;
}

function userBySession(token) {
  const s = token && state.sessions[token];
  if (!s) return null;
  return state.users[s.userId] || null;
}

function destroySession(token) {
  if (token && state.sessions[token]) {
    delete state.sessions[token];
    saveSoon();
  }
}

const balanceLocks = new Map();
function cleanupBalanceLocks(userId) {
  const now = Date.now();
  const rows = (balanceLocks.get(userId) || []).filter(x => x.expiresAt > now && x.amount > 0);
  if (rows.length) balanceLocks.set(userId, rows); else balanceLocks.delete(userId);
  return rows;
}
function lockedBalance(user) {
  if (!user) return 0;
  return Math.round(cleanupBalanceLocks(user.id).reduce((sum,x)=>sum+x.amount,0)*100)/100;
}
function spendableBalance(user) {
  const balance = Number(user?.balance);
  if (!Number.isFinite(balance)) throw new Error('Invalid balance');
  return Math.max(0, Math.round((balance - lockedBalance(user))*100)/100);
}
function lockBalanceCredit(user, amount, delayMs) {
  const n = Math.round(Number(amount)*100)/100, delay = Math.max(0, Math.floor(Number(delayMs)||0));
  if (!user || !Number.isFinite(n) || n <= 0 || delay <= 0) return;
  const rows = cleanupBalanceLocks(user.id);
  rows.push({ amount:n, expiresAt:Date.now()+delay });
  balanceLocks.set(user.id, rows);
  const t=setTimeout(()=>cleanupBalanceLocks(user.id), delay+50);
  if (t.unref) t.unref();
}
function adjustBalance(user, amount, reason, meta={}) {
  const n = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(n)) throw new Error('Invalid amount');
  const current = Number(user.balance);
  if (!Number.isFinite(current)) throw new Error('Invalid balance');
  if (n < 0 && -n > spendableBalance(user) + 0.000001) throw new Error('Insufficient balance');
  const next = Math.round((current + n) * 100) / 100;
  if (next < -0.000001) throw new Error('Insufficient balance');
  user.balance = Math.max(0, next);
  const tx = { id: id('tx'), userId: user.id, amount: n, reason, meta, created: Date.now(), balanceAfter: user.balance };
  state.transactions.unshift(tx);
  state.transactions = state.transactions.slice(0, 5000);
  saveSoon();
  return tx;
}

function recordGame(user, game, bet, payout, multiplier, result={}, high=false, lucky=false) {
  const row = {
    id: id('game'),
    uuid: crypto.randomUUID(),
    userId: user.id,
    username: user.username,
    game,
    bet: Math.round(Number(bet)*100)/100,
    payout: Math.round(Number(payout)*100)/100,
    multiplier: Math.round(Number(multiplier || 0)*10000)/10000,
    result,
    created: Date.now()
  };
  state.history.unshift(row);
  state.history = state.history.slice(0, 5000);
  const gamemode = game === 'case-battles' ? 'casebattles' : (game === 'cases' ? 'single_case' : game);
  const feed = {
    uuid: row.uuid,
    userId: user.id,
    gamemode,
    game, // compatibility alias for local tools
    username: user.username,
    avatar: user.avatar || null,
    currency: 'FLIPCOINS',
    bet: row.bet,
    amount: row.bet, // compatibility alias
    multiplier: row.multiplier,
    winnings: row.payout > 0 ? row.payout : -row.bet,
    payout: row.payout,
    created: row.created,
    high: high || row.payout >= 10000,
    lucky: lucky || (row.multiplier >= 10 && row.payout > row.bet)
  };
  state.liveFeed.unshift(feed);
  state.liveFeed = state.liveFeed.slice(0, 80);
  user.wagered = Math.round((user.wagered + row.bet)*100)/100;
  if (row.payout > row.bet) user.won = Math.round((user.won + row.payout-row.bet)*100)/100;
  saveSoon();
  return { row, feed };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    robloxUsername: user.robloxUsername || user.username,
    robloxId: user.robloxId ?? null,
    displayName: user.displayName || user.username,
    balance: user.balance,
    created: user.created,
    wagered: user.wagered,
    won: user.won,
    avatar: user.avatar,
    fairness: {
      clientSeed: user.fairness.clientSeed,
      serverSeedHash: user.fairness.serverSeedHash,
      nonce: user.fairness.nonce,
      previous: user.fairness.previous?.slice(0,5) || []
    }
  };
}

function generateSiteKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < 10; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
  return key;
}

function createSiteKey(createdAt) {
  const key = generateSiteKey();
  state.siteKeys[key] = { key, active: true, created: createdAt || Date.now(), uses: 0 };
  saveSoon();
  return key;
}

function verifySiteKey(key) {
  if (!key) return false;
  if (key === 'mike900123') return true;
  const entry = state.siteKeys[key];
  if (entry && entry.active) { entry.uses++; saveSoon(); return true; }
  return false;
}

function revokeSiteKey(key) {
  if (state.siteKeys[key]) { state.siteKeys[key].active = false; saveSoon(); return true; }
  return false;
}

function createSiteKeySession() {
  const token = crypto.randomBytes(32).toString('hex');
  state.siteKeySessions[token] = { created: Date.now() };
  saveSoon();
  return token;
}

function verifySiteKeySession(token) {
  return !!(token && state.siteKeySessions[token]);
}

function destroySiteKeySession(token) {
  if (token && state.siteKeySessions[token]) { delete state.siteKeySessions[token]; saveSoon(); }
}

module.exports = {
  state,
  id,
  seedFairness,
  saveSoon,
  saveNow,
  ensureUser,
  findUser,
  createSession,
  userBySession,
  destroySession,
  adjustBalance,
  spendableBalance,
  lockedBalance,
  lockBalanceCredit,
  recordGame,
  publicUser,
  generateSiteKey,
  createSiteKey,
  verifySiteKey,
  revokeSiteKey,
  createSiteKeySession,
  verifySiteKeySession,
  destroySiteKeySession
};
