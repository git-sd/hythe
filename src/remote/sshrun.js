// Runs the system OpenSSH client (ssh) as child processes: test, upload (tar over ssh), run with live output,
// list/fetch changed files, port forward. Uses argument arrays only (no shell on this PC).
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const S = require('./sshcmd');
const { createTarStream, TarReader } = require('./tar');

let override = '';   // optional path to ssh set by the user
function setSshPath(p) { override = String(p || '').trim(); }

// FABER_REMOTE_SSH is a test hook: a .js file is run with this runtime instead of being executed directly.
function resolveSsh() {
  const p = process.env.FABER_REMOTE_SSH || override || 'ssh';
  if (/\.js$/i.test(p)) return { cmd: process.execPath, pre: [p], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { cmd: p, pre: [], env: {} };
}

function spawnSsh(args, opts = {}) {
  const t = resolveSsh();
  return spawn(t.cmd, [...t.pre, ...args], { windowsHide: true, shell: false, env: { ...process.env, ...t.env }, ...opts });
}

function failure(stderr, code, spawnErr) {
  if (spawnErr && spawnErr.code === 'ENOENT') return { kind: 'missing', message: 'The OpenSSH client (ssh) was not found. On Windows: Settings > Apps > Optional features > add "OpenSSH Client", or set the ssh program path in Remote settings.' };
  return S.classifyError(stderr, code);
}

// Collect output of a short, non-interactive ssh call.
function exec(args, { input, timeoutMs = 30000, maxOut = 4 << 20 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnSsh(args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: '', spawnErr: e }); }
    let out = '', err = '', done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } end({ code: -1, stdout: out, stderr: err + '\nConnection timed out (no answer from ssh)', timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < maxOut) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => end({ code: -1, stdout: out, stderr: err, spawnErr: e }));
    child.on('close', (code) => end({ code, stdout: out, stderr: err }));
    child.stdin.end(input || '');
  });
}

async function testConnection(p) {
  const r = await exec([...S.sshArgs(p, { tty: 'no' }), 'echo faber-ok; uname -sm 2>/dev/null; (nvidia-smi -L 2>/dev/null | head -n 2) || true'], { timeoutMs: 25000 });
  if (r.code === 0 && /faber-ok/.test(r.stdout)) {
    const [, ...info] = r.stdout.trim().split(/\r?\n/);
    return { ok: true, info: info.join('\n') };
  }
  const f = failure(r.stderr, r.code, r.spawnErr);
  return { ok: false, kind: f.kind, error: f.message };
}

// Upload the planned files with tar over ssh. Resolves {ok} or {ok:false,error}.
function upload(p, remoteDir, plan, { onProgress = () => {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnSsh([...S.sshArgs(p, { tty: 'no' }), S.syncCommand(remoteDir)], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, ...failure('', -1, e) }); }
    let err = '', sent = 0, last = 0;
    const tar = createTarStream(plan.root, plan.files, { onBytes: (n) => { sent += n; const now = Date.now(); if (now - last > 150) { last = now; onProgress(sent, plan.bytes); } } });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.stdout.resume();
    child.stdin.on('error', () => {});
    tar.on('error', () => {});
    child.on('error', (e) => { tar.destroy(); resolve({ ok: false, ...failure(err, -1, e) }); });
    child.on('close', (code) => {
      tar.destroy();
      if (code === 0) { onProgress(plan.bytes, plan.bytes); resolve({ ok: true }); } else resolve({ ok: false, ...failure(err, code) });
    });
    tar.pipe(child.stdin);
  });
}

// Run a command with live output. Returns {stop(force), done: Promise<{code, error?, stopped}>}.
function run(p, remoteDir, command, { onOutput = () => {} } = {}) {
  let child, stopped = false, err = '', t1 = null, t2 = null;
  const dec = new StringDecoder('utf8');
  const done = new Promise((resolve) => {
    try { child = spawnSsh([...S.sshArgs(p, { tty: 'force' }), S.runCommand(remoteDir, command)], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, error: failure('', -1, e).message }); }
    const feed = (d) => { const s = dec.write(d); if (s) onOutput(s); };
    child.stdout.on('data', feed);
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); feed(d); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(t1); clearTimeout(t2); resolve({ code: -1, error: failure(err, -1, e).message }); });
    child.on('close', (code, sig) => {
      clearTimeout(t1); clearTimeout(t2);
      const rest = dec.end(); if (rest) onOutput(rest);
      const r = { code, stopped };
      if (!stopped && code === 255) r.error = failure(err, code).message;
      resolve(r);
    });
  });
  return {
    done,
    // First call: Ctrl-C through the remote terminal, then close the connection (remote gets SIGHUP). Second call: close now.
    stop(force) {
      if (!child || child.exitCode !== null) return;
      if (force || stopped) { try { child.kill(); } catch { /* gone */ } return; }
      stopped = true;
      try { child.stdin.write('\x03'); } catch { /* closed */ }
      t1 = setTimeout(() => { try { child.stdin.write('\x03'); } catch { /* closed */ } }, 1200);
      t2 = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 3500);
    },
  };
}

// Files changed on the remote since the last upload: [{rel, size}]
async function listChanged(p, remoteDir) {
  const r = await exec([...S.sshArgs(p, { tty: 'no' }), S.listChangedCommand(remoteDir)], { timeoutMs: 60000 });
  if (r.code === 3 && /NOSTAMP/.test(r.stderr)) return { ok: false, error: 'Nothing to compare with yet: run once with upload first, so Faber knows what was on the server.' };
  if (r.code !== 0) return { ok: false, error: failure(r.stderr, r.code, r.spawnErr).message };
  const files = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+) \.\/(.+)$/);
    if (m) files.push({ rel: m[2], size: Number(m[1]) });
  }
  return { ok: true, files };
}

// Safe relative name check (remote data is untrusted).
function safeRel(rel) {
  if (!rel || rel.length > 1024 || /[\\:*?"<>|\x00-\x1f]/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every((c) => c && c !== '.' && c !== '..' && !/[. ]$/.test(c) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(c));
}

// Download the given files into stagingDir using tar from the server. Returns {ok, got:[rel]}.
function download(p, remoteDir, rels, stagingDir, { maxBytes = 200 << 20 } = {}) {
  rels = rels.filter(safeRel);   // never hand the remote tar a hostile name
  return new Promise((resolve) => {
    const want = new Set(rels);
    const got = [];
    let total = 0, bad = null, err = '';
    let child;
    try { child = spawnSsh([...S.sshArgs(p, { tty: 'no' }), S.fetchCommand(remoteDir)], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, error: failure('', -1, e).message }); }
    const reader = new TarReader((name, size) => {
      const rel = name.replace(/^\.\//, '');
      if (!want.has(rel) || !safeRel(rel) || got.includes(rel)) return null;
      total += size;
      if (total > maxBytes) { bad = 'The download is larger than the limit.'; child.kill(); return null; }
      const dest = path.join(stagingDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const fd = fs.openSync(dest, 'w');
      return { write: (b) => fs.writeSync(fd, b), end: () => { fs.closeSync(fd); got.push(rel); } };
    });
    child.stdout.on('data', (d) => { try { reader.push(d); } catch (e) { bad = e.message; child.kill(); } });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => resolve({ ok: false, error: failure(err, -1, e).message }));
    child.on('close', (code) => {
      if (bad) return resolve({ ok: false, error: bad });
      if (code !== 0) return resolve({ ok: false, error: failure(err, code).message });
      resolve({ ok: true, got });
    });
    child.stdin.end(rels.join('\n') + '\n');
  });
}

// ssh -N -L: managed forward. resolves when the local port accepts connections.
function startForward(p, localPort, remotePort, { onExit = () => {} } = {}) {
  return new Promise((resolve) => {
    let child, err = '', settled = false;
    try { child = spawnSsh([...S.forwardArgs(p, localPort, remotePort)], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, error: failure('', -1, e).message }); }
    const handle = { child, stop() { try { child.kill(); } catch { /* gone */ } } };
    const settle = (r) => { if (!settled) { settled = true; clearTimeout(giveUp); resolve(r); } };
    const giveUp = setTimeout(() => { handle.stop(); settle({ ok: false, error: 'The forward did not come up within 25 seconds.' }); }, 25000);
    child.stdout.resume();
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.on('error', (e) => settle({ ok: false, error: failure(err, -1, e).message }));
    child.on('close', (code) => {
      const msg = failure(err, code).message;
      if (!settled) settle({ ok: false, error: msg }); else onExit(code, msg);
    });
    const probe = () => {
      if (settled) return;
      const s = net.connect(localPort, '127.0.0.1');
      s.on('connect', () => { s.destroy(); settle({ ok: true, handle }); });
      s.on('error', () => setTimeout(probe, 300));
    };
    setTimeout(probe, 300);
  });
}

module.exports = { setSshPath, resolveSsh, testConnection, upload, run, listChanged, download, startForward, safeRel, exec };
