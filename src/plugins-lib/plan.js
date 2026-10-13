'use strict';
// Turns a plugin command/tool + the user's input into one concrete shell command (or a helpful
// "not installed" message). Never installs or downloads anything: it only looks at what exists.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./template');

const probeCache = new Map();   // key -> {t, v}
const PROBE_TTL = 30000;

function cached(key, fn) {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.t < PROBE_TTL) return hit.v;
  const v = fn();
  probeCache.set(key, { t: Date.now(), v });
  return v;
}
const clearProbes = () => probeCache.clear();

// Run a program without any shell and report {code, out}. Used for tiny, offline "is it there" probes.
function probe(file, args, ms = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const fin = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } };
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ code: -1, out: '' }); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } fin(-2); }, ms);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => fin(-1));
    child.on('close', (c) => fin(c));
  });
}

// -> {path, args} | null
async function findPython(workspace) {
  const win = process.platform === 'win32';
  const cands = [];
  for (const v of ['.venv', 'venv']) cands.push({ path: path.join(workspace, v, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'), args: [] });
  for (const n of win ? ['python', 'python3'] : ['python3', 'python']) { const w = T.which(n, { workspace }); if (w) cands.push({ path: w.path, args: [] }); }
  if (win) { const w = T.which('py', { workspace }); if (w) cands.push({ path: w.path, args: ['-3'] }); }
  for (const c of cands) {
    if (!fs.existsSync(c.path)) continue;
    const key = 'py|' + c.path + '|' + c.args.join(' ');
    let p = probeCache.get(key);
    if (!p || Date.now() - p.t > PROBE_TTL) {
      // args are always given, so the Microsoft Store alias can never be triggered
      p = { t: Date.now(), v: probe(c.path, [...c.args, '-c', 'import sys;print(sys.version_info[0])']).then((r) => r.code === 0 && r.out.trim() === '3') };
      probeCache.set(key, p);
    }
    if (await p.v) return c;
  }
  return null;
}

const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*') + '$', 'i');

function fileExists(workspace, pattern) {
  if (!/^[\w.@*/-]+$/.test(pattern) || pattern.includes('..')) return false;
  const dir = path.join(workspace, path.dirname(pattern));
  const base = path.basename(pattern);
  try {
    if (!base.includes('*')) return fs.existsSync(path.join(dir, base));
    const re = globRe(base);
    return fs.readdirSync(dir).some((n) => re.test(n));
  } catch { return false; }
}

function packageScript(workspace, name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    const s = j && j.scripts && j.scripts[name];
    return typeof s === 'string' && !/no test specified/i.test(s);
  } catch { return false; }
}

// One requirement ("bin:x", "py:x", "file:x", "script:x", "sdk:dotnet"; a|b = either) -> {ok, label}
async function checkReq(req, env) {
  const alts = String(req).split('|');
  const first = alts[0].split(':')[0];
  // "file:a|b" means file a or file b
  const parts = first === 'file' || first === 'script' ? alts.map((a, i) => (i === 0 ? a : first + ':' + a)) : alts;
  let label = '';
  for (const part of parts) {
    const i = part.indexOf(':');
    const kind = part.slice(0, i), val = part.slice(i + 1);
    if (kind === 'bin') {
      label = label || `${val} on PATH`;
      if (T.which(val, { workspace: env.workspace, startDir: env.startDir })) return { ok: true };
    } else if (kind === 'py') {
      label = label || `python module "${val}"`;
      const py = await findPython(env.workspace);
      if (py && await cached('mod|' + py.path + '|' + val, () => probe(py.path, [...py.args, '-c', `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(${JSON.stringify(val)}) else 1)`]).then((r) => r.code === 0))) return { ok: true };
    } else if (kind === 'file') {
      label = label || `${val} in this folder`;
      if (fileExists(env.workspace, val)) return { ok: true };
    } else if (kind === 'script') {
      label = label || `"${val}" script in package.json`;
      if (packageScript(env.workspace, val)) return { ok: true };
    } else if (kind === 'sdk' && val === 'dotnet') {
      label = label || '.NET SDK';
      const d = T.which('dotnet', { workspace: env.workspace });
      if (d && await cached('sdk|' + d.path, () => probe(d.path, ['--list-sdks']).then((r) => r.code === 0 && r.out.trim().length > 0))) return { ok: true };
    }
  }
  return { ok: false, label: label || String(req) };
}

const extOf = (f) => path.extname(f).slice(1).toLowerCase();

function matchesApplies(list, file, workspace) {
  if (!list || !list.length) return true;
  const rel = path.relative(workspace || path.dirname(file), file).replace(/\\/g, '/');
  const base = path.basename(file);
  return list.some((p) => {
    if (!/[*/?]/.test(p)) return extOf(file) === p.toLowerCase();
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(p.includes('/') ? rel : base);
  });
}

// Safe environment for every plugin command: plain output, never any network by default.
const BASE_ENV = {
  NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true', TERM: 'dumb',
  PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
  npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', NO_UPDATE_NOTIFIER: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  CARGO_NET_OFFLINE: 'true', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOFLAGS: '-mod=mod',
};

const fail = (kind, message) => ({ ok: false, kind, message });

/* def: {title, scope, appliesTo, cwd, candidates:[{label,hint,detect,requires,appliesTo,run,cwd,env}], env, noInstallNote}
   input: {workspace, file?, folder?, arg?, params?, allow?: Set of variable names that may start with "-"} */
async function plan(def, input, opts = {}) {
  const win32 = opts.win32 ?? process.platform === 'win32';
  const shell = opts.shell || (win32 ? 'ps' : 'sh');
  const ws = input.workspace;
  if (!ws) return fail('no-folder', 'Open a folder first.');
  const file = input.file || '';
  if (def.scope === 'file') {
    if (!file) return fail('no-file', 'Open a file in the editor first.');
    if (!matchesApplies(def.appliesTo, file, ws)) {
      return fail('not-applicable', `"${def.title}" does not support ${extOf(file) ? '.' + extOf(file) : 'this'} files. Supported: ${(def.appliesTo || []).join(', ')}.`);
    }
  }
  const folder = def.scope === 'file' ? path.dirname(file) : (input.folder || ws);
  const values = { ws, folder, ...(file ? { file, rel: relFor(ws, file) } : {}), ...(input.arg !== undefined ? { arg: input.arg } : {}), ...(input.params || {}) };
  const startDir = file ? path.dirname(file) : ws;
  const env = { workspace: ws, startDir };

  const missingNotes = [];
  const undetected = [];
  let applicable = 0;
  for (const cand of def.candidates) {
    if (def.scope === 'file' && cand.appliesTo && !matchesApplies(cand.appliesTo, file, ws)) continue;
    applicable++;
    let detected = true;
    for (const r of cand.detect) if (!(await checkReq(r, env)).ok) { detected = false; break; }
    if (!detected) { undetected.push(cand.label); continue; }
    const missing = [];
    for (const r of cand.requires) { const c = await checkReq(r, env); if (!c.ok) missing.push(c.label); }
    const tokens = T.tokenize(cand.run);
    const bins = {};
    for (const t of tokens) {
      if (t.v === undefined) continue;
      if (t.v.startsWith('bin:')) {
        const n = t.v.slice(4);
        const w = T.which(n, env);
        if (w) bins[n] = w; else missing.push(`${n} on PATH`);
      }
    }
    if (tokens.some((t) => t.v === 'py')) {
      const py = await findPython(ws);
      if (py) bins.$py = py; else missing.push('python 3');
    }
    if (missing.length) { missingNotes.push({ label: cand.label, missing: [...new Set(missing)], hint: cand.hint }); continue; }
    let strictCmd = false;
    if (win32) {
      strictCmd = Object.values(bins).some((b) => T.isCmdShim(b.path));
      if (!strictCmd) {
        for (const w of T.commandWords(tokens)) { const f = T.which(w, env); if (f && T.isCmdShim(f.path)) strictCmd = true; }
      }
    }
    let command;
    try { command = T.render(cand.run, values, bins, { shell, win32, strictCmd, allowDash: input.allow }); } catch (e) { return fail('bad-input', e.message); }
    let cwd = cand.cwd || def.cwd || 'workspace';
    cwd = cwd === 'file-dir' && file ? path.dirname(file) : ws;
    const used = Object.entries(bins).map(([n, b]) => `${n === '$py' ? 'python' : n} (${b.local ? 'project' : 'PATH'}: ${b.path})`);
    return { ok: true, command, cwd, label: cand.label, used, env: { ...BASE_ENV, ...(def.env || {}), ...(cand.env || {}) }, shell };
  }

  if (missingNotes.length) {
    const lines = missingNotes.map((n) => `  - ${n.label}: ${n.missing.join(', ')} not installed${n.hint ? ` (to get it: ${n.hint})` : ''}`);
    return fail('not-installed', `Cannot run "${def.title}": the tool it needs is not installed.\n${lines.join('\n')}\nFaber never downloads or installs tools. Install one yourself, then run this again.`);
  }
  if (!applicable) return fail('not-applicable', `"${def.title}" has nothing for ${extOf(file) ? '.' + extOf(file) : 'this'} files.`);
  return fail('not-detected', `"${def.title}": nothing to run here, no supported project was detected in this folder. Looked for: ${[...new Set(undetected)].join(', ')}.`);
}

function relFor(ws, file) {
  const r = path.relative(ws, file).replace(/\\/g, '/');
  return r.startsWith('-') ? './' + r : r;
}

module.exports = { plan, checkReq, findPython, matchesApplies, clearProbes, probe, BASE_ENV, relFor, extOf };
