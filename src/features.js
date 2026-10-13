// Loads every src/features/*.js. Each one exports a function (ctx) => void and registers its own
// IPC channels (names must start with "feat:"). A feature that throws is skipped, not fatal.
const fs = require('fs');
const path = require('path');

module.exports = function loadFeatures(ctx) {
  const dir = path.join(__dirname, 'features');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const name = file.replace(/\.js$/, '');
    try {
      const init = require(path.join(dir, file));
      if (typeof init === 'function') init({ ...ctx, name });
    } catch (e) {
      console.error(`feature ${name} failed to load:`, e);
    }
  }
};
