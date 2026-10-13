// feature: agents (main process). Many chat sessions, each with its own agent loop, sharing the open folder.
// The renderer talks to it through feat:agents:* channels and the feat:agents:event stream.
module.exports = function (ctx) {
  const { fs, path } = ctx;
  const agentMod = require('../agent');
  const { createAgent, runSubAgent, repairConv, debugEmit } = agentMod;

  const DIR = path.join(ctx.dataDir, 'agents');
  const MAX_LOG = 5000;
  const sessions = new Map();          // id -> session; insertion order is the tab order
  let active = null;
  let seq = 0;
  let saveTimer = null;

  const rid = () => Math.random().toString(36).slice(2, 10);
  const EFFORTS = ['low', 'medium', 'high'];
  const MODES = ['ask', 'edits', 'auto'];
  const oneLine = (t, n = 90) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

  /* ---------- feature settings ---------- */
  const cfg = () => {
    const f = ctx.featureSettings('agents') || {};
    const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : d; };
    return {
      maxConcurrent: num(f.maxConcurrent, 2, 1, 8),
      persist: f.persist !== false,
      subSteps: num(f.subSteps, 12, 1, 40),
      subTimeoutSec: num(f.subTimeoutSec, 600, 1, 7200),
    };
  };

  /* ---------- concurrency gate: limits simultaneous model requests, the rest wait as "queued" ---------- */
  const waiters = [];
  let inflight = 0;
  const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  function pump() {
    while (inflight < cfg().maxConcurrent && waiters.length) {
      const w = waiters.shift();
      w.cleanup();
      inflight++;
      setWaiting(w.sid, false);
      w.resolve(releaser());
    }
  }
  function releaser() {
    let done = false;
    return () => { if (!done) { done = true; inflight--; pump(); } };
  }
  function gate(sid, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortErr());
      if (inflight < cfg().maxConcurrent && !waiters.length) { inflight++; return resolve(releaser()); }
      const w = { sid, resolve, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          setWaiting(sid, false);
          reject(abortErr());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        w.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      waiters.push(w);
      setWaiting(sid, true);
    });
  }
  function setWaiting(sid, v) {
    const s = sessions.get(sid);
    if (s) { s.waiting = v; refresh(s); }
  }

  /* ---------- sessions ---------- */
  function newSession(p = {}) {
    const g = ctx.getSettings();
    const s = {
      id: p.id || 'a' + Date.now().toString(36) + rid().slice(0, 3),
      name: String(p.name || '').trim().slice(0, 60) || `Agent ${++seq}`,
      model: p.model || g.model, effort: EFFORTS.includes(p.effort) ? p.effort : g.effort,
      mode: MODES.includes(p.mode) ? p.mode : g.mode,
      created: p.created || Date.now(), updated: p.updated || Date.now(),
      status: 'idle', preview: p.preview || '', log: p.log || [], pending: new Map(),
      running: false, waiting: false, errored: false, dirty: true, cur: '', lastText: '',
    };
    if (!EFFORTS.includes(s.effort)) s.effort = 'medium';
    if (!MODES.includes(s.mode)) s.mode = 'ask';
    s.agent = createAgent({
      id: s.id, conv: p.conv ? repairConv(p.conv) : [],
      getSettings: () => ({ ...ctx.effective(), model: s.model, effort: s.effort, mode: s.mode }),
      approve: makeApprove(s), emit: (ev) => emitFor(s, ev), gate,
      onChange: () => touch(s),
    });
    sessions.set(s.id, s);
    return s;
  }

  const info = (s) => ({
    id: s.id, name: s.name, model: s.model, effort: s.effort, mode: s.mode, status: s.status,
    preview: s.preview, created: s.created, updated: s.updated, messages: s.agent.transcript().length,
  });
  const listInfo = () => [...sessions.values()].map(info);
  const pushList = () => ctx.send('feat:agents:event', { type: 'sessions', sessions: listInfo(), active });
  const need = (sid) => {
    const s = sessions.get(String(sid));
    if (!s) throw new Error('No such agent.');
    return s;
  };

  function deriveStatus(s) {
    if (s.pending.size) return 'approval';
    if (s.waiting) return 'queued';
    if (s.running) return 'working';
    return s.errored ? 'error' : 'idle';
  }
  function refresh(s) {
    const st = deriveStatus(s);
    if (st === s.status) return;
    s.status = st;
    ctx.send('feat:agents:event', { type: 'status', session: s.id, status: st, preview: s.preview });
  }

  /* ---------- events: log them (for restoring the chat) and forward them ---------- */
  function record(s, ev) {
    if (ev.type === 'file_changed' || ev.type === 'tool_output') return;
    const last = s.log[s.log.length - 1];
    if ((ev.type === 'token' || ev.type === 'thinking') && last && last.type === ev.type && last.sub === ev.sub) {
      last.text += ev.text;
    } else {
      s.log.push({ ...ev, session: undefined });
      if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG + 500);
    }
    touch(s);
  }
  function emitFor(s, ev) {
    record(s, ev);
    ctx.send('feat:agents:event', ev);
    if (ev.sub) return;
    if (ev.type === 'token') s.cur += ev.text;
    if (ev.type === 'turn_end' || ev.type === 'tool_start' || ev.type === 'done' || ev.type === 'error') {
      if (s.cur.trim()) { s.lastText = s.cur; s.preview = oneLine(s.lastText); }
      s.cur = '';
      if (ev.type === 'error') { s.errored = true; s.preview = oneLine(ev.message); }
      if (ev.type !== 'turn_end') ctx.send('feat:agents:event', { type: 'status', session: s.id, status: s.status, preview: s.preview });
    }
  }

  function makeApprove(s) {
    return (kind, title, detail) => {
      if (kind === 'edit' && s.mode !== 'ask') return Promise.resolve(true);
      return new Promise((resolve) => {
        const id = rid();
        s.pending.set(id, resolve);
        debugEmit({ kind: 'approval', state: 'asked', session: s.id, approvalKind: kind, title });
        emitFor(s, { session: s.id, type: 'approval', id, kind, title, detail });
        refresh(s);
      });
    };
  }
  function answer(s, id, ok, why) {
    const r = s.pending.get(id);
    if (!r) return false;
    s.pending.delete(id);
    const entry = [...s.log].reverse().find((e) => e.type === 'approval' && e.id === id);
    if (entry) { entry.ok = !!ok; touch(s); }
    debugEmit({ kind: 'approval', state: ok ? 'allowed' : 'denied', session: s.id, title: entry && entry.title, reason: why });
    ctx.send('feat:agents:event', { type: 'approval_result', session: s.id, id, ok: !!ok });
    r(!!ok);
    refresh(s);
    return true;
  }
  function stopSession(s) {
    for (const id of [...s.pending.keys()]) answer(s, id, false, 'stopped');
    s.agent.stop();
  }

  /* ---------- persistence: sessions + transcripts under <userData>/agents ---------- */
  function touch(s) {
    s.dirty = true;
    s.updated = Date.now();
    if (!saveTimer && cfg().persist) saveTimer = setTimeout(flush, 1500);
  }
  const writeJson = (file, data) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!cfg().persist) return;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      for (const s of sessions.values()) {
        if (!s.dirty) continue;
        writeJson(path.join(DIR, s.id + '.json'), { conv: s.agent.transcript(), log: s.log });
        s.dirty = false;
      }
      const meta = [...sessions.values()].map((s) => ({ id: s.id, name: s.name, model: s.model, effort: s.effort, mode: s.mode, created: s.created, updated: s.updated, preview: s.preview }));
      writeJson(path.join(DIR, 'index.json'), { version: 1, active, seq, sessions: meta });
    } catch (e) { console.error('agents: could not save', e.message); }
  }
  function load() {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
      seq = Number(idx.seq) || 0;
      for (const m of idx.sessions || []) {
        let body = {};
        try { body = JSON.parse(fs.readFileSync(path.join(DIR, m.id + '.json'), 'utf8')); } catch { /* start empty */ }
        const log = Array.isArray(body.log) ? body.log : [];
        const s = newSession({ ...m, conv: Array.isArray(body.conv) ? body.conv : [], log });
        s.dirty = false;
      }
      if (sessions.has(idx.active)) active = idx.active;
    } catch { /* first run or unreadable: start fresh */ }
    if (!sessions.size) newSession();
    if (!active) active = sessions.keys().next().value;
  }
  function removeFiles(id) {
    try { fs.rmSync(path.join(DIR, id + '.json'), { force: true }); } catch { /* gone */ }
  }

  /* ---------- IPC ---------- */
  const H = ctx.handle;
  H('feat:agents:state', () => ({ sessions: listInfo(), active, settings: cfg() }));
  H('feat:agents:log', (sid) => need(sid).log);
  H('feat:agents:settings', () => cfg());
  H('feat:agents:poke', () => { pump(); return cfg(); });
  H('feat:agents:flush', () => { flush(); return true; });

  H('feat:agents:create', (p) => {
    const s = newSession(p && typeof p === 'object' ? p : {});
    active = s.id;
    touch(s);
    pushList();
    return info(s);
  });
  H('feat:agents:rename', (sid, name) => {
    const s = need(sid);
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error('Name cannot be empty.');
    s.name = n;
    touch(s);
    pushList();
    return info(s);
  });
  H('feat:agents:update', (sid, patch) => {
    const s = need(sid);
    patch = patch || {};
    if (patch.model !== undefined) {
      const m = String(patch.model).trim();
      if (!m || m.length > 200) throw new Error('Invalid model name.');
      s.model = m;
    }
    if (patch.effort !== undefined) {
      if (!EFFORTS.includes(patch.effort)) throw new Error('Effort must be low, medium or high.');
      s.effort = patch.effort;
    }
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) throw new Error('Mode must be ask, edits or auto.');
      s.mode = patch.mode;
    }
    touch(s);
    pushList();
    return info(s);
  });
  H('feat:agents:setActive', (sid) => {
    need(sid);
    active = String(sid);
    flushSoon();
    return true;
  });
  const flushSoon = () => { if (!saveTimer && cfg().persist) saveTimer = setTimeout(flush, 1500); };
  H('feat:agents:close', (sid) => {
    const s = need(sid);
    stopSession(s);
    const ids = [...sessions.keys()];
    const at = ids.indexOf(s.id);
    sessions.delete(s.id);
    removeFiles(s.id);
    if (!sessions.size) { const n = newSession(); active = n.id; }
    else if (active === s.id) active = ids[at + 1] && sessions.has(ids[at + 1]) ? ids[at + 1] : [...sessions.keys()].pop();
    flushSoon();
    pushList();
    return { active };
  });

  H('feat:agents:send', (sid, text) => {
    const s = need(sid);
    text = String(text || '').trim();
    if (!text) throw new Error('Empty message.');
    if (s.running) throw new Error('This agent is already working. Stop it first.');
    s.running = true;
    s.errored = false;
    s.cur = '';
    s.preview = oneLine(text);
    record(s, { type: 'user', text });
    refresh(s);
    s.agent.send(text).catch((e) => emitFor(s, { type: 'error', message: e.message })).finally(() => {
      s.running = false;
      refresh(s);
      touch(s);
      pushList();
    });
    return { ok: true };
  });
  H('feat:agents:stop', (sid) => { stopSession(need(sid)); return true; });
  H('feat:agents:stopAll', () => { for (const s of sessions.values()) stopSession(s); return true; });
  H('feat:agents:approve', (sid, id, ok) => answer(need(sid), String(id), !!ok));
  H('feat:agents:clear', (sid) => {
    const s = need(sid);
    stopSession(s);
    s.agent.clear();
    s.log = [];
    s.preview = '';
    s.errored = false;
    refresh(s);
    touch(s);
    pushList();
    return true;
  });
  H('feat:agents:compact', async (sid) => {
    const s = need(sid);
    if (s.running) throw new Error('Stop the current run first.');
    s.running = true;
    refresh(s);
    try { return await s.agent.compact(); } finally { s.running = false; refresh(s); touch(s); }
  });
  H('feat:agents:transcript', (sid) => need(sid).agent.transcript());
  H('feat:agents:deleteHistory', () => {
    for (const s of sessions.values()) { stopSession(s); s.agent.clear(); s.log = []; s.preview = ''; s.errored = false; refresh(s); }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* nothing saved */ }
    for (const s of sessions.values()) s.dirty = true;
    flushSoon();
    pushList();
    return true;
  });

  /* ---------- delegate_task: lets the main agent hand a job to a sub-agent ---------- */
  const { fn, str } = ctx.tools.helpers;
  ctx.tools.registerTool(
    fn('delegate_task',
      'Hand a self-contained job to a sub-agent that works in a fresh context and returns a final report. ' +
      'Roles: researcher (read-only investigation), reviewer (read-only code review), coder (can edit files and run commands, with the user\'s approval). ' +
      'The sub-agent cannot see this conversation, so put everything it needs in the task.',
      {
        role: { type: 'string', enum: ['researcher', 'coder', 'reviewer'], description: 'Which kind of sub-agent' },
        task: str('Complete description of the job and what the final report should contain'),
      }, ['role', 'task']),
    (args, tctx) => runSubAgent(tctx, args, { maxSteps: cfg().subSteps, timeoutSec: cfg().subTimeoutSec }),
  );

  load();
  ctx.app.on('before-quit', flush);
};
