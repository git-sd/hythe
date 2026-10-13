// feature: background (main process). One cheap round trip for the periodic refresher:
// Ollama reachability + model list, and change signatures for the open files and expanded folders.
const crypto = require('crypto');

module.exports = function (ctx) {
  const { fs, path } = ctx;

  async function ollama() {
    const host = ctx.getSettings().host;
    try {
      const r = await fetch(host + '/api/tags', { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return { up: false, models: [], error: 'HTTP ' + r.status };
      const j = await r.json();
      return { up: true, models: (j.models || []).map((m) => String(m.name)) };
    } catch (e) {
      return { up: false, models: [], error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  const list = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.length > 0 && p.length < 1024).slice(0, 200) : []);

  async function fileSig(p) {
    try { const st = await fs.promises.stat(p); return st.isFile() ? st.mtimeMs + ':' + st.size : null; } catch { return null; }
  }

  // Same listing the file tree shows (folders first is irrelevant here: the signature is order independent).
  async function dirSig(dir, showHidden) {
    try {
      const names = (await fs.promises.readdir(path.resolve(dir), { withFileTypes: true }))
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .map((e) => e.name + (e.isDirectory() ? '/' : ''))
        .sort();
      return crypto.createHash('md5').update(names.join('\n')).digest('hex') + ':' + names.length;
    } catch { return null; }
  }

  ctx.handle('feat:background:ping', async (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const files = list(o.paths), dirs = list(o.dirs);
    const showHidden = !!ctx.getSettings().showHidden;
    const [oll, fsigs, dsigs] = await Promise.all([
      ollama(),
      Promise.all(files.map(fileSig)),
      Promise.all(dirs.map((d) => dirSig(d, showHidden))),
    ]);
    return {
      ...oll, host: ctx.getSettings().host, at: Date.now(),
      files: Object.fromEntries(files.map((p, i) => [p, fsigs[i]])),
      dirs: Object.fromEntries(dirs.map((d, i) => [d, dsigs[i]])),
    };
  });
};
