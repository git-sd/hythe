// Agent loop: streams from a local Ollama server, runs tool calls, feeds results back.
// createAgent() is cheap and independent: every chat session (and every sub-agent) has its own instance.
const os = require('os');
const tools = require('./tools');
const claude = require('./claude');

const MAX_STEPS = 30;
const EFFORT = {
  low:    { think: false, temperature: 0.3, num_predict: 1024 },
  medium: { think: true,  temperature: 0.6, num_predict: 4096 },
  high:   { think: true,  temperature: 0.6, num_predict: 16384 },
};

/* ---------- sub-agent roles (depth 1 only) ---------- */
const READ_ONLY = ['read_file', 'list_dir', 'search_files'];
const ROLES = {
  researcher: {
    tools: READ_ONLY,
    text: 'Role: researcher. Explore the project with the read-only tools (read_file, list_dir, search_files) and report what you find. You cannot change anything.',
  },
  reviewer: {
    tools: READ_ONLY,
    text: 'Role: reviewer. Read the relevant code and report concrete problems (bugs, risks, missing cases) with file and line references, most important first. You cannot change anything.',
  },
  coder: {
    tools: [...READ_ONLY, 'write_file', 'edit_file', 'run_command'],
    text: 'Role: coder. Make exactly the change described in the task and nothing more. Read a file before editing it; prefer edit_file for small changes. The user approves edits and commands, so keep them minimal.',
  },
};

/* ---------- debug hook: the debug feature attaches a sink; with none attached every hook is a null check ---------- */
let debugSink = null;
const setDebugSink = (fn) => { debugSink = typeof fn === 'function' ? fn : null; };
const hasDebugSink = () => !!debugSink;
const debugEmit = (ev) => { if (debugSink) { try { debugSink(ev); } catch { /* debugging must never break the agent */ } } };

// Anything that looks like a secret is replaced before it can reach a log. Tool schemas may also mark
// a parameter with `secret: true`.
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|authorization|credentials?|private[_-]?key)$/i;
function scrub(v, secretKeys = [], depth = 0) {
  if (v == null || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, secretKeys, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) || secretKeys.includes(k) ? '[redacted]' : scrub(x, secretKeys, depth + 1);
  return o;
}
function secretParams(name) {
  const t = tools.schemas.find((s) => s.function.name === name);
  const props = (t && t.function.parameters && t.function.parameters.properties) || {};
  return Object.keys(props).filter((k) => props[k] && props[k].secret);
}
const estTokens = (...parts) => Math.ceil(parts.reduce((n, p) => n + (p ? JSON.stringify(p).length : 0), 0) / 4);

// Per-model runtime options saved by the models feature: settings.features.models.runtime[model]
// = { num_gpu, num_thread, num_ctx, use_mmap, keep_alive }. Missing fields keep Ollama's defaults.
function applyRuntime(body, s) {
  const rt = (((s.features || {}).models || {}).runtime || {})[body.model];
  if (!rt || typeof rt !== 'object') return;
  for (const k of ['num_gpu', 'num_thread', 'num_ctx', 'use_mmap']) if (rt[k] !== undefined && rt[k] !== null && rt[k] !== '') body.options[k] = rt[k];
  if (rt.keep_alive !== undefined && rt.keep_alive !== null && rt.keep_alive !== '') body.keep_alive = rt.keep_alive;
}

// Claude-only fields (raw blocks with thinking signatures) must not be sent to Ollama.
const plain = (m) => { if (!m.claude) return m; const { claude: _c, claudeModel: _m, ...rest } = m; return rest; };
const rid = () => Math.random().toString(36).slice(2);
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function systemPrompt(s, role, canDelegate) {
  const where = s.hasFolder
    ? `Project folder: ${s.workspace}. File tools only work inside it; paths outside are blocked.`
    : 'No project folder is open, so you have no file or command tools. Answer from knowledge and suggest the user open a folder if they want you to work on files.';
  const osLine = `OS: ${os.platform()} (${process.platform === 'win32' ? 'PowerShell' : 'bash'}).`;
  const extra = s.extraSystem ? `\nUser instructions:\n${s.extraSystem}` : '';
  if (role) {
    return [
      'You are a sub-agent of Faber, an offline coding assistant running on the user\'s own machine.',
      'The main agent gave you one self-contained task. Work on it alone: you cannot ask questions and you cannot start other agents.',
      ROLES[role].text, where, osLine,
      'Finish with a short final report (under 250 words): what you did or found, with file paths. That report is the only thing the main agent sees.',
      extra,
    ].join('\n');
  }
  return [
    'You are Faber, an offline coding assistant running fully on the user\'s own machine.',
    where, osLine,
    'Use the tools to inspect and change files and run commands. Read a file before editing it.',
    'Prefer edit_file for small changes and write_file for new files. Keep answers concise.',
    'If a tool call is denied by the user, do not retry it; ask what they would like instead.',
    canDelegate ? 'For a big, self-contained job (wide research, review, an isolated change) you may call delegate_task with a role and a complete task; do small things yourself.' : '',
    extra,
  ].join('\n');
}

// A conversation is only valid if every tool call has a reply. Used when restoring from disk.
function repairConv(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      let n = 0;
      while (list[i + 1] && list[i + 1].role === 'tool') { out.push(list[++i]); n++; }
      for (let k = n; k < m.tool_calls.length; k++) out.push({ role: 'tool', tool_name: m.tool_calls[k].function.name, content: 'Interrupted before this ran.' });
    }
  }
  return out;
}

/*
  opts: getSettings()            effective settings for THIS agent (model, effort, mode, host...)
        approve(kind,title,detail)  emit(ev)   events get a `session` field
        id                        session id (sub-agents reuse their parent's)
        gate(id, signal)          optional: resolves to a release() when a model request may start (concurrency limit)
        role, depth, maxSteps, allowedTools   sub-agent restrictions
        conv                      initial conversation       onChange()  called when the conversation changes
*/
function createAgent(opts) {
  const { id = 'main', getSettings, approve, gate = null, onChange = null, role = null, depth = 0, maxSteps = MAX_STEPS, allowedTools = null } = opts;
  const emit = (ev) => opts.emit({ session: id, ...ev });
  const label = role || 'main';
  let conv = opts.conv ? opts.conv.slice() : [];
  let abort = null;
  let killCmd = null;
  const changed = () => { if (onChange) { try { onChange(); } catch { /* ignore */ } } };

  const offered = () => tools.schemas.filter((t) => (allowedTools ? allowedTools.includes(t.function.name) : true) && tools.offeredTo(t.function.name, id));

  const runnerDied = (e) => (e.status === 500 || !e.status) && /terminated|signal: killed|unexpected EOF/i.test(`${e.body || ''} ${e.message || ''}`);

  async function* stream(body, signal) {
    const s = getSettings();
    if (claude.isClaude(body.model)) { yield* claude.stream(body, signal, s); return; }
    let res;
    try {
      res = await fetch(`${s.host}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`Cannot reach Ollama at ${s.host}. Start it (open the Ollama app or run "ollama serve").`);
    }
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(t.includes('not found') ? `Model "${body.model}" is not installed. Type /pull ${body.model} to download it.` : `Ollama error ${res.status}: ${t}`);
      err.status = res.status; err.body = t;
      throw err;
    }
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const part = JSON.parse(line);
        if (part.error) throw new Error(`Ollama: ${part.error}`);
        yield part;
      }
    }
  }

  async function turn(signal, step) {
    const s = getSettings();
    const eff = EFFORT[s.effort] || EFFORT.medium;
    const list = s.hasFolder ? offered() : [];
    const body = {
      model: s.model,
      messages: [{ role: 'system', content: systemPrompt(s, role, depth === 0 && !allowedTools && list.some((t) => t.function.name === 'delegate_task')) }, ...(claude.isClaude(s.model) ? conv : conv.map(plain))],
      tools: list.length ? list : undefined,
      stream: true,
      think: eff.think,
      options: { temperature: eff.temperature, num_predict: eff.num_predict, num_ctx: s.numCtx || 16384 },
    };
    applyRuntime(body, s);
    let content = '', thinking = '', raw = null;
    const calls = [];
    let final = null;
    const t0 = Date.now();
    const logRequest = (retry) => {
      if (!debugSink) return;
      debugEmit({
        kind: 'request', session: id, agent: label, depth, step, retry, model: body.model, host: s.host,
        options: body.options, think: body.think, messageCount: body.messages.length,
        promptTokensEst: estTokens(body.messages, body.tools), tools: list.map((t) => t.function.name),
        system: body.messages[0].content, body,
      });
    };
    const run = async () => {
      const release = gate ? await gate(id, signal) : null;
      try {
        for await (const part of stream(body, signal)) {
          const m = part.message || {};
          if (m.thinking) { thinking += m.thinking; emit({ type: 'thinking', text: m.thinking }); }
          if (m.content) { content += m.content; emit({ type: 'token', text: m.content }); }
          if (m.tool_calls) calls.push(...m.tool_calls);
          if (m.raw) raw = { claude: m.raw, claudeModel: m.rawModel };
          if (part.done) final = part;
        }
      } finally { if (release) release(); }
    };
    logRequest();
    try { await run(); } catch (e) {
      // Model without thinking support: retry once without the flag.
      if (!claude.isClaude(body.model) && e.status === 400 && /think/i.test(e.body || '')) { delete body.think; logRequest('without think'); await run(); }
      // Ollama's model runner died before answering (seen on a 16 GB PC with several models loaded: "signal: killed", "unexpected EOF").
      // The next request starts a fresh runner, so try once more, and say so.
      else if (!claude.isClaude(body.model) && runnerDied(e) && !content && !thinking && !calls.length && !signal.aborted) {
        emit({ type: 'notice', text: `Ollama's model runner stopped (${String(e.body || e.message).slice(0, 160)}). Starting it again and retrying this request once.` });
        logRequest('runner restarted');
        await new Promise((r) => setTimeout(r, 2000));
        await run();
      } else throw e;
    }
    if (debugSink) {
      const f = final || {};
      const evalNs = f.eval_duration || 0;
      debugEmit({
        kind: 'response', session: id, agent: label, depth, step, model: body.model,
        eval_count: f.eval_count, prompt_eval_count: f.prompt_eval_count,
        tokens_per_sec: evalNs && f.eval_count ? Math.round((f.eval_count / (evalNs / 1e9)) * 100) / 100 : null,
        eval_duration: f.eval_duration, prompt_eval_duration: f.prompt_eval_duration,
        load_duration: f.load_duration, total_duration: f.total_duration, done_reason: f.done_reason,
        ctxUsed: (f.prompt_eval_count || 0) + (f.eval_count || 0), numCtx: body.options.num_ctx,
        contentChars: content.length, thinkingChars: thinking.length, toolCalls: calls.length, wallMs: Date.now() - t0,
      });
    }
    if (final) {
      const ns = final.eval_duration || 0;
      emit({ type: 'usage', model: body.model, prompt: final.prompt_eval_count || 0, eval: final.eval_count || 0, tps: ns && final.eval_count ? Math.round((final.eval_count / (ns / 1e9)) * 10) / 10 : null, ms: Date.now() - t0 });
    }
    if (final && final.done_reason === 'length') emit({ type: 'notice', text: 'The reply was cut off by the token limit. Say "continue" to go on.' });
    return { content, calls, raw };
  }

  // Resolves to { text, stopped, error, limit }. Events are emitted along the way.
  async function send(text) {
    if (abort) throw new Error('Already working.');
    abort = new AbortController();
    const signal = abort.signal;
    conv.push({ role: 'user', content: text });
    const result = { text: '', stopped: false, error: null, limit: false, steps: 0 };
    try {
      let step = 0;
      for (; step < maxSteps; step++) {
        const { content, calls, raw } = await turn(signal, step);
        result.steps = step + 1;
        if (content.trim()) result.text = content;
        conv.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}), ...(raw || {}) });
        changed();
        if (!calls.length) break;
        emit({ type: 'turn_end' });
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          const name = call.function.name;
          const args = call.function.arguments;
          const callId = rid();
          emit({ type: 'tool_start', id: callId, name, args });
          const t1 = Date.now();
          let ok = true, out;
          try {
            if (allowedTools && !allowedTools.includes(name)) {
              throw new Error(`Tool "${name}" is not available to ${role ? 'the ' + role + ' sub-agent' : 'this agent'}.`);
            }
            const s = getSettings();
            out = String(await tools.execute(name, args, {
              workspace: s.workspace, sandbox: s.sandbox, mode: s.mode,
              approve, changed: (p) => emit({ type: 'file_changed', path: p }), onOutput: (t) => emit({ type: 'tool_output', id: callId, text: t }),
              setKill: (k) => { killCmd = k; },
              // lets tools like delegate_task start nested work that reports under this call
              agent: { id, depth, role, callId, signal, getSettings, approve, gate, emitSub: (ev) => emit({ ...ev, sub: callId }) },
            }));
          } catch (e) { ok = false; out = `Error: ${e.message}`; }
          killCmd = null;
          emit({ type: 'tool_result', id: callId, ok, output: out });
          conv.push({ role: 'tool', tool_name: name, content: out });
          changed();
          if (debugSink) {
            let a = args;
            if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* keep the string */ } }
            debugEmit({ kind: 'tool', session: id, agent: label, depth, name, args: scrub(a, secretParams(name)), ok, durationMs: Date.now() - t1, resultLength: out.length, result: out });
          }
          if (signal.aborted) {
            // keep the conversation valid: every tool call needs a reply
            for (const rest of calls.slice(i + 1)) conv.push({ role: 'tool', tool_name: rest.function.name, content: 'Stopped by the user before this ran.' });
            changed();
            throw abortError();
          }
        }
      }
      if (step >= maxSteps) {
        result.limit = true;
        emit({ type: 'notice', text: `Stopped after ${maxSteps} steps. Send another message to continue.` });
      }
      emit({ type: 'done' });
    } catch (e) {
      if (e.name === 'AbortError') { result.stopped = true; emit({ type: 'done', stopped: true }); }
      else {
        result.error = e.message;
        emit({ type: 'error', message: e.message });
        debugEmit({ kind: 'error', session: id, agent: label, depth, message: e.message, stack: e.stack });
      }
    } finally {
      abort = null;
      changed();
    }
    return result;
  }

  async function compact() {
    if (abort) throw new Error('Stop the current run first.');
    if (!conv.length) return 'Nothing to compact.';
    const s = getSettings();
    const ask = 'Summarize our conversation so far in under 300 words: goals, decisions, files changed, open tasks.';
    if (claude.isClaude(s.model)) {
      const release = gate ? await gate(id, null) : null;
      let summary;
      try { summary = await claude.complete([...conv, { role: 'user', content: ask }], s.model); } finally { if (release) release(); }
      if (!summary.trim()) throw new Error('The model returned an empty summary.');
      conv = [{ role: 'user', content: `Summary of the conversation so far:\n${summary}` }, { role: 'assistant', content: 'Understood.' }];
      changed();
      return summary;
    }
    const body = {
      model: s.model, stream: false, think: false,
      messages: [...conv.map(plain), { role: 'user', content: ask }],
    };
    body.options = {};
    applyRuntime(body, s);
    const release = gate ? await gate(id, null) : null;
    let res;
    try {
      debugEmit({ kind: 'request', session: id, agent: label, depth, purpose: 'compact', model: s.model, host: s.host, options: {}, messageCount: body.messages.length, promptTokensEst: estTokens(body.messages), tools: [], system: '', body });
      try { res = await fetch(`${s.host}/api/chat`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }); }
      catch { throw new Error(`Cannot reach Ollama at ${s.host}.`); }
    } finally { if (release) release(); }
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const j = await res.json();
    const summary = (j.message && j.message.content) || '';
    if (!summary.trim()) throw new Error('The model returned an empty summary.');
    debugEmit({ kind: 'response', session: id, agent: label, depth, purpose: 'compact', model: s.model, eval_count: j.eval_count, prompt_eval_count: j.prompt_eval_count, done_reason: j.done_reason, total_duration: j.total_duration });
    conv = [{ role: 'user', content: `Summary of the conversation so far:\n${summary}` }, { role: 'assistant', content: 'Understood.' }];
    changed();
    return summary;
  }

  return {
    send, compact,
    stop() { if (killCmd) killCmd(); if (abort) abort.abort(); },
    clear() { conv = []; changed(); },
    busy: () => !!abort,
    transcript: () => conv,
    setTranscript(list) { conv = list.slice(); },
  };
}

/*
  delegate_task implementation. `tctx` is the tool context from the parent's loop (tctx.agent).
  The sub-agent starts with a fresh context, role-specific prompt and restricted tools, cannot spawn
  further agents, and still goes through the parent's approval and the folder sandbox.
*/
async function runSubAgent(tctx, args, cfg = {}) {
  const a = tctx.agent;
  if (!a) throw new Error('delegate_task can only be used by an agent.');
  if (a.depth >= 1) throw new Error('Sub-agents cannot start other sub-agents. Do the work yourself.');
  const role = String(args.role || '').toLowerCase();
  const def = ROLES[role];
  if (!def) throw new Error(`Unknown role "${args.role}". Use researcher, coder or reviewer.`);
  const task = String(args.task || '').trim();
  if (!task) throw new Error('task is required.');
  const steps = Math.max(1, Math.min(40, Number(cfg.maxSteps) || 12));
  const timeoutMs = Math.max(1, Number(cfg.timeoutSec) || 600) * 1000;

  const child = createAgent({
    id: a.id, role, depth: a.depth + 1, maxSteps: steps, allowedTools: def.tools,
    getSettings: a.getSettings, gate: a.gate,
    approve: (kind, title, detail) => a.approve(kind, `[${role}] ${title}`, detail),
    emit: (ev) => a.emitSub(ev),
  });
  let timedOut = false;
  const onAbort = () => child.stop();
  a.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; child.stop(); }, timeoutMs);
  const t0 = Date.now();
  debugEmit({ kind: 'subagent', state: 'start', session: a.id, role, task });
  let r;
  try { r = await child.send(task); } finally {
    clearTimeout(timer);
    a.signal.removeEventListener('abort', onAbort);
  }
  const text = (r.text || '').trim();
  const fin = (ok, extra) => debugEmit({ kind: 'subagent', state: 'finish', session: a.id, role, ok, steps: r.steps, durationMs: Date.now() - t0, resultLength: text.length, ...extra });
  if (timedOut) {
    fin(false, { error: 'timeout' });
    throw new Error(`The ${role} sub-agent timed out after ${Math.round(timeoutMs / 1000)}s.${text ? ' Partial result:\n' + text : ''}`);
  }
  if (r.stopped) { fin(false, { error: 'stopped' }); return 'The sub-agent was stopped.'; }
  if (r.error) { fin(false, { error: r.error }); throw new Error(`The ${role} sub-agent failed: ${r.error}`); }
  fin(true);
  const out = text || '(the sub-agent returned no text)';
  return (r.limit ? `[Step limit reached, partial result]\n` : '') + (out.length > 8000 ? out.slice(0, 8000) + '\n[truncated]' : out);
}

module.exports = { createAgent, runSubAgent, repairConv, ROLES, setDebugSink, hasDebugSink, debugEmit, scrub };
