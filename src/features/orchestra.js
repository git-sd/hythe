// feature: orchestra (main process). The central orchestrator (src/orchestrator.js) inside the app: a conductor plans, specialist
// agents on DIFFERENT models do the steps, everything said goes through the shared communication line (see feature "trace").
// Agents here are headless (no chat tabs); the owner follows them in the Trace panel and answers approvals in the Orchestra tab.
// Channels: feat:orchestra:state roster run stop approve. Events: feat:orchestra:state, feat:orchestra:approval.
const comms = require('../comms');
const { createOrchestrator } = require('../orchestrator');
const { resolveRoster, ROLES } = require('../model-roster');

module.exports = function (ctx) {
  const host = () => String(ctx.getSettings().host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const cfg = () => ctx.featureSettings('orchestra') || {};
  let job = null;                 // { orch, state }
  const pending = new Map();      // approval id -> { resolve, info }
  let seq = 0;

  /* ---------- installed models (with capabilities, so embedding-only models are never picked) ---------- */
  async function installed() {
    const j = async (p, body) => {
      const res = await fetch(host() + p, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('Ollama error ' + res.status);
      return res.json();
    };
    let tags;
    try { tags = (await j('/api/tags')).models || []; } catch { return { ok: false, models: [] }; }
    const models = await Promise.all(tags.map(async (m) => {
      let caps = null;
      try { const s = await j('/api/show', { model: m.name }); caps = Array.isArray(s.capabilities) ? s.capabilities : null; } catch { /* unknown capabilities */ }
      return { name: m.name, size: m.size || 0, caps };
    }));
    return { ok: true, models };
  }
  async function roster() {
    const inst = await installed();
    const primary = ctx.getSettings().model;
    const saved = cfg().overrides || {};
    const os = ctx.os;
    const r = resolveRoster({ installed: inst.models, primary, overrides: saved, ramTotal: os.totalmem() });
    return { ok: inst.ok, installed: inst.models.map((m) => ({ name: m.name, size: m.size, caps: m.caps })), roster: r.roster, suggestions: r.suggestions, overrides: saved, primary };
  }

  const pub = (extra = {}) => ({
    running: !!job && job.running, phase: job ? job.phase : 'idle', result: job ? job.result : null, task: job ? job.task : '',
    approvals: [...pending.entries()].map(([id, p]) => ({ id, ...p.info })), ...extra,
  });
  const push = () => ctx.send('feat:orchestra:state', pub());

  function approve(kind, title, detail) {
    return new Promise((resolve) => {
      const id = 'ap' + (++seq);
      pending.set(id, { resolve, info: { kind, title, detail: String(detail || '').slice(0, 4000) } });
      push();
    });
  }
  function denyAll() { for (const p of pending.values()) p.resolve(false); pending.clear(); }

  async function run(p) {
    p = p || {};
    if (job && job.running) throw new Error('The orchestra is already working. Stop it first.');
    const ws = ctx.workspace();
    if (!ws) throw new Error('Open a project folder first: the agents work on its files.');
    const task = String(p.task || '').trim().slice(0, 6000);
    if (!task) throw new Error('Describe the task first.');
    const r = await roster();
    if (!r.ok) throw new Error('Cannot reach Ollama. Start it first.');
    // the user's choices win; anything unset uses the resolved roster
    const pickM = (role) => (p.models && p.models[role]) || (r.roster.find((x) => x.role === role) || {}).model || r.primary;
    const agents = ['coder', 'reviewer', 'fast'].map((role) => ({ name: role, role, model: pickM(role) }));
    if (p.researcher) agents.push({ name: 'researcher', role: 'researcher', model: pickM('researcher') });
    const mode = ['ask', 'edits', 'auto'].includes(p.mode) ? p.mode : 'edits';
    const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : d; };
    ctx.setFeatureSettings('orchestra', { overrides: { ...cfg().overrides, ...(p.models || {}) } });
    const line = comms.shared();
    const orch = createOrchestrator({
      host: host(), workspace: ws, line, mode, effort: ctx.getSettings().effort, numCtx: ctx.getSettings().numCtx || 8192, features: ctx.getSettings().features || {},
      concurrency: num(p.concurrency, 1, 1, 4), maxRework: num(p.maxRework, 1, 0, 3), stepTimeoutSec: num(p.stepTimeoutSec, 900, 30, 7200),
      roster: { conductor: { model: pickM('conductor') }, agents },
      installed: r.installed.map((m) => m.name), fallbackModel: r.primary,
      approve: (kind, title, detail) => approve(kind, title, detail),
    });
    job = { orch, running: true, phase: 'starting', result: null, task };
    orch.onState((st) => { job.phase = st.phase; job.result = JSON.parse(JSON.stringify(st.result)); push(); });
    push();
    const out = await orch.run(task).catch((e) => ({ ok: false, status: 'error', error: e.message, steps: [], final: '' }));
    job.running = false; job.phase = 'done'; job.result = out;
    denyAll();
    push();
    return out;
  }

  const H = ctx.handle;
  H('feat:orchestra:state', () => pub());
  H('feat:orchestra:roster', () => roster());
  // starts the run and returns at once; progress comes as events, the outcome in the state
  H('feat:orchestra:run', (p) => {
    run(p).catch((e) => { if (job) { job.running = false; job.phase = 'done'; job.result = { ok: false, status: 'error', error: e.message, steps: [], final: '' }; } push(); });
    return { started: true };
  });
  H('feat:orchestra:runWait', (p) => run(p));       // used by tests: resolves with the final result
  H('feat:orchestra:stop', () => { if (job && job.running) { job.orch.stop(); denyAll(); } return pub(); });
  H('feat:orchestra:approve', (id, ok) => {
    const p = pending.get(String(id));
    if (!p) return false;
    pending.delete(String(id));
    p.resolve(!!ok);
    push();
    return true;
  });
  void ROLES;
};
