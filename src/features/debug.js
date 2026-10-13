// feature: debug (main process). Off by default. While on, src/agent.js reports every model request/response,
// tool call, approval and sub-agent through a sink that this file attaches. While off there is no sink at all.
module.exports = function (ctx) {
  const agentMod = require('../agent');
  const CAP = 2000;               // entries kept
  const MAX_STR = 4000;           // longest string kept inside an entry
  const MAX_ENTRY = 100 * 1024;   // largest serialized entry
  const entries = [];             // { seq, ts, kind, session, agent, summary, data }
  const lastBySession = new Map();
  let seq = 0;
  let enabled = false;

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\u2026[+${s.length - n} chars]` : s);
  function shrink(v, depth = 0) {
    if (typeof v === 'string') return clip(v, MAX_STR);
    if (v == null || typeof v !== 'object') return v;
    if (depth > 10) return '[nested too deep]';
    if (Array.isArray(v)) {
      const out = v.slice(0, 200).map((x) => shrink(x, depth + 1));
      if (v.length > 200) out.push(`\u2026[+${v.length - 200} more]`);
      return out;
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = shrink(x, depth + 1);
    return o;
  }
  function pack(ev) {
    const data = shrink(agentMod.scrub(ev));
    if (typeof data.system === 'string') data.system = clip(ev.system, 20000);
    const text = JSON.stringify(data);
    return text.length > MAX_ENTRY ? { _truncated: true, size: text.length, preview: text.slice(0, MAX_ENTRY) } : data;
  }

  const ms = (ns) => (ns ? Math.round(ns / 1e6) : 0);
  function summarize(e) {
    switch (e.kind) {
      case 'request': return `${e.model}  ${e.messageCount} msgs  ~${e.promptTokensEst} tok  ${(e.tools || []).length} tools${e.retry ? '  (' + e.retry + ')' : ''}`;
      case 'response': return `${e.eval_count ?? '?'} tok out  ${e.tokens_per_sec ?? '?'} t/s  prompt ${e.prompt_eval_count ?? '?'}  ${e.done_reason || ''}`.trim();
      case 'tool': return `${e.name}  ${e.ok ? 'ok' : 'error'}  ${e.durationMs} ms  ${e.resultLength} chars`;
      case 'approval': return `${e.state}  ${e.title || ''}`;
      case 'subagent': return `${e.state}  ${e.role}  ${String(e.task || (e.ok ? 'ok' : e.error || '')).replace(/\s+/g, ' ').slice(0, 80)}`;
      case 'error': return String(e.message || '').slice(0, 160);
      default: return String(e.note || e.kind);
    }
  }

  function sink(ev) {
    const sid = ev.session || '';
    if (sid) {
      const l = lastBySession.get(sid) || {};
      if (ev.kind === 'request' && !ev.depth) { l.system = clip(ev.system || '', 100000); l.model = ev.model; l.numCtx = ev.options && ev.options.num_ctx; l.est = ev.promptTokensEst; }
      if (ev.kind === 'response' && !ev.depth && ev.ctxUsed) { l.used = ev.ctxUsed; l.numCtx = ev.numCtx || l.numCtx; }
      lastBySession.set(sid, l);
    }
    const e = { seq: ++seq, ts: Date.now(), kind: String(ev.kind || 'note'), session: sid, agent: ev.agent || ev.role || '', summary: summarize(ev) };
    entries.push({ ...e, data: pack(ev) });
    if (entries.length > CAP) entries.splice(0, entries.length - CAP);
    ctx.send('feat:debug:entry', e);
  }

  function setEnabled(on) {
    enabled = !!on;
    agentMod.setDebugSink(enabled ? sink : null);
    ctx.setFeatureSettings('debug', { enabled });
    return state();
  }
  const state = () => ({ enabled, count: entries.length, cap: CAP });

  const H = ctx.handle;
  H('feat:debug:get', () => state());
  H('feat:debug:set', (on) => setEnabled(on));
  H('feat:debug:list', () => entries.map(({ data, ...e }) => e));
  H('feat:debug:entry', (n) => {
    const e = entries.find((x) => x.seq === Number(n));
    if (!e) throw new Error('That entry is no longer in the log.');
    return e;
  });
  H('feat:debug:clear', () => { entries.length = 0; return state(); });
  H('feat:debug:system', (sid) => lastBySession.get(String(sid)) || null);
  H('feat:debug:context', (sid) => {
    const l = lastBySession.get(String(sid));
    return l ? { used: l.used || 0, est: l.est || 0, numCtx: l.numCtx || 0, model: l.model || '' } : null;
  });
  H('feat:debug:export', async () => {
    const win = ctx.window();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const r = await ctx.dialog.showSaveDialog(win, { defaultPath: ctx.path.join(ctx.effective().workspace, `faber-debug-${stamp}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    ctx.fs.writeFileSync(r.filePath, JSON.stringify({ exportedAt: new Date().toISOString(), count: entries.length, entries }, null, 2));
    return r.filePath;
  });

  if ((ctx.featureSettings('debug') || {}).enabled === true) setEnabled(true);
};
