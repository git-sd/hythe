// Central agent orchestrator. One conductor model turns a task into a plan of steps (JSON), the orchestrator runs the
// steps on specialist agents (each with its OWN model), passes results between them, sends reviewer feedback back for
// one round of rework, and has the conductor write the final answer.
//
// Everything said between the orchestrator and an agent goes through the communication line (src/comms.js), which
// logs it before delivery. The agents' tool calls, reasoning and token use are logged too, and so are approvals.
// Plain Node: no Electron. It talks to Ollama through src/agent.js, so it runs the same in the app and from the CLI.
const { createAgent } = require('./agent');
const { ROLES } = require('./model-roster');
const { agentEventLogger } = require('./comms');
const fs = require('fs');
const path = require('path');

const READ = ['read_file', 'list_dir', 'search_files'];
const ROLE_TOOLS = {
  conductor: [], researcher: READ, reviewer: READ, fast: READ,
  coder: [...READ, 'write_file', 'edit_file', 'run_command'],
};
const ROLE_TEXT = {
  conductor: 'You are the conductor. You plan the work, check results and write the final answer for the user. You have no tools: you get the project listing in the request, and the agents do the reading and changing.',
  coder: 'You are a coder. Make exactly the change your step describes, in the project folder. Read a file before editing it. Report what you changed.',
  reviewer: 'You are an independent reviewer. Read the changed files and check them against the step description. You cannot change files. Begin your reply with exactly "VERDICT: APPROVED" or "VERDICT: CHANGES NEEDED", then give concrete reasons with file names.',
  researcher: 'You are a researcher. Read the project and report concrete findings with file names. You cannot change files.',
  fast: 'You are a fast helper model. Do the small job your step describes, briefly and exactly. Do not wander off the step.',
};
const ROLE_BLURB = {
  conductor: 'plans and writes the final answer', coder: 'writes and edits code, runs commands', reviewer: 'independent read-only review, returns a VERDICT',
  researcher: 'reads the project and reports findings (read-only)', fast: 'small and quick: summaries and simple jobs (read-only)',
};

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + `\n[... ${s.length - n} more characters omitted from this message; the trace has them all]` : s; };

// Pull the first balanced {...} out of a model reply (it may be wrapped in prose or a ```json fence).
function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const cands = [fence ? fence[1] : null, s].filter(Boolean);
  for (const c of cands) {
    for (let i = c.indexOf('{'); i >= 0; i = c.indexOf('{', i + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < c.length; j++) {
        const ch = c[j];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { try { return JSON.parse(c.slice(i, j + 1)); } catch { break; } }
      }
    }
  }
  return null;
}

// Check a plan against the roster. Returns { steps } or { error }.
function validatePlan(obj, agents, maxSteps) {
  if (!obj || !Array.isArray(obj.steps) || !obj.steps.length) return { error: 'the reply has no "steps" list' };
  if (obj.steps.length > maxSteps) return { error: `the plan has ${obj.steps.length} steps; the limit is ${maxSteps}` };
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  const byRole = new Map();
  for (const a of agents) if (!byRole.has(a.role)) byRole.set(a.role, a);
  const ids = new Set();
  const steps = [];
  for (let i = 0; i < obj.steps.length; i++) {
    const s = obj.steps[i] || {};
    const id = String(s.id || `s${i + 1}`);
    if (ids.has(id)) return { error: `step id "${id}" is used twice` };
    const who = String(s.agent || '').toLowerCase();
    const agent = byName.get(who) || byRole.get(who);
    if (!agent) return { error: `step ${id} names an unknown agent "${s.agent}". Agents: ${agents.map((a) => a.name).join(', ')}` };
    const instruction = String(s.instruction || '').trim();
    if (!instruction) return { error: `step ${id} has no instruction` };
    const deps = (Array.isArray(s.depends_on) ? s.depends_on : []).map(String);
    for (const d of deps) if (!ids.has(d)) return { error: `step ${id} depends on "${d}", which is not an earlier step` };
    ids.add(id);
    steps.push({ id, agent: agent.name, instruction, depends_on: deps });
  }
  return { steps };
}

// A short listing of the project folder for the conductor's prompt (the conductor has no tools: on a small model a tool call during
// planning was observed to swallow the JSON plan, and every round trip costs a slow prompt on a CPU).
function projectListing(dir, { maxLines = 60 } = {}) {
  if (!dir) return '(no project folder is open)';
  const lines = [];
  const walk = (d, depth, prefix) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of names) {
      if (lines.length >= maxLines) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) { lines.push(`${prefix}${e.name}/`); if (depth < 2) walk(path.join(d, e.name), depth + 1, prefix + '  '); }
      else { let size = ''; try { size = ` (${fs.statSync(path.join(d, e.name)).size} bytes)`; } catch { /* gone */ } lines.push(`${prefix}${e.name}${size}`); }
    }
  };
  walk(dir, 0, '');
  if (lines.length >= maxLines) lines.push('... (more files not shown)');
  return lines.length ? lines.join('\n') : '(the folder is empty)';
}

// A step that begins with a change/run verb but is given to a read-only agent cannot be done there (a real run gave "Run node test.js"
// to the read-only fast model, which then made up a report). Move such steps to the first coder, and say so.
const CHANGE_VERB = /^\W*(run|execute|install|create|write|fix|edit|modify|delete|remove|rename|implement|add|update|refactor|apply|build|generate)\b/i;
function routeByCapability(steps, agents) {
  const coder = agents.find((a) => a.role === 'coder');
  const role = new Map(agents.map((a) => [a.name, a.role]));
  const moved = [];
  if (!coder) return { steps, moved };
  const out = steps.map((s) => {
    const r = role.get(s.agent);
    if ((r === 'fast' || r === 'researcher') && CHANGE_VERB.test(s.instruction)) { moved.push({ id: s.id, from: s.agent, to: coder.name }); return { ...s, agent: coder.name, rerouted: s.agent }; }
    return s;
  });
  return { steps: out, moved };
}

// Policy, not a request: work that changes files must be reviewed by the reviewer agent. A real 9B conductor was observed ignoring the
// prompt rule "end with a reviewer step". So after the steps have run, the orchestrator looks at what the tools REALLY did (the ledger) and,
// when a step wrote or edited files and no reviewer step follows it (directly or through other steps), appends one. The addition is logged.
// `changed(step)` says whether a step counts as changing files (default: it is a coder step, for judging a plan before it runs).
function ensureReview(steps, agents, task, changed) {
  const reviewer = agents.find((a) => a.role === 'reviewer');
  if (!reviewer) return { steps, added: null };
  const role = new Map(agents.map((a) => [a.name, a.role]));
  const isChange = changed || ((s) => role.get(s.agent) === 'coder');
  const byId = new Map(steps.map((s) => [s.id, s]));
  const reviews = (s, writerId, seen = new Set()) => {         // does reviewer step `s` (transitively) follow `writerId`?
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return s.depends_on.some((d) => d === writerId || (byId.get(d) && reviews(byId.get(d), writerId, seen)));
  };
  const reviewerSteps = steps.filter((s) => role.get(s.agent) === 'reviewer' && !['failed', 'skipped', 'stopped'].includes(s.status));
  const unreviewed = steps.filter((s) => role.get(s.agent) !== 'reviewer' && isChange(s) && !reviewerSteps.some((r) => reviews(r, s.id)));
  if (!unreviewed.length) return { steps, added: null };
  let n = steps.length + 1;
  while (byId.has('s' + n)) n++;
  const added = {
    id: 's' + n, agent: reviewer.name, depends_on: unreviewed.map((s) => s.id), added: true,
    instruction: `Independently review the work of ${unreviewed.map((s) => s.id).join(', ')} against the original task: ${task}\nRead every file those steps created or changed, check that each does what the task asks, and look for mistakes (wrong logic, missing files, wrong names, things that would not run).`,
  };
  return { steps: [...steps, added], added, unreviewed: unreviewed.map((s) => s.id) };
}

const verdictOf = (text) => (/VERDICT:\s*APPROVED/i.test(text) ? 'approved' : /VERDICT:\s*CHANGES\s*NEEDED/i.test(text) ? 'changes-needed' : 'none');

const planText = (steps) => steps.map((s) => `${s.id}: ${s.agent}${s.depends_on.length ? ' (after ' + s.depends_on.join(', ') + ')' : ''}${s.added ? ' [added by the orchestrator]' : ''}${s.rerouted ? ' [moved from ' + s.rerouted + ', which can only read]' : ''}\n    ${s.instruction.replace(/\n/g, '\n    ')}`).join('\n');

// What the tools REALLY did in one step, from the agent's own tool events (not from what the agent says it did).
const newLedger = () => ({ reads: 0, writes: [], runs: [], failed: 0, cutOff: 0 });
function tally(rt, ev) {
  const L = rt.ledger;
  if (!L) return;
  if (ev.type === 'tool_start') {
    const a = ev.args && typeof ev.args === 'object' ? ev.args : {};
    if (ev.name === 'write_file') L.writes.push(`wrote ${a.path || '?'}`);
    else if (ev.name === 'edit_file') L.writes.push(`edited ${a.path || '?'}`);
    else if (ev.name === 'run_command') L.runs.push(`ran \`${String(a.command || '?').slice(0, 80)}\``);
    else L.reads++;
  } else if (ev.type === 'tool_result' && ev.ok === false) L.failed++;
  else if (ev.type === 'notice' && /token limit/i.test(ev.text || '')) L.cutOff++;
}
const ledgerList = (L) => [...L.writes, ...L.runs, ...(L.reads ? [`${L.reads} read${L.reads === 1 ? '' : 's'}`] : []), ...(L.failed ? [`${L.failed} failed tool call${L.failed === 1 ? '' : 's'}`] : [])];

// Checks the orchestrator makes itself, from the tool ledger, because small models were observed to (a) say they changed a file they only
// read, (b) approve work without opening any file, and (c) end a step with an empty reply after hitting the token limit. A problem gets
// one visible nudge; if the step still does not show the evidence, it FAILS (and what depends on it is skipped).
const WRITE_VERB = /^\W*(create|write|fix|edit|modify|update|add|implement|refactor|apply|generate|rename|delete|remove|rewrite|change)\b/i;
const RUN_VERB = /^\W*(run|execute)\b/i;
function stepProblem(role, instruction, text, L) {
  const empty = !String(text || '').trim();
  if (L.cutOff && empty) return { why: 'the reply was cut off by the token limit and is empty', nudge: 'continue' };
  if (role === 'coder') {
    if (RUN_VERB.test(instruction) && !L.runs.length) return { why: 'the step asked to run a command but no command was run', nudge: 'You did not run anything. Run the command now with run_command, then report its output.' };
    if (WRITE_VERB.test(instruction) && !L.writes.length && !L.runs.length) return { why: 'the step asked for a change but no file was written or edited', nudge: 'No file has been written or edited yet (you only read). Make the change now with edit_file or write_file, then report what you changed.' };
  }
  if (role === 'reviewer' && L.reads === 0) return { why: 'the reviewer answered without reading any file', nudge: 'You have not read any file. Read the files with read_file first, then give your VERDICT.' };
  return null;
}

// The orchestrator's own summary, from the tool log, appended to the conductor's final answer. A model cannot talk its way into this.
function factsText(steps, modelOf) {
  return steps.map((s) => {
    const acts = (s.actions && s.actions.length ? s.actions.join(', ') : 'no tool used');
    const state = s.status === 'done' ? (s.verdict ? `done, VERDICT ${s.verdict.toUpperCase()}` : 'done') : `${s.status.toUpperCase()}${s.error ? ': ' + s.error : ''}`;
    return `  ${s.id} ${s.agent} (${modelOf(s.agent)}): ${state}. Tools: ${acts}`;
  }).join('\n');
}

/*
  opts: host, workspace, line (src/comms.js), roster { conductor: { model, effort? }, agents: [{ name, role, model, effort? }] }
        approve(kind, title, detail) -> Promise<bool>   asked for edits / commands the agents want (default: allow)
        mode ('ask' | 'edits' | 'auto'), effort, numCtx, features (settings.features: per-model runtime options)
        maxSteps per agent turn (default 12), concurrency (default 1: on a CPU, models take turns), stepTimeoutSec (900),
        maxPlanSteps (8), maxRework (1), installed [names] (optional: missing models are replaced by `fallbackModel`, visibly)
*/
function createOrchestrator(opts) {
  const {
    host, workspace, line, roster, approve = null, mode = 'auto', effort = 'medium', numCtx = 8192, features = {},
    maxSteps = 12, concurrency = 1, stepTimeoutSec = 900, conductorTimeoutSec = 600, maxPlanSteps = 8, maxRework = 1, installed = null, fallbackModel = '',
    autoReview = true,
  } = opts;
  if (!line) throw new Error('The orchestrator needs a communication line.');
  if (!roster || !roster.conductor || !Array.isArray(roster.agents) || !roster.agents.length) throw new Error('The roster needs a conductor and at least one agent.');
  for (const a of roster.agents) if (!ROLES.includes(a.role) || a.role === 'conductor') throw new Error(`Agent "${a.name}" has an invalid role "${a.role}".`);

  let stopped = false;
  const runtime = new Map();      // name -> { name, role, model, agent }
  const listeners = new Set();
  const emitState = (st) => { for (const f of listeners) { try { f(st); } catch { /* ignore */ } } };

  /* ----- one agent ----- */
  async function approveFor(def, kind, title, detail) {
    line.log({ from: def.name, to: 'owner', kind: 'question', model: def.model, text: `${title}\n${detail || ''}`.trim(), meta: { approval: kind } });
    let ok;
    if (approve) ok = !!(await approve(kind, `[${def.name}] ${title}`, detail));
    else ok = true;
    line.log({ from: 'owner', to: def.name, kind: 'answer', text: ok ? `allowed${approve ? '' : ' (no approval prompt in this run)'}` : 'denied', meta: { approval: kind } });
    return ok;
  }
  function makeAgent(def, timeoutSec = stepTimeoutSec) {
    const system = `${ROLE_TEXT[def.role] || ROLE_TEXT.coder}\nYour name in this team is "${def.name}". You work for a conductor; reply to the step you are given.`;
    const agent = createAgent({
      id: 'orch-' + def.name, maxSteps,
      allowedTools: ROLE_TOOLS[def.role] || READ,
      getSettings: () => ({ host, model: def.model, effort: def.effort || effort, mode, hasFolder: !!workspace, workspace: workspace || '', sandbox: true, numCtx, features, extraSystem: system }),
      approve: (kind, title, detail) => (kind === 'edit' && mode !== 'ask' ? Promise.resolve(true) : approveFor(def, kind, title, detail)),
      emit: (ev) => { logEvent(ev); tally(rt, ev); },
    });
    const logEvent = agentEventLogger(line, def);
    const rt = { name: def.name, role: def.role, model: def.model, agent, ledger: newLedger() };
    // what line.request() needs
    rt.run = async (text) => {
      let timer;
      const t = new Promise((_, rej) => { timer = setTimeout(() => { agent.stop(); rej(Object.assign(new Error(`timed out after ${timeoutSec}s`), { timeout: true })); }, timeoutSec * 1000); });
      try { return await Promise.race([agent.send(text), t]); } finally { clearTimeout(timer); }
    };
    return rt;
  }

  /* ----- model availability, visibly ----- */
  function checkModels() {
    const all = [{ ref: roster.conductor, name: 'conductor', role: 'conductor' }, ...roster.agents.map((a) => ({ ref: a, name: a.name, role: a.role }))];
    for (const a of all) {
      line.log({ from: 'orchestrator', to: a.name, kind: 'system', model: a.ref.model, text: `${a.name} (${a.role}) will use model ${a.ref.model}` });
      const m = a.ref.model;
      if (installed && !installed.some((n) => n === m || n === m + ':latest' || n + ':latest' === m)) {
        const sub = fallbackModel || roster.conductor.model;
        line.log({ from: 'orchestrator', to: a.name, kind: 'system', model: m, text: `model ${m} is not installed; ${a.name} will use ${sub} instead` });
        a.ref.model = sub;
      }
    }
  }

  /* ----- prompts ----- */
  const rosterText = () => roster.agents.map((a) => `- ${a.name} (model ${a.model}, role ${a.role}): ${ROLE_BLURB[a.role]}`).join('\n');
  const planPrompt = (task) => [
    'You are the conductor of a team of specialist agents. Each agent runs on its own model and works on its own; they cannot see each other\'s chats.',
    'The agents:', rosterText(), '',
    'The project folder:', projectListing(workspace), '',
    'The user\'s task:', task, '',
    `Break the task into at most ${maxPlanSteps} steps. Reply with ONLY a JSON object, no other text:`,
    '{"steps":[{"id":"s1","agent":"<agent name>","instruction":"<complete, self-contained instruction>","depends_on":[]}]}',
    'Rules: instructions must name files and say exactly what to produce. depends_on lists ids of EARLIER steps whose results this step needs (they are passed along automatically). Steps without dependencies on each other may run in parallel. If files change, end with a reviewer step that depends on the steps that changed them. Give reading, listing and summarizing jobs to the fast agent if there is one: it answers several times faster than the others.',
  ].join('\n');
  // The tiny helper model (0.8B) was observed taking the OVERALL task for its own step and trying to do all of it, so it only sees its step.
  const stepPrompt = (task, step, results, role) => [
    role === 'fast' ? '' : `Overall task (for context): ${task}\n`, `YOUR STEP ${step.id}:`, step.instruction,
    results.length ? '\nRESULTS FROM EARLIER STEPS:\n' + results.map((r) => `[${r.id} by ${r.agent}${r.actions && r.actions.length ? '; what the tools really did: ' + r.actions.join(', ') : ''}]\n${clip(r.text, 2500)}`).join('\n\n') : '',
    '\nWhen done, reply with a short report: what you did, which files, and any problem.',
  ].join('\n');
  const reworkPrompt = (review) => `A reviewer checked your work and asked for changes:\n\n${clip(review, 3000)}\n\nFix exactly these problems in the project files, then reply with a short report of what you changed.`;
  const reReviewPrompt = (step) => `${step.instruction}\n\nThe author has reworked the files after your last review. Review them again. Begin your reply with exactly "VERDICT: APPROVED" or "VERDICT: CHANGES NEEDED".`;
  const finalPrompt = (task, steps) => [
    'All steps are finished. Write the final answer for the user (under 200 words): what was done, which files exist, and anything that is still open or unverified. Be honest about failed or skipped steps and unresolved review comments.',
    'Each step header lists what the tools REALLY did. If an agent\'s report claims something its tool list does not show (for example "tests passed" without a command being run), say that it is unverified.',
    `\nOriginal task: ${task}\n`,
    ...steps.map((s) => `[${s.id} ${s.agent}: ${s.status}${s.verdict ? ', verdict ' + s.verdict : ''}; what the tools really did: ${s.actions && s.actions.length ? s.actions.join(', ') : 'nothing (no tool was used)'}]\n${clip(s.result || s.error || '(no output)', 1500)}`),
  ].join('\n');

  /* ----- the run ----- */
  async function run(task) {
    task = String(task || '').trim();
    if (!task) throw new Error('Describe the task first.');
    stopped = false;
    line.startRun(task.slice(0, 80));
    checkModels();
    const conductor = makeAgent({ name: 'conductor', role: 'conductor', model: roster.conductor.model, effort: roster.conductor.effort }, conductorTimeoutSec);
    runtime.set('conductor', conductor);
    for (const a of roster.agents) runtime.set(a.name, makeAgent(a));
    const result = { ok: false, status: 'running', task, plan: null, steps: [], final: '' };
    emitState({ phase: 'planning', result });

    try {
      /* 1. plan */
      let plan = null, why = '';
      let reply = await line.request('orchestrator', conductor, planPrompt(task));
      if (stopped) throw Object.assign(new Error('stopped'), { stopped: true });
      for (let attempt = 0; attempt < 2 && !plan; attempt++) {
        const v = validatePlan(extractJson(reply && reply.text), roster.agents, maxPlanSteps);
        if (v.steps) { plan = v.steps; break; }
        why = v.error;
        line.log({ from: 'orchestrator', to: 'conductor', kind: 'system', text: `plan rejected: ${why}${attempt === 0 ? '. Asking the conductor to fix it.' : ''}` });
        if (attempt === 0) reply = await line.request('orchestrator', conductor, `Your plan was not usable: ${why}.\nReply with ONLY the corrected JSON object.`);
      }
      if (!plan) {
        // visible fallback: one step for the first coder (or first agent) and a review if there is a reviewer
        const worker = roster.agents.find((a) => a.role === 'coder') || roster.agents[0];
        const rev = roster.agents.find((a) => a.role === 'reviewer');
        plan = [{ id: 's1', agent: worker.name, instruction: task, depends_on: [] }];
        if (rev) plan.push({ id: 's2', agent: rev.name, instruction: `Review the work done for this task: ${task}`, depends_on: ['s1'] });
        line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: `no usable plan from the conductor (${why}); using a simple fallback plan:\n${planText(plan)}` });
      } else {
        const rt2 = routeByCapability(plan, roster.agents);
        if (rt2.moved.length) {
          plan = rt2.steps;
          for (const m of rt2.moved) line.log({ from: 'orchestrator', to: m.to, kind: 'system', text: `step ${m.id} was given to ${m.from}, which can only read, but it starts with a verb that changes or runs things. Moved to ${m.to}.` });
        }
        line.log({ from: 'conductor', to: 'orchestrator', kind: 'plan', model: conductor.model, text: planText(plan), meta: { steps: plan.length } });
      }
      result.plan = plan;
      result.steps = plan.map((p) => ({ ...p, status: 'pending', result: '', error: '', verdict: '', actions: [] }));
      emitState({ phase: 'running', result });

      /* 2. run the steps: dependency order, up to `concurrency` at once */
      const byId = new Map(result.steps.map((s) => [s.id, s]));
      const running = new Map();
      const busy = new Set();     // an agent does one thing at a time, even when `concurrency` allows more
      const finish = (s) => { running.delete(s.id); busy.delete(s.agent); emitState({ phase: 'running', result }); };
      async function runStep(s) {
        const agent = runtime.get(s.agent);
        s.status = 'running'; emitState({ phase: 'running', result });
        const deps = s.depends_on.map((d) => byId.get(d)).map((d) => ({ id: d.id, agent: d.agent, text: d.result, actions: d.actions }));
        let rep;
        agent.ledger = newLedger();
        try {
          rep = await line.request('orchestrator', agent, stepPrompt(task, s, deps, agent.role), { step: s.id });
        } catch (e) { s.status = 'failed'; s.error = e.message; s.actions = ledgerList(agent.ledger); return finish(s); }
        s.actions = ledgerList(agent.ledger);
        if (rep.error || rep.stopped) { s.status = stopped ? 'stopped' : 'failed'; s.error = rep.error || 'stopped'; s.result = rep.text || ''; return finish(s); }
        let prob = stepProblem(agent.role, s.instruction, rep.text, agent.ledger);
        if (prob && !stopped) {
          line.log({ from: 'orchestrator', to: agent.name, kind: 'system', text: `step ${s.id}: ${prob.why}. Asking ${agent.name} once more.` });
          agent.ledger.cutOff = 0;
          let again;
          try { again = await line.request('orchestrator', agent, prob.nudge, { step: s.id, retry: 1 }); } catch (e) { again = { error: e.message }; }
          s.actions = ledgerList(agent.ledger);
          if (again.error || again.stopped) { s.status = stopped ? 'stopped' : 'failed'; s.error = again.error || 'stopped'; s.result = rep.text || ''; return finish(s); }
          rep = { ...again, text: [String(rep.text || '').trim(), String(again.text || '').trim()].filter(Boolean).join('\n') };
          prob = stepProblem(agent.role, s.instruction, again.text, agent.ledger);
          if (prob && prob.why === 'the reply was cut off by the token limit and is empty') prob = null;      // continued: the text is what it is
        }
        if (prob) {
          s.status = 'failed'; s.error = `${prob.why} (even after asking again)`; s.result = String(rep.text || '').trim();
          line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: `step ${s.id} FAILED: ${s.error}` });
          return finish(s);
        }
        s.result = String(rep.text || '').trim();
        s.status = 'done';
        if (agent.role === 'reviewer') {
          s.verdict = verdictOf(s.result);
          let rounds = 0;
          while (s.verdict === 'changes-needed' && rounds < maxRework && !stopped) {
            rounds++;
            // the feedback goes to each distinct author the review covered (usually one), once per round
            const authorSteps = [];
            for (const d of s.depends_on) { const st = byId.get(d); if (st && runtime.get(st.agent).role !== 'reviewer' && !authorSteps.some((x) => x.agent === st.agent)) authorSteps.push(st); }
            if (!authorSteps.length) break;
            let reworkFailed = false;
            for (const authorStep of authorSteps) {
              const author = runtime.get(authorStep.agent);
              line.log({ from: 'orchestrator', to: author.name, kind: 'system', text: `review of ${s.id} asked for changes: sending the feedback to ${author.name} (rework ${rounds} of ${maxRework})` });
              author.ledger = newLedger();
              const rw = await line.request('orchestrator', author, reworkPrompt(s.result), { step: authorStep.id, rework: rounds });
              authorStep.actions = [...(authorStep.actions || []), ...ledgerList(author.ledger).map((a) => `rework ${rounds}: ${a}`)];
              if (rw.error || rw.stopped) { reworkFailed = true; break; }
              authorStep.result += `\n[rework ${rounds}] ${String(rw.text || '').trim()}`;
            }
            if (reworkFailed) break;
            const again = await line.request('orchestrator', agent, reReviewPrompt(s), { step: s.id, rework: rounds });
            if (again.error || again.stopped) break;
            s.result = String(again.text || '').trim();
            s.verdict = verdictOf(s.result);
          }
        }
        finish(s);
      }
      async function drain() {
        while (!stopped) {
          // anything whose dependencies failed can never run
          for (const s of result.steps) {
            if (s.status !== 'pending') continue;
            const bad = s.depends_on.map((d) => byId.get(d)).find((d) => ['failed', 'skipped', 'stopped'].includes(d.status));
            if (bad) { s.status = 'skipped'; s.error = `dependency ${bad.id} ${bad.status}`; line.log({ from: 'orchestrator', to: s.agent, kind: 'system', text: `step ${s.id} skipped: ${s.error}` }); }
          }
          const ready = result.steps.filter((s) => s.status === 'pending' && s.depends_on.every((d) => byId.get(d).status === 'done'));
          for (const s of ready) {
            if (running.size >= concurrency) break;
            if (busy.has(s.agent)) continue;
            busy.add(s.agent);
            running.set(s.id, runStep(s).catch((e) => { s.status = 'failed'; s.error = e.message; finish(s); }));
          }
          if (!running.size) break;
          await Promise.race(running.values());
        }
        if (running.size) await Promise.allSettled(running.values());
      }
      await drain();
      if (autoReview && !stopped) {
        const wrote = (s) => s.status === 'done' && (s.actions || []).some((a) => /^(rework \d+: )?(wrote|edited) /.test(a));
        const rv = ensureReview(result.steps, roster.agents, task, wrote);
        if (rv.added) {
          line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: `${rv.unreviewed.join(', ')} wrote or edited files but no reviewer step follows ${rv.unreviewed.length > 1 ? 'them' : 'it'}. Policy: changed files are always reviewed, so the orchestrator adds step ${rv.added.id} for ${rv.added.agent}.` });
          const st = { ...rv.added, status: 'pending', result: '', error: '', verdict: '', actions: [] };
          result.steps.push(st); byId.set(st.id, st);
          emitState({ phase: 'running', result });
          await drain();
        }
      }
      if (stopped) throw Object.assign(new Error('stopped'), { stopped: true });

      /* 3. final answer from the conductor */
      emitState({ phase: 'finishing', result });
      const fin = await line.request('orchestrator', conductor, finalPrompt(task, result.steps), { replyKind: 'final' });
      result.final = fin && fin.text && !fin.error ? String(fin.text).trim() : '';
      if (!result.final) {
        result.final = `The conductor could not write a summary. Step results:\n${result.steps.map((s) => `${s.id} ${s.agent}: ${s.status}`).join('\n')}`;
        line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: 'the conductor returned no final answer; showing a plain status list instead' });
      }
      const facts = factsText(result.steps, (name) => (runtime.get(name) || {}).model || '?');
      line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: `Checked by the orchestrator from the tool log (not from what the models said):\n${facts}` });
      result.facts = facts;
      result.final += `\n\nChecked by the orchestrator from the tool log (not from what the models said):\n${facts}`;
      const unresolved = result.steps.some((s) => s.verdict === 'changes-needed');
      result.ok = result.steps.every((s) => s.status === 'done') && !unresolved;
      result.status = result.ok ? 'done' : 'finished-with-problems';
    } catch (e) {
      result.status = e.stopped ? 'stopped' : 'error';
      result.error = e.message;
      line.log({ from: 'orchestrator', to: 'owner', kind: e.stopped ? 'system' : 'error', text: e.stopped ? 'stopped by the owner' : `orchestration failed: ${e.message}` });
    }
    const v = line.verify();
    line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: `run ${result.status}. ${line.count()} messages in this trace, chain ${v.ok ? 'verified' : 'BROKEN at #' + v.brokenAt}.` });
    emitState({ phase: 'done', result });
    return result;
  }

  return {
    run,
    stop() { stopped = true; for (const r of runtime.values()) { try { r.agent.stop(); } catch { /* idle */ } } },
    onState(f) { listeners.add(f); return () => listeners.delete(f); },
    // add an agent before run() (used by the UI and tests); names must be unique
    addAgent(def) { if (roster.agents.some((a) => a.name === def.name)) throw new Error(`There is already an agent called ${def.name}.`); roster.agents.push(def); },
    agents: () => [...runtime.values()].map((r) => ({ name: r.name, role: r.role, model: r.model })),
  };
}

module.exports = { createOrchestrator, extractJson, validatePlan, verdictOf, ensureReview, routeByCapability, projectListing, stepProblem, factsText, ROLE_TOOLS };
