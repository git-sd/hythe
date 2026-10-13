// feature: claude (main process). Optional ONLINE provider. Off by default and off again at every start.
// The user's own API key is stored only through Electron safeStorage and never leaves this process:
// the renderer can set it, clear it and ask whether one exists, but can never read it back.
// Channels: feat:claude:state setKey clearKey setEnabled test. Event: feat:claude:state.
const claude = require('../claude');

let electronSafe = null;
try { electronSafe = require('electron').safeStorage || null; } catch { /* plain node */ }

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;

module.exports = function (ctx) {
  const safe = ctx.safeStorage || electronSafe;
  const cfg = () => ctx.featureSettings('claude') || {};
  let enabled = false;   // memory only: never persisted, so Faber always starts offline

  function canEncrypt() {
    try {
      if (!safe || !safe.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && typeof safe.getSelectedStorageBackend === 'function' && /basic_text|unknown/.test(safe.getSelectedStorageBackend())) return false;
      return true;
    } catch { return false; }
  }
  function readKey() {
    const enc = cfg().keyEnc;
    if (!enc) return null;
    try { return safe.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
  }
  const state = () => ({
    enabled, hasKey: !!cfg().keyEnc, keyTail: cfg().keyTail || '', canEncrypt: canEncrypt(),
    models: claude.MODELS.map((m) => ({ ...m, name: claude.PREFIX + m.id })),
  });
  const push = () => { ctx.send('feat:claude:state', state()); return state(); };

  claude.configure({ getKey: () => (enabled ? readKey() : null), enabled: () => enabled });

  const H = ctx.handle;
  H('feat:claude:state', () => state());
  H('feat:claude:setKey', (key) => {
    key = String(key || '').trim();
    if (!KEY_RE.test(key)) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-). Create one at console.anthropic.com.');
    if (!canEncrypt()) throw new Error('Secure storage (Windows DPAPI) is not available here, so Faber will not save an API key. Keys are never stored in plain text.');
    ctx.setFeatureSettings('claude', { keyEnc: safe.encryptString(key).toString('base64'), keyTail: key.slice(-4) });
    return push();
  });
  H('feat:claude:clearKey', () => {
    ctx.setFeatureSettings('claude', { keyEnc: '', keyTail: '' });
    enabled = false;
    return push();
  });
  H('feat:claude:setEnabled', (on) => {
    on = !!on;
    if (on && !cfg().keyEnc) throw new Error('Add your API key first.');
    enabled = on;
    return push();
  });
  H('feat:claude:test', async () => {
    const key = readKey();
    if (!key) return { ok: false, error: 'No API key is saved.' };
    return claude.testKey(key);
  });

  // Only a test hook may point the provider somewhere else; user input can never change the address.
  if (process.env.FABER_CLAUDE_BASE_URL) claude.configure({ baseUrl: process.env.FABER_CLAUDE_BASE_URL });
};
