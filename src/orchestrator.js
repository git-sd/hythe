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

const READ = ['read_file', 'list_dir', 'search_files'];
const ROLE_TOOLS = {
  conductor: READ, researcher: READ, reviewer: READ, fast: READ,
  coder: [...READ, 'write_file', 'edit_file', 'run_command'],
};
const ROLE_TEXT = {
  conductor: 'You are the conductor. You plan the work, check results and write the final answer for the user. You may read the project to plan, but you never change files.',
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

const verdictOf = (text) => (/VERDICT:\s*APPROVED/i.test(text) ? 'approved' : /VERDICT:\s*CHANGES\s*NEEDED/i.test(text) ? 'changes-needed' : 'none');

const planText = (steps) => steps.map((s) => `${s.id}: ${s.agent}${s.depends_on.length ? ' (after ' + s.depends_on.join(', ') + ')' : ''}\n    ${s.instruction.replace(/\n/g, '\n    ')}`).join('\n');

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
      emit: agentEventLogger(line, def),
    });
    const rt = { name: def.name, role: def.role, model: def.model, agent };
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
    'The user\'s task:', task, '',
    `Break the task into at most ${maxPlanSteps} steps. Reply with ONLY a JSON object, no other text:`,
    '{"steps":[{"id":"s1","agent":"<agent name>","instruction":"<complete, self-contained instruction>","depends_on":[]}]}',
    'Rules: instructions must name files and say exactly what to produce. depends_on lists ids of EARLIER steps whose results this step needs (they are passed along automatically). Steps without dependencies on each other may run in parallel. If files change, end with a reviewer step that depends on the steps that changed them.',
  ].join('\n');
  const stepPrompt = (task, step, results) => [
    `Overall task (for context): ${task}`, '', `YOUR STEP ${step.id}:`, step.instruction,
    results.length ? '\nRESULTS FROM EARLIER STEPS:\n' + results.map((r) => `[${r.id} by ${r.agent}]\n${clip(r.text, 2500)}`).join('\n\n') : '',
    '\nWhen done, reply with a short report: what you did, which files, and any problem.',
  ].join('\n');
  const reworkPrompt = (review) => `A reviewer checked your work and asked for changes:\n\n${clip(review, 3000)}\n\nFix exactly these problems in the project files, then reply with a short report of what you changed.`;
  const reReviewPrompt = (step) => `${step.instruction}\n\nThe author has reworked the files after your last review. Review them again. Begin your reply with exactly "VERDICT: APPROVED" or "VERDICT: CHANGES NEEDED".`;
  const finalPrompt = (task, steps) => [
    'All steps are finished. Write the final answer for the user (under 200 words): what was done, which files exist, and anything that is still open or unverified. Be honest about failed or skipped steps and unresolved review comments.',
    `\nOriginal task: ${task}\n`,
    ...steps.map((s) => `[${s.id} ${s.agent}: ${s.status}${s.verdict ? ', verdict ' + s.verdict : ''}]\n${clip(s.result || s.error || '(no output)', 1500)}`),
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
        line.log({ from: 'conductor', to: 'orchestrator', kind: 'plan', model: conductor.model, text: planText(plan), meta: { steps: plan.length } });
      }
      result.plan = plan;
      result.steps = plan.map((p) => ({ ...p, status: 'pending', result: '', error: '', verdict: '' }));
      emitState({ phase: 'running', result });

      /* 2. run the steps: dependency order, up to `concurrency` at once */
      const byId = new Map(result.steps.map((s) => [s.id, s]));
      const running = new Map();
      const busy = new Set();     // an agent does one thing at a time, even when `concurrency` allows more
      const finish = (s) => { running.delete(s.id); busy.delete(s.agent); emitState({ phase: 'running', result }); };
      async function runStep(s) {
        const agent = runtime.get(s.agent);
        s.status = 'running'; emitState({ phase: 'running', result });
        const deps = s.depends_on.map((d) => byId.get(d)).map((d) => ({ id: d.id, agent: d.agent, text: d.result }));
        let rep;
        try {
          rep = await line.request('orchestrator', agent, stepPrompt(task, s, deps), { step: s.id });
        } catch (e) { s.status = 'failed'; s.error = e.message; return finish(s); }
        if (rep.error || rep.stopped) { s.status = stopped ? 'stopped' : 'failed'; s.error = rep.error || 'stopped'; s.result = rep.text || ''; return finish(s); }
        s.result = String(rep.text || '').trim();
        s.status = 'done';
        if (agent.role === 'reviewer') {
          s.verdict = verdictOf(s.result);
          let rounds = 0;
          while (s.verdict === 'changes-needed' && rounds < maxRework && !stopped) {
            rounds++;
            const authorStep = [...s.depends_on].reverse().map((d) => byId.get(d)).find((d) => d && runtime.get(d.agent).role !== 'reviewer');
            if (!authorStep) break;
            const author = runtime.get(authorStep.agent);
            line.log({ from: 'orchestrator', to: author.name, kind: 'system', text: `review of ${s.id} asked for changes: sending the feedback to ${author.name} (rework ${rounds} of ${maxRework})` });
            const rw = await line.request('orchestrator', author, reworkPrompt(s.result), { step: authorStep.id, rework: rounds });
            if (rw.error || rw.stopped) break;
            authorStep.result += `\n[rework ${rounds}] ${String(rw.text || '').trim()}`;
            const again = await line.request('orchestrator', agent, reReviewPrompt(s), { step: s.id, rework: rounds });
            if (again.error || again.stopped) break;
            s.result = String(again.text || '').trim();
            s.verdict = verdictOf(s.result);
          }
        }
        finish(s);
      }
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
      if (stopped) throw Object.assign(new Error('stopped'), { stopped: true });

      /* 3. final answer from the conductor */
      emitState({ phase: 'finishing', result });
      const fin = await line.request('orchestrator', conductor, finalPrompt(task, result.steps), { replyKind: 'final' });
      result.final = fin && fin.text && !fin.error ? String(fin.text).trim() : '';
      if (!result.final) {
        result.final = `The conductor could not write a summary. Step results:\n${result.steps.map((s) => `${s.id} ${s.agent}: ${s.status}`).join('\n')}`;
        line.log({ from: 'orchestrator', to: 'owner', kind: 'system', text: 'the conductor returned no final answer; showing a plain status list instead' });
      }
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

module.exports = { createOrchestrator, extractJson, validatePlan, verdictOf, ROLE_TOOLS };
