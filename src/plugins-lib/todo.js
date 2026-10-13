'use strict';
// TODO/FIXME/HACK/XXX scanner. Async, yields to the event loop, bounded in files, size and results.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage', '.cache', '.gradle', 'vendor', 'bin', 'obj']);
const BINARY_EXT = new Set('png jpg jpeg gif bmp ico webp svgz pdf zip gz tgz 7z rar tar exe dll so dylib bin obj o a lib class jar war wasm woff woff2 ttf otf eot mp3 mp4 mov avi mkv wav ogg flac psd sqlite db lock map min.js pyc'.split(' '));
const TAGS = ['TODO', 'FIXME', 'HACK', 'XXX'];

const tick = () => new Promise((r) => setImmediate(r));

// opts: {root, dir?, tags?, maxFiles, maxMatches, maxBytes, isCancelled(), onProgress(scanned)}
async function scan(opts) {
  const root = path.resolve(opts.root);
  const start = path.resolve(opts.dir || root);
  const tags = (opts.tags && opts.tags.length ? opts.tags : TAGS).filter((t) => TAGS.includes(t));
  const maxFiles = opts.maxFiles || 20000, maxMatches = opts.maxMatches || 2000, maxBytes = opts.maxBytes || 1000000;
  const re = new RegExp(`\\b(${tags.join('|')})\\b(?:\\(([^)]{0,40})\\))?[:\\s-]*(.*)$`);
  const quick = new RegExp(`\\b(?:${tags.join('|')})\\b`);
  const items = [];
  let scanned = 0, truncated = false, skipped = 0;
  let slice = Date.now();
  const stack = [start];
  while (stack.length && !truncated) {
    if (opts.isCancelled && opts.isCancelled()) break;
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (BINARY_EXT.has(ext) || e.name.endsWith('.min.js')) { skipped++; continue; }
      if (scanned >= maxFiles) { truncated = true; break; }
      scanned++;
      try {
        const st = await fs.promises.stat(abs);
        if (st.size > maxBytes) { skipped++; continue; }
        const buf = await fs.promises.readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) { skipped++; continue; }
        const text = buf.toString('utf8');
        if (quick.test(text)) {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            const body = m[3].replace(/\s*(\*\/|-->)\s*$/, '').trim().slice(0, 200);
            items.push({ file: path.relative(root, abs).replace(/\\/g, '/'), abs, line: i + 1, tag: m[1], owner: m[2] || '', text: body });
            if (items.length >= maxMatches) { truncated = true; break; }
          }
        }
      } catch { /* unreadable: skip */ }
      if (Date.now() - slice > 8) {            // never hog the event loop for more than a few ms
        if (opts.onProgress) opts.onProgress(scanned);
        await tick();
        slice = Date.now();
        if (opts.isCancelled && opts.isCancelled()) break;
      }
      if (truncated) break;
    }
  }
  items.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { items, scanned, skipped, truncated, cancelled: !!(opts.isCancelled && opts.isCancelled()) };
}

function format(result, max = 200) {
  if (!result.items.length) return `No TODO/FIXME/HACK/XXX found (${result.scanned} files scanned).`;
  const lines = result.items.slice(0, max).map((i) => `${i.file}:${i.line}: ${i.tag}${i.owner ? '(' + i.owner + ')' : ''}: ${i.text}`);
  const more = result.items.length > max ? `\n...and ${result.items.length - max} more` : '';
  return `${result.items.length} item(s) in ${result.scanned} files${result.truncated ? ' (limit reached, results are partial)' : ''}:\n${lines.join('\n')}${more}`;
}

module.exports = { scan, format, TAGS };
