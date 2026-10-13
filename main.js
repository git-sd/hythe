const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const { spawn } = require('child_process');
let pty = null;
try { pty = require('@lydell/node-pty'); } catch (e) { console.error('node-pty unavailable:', e.message); }
const path = require('path');
const fs = require('fs');
const os = require('os');
const createAuth = require('./src/auth');
const loadFeatures = require('./src/features');
const tools = require('./src/tools');
const { createAgent } = require('./src/agent');

const DEFAULTS = {
  model: 'qwen3.5:9b', effort: 'medium', mode: 'ask',
  host: 'http://127.0.0.1:11434', accent: '#8b5cf6',
  workspace: '',     // open project folder ('' = none)
  recent: [], showHidden: false, features: {}, hostRemote: false, extraSystem: '', numCtx: 16384,
};

let win, auth, agent, settings, settingsFile;
const terms = new Map();
let termSeq = 0;
const REQUIRE_LOGIN = false; // flip to true to re-enable the offline login screen
const pendingApprovals = new Map();
let pullAbort = null;

const send = (channel, payload) => {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch { /* window is closing */ }
};
const loadSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const folderOpen = () => !!settings.workspace && fs.existsSync(settings.workspace);
const publicSettings = () => ({ ...settings, home: os.homedir(), platform: process.platform });

// What the agent uses: file tools are always confined to the open folder (none open = no tools).
function effective() {
  const hasFolder = folderOpen();
  return { ...settings, hasFolder, workspace: hasFolder ? settings.workspace : os.homedir(), sandbox: true };
}

// Watch the open folder so the editor and file tree follow changes made by anything:
// the AI's tools, commands it runs, or programs in the terminal (e.g. claude).
let watcher = null;
const watchTimers = new Map();
const IGNORED = /(^|[\\/])(node_modules|\.git|\.venv|__pycache__|dist|build)([\\/]|$)/;
function watchWorkspace() {
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  if (!folderOpen()) return;
  try {
    watcher = fs.watch(settings.workspace, { recursive: true }, (_evt, name) => {
      if (!name || IGNORED.test(String(name))) return;
      const abs = path.join(settings.workspace, String(name));
      clearTimeout(watchTimers.get(abs));
      watchTimers.set(abs, setTimeout(() => {
        watchTimers.delete(abs);
        send('fs:changed', { path: abs, exists: fs.existsSync(abs) });
      }, 120));
    });
    watcher.on('error', () => {});
  } catch { /* folder not watchable; editor still updates on AI edits */ }
}

// What features get. See docs/EXTENDING.md.
function featureCtx(dataDir) {
  return {
    dataDir,
    app, dialog, tools, os, fs, path,
    window: () => win,
    send,
    handle: (channel, fn) => {
      if (!String(channel).startsWith('feat:')) throw new Error('Feature channels must start with "feat:"');
      handle(channel, fn);
    },
    getSettings: () => settings,
    effective: () => effective(),
    workspace: () => (folderOpen() ? settings.workspace : ''),
    featureSettings: (name) => (settings.features || {})[name] || {},
    setFeatureSettings: (name, patch) => {
      settings.features = { ...(settings.features || {}), [name]: { ...((settings.features || {})[name] || {}), ...patch } };
      saveSettings();
      return settings.features[name];
    },
    // Local engine only unless remote is true (the user explicitly chose a remote server).
    setHost: (url, remote = false) => {
      if (!remote && !isLoopback(url)) throw new Error('Only localhost is allowed unless the remote option is used.');
      settings.host = url;
      settings.hostRemote = !!remote;
      saveSettings();
      send('feat:host-changed', { host: url, remote: !!remote });
      return publicSettings();
    },
    ollamaUp: () => ollamaUp(),
  };
}

function isLoopback(host) {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(host).hostname); } catch { return false; }
}

function denyAllApprovals() {
  for (const resolve of pendingApprovals.values()) resolve(false);
  pendingApprovals.clear();
}

function approve(kind, title, detail) {
  if (kind === 'edit' && settings.mode !== 'ask') return Promise.resolve(true);
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    pendingApprovals.set(id, resolve);
    send('chat:event', { type: 'approval', id, kind, title, detail });
  });
}

// Everything except login status/login/create requires an authenticated session.
function handle(channel, fn, { open = false } = {}) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (REQUIRE_LOGIN && !open && !auth.current()) throw new Error('Not logged in.');
    return fn(...args);
  });
}

async function ollamaUp() {
  try { return (await fetch(`${settings.host}/api/version`)).ok; } catch { return false; }
}

async function hasModel(name) {
  try {
    const r = await fetch(`${settings.host}/api/tags`);
    return (await r.json()).models.some((m) => m.name === name || m.name === name + ':latest');
  } catch { return false; }
}

// If the Ollama app is installed but not running, launch it and wait for it to come up.
async function ensureOllama() {
  if (await ollamaUp()) return;
  const appExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
  if (process.platform === 'win32' && fs.existsSync(appExe)) {
    const p = spawn(appExe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } else {
    const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {}); // not installed
    p.unref();
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ollamaUp()) return;
  }
  throw new Error('Ollama is not installed or did not start. Install it from ollama.com, then press Retry.');
}

async function doPull(name, onEvent) {
  if (pullAbort) throw new Error('A download is already running.');
  pullAbort = new AbortController();
  try {
    let r;
    try {
      r = await fetch(`${settings.host}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: pullAbort.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`Cannot reach Ollama at ${settings.host}.`);
    }
    if (!r.ok) {
      if (r.status === 412) throw new Error('Your Ollama is too old for this model. Update Ollama (run: winget upgrade Ollama.Ollama), then press Retry.');
      throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
    }
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        onEvent({ status: j.status, total: j.total, completed: j.completed });
      }
    }
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Download cancelled.' : e.message);
  } finally { pullAbort = null; }
}

function setupIpc() {
  handle('auth:status', () => ({ required: REQUIRE_LOGIN, hasUsers: auth.hasUsers(), user: auth.current() }), { open: true });
  handle('auth:create', async (u, p) => ({ user: await auth.createFirst(u, p) }), { open: true });
  handle('auth:login', async (u, p) => ({ user: await auth.login(u, p) }), { open: true });
  handle('auth:logout', () => {
    agent.stop(); agent.clear(); denyAllApprovals(); auth.logout();
  }, { open: true });
  handle('auth:adduser', (u, p) => auth.addUser(u, p));
  handle('auth:passwd', (o, n) => auth.changePassword(o, n));

  handle('settings:get', publicSettings);
  handle('settings:set', (patch) => {
    if (patch.host && !isLoopback(patch.host)) throw new Error('Only localhost addresses are allowed (offline mode).');
    delete patch.workspace; delete patch.recent; // folders change through folder:open / folder:close
    delete patch.host; delete patch.hostRemote;   // the host changes only through ctx.setHost
    const { features, ...rest } = patch;
    if (features) {
      settings.features = { ...(settings.features || {}) };
      for (const [k, v] of Object.entries(features)) settings.features[k] = { ...(settings.features[k] || {}), ...v };
    }
    settings = { ...settings, ...rest, features: settings.features };
    saveSettings();
    return publicSettings();
  });

  handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.workspace || os.homedir() });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('folder:open', (p) => {
    const abs = path.resolve(os.homedir(), String(p || '').replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
    settings.workspace = abs;
    settings.recent = [abs, ...settings.recent.filter((r) => r.toLowerCase() !== abs.toLowerCase())].slice(0, 8);
    saveSettings();
    watchWorkspace();
    return publicSettings();
  });
  handle('folder:close', () => {
    settings.workspace = '';
    saveSettings();
    watchWorkspace();
    return publicSettings();
  });

  handle('models:list', async () => {
    try {
      const r = await fetch(`${settings.host}/api/tags`);
      return { ok: true, names: (await r.json()).models.map((m) => m.name) };
    } catch { return { ok: false, names: [] }; }
  });

  // Only runs when the user clicks Download, /pull, or the first-run setup screen.
  handle('models:pull', (name) => doPull(name, (ev) => send('pull:progress', ev)));
  handle('models:pullCancel', () => { if (pullAbort) pullAbort.abort(); });

  // First-run setup: connect to the installed Ollama app, then download the model into it.
  handle('setup:status', async () => ({
    ready: (await ollamaUp()) && (await hasModel(settings.model)),
  }));
  handle('setup:run', async () => {
    const prog = (step, p) => send('setup:progress', { step, ...p });
    prog(1, { text: 'Connecting to Ollama…' });
    await ensureOllama();
    if (!(await hasModel(settings.model))) {
      await doPull(settings.model, (ev) => {
        const pct = ev.total ? (ev.completed || 0) / ev.total : null;
        prog(2, { text: `Downloading ${settings.model} into Ollama`, pct, bytes: ev.completed, total: ev.total });
      });
    }
  });
  handle('setup:cancel', () => { if (pullAbort) pullAbort.abort(); });

  handle('chat:send', (text) => { agent.send(text); });
  handle('chat:stop', () => { agent.stop(); denyAllApprovals(); });
  handle('chat:clear', () => agent.clear());
  handle('chat:compact', () => agent.compact());
  handle('chat:transcript', () => agent.transcript());
  handle('approval:respond', (id, ok) => {
    const r = pendingApprovals.get(id);
    if (r) { pendingApprovals.delete(id); r(!!ok); }
  });

  // Real terminals (PTY): run anything interactive, e.g. claude, python, vim, ssh.
  handle('term:open', (cols, rows) => {
    if (!pty) throw new Error('The terminal component is missing. Reinstall Faber.');
    const id = ++termSeq;
    const win32 = process.platform === 'win32';
    const cwd = folderOpen() ? settings.workspace : os.homedir();
    const p = pty.spawn(win32 ? 'powershell.exe' : (process.env.SHELL || 'bash'), win32 ? ['-NoLogo'] : [], {
      name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    terms.set(id, p);
    p.onData((data) => send('term:data', { id, data }));
    p.onExit(({ exitCode }) => { terms.delete(id); send('term:exit', { id, code: exitCode }); });
    return id;
  });
  handle('term:input', (id, data) => { terms.get(id)?.write(data); });
  handle('term:resize', (id, cols, rows) => {
    try { terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* already exited */ }
  });
  handle('term:close', (id) => {
    const p = terms.get(id);
    terms.delete(id);
    try { p?.kill(); } catch { /* already exited */ }
  });

  // Find in files (text or regex) across the open folder. Skips ignored folders, binaries and big files.
  handle('ws:search', async (opts = {}) => {
    if (!folderOpen()) throw new Error('Open a folder first.');
    const q = String(opts.query || '');
    if (!q) return { files: [], total: 0, truncated: false };
    const flags = opts.caseSensitive ? 'g' : 'gi';
    let re;
    try { re = new RegExp(opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch (e) { throw new Error('Invalid pattern: ' + e.message); }
    const exts = String(opts.include || '').split(/[,\s]+/).map((s) => s.replace(/^\*?\.?/, '').toLowerCase()).filter(Boolean);
    const MAX = 500;
    const files = [];
    let total = 0, truncated = false, seen = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (truncated) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!IGNORED.test(e.name)) await walk(abs); continue; }
        if (exts.length && !exts.includes(path.extname(e.name).slice(1).toLowerCase())) continue;
        if (++seen % 40 === 0) await new Promise((r) => setImmediate(r));
        let st;
        try { st = await fs.promises.stat(abs); } catch { continue; }
        if (st.size > 1024 * 1024) continue;
        let buf;
        try { buf = await fs.promises.readFile(abs); } catch { continue; }
        if (buf.subarray(0, 8000).includes(0)) continue;
        const matches = [];
        buf.toString('utf8').split('\n').forEach((line, i) => {
          if (truncated) return;
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m) {
            matches.push({ line: i + 1, col: m.index, len: m[0].length, text: line.replace(/\r$/, '').slice(0, 300) });
            if (++total >= MAX) truncated = true;
          }
        });
        if (matches.length) files.push({ path: abs, rel: path.relative(settings.workspace, abs), matches });
      }
    };
    await walk(settings.workspace);
    return { files, total, truncated };
  });

  handle('ws:list', (dir) => {
    const abs = path.resolve(dir);
    const items = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      items.push({ name: e.name, dir: e.isDirectory(), path: path.join(abs, e.name) });
    }
    return items.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  });
  handle('file:read', (p) => {
    const abs = path.resolve(p);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('Not a file.');
    if (st.size > 2 * 1024 * 1024) throw new Error('File is larger than 2 MB, not opened in the editor.');
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new Error('Binary file, not opened in the editor.');
    return { path: abs, text: buf.toString('utf8') };
  });
  handle('file:write', (p, text) => { fs.writeFileSync(path.resolve(p), String(text)); return true; });
  handle('ws:export', async (markdown) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(effective().workspace, 'faber-transcript.md') });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, markdown);
    return r.filePath;
  });
  handle('app:quit', () => app.quit());
}

// Offline enforcement: the renderer may only load local resources.
function lockdownNetwork() {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(file|data|blob|devtools|chrome-extension):/.test(details.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 600,
    backgroundColor: '#0d0b14', autoHideMenuBar: true, title: 'Faber',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // F5 / Ctrl+R would reload the whole window and wipe the chat. Reload the files instead.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key).toLowerCase();
    if (k === 'f5' || ((input.control || input.meta) && k === 'r')) { e.preventDefault(); send('app:reload'); }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  settingsFile = path.join(dataDir, 'settings.json');
  settings = loadSettings();
  // always start on the local engine; a remote host must be chosen again each session
  settings.hostRemote = false;
  if (!isLoopback(settings.host) || settings.host.endsWith(':11435')) settings.host = DEFAULTS.host;
  if (!folderOpen()) settings.workspace = '';
  watchWorkspace();
  auth = createAuth(dataDir);
  agent = createAgent({ getSettings: effective, approve, emit: (ev) => send('chat:event', ev) });
  lockdownNetwork();
  Menu.setApplicationMenu(null);   // Faber draws its own menu bar; the default one adds Ctrl+W (close window) etc.
  setupIpc();
  createWindow();
  loadFeatures(featureCtx(dataDir));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const p of terms.values()) { try { p.kill(); } catch { /* gone */ } } });
