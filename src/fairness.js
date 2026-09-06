const crypto = require('crypto');

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function deriveHex(serverSeed, clientSeed, nonce, game, extra='') {
  return crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${game}:${extra}`)
    .digest('hex');
}

function hexFloat(hex) {
  const slice = hex.slice(0, 13);
  return parseInt(slice, 16) / 0x10000000000000;
}

function nextFloat(user, game, extra='') {
  const f = user.fairness;
  const nonce = f.nonce++;
  const hex = deriveHex(f.serverSeed, f.clientSeed, nonce, game, extra);
  return {
    value: hexFloat(hex),
    proof: { clientSeed: f.clientSeed, serverSeedHash: f.serverSeedHash, nonce, game, extra, hash: hex }
  };
}

function floatsForSeed(serverSeed, clientSeed, nonce, game, count=32) {
  const out=[];
  for (let i=0;i<count;i++) out.push(hexFloat(deriveHex(serverSeed, clientSeed, nonce, game, i)));
  return out;
}

function beginRound(user, game, count=64) {
  const f = user.fairness;
  const nonce = f.nonce++;
  return {
    values: floatsForSeed(f.serverSeed, f.clientSeed, nonce, game, count),
    proof: { clientSeed: f.clientSeed, serverSeedHash: f.serverSeedHash, nonce, game }
  };
}

function rotate(user, newClientSeed) {
  const old = {
    serverSeed: user.fairness.serverSeed,
    serverSeedHash: user.fairness.serverSeedHash,
    clientSeed: user.fairness.clientSeed,
    nonce: user.fairness.nonce,
    revealedAt: Date.now()
  };
  const serverSeed = crypto.randomBytes(32).toString('hex');
  user.fairness.previous = [old, ...(user.fairness.previous || [])].slice(0,8);
  user.fairness.serverSeed = serverSeed;
  user.fairness.serverSeedHash = hashSeed(serverSeed);
  user.fairness.clientSeed = (String(newClientSeed || '').trim() || crypto.randomBytes(8).toString('hex')).slice(0,64);
  user.fairness.nonce = 0;
  return old;
}

module.exports = { hashSeed, deriveHex, hexFloat, nextFloat, beginRound, rotate };
