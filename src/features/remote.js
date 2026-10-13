// feature: remote. Opt-in remote compute: remote Ollama server (via a local authenticating relay), Colab/Kaggle
// notebook generator, and SSH (terminal, run on remote, fetch results, port forward). See docs/EXTENDING.md.
// Nothing here runs at startup except restoring the local engine. Data only leaves this PC after the
// user confirms in the consent modal (enforced here with a one-time token).
'use strict';
const crypto = require('crypto');
const os = require('os');
const fsx = require('fs');
const pathx = require('path');
let electronSafe = null;
try { electronSafe = require('electron').safeStorage || null; } catch { /* plain node (unit tests) */ }
const { normalizeUrl, classify, testServer, scanLan, lanPrefixes } = require('../remote/net');
const { createProxy } = require('../remote/proxy');
const { buildNotebook } = require('../remote/notebook');
const S = require('../remote/sshcmd');
const { scanFolder } = require('../remote/tar');
const R = require('../remote/sshrun');

const LOCAL_HOST = 'http://127.0.0.1:11434';

// Token vault around Electron safeStorage. Refuses (canEncrypt false) when the OS cannot encrypt.
function makeVault(safeStorage, platform) {
  function canEncrypt() {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      if (platform === 'linux' && safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }
  const encrypt = (t) => {
    if (!canEncrypt()) throw new Error('Secure storage (Windows DPAPI) is not available here, so Faber will not save a token. Servers without a token still work.');
    return safeStorage.encryptString(t).toString('base64');
  };
  function decrypt(b64) {
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { throw new Error('The saved token cannot be decrypted (it was saved by another Windows account or PC). Edit the server and enter the token again.'); }
  }
  return { canEncrypt, encrypt, decrypt };
}

// Commands shown (copyable) in the LAN help. Pure data so tests can check them.
const LAN_COMMANDS = {
  ollamaHost: [
    '# Run on the server PC (PowerShell). Makes Ollama listen on the network:',
    '[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")',
    '# then quit Ollama from the tray icon and start it again.',
  ].join('\n'),
  firewall: [
    '# Run PowerShell as Administrator on the server PC. Allows port 11434 on PRIVATE networks only:',
    'New-NetFirewallRule -DisplayName "Ollama (Faber, private network only)" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow -Profile Private',
  ].join('\n'),
  linux: [
    '# Linux server with systemd:',
    'sudo systemctl edit ollama   # add under [Service]:  Environment="OLLAMA_HOST=0.0.0.0:11434"',
    'sudo systemctl restart ollama',
  ].join('\n'),
};
const LAN_WARNING = 'Ollama has no login. Anyone on the same network can use it. Only do this on a network you trust (home, not cafe or hotel Wi-Fi), or put a token proxy in front of it and use a Bearer token profile.';
const BIG_MODEL_TIPS = [
  'Pick a model that fits the server GPU memory (VRAM). Rough size: 4-bit weights need about 0.6 GB per billion parameters, plus 1-3 GB for context.',
  'Set a larger context on the server (OLLAMA_CONTEXT_LENGTH=32768) only if the VRAM allows; long contexts use a lot of memory.',
  'Keep the model loaded between requests: OLLAMA_KEEP_ALIVE=30m, and OLLAMA_MAX_LOADED_MODELS=1 on small GPUs.',
  'Enable flash attention on the server: OLLAMA_FLASH_ATTENTION=1 (less memory, faster).',
  'Pull the model on the server first (ollama pull <name>) so the first request does not time out while it downloads.',
  'Latency matters for agent loops: prefer a server in your region, and an SSH forward or LAN over a public tunnel when you can.',
];
const id6 = () => crypto.randomBytes(6).toString('hex');

module.exports = function (ctx) {
  const fs = ctx.fs || fsx, path = ctx.path || pathx;
  const st = { proxy: null, active: null, pending: new Map(), plans: new Map(), run: null, forward: null, prevLocal: LOCAL_HOST };
  const cfg = () => ctx.featureSettings('remote');
  const save = (p) => ctx.setFeatureSettings('remote', p);
  const emit = (ev, payload) => ctx.send('feat:remote:' + ev, payload);

  R.setSshPath(cfg().sshPath);

  /* ---------- token storage (safeStorage only) ---------- */
  const vault = makeVault(ctx.safeStorage || electronSafe, process.platform);
  const canEncrypt = vault.canEncrypt, encrypt = vault.encrypt, decrypt = vault.decrypt;
  const tokenOf = (s) => (s.tokenEnc ? decrypt(s.tokenEnc) : '');

  /* ---------- state shown in the UI (never contains tokens) ---------- */
  const servers = () => cfg().servers || [];
  const sshProfiles = () => cfg().ssh || [];
  const pubServer = (s) => {
    let c = { https: false, scope: 'public', host: '' };
    try { c = classify(s.url); } catch { /* bad url */ }
    return { id: s.id, name: s.name, url: s.url, host: c.host, https: c.https, scope: c.scope, hasToken: !!s.tokenEnc };
  };
  function forwardServer() {
    if (!st.forward) return null;
    return { id: 'fwd', name: `SSH forward to ${st.forward.label}`, url: `http://127.0.0.1:${st.forward.localPort}`, host: `127.0.0.1:${st.forward.localPort}`, https: false, scope: 'ssh', hasToken: false, via: st.forward.label };
  }
  function checkActive() {   // someone else changed the host: forget our connection
    if (st.active && ctx.getSettings().host !== (st.proxy && st.proxy.url)) { dropProxy(); st.active = null; }
  }
  function state() {
    checkActive();
    const c = cfg();
    const fwd = forwardServer();
    return {
      canEncrypt: canEncrypt(),
      servers: [...servers().map(pubServer), ...(fwd ? [fwd] : [])],
      ssh: sshProfiles(),
      active: st.active ? { id: st.active.id, name: st.active.name, host: st.active.host, via: st.active.via || '', since: st.active.since, stats: st.proxy ? st.proxy.stats : null } : null,
      offer: !st.active && c.offerReconnect !== false && c.lastActive && servers().find((s) => s.id === c.lastActive) ? { id: c.lastActive, name: servers().find((s) => s.id === c.lastActive).name } : null,
      offerEnabled: c.offerReconnect !== false,
      forward: st.forward ? { label: st.forward.label, localPort: st.forward.localPort, remotePort: st.forward.remotePort } : null,
      run: st.run ? { id: st.run.id, phase: st.run.phase, sshId: st.run.sshId } : null,
      sshPath: c.sshPath || '',
      nb: c.nb || { model: '', tunnel: 'cloudflared', requireToken: true },
      info: { lanCommands: LAN_COMMANDS, lanWarning: LAN_WARNING, tips: BIG_MODEL_TIPS },
      localHost: ctx.getSettings().host,
    };
  }
  const push = () => emit('state', state());

  /* ---------- proxy + switching ---------- */
  function dropProxy() { if (st.proxy) { const p = st.proxy; st.proxy = null; p.close().catch(() => {}); } }

  function goLocal(clearOffer) {
    const was = !!st.active;
    dropProxy();
    st.active = null;
    if (was || ctx.getSettings().hostRemote) ctx.setHost(st.prevLocal || LOCAL_HOST, false);
    save({ proxyUrl: '', ...(clearOffer ? { lastActive: '' } : {}) });
    push();
  }

  // Startup: the core always starts local. If a crash left our relay address in settings, heal it.
  (function heal() {
    const c = cfg();
    if (c.proxyUrl && ctx.getSettings().host === c.proxyUrl) { try { ctx.setHost(LOCAL_HOST, false); } catch { /* ignore */ } }
    if (c.proxyUrl) save({ proxyUrl: '' });
  })();

  async function usePrepare(id) {
    const s = id === 'fwd' ? forwardServer() : servers().find((x) => x.id === id);
    if (!s) throw new Error('Unknown server.');
    const nonce = crypto.randomBytes(16).toString('hex');
    st.pending.set(nonce, { id, exp: Date.now() + 5 * 60 * 1000 });
    const pub = id === 'fwd' ? s : pubServer(s);
    return { nonce, server: pub, folder: ctx.workspace() };
  }

  async function use(id, nonce) {
    const p = st.pending.get(nonce);
    st.pending.delete(nonce);
    if (!p || p.id !== id || p.exp < Date.now()) throw new Error('Consent is required first. Use the confirmation window.');
    const s = id === 'fwd' ? forwardServer() : servers().find((x) => x.id === id);
    if (!s) throw new Error('Unknown server.');
    const url = s.url;
    const token = id === 'fwd' ? '' : tokenOf(s);
    const c = classify(url);
    if (token && !c.https && c.scope === 'public') throw new Error('Refusing to send the token over plain http to a public address. Use an https:// address.');
    const was = st.active;
    const previous = st.proxy;
    const label = `Remote server "${s.name}"`;
    const proxy = await createProxy({
      target: url, token, label,
      onEvent: (ev) => { if (ev.midStream) emit('event', { type: 'error', message: ev.message }); emit('stats', proxy.stats); },
    });
    const t = await testServer(url, token, { timeoutMs: 8000 });   // direct check first, so errors name the real problem
    if (!t.ok) { proxy.close().catch(() => {}); throw new Error(t.error || 'The server did not answer like Ollama.'); }
    if (!was) { const cur = ctx.getSettings().host; st.prevLocal = classify(cur).scope === 'loopback' && !ctx.getSettings().hostRemote ? cur : LOCAL_HOST; }
    save({ proxyUrl: proxy.url });
    ctx.setHost(proxy.url, true);
    st.proxy = proxy;
    if (previous) previous.close().catch(() => {});
    st.active = { id, name: s.name, host: c.host, via: s.via || '', since: Date.now() };
    save({ lastActive: id === 'fwd' ? '' : id });
    push();
    return { models: t.models || [], version: t.version };
  }

  /* ---------- server profiles ---------- */
  function validName(n) {
    n = String(n || '').trim();
    if (!n || n.length > 60 || /[\x00-\x1f]/.test(n)) throw new Error('Give the server a short name.');
    return n;
  }
  function validToken(t) {
    if (t.length > 512 || !/^[\x21-\x7e]+$/.test(t)) throw new Error('The token may only contain visible characters, no spaces.');
    return t;
  }
  function saveServer(input) {
    const list = [...servers()];
    const old = input.id ? list.find((x) => x.id === input.id) : null;
    if (input.id && !old) throw new Error('Unknown server.');
    if (!old && list.length >= 30) throw new Error('Too many saved servers.');
    const url = normalizeUrl(input.url);
    const c = classify(url);
    const s = { id: old ? old.id : id6(), name: validName(input.name), url };
    let enc = old ? old.tokenEnc : undefined;
    if (input.clearToken) enc = undefined;
    if (input.token) {
      const tok = validToken(String(input.token));
      if (!c.https && c.scope === 'public') throw new Error('Refusing to store a token for a plain http:// public address: it would travel unencrypted. Use https://.');
      if (!canEncrypt()) throw new Error('Secure storage (Windows DPAPI) is not available here, so Faber will not save a token. Servers without a token still work.');
      enc = encrypt(tok);
    }
    if (enc) s.tokenEnc = enc;
    if (!old && list.some((x) => x.url === url && x.name === s.name)) throw new Error('A server with this name and address already exists.');
    save({ servers: old ? list.map((x) => (x.id === old.id ? s : x)) : [...list, s] });
    if (st.active && st.active.id === s.id) goLocal(false);
    push();
    return pubServer(s);
  }

  function parsePaste(text) {
    const t = String(text || '');
    const u = t.match(/FABER_URL=(\S+)/);
    const k = t.match(/FABER_TOKEN=(\S+)/);
    return { url: normalizeUrl(u ? u[1] : t), token: k ? k[1] : '' };
  }

  /* ---------- SSH profiles ---------- */
  const sshById = (id) => {
    const p = sshProfiles().find((x) => x.id === id);
    if (!p) throw new Error('Unknown SSH profile.');
    return p;
  };
  function saveSsh(input) {
    const list = [...sshProfiles()];
    const o = S.validateProfile(input);
    if (o.id) { if (!list.some((x) => x.id === o.id)) throw new Error('Unknown SSH profile.'); } else { if (list.length >= 30) throw new Error('Too many profiles.'); o.id = id6(); }
    if (o.keyFile && !fs.existsSync(o.keyFile)) throw new Error('The key file does not exist: ' + o.keyFile);
    save({ ssh: list.some((x) => x.id === o.id) ? list.map((x) => (x.id === o.id ? o : x)) : [...list, o] });
    push();
    return o;
  }

  /* ---------- run on remote ---------- */
  const needFolder = () => { const f = ctx.workspace(); if (!f) throw new Error('Open a folder first: Faber syncs the open folder.'); return f; };
  function newPlanId(data) { const id = crypto.randomBytes(12).toString('hex'); st.plans.set(id, { ...data, exp: Date.now() + 10 * 60 * 1000 }); return id; }
  const takePlan = (id, kind, sshId) => {
    const p = st.plans.get(id);
    st.plans.delete(id);
    if (!p || p.kind !== kind || p.sshId !== sshId || p.exp < Date.now()) throw new Error('Please confirm again (the confirmation expired).');
    return p;
  };

  function runPlan(sshId) {
    const p = sshById(sshId);
    const folder = needFolder();
    const plan = scanFolder(folder, { maxFileMB: p.maxFileMB, maxTotalMB: p.maxTotalMB });
    const dir = S.remoteDirFor(p, folder);
    const biggest = [...plan.files].sort((a, b) => b.size - a.size).slice(0, 8).map((f) => ({ rel: f.rel, size: f.size }));
    const planId = plan.tooLarge || plan.tooMany || !plan.count ? '' : newPlanId({ kind: 'sync', sshId, plan, dir });
    return {
      planId, folder, dir, target: `${p.user}@${p.host}`, count: plan.count, bytes: plan.bytes, limitMB: p.maxTotalMB, fileLimitMB: p.maxFileMB,
      excludedDirs: plan.excludedDirs, skippedLarge: plan.skippedLarge.slice(0, 10), skippedLargeCount: plan.skippedLarge.length,
      skippedSecrets: plan.skippedSecrets.slice(0, 10), skippedSecretCount: plan.skippedSecrets.length, skippedOtherCount: plan.skippedOther.length,
      sample: plan.files.slice(0, 12).map((f) => f.rel), biggest, tooLarge: plan.tooLarge, tooMany: plan.tooMany, empty: !plan.count,
    };
  }

  const LOG_MAX = 256 * 1024;
  function runStart(sshId, { planId, command, skipUpload }) {
    const p = sshById(sshId);
    command = String(command || '').trim();
    if (!command) throw new Error('Type the command to run on the server.');
    if (command.length > 8000) throw new Error('The command is too long.');
    if (st.run && st.run.phase !== 'done') throw new Error('A remote run is already in progress.');
    const folder = needFolder();
    let plan = null, dir = S.remoteDirFor(p, folder);
    if (!skipUpload) { const pl = takePlan(planId, 'sync', sshId); plan = pl.plan; dir = pl.dir; }
    const run = { id: id6(), sshId, phase: skipUpload ? 'run' : 'sync', log: '', handle: null, folder, dir };
    st.run = run;
    let pendingOut = '', timer = null;
    const flush = () => { timer = null; if (pendingOut) { emit('run', { type: 'out', text: pendingOut }); pendingOut = ''; } };
    const out = (t) => {
      run.log = (run.log + t).slice(-LOG_MAX);
      pendingOut += t;
      if (!timer) timer = setTimeout(flush, 40);
    };
    const phase = (ph, text) => { run.phase = ph; if (text) out(text); emit('run', { type: 'phase', phase: ph }); push(); };
    const end = (r) => { clearTimeout(timer); flush(); run.phase = 'done'; run.result = r; emit('run', { type: 'end', ...r }); push(); };
    (async () => {
      const t0 = Date.now();
      if (!skipUpload) {
        out(`[faber] Uploading ${plan.count} files (${(plan.bytes / 1048576).toFixed(1)} MB) to ${p.user}@${p.host}:${dir}\n`);
        let lastPct = -1;
        const up = await R.upload(p, dir, plan, { onProgress: (a, b) => { const pct = b ? Math.floor((a / b) * 100) : 100; if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; out(`[faber] upload ${pct}%\n`); } } });
        if (!up.ok) return end({ ok: false, error: up.error, kind: up.kind, stage: 'upload' });
        save({ lastSync: { ...(cfg().lastSync || {}), [sshId]: { folder, dir, at: Date.now(), files: plan.count } } });
        phase('run', `[faber] Upload done. Running on the server: ${command}\n`);
      } else out(`[faber] Running on the server (no upload): ${command}\n`);
      emit('run', { type: 'phase', phase: 'run' });
      run.handle = R.run(p, dir, command, { onOutput: out });
      const r = await run.handle.done;
      end({ ok: r.code === 0 && !r.error, code: r.code, stopped: !!r.stopped, error: r.error, stage: 'run', seconds: Math.round((Date.now() - t0) / 1000) });
    })().catch((e) => end({ ok: false, error: e.message, stage: 'run' }));
    push();
    return { runId: run.id };
  }

  async function fetchPlan(sshId) {
    const p = sshById(sshId);
    const folder = needFolder();
    const dir = S.remoteDirFor(p, folder);
    const r = await R.listChanged(p, dir);
    if (!r.ok) throw new Error(r.error);
    const maxOne = 50 * 1048576;
    const files = r.files.slice(0, 2000).map((f) => {
      const safe = R.safeRel(f.rel);
      const abs = safe ? path.join(folder, ...f.rel.split('/')) : '';
      let local = null;
      if (safe) { try { const s = fs.lstatSync(abs); local = { size: s.size, mtime: s.mtimeMs, isFile: s.isFile() }; } catch { /* new */ } }
      return { rel: f.rel, size: f.size, safe, tooBig: f.size > maxOne, exists: !!local, localSize: local ? local.size : 0, blocked: !!(local && !local.isFile) };
    });
    return { planId: newPlanId({ kind: 'fetch', sshId, dir, folder, files }), dir, folder, files, truncated: r.files.length > files.length };
  }

  async function fetchApply(sshId, planId, selected) {
    const pl = takePlan(planId, 'fetch', sshId);
    const p = sshById(sshId);
    const folder = needFolder();
    if (folder !== pl.folder) throw new Error('The open folder changed; fetch again.');
    const okSet = new Map(pl.files.filter((f) => f.safe && !f.tooBig && !f.blocked).map((f) => [f.rel, f]));
    const rels = [...new Set((selected || []).map(String))].filter((r) => okSet.has(r));
    if (!rels.length) return { written: [], identical: [], backedUp: [], message: 'Nothing selected.' };
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-fetch-'));
    try {
      const r = await R.download(p, pl.dir, rels, staging);
      if (!r.ok) throw new Error(r.error);
      const realRoot = fs.realpathSync(folder);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const written = [], identical = [], backedUp = [];
      for (const rel of r.got) {
        const src = path.join(staging, ...rel.split('/'));
        const dest = path.join(folder, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const realParent = fs.realpathSync(path.dirname(dest));
        if (path.relative(realRoot, realParent).startsWith('..') || path.isAbsolute(path.relative(realRoot, realParent))) continue;   // symlinked out of the folder
        if (fs.existsSync(dest)) {
          if (fs.readFileSync(dest).equals(fs.readFileSync(src))) { identical.push(rel); continue; }
          const bak = path.join(folder, '.faber-backup', stamp, ...rel.split('/'));
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(dest, bak);
          backedUp.push(rel);
        }
        fs.copyFileSync(src, dest);
        written.push(rel);
      }
      return { written, identical, backedUp, backupDir: backedUp.length ? path.join(folder, '.faber-backup', stamp) : '' };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  /* ---------- port forward ---------- */
  async function forwardStart(sshId, { localPort, remotePort }) {
    const p = sshById(sshId);
    localPort = Number(localPort) || 11436; remotePort = Number(remotePort) || 11434;
    for (const n of [localPort, remotePort]) if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Ports must be between 1024 and 65535.');
    if (st.forward) throw new Error('A forward is already running. Stop it first.');
    const label = `${p.user}@${p.host}`;
    const r = await R.startForward(p, localPort, remotePort, {
      onExit: (code, msg) => {
        if (!st.forward) return;
        const wasUsed = st.active && st.active.id === 'fwd';
        st.forward = null;
        if (wasUsed) goLocal(false);
        emit('event', { type: 'error', message: `SSH forward to ${label} ended: ${msg}${wasUsed ? ' Switched back to the local model.' : ''}` });
        push();
      },
    });
    if (!r.ok) throw new Error(r.error);
    st.forward = { handle: r.handle, label, localPort, remotePort };
    push();
    return { url: `http://127.0.0.1:${localPort}` };
  }
  function forwardStop() {
    const f = st.forward;
    if (!f) return;
    st.forward = null;
    if (st.active && st.active.id === 'fwd') goLocal(false);
    f.handle.stop();
    push();
  }

  function shutdown() {
    try { if (st.run && st.run.handle) st.run.handle.stop(true); } catch { /* ignore */ }
    try { if (st.forward) st.forward.handle.stop(); } catch { /* ignore */ }
    if (st.active) { try { ctx.setHost(st.prevLocal || LOCAL_HOST, false); save({ proxyUrl: '' }); } catch { /* ignore */ } }
    dropProxy();
  }
  ctx.app.on('before-quit', shutdown);
  process.on('exit', () => { try { if (st.run && st.run.handle) st.run.handle.stop(true); if (st.forward) st.forward.handle.stop(); } catch { /* ignore */ } });

  /* ---------- IPC ---------- */
  const H = (name, fn) => ctx.handle('feat:remote:' + name, async (...a) => fn(...a));
  H('state', () => state());
  H('serverSave', (i) => saveServer(i || {}));
  H('serverDelete', (id) => {
    if (st.active && st.active.id === id) throw new Error('Switch back to the local model first.');
    save({ servers: servers().filter((x) => x.id !== id), ...(cfg().lastActive === id ? { lastActive: '' } : {}) });
    push();
  });
  H('serverTest', async ({ id, url, token } = {}) => {
    let u = url, t = token || '';
    if (id === 'fwd') { u = forwardServer().url; t = ''; } else if (id) { const s = servers().find((x) => x.id === id); if (!s) throw new Error('Unknown server.'); u = s.url; t = tokenOf(s); } else u = normalizeUrl(u);
    const c = classify(u);
    if (t && !c.https && c.scope === 'public') return { ok: false, error: 'Not sending a token over plain http to a public address. Use https://.' };
    const r = await testServer(u, t);
    r.host = c.host; r.https = c.https; r.scope = c.scope;
    return r;
  });
  H('pasteAdd', async ({ text, token, name } = {}) => {
    const pr = parsePaste(text);
    const tok = String(token || '').trim() || pr.token;
    const host = new URL(pr.url).hostname.split('.')[0].slice(0, 14);
    const same = servers().find((x) => x.url === pr.url);
    const s = saveServer({ id: same ? same.id : undefined, name: String(name || '').trim() || (same ? same.name : `Notebook ${host}`), url: pr.url, token: tok || undefined });
    const r = await (async () => { const sv = servers().find((x) => x.id === s.id); return testServer(sv.url, tokenOf(sv)); })();
    return { server: s, test: r };
  });
  H('usePrepare', (id) => usePrepare(id));
  H('use', (id, nonce) => use(id, nonce));
  H('local', () => { if (st.active || ctx.getSettings().hostRemote) goLocal(false); return state(); });
  H('setPref', (p = {}) => {
    const patch = {};
    if (typeof p.offerReconnect === 'boolean') patch.offerReconnect = p.offerReconnect;
    if (typeof p.sshPath === 'string') { patch.sshPath = p.sshPath.trim(); if (patch.sshPath && !fs.existsSync(patch.sshPath)) throw new Error('That file does not exist.'); R.setSshPath(patch.sshPath); }
    if (p.nb) patch.nb = { platform: p.nb.platform === 'kaggle' ? 'kaggle' : 'colab', model: String(p.nb.model || '').slice(0, 100), tunnel: p.nb.tunnel === 'ngrok' ? 'ngrok' : 'cloudflared', requireToken: p.nb.requireToken !== false };
    save(patch); push();
  });
  H('forgetTokens', () => { save({ servers: servers().map(({ tokenEnc, ...rest }) => rest) }); if (st.active) goLocal(false); push(); });
  H('notebookSave', async (opts = {}) => {
    const nb = buildNotebook(opts);
    const kaggle = opts.platform === 'kaggle';
    const r = await ctx.dialog.showSaveDialog(ctx.window(), {
      title: kaggle ? 'Save the Kaggle notebook' : 'Save the Colab notebook', defaultPath: path.join(ctx.workspace() || os.homedir(), kaggle ? 'faber-kaggle-ollama.ipynb' : 'faber-colab-ollama.ipynb'),
      filters: [{ name: 'Jupyter notebook', extensions: ['ipynb'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(nb, null, 1));
    return r.filePath;
  });
  let scanning = false, scanStop = false;
  H('lanScan', async () => {
    if (scanning) throw new Error('A scan is already running.');
    const prefixes = lanPrefixes(os.networkInterfaces());
    if (!prefixes.length) return { prefixes, found: [], note: 'No private network address found on this PC.' };
    scanning = true; scanStop = false;
    try {
      const found = await scanLan(prefixes, { shouldStop: () => scanStop, onProgress: (d, t) => emit('scan', { done: d, total: t }) });
      return { prefixes: prefixes.map((p) => p + '.0/24'), found, stopped: scanStop };
    } finally { scanning = false; }
  });
  H('lanScanStop', () => { scanStop = true; });
  H('pickKey', async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.window(), { title: 'Choose your private key file', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });
  H('sshSave', (i) => saveSsh(i || {}));
  H('sshDelete', (id) => { if (st.forward && st.forward.label.startsWith(sshById(id).user + '@')) forwardStop(); save({ ssh: sshProfiles().filter((x) => x.id !== id) }); push(); });
  H('sshTest', (id) => R.testConnection(sshById(id)));
  H('sshTerminal', (id) => ({ line: S.terminalLine(sshById(id), ctx.workspace(), process.platform === 'win32' ? 'ssh' : 'ssh') }));
  H('runPlan', (id) => runPlan(id));
  H('runStart', (id, o) => runStart(id, o || {}));
  H('runStop', (force) => { if (st.run && st.run.handle) st.run.handle.stop(!!force); });
  H('runLog', () => (st.run ? { phase: st.run.phase, log: st.run.log, result: st.run.result || null } : null));
  H('fetchPlan', (id) => fetchPlan(id));
  H('fetchApply', (id, planId, sel) => fetchApply(id, planId, sel));
  H('forwardStart', (id, o) => forwardStart(id, o || {}));
  H('forwardStop', () => forwardStop());
};

// Pure helpers exported for tests/remote-unit.js
Object.assign(module.exports, { makeVault, LAN_COMMANDS, LAN_WARNING, BIG_MODEL_TIPS, helpers: { normalizeUrl, classify, testServer, scanLan, lanPrefixes, createProxy, buildNotebook, scanFolder, ssh: S, run: R } });
