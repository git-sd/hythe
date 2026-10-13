'use strict';
// Runs one shell command (PowerShell on Windows, bash elsewhere), streaming output.
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const tools = require('../tools');

const HEAD = 256 * 1024, TAIL = 1024 * 1024;

const PS_PRE = "$ProgressPreference='SilentlyContinue';try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{};";
const PS_POST = ';$__ok=$?;$__c=$LASTEXITCODE;if($null -ne $__c){exit $__c};if(-not $__ok){exit 1};exit 0';

// The script travels as base64 inside a plain -Command (ASCII only, so no quoting problems and no
// CLIXML noise on stderr, which -EncodedCommand would add).
function spawnArgs(command) {
  if (process.platform === 'win32') {
    const b64 = Buffer.from(PS_PRE + command + PS_POST, 'utf8').toString('base64');
    const wrapper = "$b=[Convert]::FromBase64String('" + b64 + "');& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b)))";
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapper]];
  }
  return ['bash', ['-lc', command]];
}

// PowerShell error records end with position noise ("At line:1 char:160", "+ CategoryInfo ..."). Drop it.
let inErr = false;
function noise(chunk) {
  if (process.platform !== 'win32') return chunk;
  const parts = chunk.split(/(?<=\n)/);
  let out = '';
  for (const l of parts) {
    if (/^At line:\d+ char:\d+/.test(l)) { inErr = true; continue; }
    if (inErr && /^\s*\+ /.test(l)) continue;
    if (inErr && /^\s*\r?\n?$/.test(l)) { inErr = false; continue; }
    inErr = false;
    out += l;
  }
  return out;
}

// -> {promise: {code, output, timedOut, killed, ms}, kill}
function start({ command, cwd, env, timeoutMs = 120000, onData }) {
  const [file, args] = spawnArgs(command);
  const t0 = Date.now();
  const child = spawn(file, args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let head = '', tail = '', dropped = 0, timedOut = false, killed = false;
  const push = (s) => {
    s = noise(s);
    if (!s) return;
    if (onData) { try { onData(s); } catch { /* listener bug must not kill the run */ } }
    if (head.length < HEAD) { const room = HEAD - head.length; head += s.slice(0, room); s = s.slice(room); }
    tail += s;
    if (tail.length > TAIL * 2) { dropped += tail.length - TAIL; tail = tail.slice(-TAIL); }
  };
  for (const stream of [child.stdout, child.stderr]) {
    const dec = new StringDecoder('utf8');
    stream.on('data', (d) => push(dec.write(d)));
    stream.on('end', () => { const r = dec.end(); if (r) push(r); });
  }
  const kill = () => { killed = true; tools.killTree(child); };
  let timer;
  const promise = new Promise((resolve) => {
    const fin = (code, extra = '') => {
      clearTimeout(timer);
      resolve({ code, output: head + (dropped ? `\n...[${dropped} characters omitted]...\n` : '') + tail + extra, timedOut, killed, ms: Date.now() - t0 });
    };
    timer = setTimeout(() => { timedOut = true; push('\n[timed out]\n'); tools.killTree(child); }, timeoutMs);
    child.on('close', (code) => fin(code));
    child.on('error', (e) => fin(-1, '\n' + String(e.message || e)));
  });
  return { promise, kill, pid: child.pid };
}

module.exports = { start, spawnArgs };
