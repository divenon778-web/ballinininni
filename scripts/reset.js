const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'data', 'state.json');
const avatars = path.join(__dirname, '..', 'public', 'local-avatars');
try {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  if (fs.existsSync(avatars)) for (const name of fs.readdirSync(avatars)) {
    const target = path.join(avatars, name);
    if (fs.statSync(target).isFile()) fs.unlinkSync(target);
  }
  console.log('BloxFlip MODDED v1.1 state and cached avatars reset. The next launch will create a fresh database.');
} catch (e) {
  console.error('Could not reset state:', e.message);
  process.exitCode = 1;
}
