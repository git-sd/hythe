// Browser test harness: runs the REAL renderer in Chromium (Playwright) against the REAL main.js and features.
// Electron is replaced by a small stand-in (windows, IPC, dialogs), so everything above that line is the shipped code.
// Not covered: Electron itself, the real PTY terminal, native dialogs, zoom. Use only for logic + DOM/CSS checks.
//   const h = await launch({ ollama: fake.url, workspace: dir, settings: {...} });  h.page, h.invoke, h.errors, h.close()
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function playwright() {
  try { return require('playwright'); } catch { /* fall through */ }
  const { execSync } = require('child_process');
  return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}

let booted = null;   // main.js can only be required once per process
async function launch(opts = {}) {
  const userData = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'faber-web-'));
  fs.mkdirSync(userData, { recursive: true });
  const settingsFile = path.join(userData, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    model: 'qwen3.5:9b', effort: 'low', mode: 'ask', ...(opts.ollama ? { host: opts.ollama } : {}),
    workspace: opts.workspace || '', ...(opts.settings || {}),
  }));

  // --- electron stand-in ---
  const handlers = new Map();
  const pushes = [];
  let pageSend = null;
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(), getPath: () => userData, quit() {}, isPackaged: false, getVersion: () => '0.0.0-test',
  });
  const dialogState = { open: null, save: null };
  const electron = {
    app,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    dialog: {
      showOpenDialog: async () => (dialogState.open ? { canceled: false, filePaths: [dialogState.open] } : { canceled: true, filePaths: [] }),
      showSaveDialog: async () => (dialogState.save ? { canceled: false, filePath: dialogState.save } : { canceled: true }),
    },
    session: { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {} } },
    Menu: { setApplicationMenu() {} },
    safeStorage: opts.safeStorage || {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('base64')),
      decryptString: (b) => Buffer.from(Buffer.from(b).toString().replace(/^enc:/, ''), 'base64').toString(),
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send: (ch, p) => { pushes.push([ch, p]); if (pageSend) pageSend(ch, p); }, setWindowOpenHandler() {}, on() {} }; }
      loadFile() {} isDestroyed() { return false; } on() {}
    },
  };
  if (booted) throw new Error('harness: launch() can only be called once per process');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === '@lydell/node-pty') throw new Error('node-pty not available in the web harness');
    return origLoad.call(this, request, ...rest);
  };
  require(path.join(ROOT, 'main.js'));
  booted = true;
  await new Promise((r) => setTimeout(r, 200));   // whenReady().then(...) runs on the next tick

  // --- static server for renderer/ ---
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, 'renderer', u === '/' ? 'index.html' : u);
    if (!f.startsWith(path.join(ROOT, 'renderer')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('no'); }
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const { chromium } = playwright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const invoke = async (ch, ...args) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error('No handler for ' + ch);
    return JSON.parse(JSON.stringify((await fn({}, ...args)) ?? null));
  };
  await page.exposeFunction('__invoke', async (ch, args) => {
    try { return { ok: true, v: await invoke(ch, ...args) }; } catch (e) { return { ok: false, e: e.message }; }
  });
  pageSend = (ch, p) => { page.evaluate(([c, d]) => window.__push && window.__push(c, d), [ch, p]).catch(() => {}); };
  // the real preload.js, run with a fake electron
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  await page.addInitScript(`(() => {
    const listeners = {};
    const ipcRenderer = {
      invoke: async (ch, ...a) => { const r = await window.__invoke(ch, a); if (!r.ok) throw new Error("Error invoking remote method '" + ch + "': Error: " + r.e); return r.v; },
      on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); },
    };
    window.__push = (ch, p) => { for (const cb of listeners[ch] || []) cb({}, p); };
    const contextBridge = { exposeInMainWorld: (n, o) => { window[n] = o; } };
    const webFrame = { setZoomFactor() {} };
    new Function('require', ${JSON.stringify(preload)})((m) => ({ contextBridge, ipcRenderer, webFrame }));
  })();`);

  const h = {
    page, errors, invoke, userData, base, dialogState, pushes, handlers,
    async open() { await page.goto(base); await page.waitForFunction(() => window.Faber && document.querySelector('#app') && !document.querySelector('#app').hidden, null, { timeout: 15000 }); },
    js: (fn, arg) => page.evaluate(fn, arg),
    async close() { await browser.close(); await new Promise((r) => server.close(r)); try { app.emit('before-quit'); } catch {} },
  };
  return h;
}

// tiny assertion helper that prints PASS/FAIL and keeps going
function checker() {
  const results = [];
  const check = (name, ok, extra) => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '')); };
  check.done = () => { const bad = results.filter((x) => !x).length; console.log(`\n${results.length - bad}/${results.length} passed`); return bad; };
  return check;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, arg, ms = 8000) {
  try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; }
}

module.exports = { launch, checker, sleep, waitFor, ROOT };
