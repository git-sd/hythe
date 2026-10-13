// feature: orchestra (main process). The central orchestrator (src/orchestrator.js) inside the app: a conductor plans, specialist
// agents on DIFFERENT models do the steps, everything said goes through the shared communication line (see feature "trace").
// Agents here are headless (no chat tabs); the owner follows them in the Trace panel and answers approvals in the Orchestra tab.
// Channels: feat:orchestra:state roster run stop approve, and the talk-to-the-orchestrator chat: chat-state chat-send chat-reset.
// Events: feat:orchestra:state, feat:orchestra:chat.
const comms = require('../comms');
const { createOrchestrator } = require('../orchestrator');
const { resolveRoster, ROLES } = require('../model-roster');
const { createChat } = require('../orchestrator-chat');

module.exports = function (ctx) {
  const host = () => String(ctx.getSettings().host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const cfg = () => ctx.featureSettings('orchestra') || {};
  let job = null;                 // { orch, state }
  const pending = new Map();      // approval id -> { resolve, info }
  let seq = 0;

  /* ---------- installed models (with capabilities, so embedding-only models are never picked) ---------- */
  let instCache = { t: 0, v: null };
  async function installed(force) {
    if (!force && instCache.v && Date.now() - instCache.t < 20000) return instCache.v;     // every chat message asks; do not ask Ollama about every model each time
    const v = await installed0();
    if (v.ok) instCache = { t: Date.now(), v };
    return v;
  }
  async function installed0() {
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
  async function roster(force) {
    const inst = await installed(force);
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
    // a team made in the chat (any number of agents, any mix) or the classic four roles from the form
    const agents = Array.isArray(p.agents) && p.agents.length
      ? p.agents.map((a) => ({ name: String(a.name), role: a.role, model: a.model || pickM(a.role), ...(a.focus ? { focus: String(a.focus) } : {}) }))
      : ['coder', 'reviewer', 'fast'].map((role) => ({ name: role, role, model: pickM(role) }));
    if (!(Array.isArray(p.agents) && p.agents.length) && p.researcher) agents.push({ name: 'researcher', role: 'researcher', model: pickM('researcher') });
    const mode = ['ask', 'edits', 'auto'].includes(p.mode) ? p.mode : 'edits';
    const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : d; };
    if (p.models) ctx.setFeatureSettings('orchestra', { overrides: { ...cfg().overrides, ...p.models } });
    const line = comms.shared();
    const orch = createOrchestrator({
      host: host(), workspace: ws, line, mode, effort: ctx.getSettings().effort, numCtx: ctx.getSettings().numCtx || 8192, features: ctx.getSettings().features || {},
      concurrency: num(p.concurrency, 1, 1, 4), maxRework: num(p.maxRework, 1, 0, 3), stepTimeoutSec: num(p.stepTimeoutSec, 900, 30, 7200),
      roster: { conductor: { model: p.conductor || pickM('conductor') }, agents },
      installed: r.installed.map((m) => m.name), fallbackModel: r.primary,
      approve: (kind, title, detail) => approve(kind, title, detail),
    });
    job = { orch, running: true, phase: 'starting', result: null, task };
    orch.onState((st) => { job.phase = st.phase; job.result = JSON.parse(JSON.stringify(st.result)); push(); if (p.onState) { try { p.onState(st); } catch { /* the chat must not break a run */ } } });
    push();
    const out = await orch.run(task).catch((e) => ({ ok: false, status: 'error', error: e.message, steps: [], final: '' }));
    job.running = false; job.phase = 'done'; job.result = out;
    denyAll();
    push();
    return out;
  }

  // The owner talks to one agent outside any plan.
  async function ask(name, text, team, conductorModel) {
    if (job && job.running) throw new Error('The orchestra is already working. Stop it first.');
    const ws = ctx.workspace();
    if (!ws) throw new Error('Open a project folder first: the agents work on its files.');
    const r = await roster();
    if (!r.ok) throw new Error('Cannot reach Ollama. Start it first.');
    const orch = createOrchestrator({
      host: host(), workspace: ws, line: comms.shared(), mode: chat ? chat.state().mode : 'edits', effort: ctx.getSettings().effort, numCtx: ctx.getSettings().numCtx || 8192, features: ctx.getSettings().features || {},
      roster: { conductor: { model: conductorModel || (r.roster.find((x) => x.role === 'conductor') || {}).model || r.primary }, agents: team.map((a) => ({ ...a })) },
      installed: r.installed.map((m) => m.name), fallbackModel: r.primary,
      approve: (kind, title, detail) => approve(kind, title, detail),
    });
    job = { orch, running: true, phase: 'asking', result: null, task: `Ask ${name}: ${String(text).slice(0, 200)}` };
    push();
    try { return await orch.ask(name, text); } finally { job.running = false; job.phase = 'done'; denyAll(); push(); }
  }
  function stopAll() { if (job && job.running) { job.orch.stop(); denyAll(); } }

  /* ---------- talking to the orchestrator ---------- */
  let chat = null, saveTimer = null;
  const clipMsg = (m) => ({ ...m, text: String(m.text).slice(0, 4000) });
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!chat) return;
      const st = chat.state();
      ctx.setFeatureSettings('orchestra', { chat: { team: st.team, conductor: st.conductor, concurrency: st.concurrency, mode: st.mode, history: st.history.slice(-40).map(clipMsg) } });
    }, 400);
  }
  const chatPub = () => { const st = chat.state(); return { team: st.team, conductor: st.conductor, busy: st.busy, concurrency: st.concurrency, mode: st.mode, pendingTask: st.pendingTask, history: st.history }; };
  const chatPush = () => { ctx.send('feat:orchestra:chat', chatPub()); persist(); };
  function getChat() {
    if (chat) return chat;
    const line = comms.shared();
    chat = createChat({
      getEnv: async () => { const inst = await installed(); return { ok: inst.ok, installed: inst.models, primary: ctx.getSettings().model, ramTotal: ctx.os.totalmem(), workspace: ctx.workspace() }; },
      startRun: (job2) => run({ task: job2.task, agents: job2.team, conductor: job2.conductor, concurrency: job2.concurrency, mode: job2.mode, onState: job2.onState }),
      ask,
      stop: stopAll,
      // the conversation itself is on the line too: what the owner said, what the orchestrator answered
      onMessage: (m) => {
        line.log(m.from === 'you'
          ? { from: 'owner', to: 'orchestrator', kind: 'task', text: m.text, meta: { chat: true } }
          : { from: 'orchestrator', to: 'owner', kind: m.kind === 'final' ? 'final' : 'result', text: m.text, meta: { chat: true, shown: m.kind } });
        chatPush();
      },
      onChange: chatPush,
    }, cfg().chat || {});
    return chat;
  }

  const H = ctx.handle;
  H('feat:orchestra:chat-state', () => { getChat(); return chatPub(); });
  // returns at once; the answer arrives as events (a run can take many minutes)
  H('feat:orchestra:chat-send', (text) => {
    const t = String(text || '').slice(0, 6000);
    if (!t.trim()) return { accepted: false };
    getChat().handle(t).catch((e) => { try { ctx.send('feat:orchestra:chat', { ...chatPub(), error: e.message }); } catch { /* window closed */ } });
    return { accepted: true };
  });
  H('feat:orchestra:chat-sendWait', async (text) => { const c = getChat(); await c.handle(String(text || '').slice(0, 6000)); await c.idle(); return chatPub(); });   // used by tests
  H('feat:orchestra:chat-reset', () => { if (job && job.running) throw new Error('A task is running. Stop it first.'); chat = null; ctx.setFeatureSettings('orchestra', { chat: {} }); getChat(); return chatPub(); });
  H('feat:orchestra:state', () => pub());
  H('feat:orchestra:roster', () => roster(true));
  // starts the run and returns at once; progress comes as events, the outcome in the state
  H('feat:orchestra:run', (p) => {
    run(p).catch((e) => { if (job) { job.running = false; job.phase = 'done'; job.result = { ok: false, status: 'error', error: e.message, steps: [], final: '' }; } push(); });
    return { started: true };
  });
  H('feat:orchestra:runWait', (p) => run(p));       // used by tests: resolves with the final result
  H('feat:orchestra:stop', () => { stopAll(); return pub(); });
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
