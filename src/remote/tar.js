// Minimal tar (ustar + pax) writer and reader, plus the folder scan used before an upload.
// Own implementation so exclusions, size limits and UTF-8 names are exact and the reader can refuse unsafe paths.
'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { DEFAULT_EXCLUDE_DIRS, SECRET_NAME } = require('./sshcmd');

const BLOCK = 512;

/* ---------- scan ---------- */
function scanFolder(root, { maxFileMB = 25, maxTotalMB = 200, excludeDirs = DEFAULT_EXCLUDE_DIRS, maxFiles = 20000 } = {}) {
  const plan = { root, files: [], count: 0, bytes: 0, excludedDirs: {}, skippedLarge: [], skippedSecrets: [], skippedOther: [], tooLarge: false, tooMany: false };
  const maxFile = maxFileMB * 1048576, maxTotal = maxTotalMB * 1048576;
  const walk = (dirAbs, rel) => {
    let entries;
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { plan.skippedOther.push(rel || '.'); return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dirAbs, e.name);
      if (/[\r\n]/.test(e.name)) { plan.skippedOther.push(r); continue; }
      if (e.isSymbolicLink()) { plan.skippedOther.push(r + ' (link)'); continue; }
      if (e.isDirectory()) {
        if (excludeDirs.includes(e.name)) { plan.excludedDirs[e.name] = (plan.excludedDirs[e.name] || 0) + 1; continue; }
        walk(abs, r);
        continue;
      }
      if (!e.isFile()) { plan.skippedOther.push(r); continue; }
      if (SECRET_NAME.test(e.name)) { plan.skippedSecrets.push(r); continue; }
      let st;
      try { st = fs.statSync(abs); } catch { plan.skippedOther.push(r); continue; }
      if (st.size > maxFile) { plan.skippedLarge.push({ rel: r, size: st.size }); continue; }
      if (plan.files.length >= maxFiles) { plan.tooMany = true; continue; }
      plan.files.push({ rel: r, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      plan.bytes += st.size;
    }
  };
  walk(root, '');
  plan.count = plan.files.length;
  plan.tooLarge = plan.bytes > maxTotal;
  return plan;
}

/* ---------- writer ---------- */
const octal = (n, len) => Buffer.from(n.toString(8).padStart(len - 1, '0') + '\0', 'latin1');

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(String(len) + body);
}

function header(name, size, mtime, mode, type, prefix = '') {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'latin1');
  octal(mode, 8).copy(b, 100);
  octal(0, 8).copy(b, 108);
  octal(0, 8).copy(b, 116);
  octal(size, 12).copy(b, 124);
  octal(mtime, 12).copy(b, 136);
  b.fill(0x20, 148, 156);
  b.write(type, 156, 1, 'latin1');
  b.write('ustar\0', 257, 6, 'latin1');
  b.write('00', 263, 2, 'latin1');
  b.write(prefix, 345, 155, 'latin1');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return b;
}

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const padTo = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

function entryHeaders(rel, size, mtime, mode) {
  if (isAscii(rel) && rel.length <= 100) return [header(rel, size, mtime, mode, '0')];
  if (isAscii(rel)) {   // try the ustar prefix split
    const i = rel.lastIndexOf('/', 156);
    if (i > 0 && rel.length - i - 1 <= 100 && i <= 155 && rel.length - i - 1 > 0) return [header(rel.slice(i + 1), size, mtime, mode, '0', rel.slice(0, i))];
  }
  const data = paxRecord('path', rel);
  const short = ('pax' + Buffer.from(rel).reduce((a, c) => (a * 31 + c) >>> 0, 7)).slice(0, 90);
  return [header('PaxHeaders/' + short, data.length, mtime, 0o644, 'x'), data, padTo(data.length), header(short, size, mtime, mode, '0')];
}

// Readable stream of a tar archive for plan.files. onBytes(n) is called as file data is produced.
function createTarStream(root, files, { onBytes = () => {} } = {}) {
  async function* gen() {
    for (const f of files) {
      let fh;
      try { fh = await fs.promises.open(path.join(root, ...f.rel.split('/')), 'r'); } catch { continue; }
      try {
        const st = await fh.stat();
        const probe = Buffer.alloc(2);
        await fh.read(probe, 0, 2, 0);
        const mode = probe.toString('latin1') === '#!' ? 0o755 : 0o644;
        for (const h of entryHeaders(f.rel, st.size, Math.floor(st.mtimeMs / 1000), mode)) yield h;
        let left = st.size, pos = 0;
        while (left > 0) {
          const buf = Buffer.alloc(Math.min(65536, left));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          const chunk = bytesRead === buf.length ? buf : Buffer.concat([buf.subarray(0, bytesRead), Buffer.alloc(buf.length - bytesRead)]);  // file shrank: pad
          pos += buf.length; left -= buf.length;
          onBytes(chunk.length);
          yield chunk;
        }
        yield padTo(st.size);
      } finally { await fh.close(); }
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  return Readable.from(gen(), { objectMode: false });
}

/* ---------- reader ---------- */
const readOct = (b, off, len) => {
  if (b[off] & 0x80) { let v = 0; for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i]; return v; }   // base-256
  const s = b.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
};
const cstr = (b, off, len) => b.toString('utf8', off, off + len).replace(/\0.*$/, '');

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('latin1', i, sp), 10);
    if (!(len > 0)) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);   // utf8 slice by bytes then decode
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// push(chunk) feeds bytes. onFile(name, size) returns null to skip, or a sink {write(buf), end()}.
class TarReader {
  constructor(onFile) { this.onFile = onFile; this.buf = Buffer.alloc(0); this.state = 'header'; this.meta = {}; this.global = {}; this.zeros = 0; this.done = false; this.entries = 0; }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.done) { this.buf = Buffer.alloc(0); return; }
      if (this.state === 'padding') {
        const k = Math.min(this.skipPad, this.buf.length);
        this.buf = this.buf.subarray(k); this.skipPad -= k;
        if (this.skipPad > 0) return;
        this.state = 'header';
        continue;
      }
      if (this.state === 'header') {
        if (this.buf.length < BLOCK) return;
        const h = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (h.every((x) => x === 0)) { if (++this.zeros >= 2) this.done = true; continue; }
        this.zeros = 0;
        this.beginEntry(h);
      } else if (this.state === 'collect') {
        const need = this.size + this.pad;
        if (this.buf.length < need) return;
        this.collected = this.buf.subarray(0, this.size);
        this.buf = this.buf.subarray(need);
        this.endCollect();
      } else {   // stream or skip
        const take = Math.min(this.buf.length, this.left);
        if (take) { if (this.sink) this.sink.write(this.buf.subarray(0, take)); this.left -= take; this.buf = this.buf.subarray(take); }
        if (this.left > 0) return;
        if (this.sink) { this.sink.end(); this.sink = null; }
        this.skipPad = this.pad; this.state = 'padding';
      }
    }
  }

  beginEntry(h) {
    const type = String.fromCharCode(h[156] || 0x30);
    let size = readOct(h, 124, 12);
    let name = cstr(h, 0, 100);
    if (h.toString('latin1', 257, 262) === 'ustar' && h[262] === 0) { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
    this.size = size; this.pad = (BLOCK - (size % BLOCK)) % BLOCK; this.type = type;
    if (['x', 'g', 'L', 'K'].includes(type)) { if (size > 1 << 20) throw new Error('tar metadata too large'); this.state = 'collect'; return; }
    const px = { ...this.global, ...this.meta };
    if (px.path) name = px.path;
    if (px.size) { size = parseInt(px.size, 10); this.size = size; this.pad = (BLOCK - (size % BLOCK)) % BLOCK; }
    if (this.meta.longname) name = this.meta.longname;
    this.meta = {};
    this.entries++;
    this.left = size;
    this.sink = (type === '0' || type === '\0') ? this.onFile(name, size) : null;
    this.state = 'stream';
  }

  endCollect() {
    if (this.type === 'x') Object.assign(this.meta, parsePax(this.collected));
    else if (this.type === 'g') Object.assign(this.global, parsePax(this.collected));
    else if (this.type === 'L') this.meta.longname = this.collected.toString('utf8').replace(/\0.*$/s, '');
    this.state = 'header';
  }
}

module.exports = { scanFolder, createTarStream, TarReader, BLOCK };
