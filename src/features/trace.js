// feature: trace (main process). The owner's window onto the communication line (src/comms.js): every message between
// agents, every tool call and every approval from team mode, the orchestrator and anything else that uses the line.
// The record is kept in memory, in a JSONL file under <userData>/traces, and can be exported. verify() checks the hash chain.
// Channels: feat:trace:list verify clear export info openFolder. Event: feat:trace:entries (batched).
const comms = require('../comms');

module.exports = function (ctx) {
  const { fs, path } = ctx;
  const dir = path.join(ctx.dataDir, 'traces');
  let unsub = null;
  let pending = [];
  let timer = null;

  function fresh() {
    if (unsub) unsub();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const line = comms.resetShared({
      file: path.join(dir, `trace-${stamp}.jsonl`), clip: 600,
      echo: process.env.FABER_TRACE_CONSOLE ? (s) => console.log(s) : null,    // set FABER_TRACE_CONSOLE=1 to also print it in the terminal that started Faber
    });
    unsub = line.on((e) => {
      pending.push(e);
      if (!timer) timer = setTimeout(() => { timer = null; const batch = pending; pending = []; ctx.send('feat:trace:entries', batch); }, 120);
    });
    return line;
  }
  fresh();
  // keep only the 30 newest trace files
  try {
    const files = fs.readdirSync(dir).filter((f) => /^trace-.*\.jsonl$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* no traces yet */ }

  const H = ctx.handle;
  H('feat:trace:list', (since, limit) => {
    const line = comms.shared();
    const all = line.entries();
    const n = Math.max(1, Math.min(5000, Number(limit) || 500));
    const from = Number(since) || 0;
    const out = from ? all.filter((e) => e.seq > from) : all.slice(-n);
    return { entries: out, count: line.count(), head: line.head(), file: line.file(), summary: line.summary() };
  });
  H('feat:trace:verify', () => {
    const line = comms.shared();
    const mem = line.verify();
    let disk = null;
    const f = line.file();
    if (f) {
      try { disk = comms.verify(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); } catch (e) { disk = { ok: false, reason: 'the trace file could not be read: ' + e.message }; }
    }
    return { memory: mem, file: disk };
  });
  H('feat:trace:clear', () => { fresh(); return { file: comms.shared().file() }; });
  H('feat:trace:info', () => ({ dir, file: comms.shared().file(), count: comms.shared().count() }));
  H('feat:trace:openFolder', async () => { try { fs.mkdirSync(dir, { recursive: true }); await require('electron').shell.openPath(dir); } catch { /* ignore */ } return true; });
  H('feat:trace:export', async (format) => {
    const line = comms.shared();
    const text = format === 'text' ? line.entries().map((e) => line.format(e, { full: true })).join('\n') + '\n' : line.toJSONL();
    const r = await ctx.dialog.showSaveDialog(ctx.window(), { defaultPath: path.join(ctx.workspace() || ctx.os.homedir(), format === 'text' ? 'faber-trace.txt' : 'faber-trace.jsonl') });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
};
