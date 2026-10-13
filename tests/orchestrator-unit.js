// Central orchestrator + model roster + transparent line, with four distinct scripted models (tests/fake-models.js).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { startPersonaFake, MODELS } = require('./fake-models');
const { runDemo } = require('./orchestration-demo');
const { createLine, verify } = require('../src/comms');
const { createOrchestrator, extractJson, validatePlan, verdictOf } = require('../src/orchestrator');
const { resolveRoster, matches } = require('../src/model-roster');

let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); };
const GB = 1e9;
const inst = (name, size, caps = ['completion', 'tools']) => ({ name, size: size * GB, caps });

(async () => {
  /* ---------- roster ---------- */
  const r1 = resolveRoster({ installed: [inst('qwen3.5:9b', 6.6), inst('qwen2.5-coder:7b', 4.7), inst('llama3.2:1b', 1.3), inst('phi4-mini', 2.5), inst('nomic-embed-text', 0.3, ['embedding'])], primary: 'qwen3.5:9b', ramTotal: 15 * GB });
  const role = (r, x) => r.roster.find((o) => o.role === x);
  check('conductor = the primary family model', role(r1, 'conductor').model === 'qwen3.5:9b');
  check('coder = the code specialist when installed', role(r1, 'coder').model === 'qwen2.5-coder:7b', role(r1, 'coder'));
  check('fast = smallest suitable model (speed specialist)', role(r1, 'fast').model === 'llama3.2:1b', role(r1, 'fast'));
  check('reviewer is a different model from the coder', role(r1, 'reviewer').model !== role(r1, 'coder').model, role(r1, 'reviewer'));
  check('embedding-only models are never picked', !r1.roster.some((o) => o.model === 'nomic-embed-text'));
  const r2 = resolveRoster({ installed: [inst('qwen3.5:9b', 6.6)], primary: 'qwen3.5:9b', ramTotal: 15 * GB });
  check('only the primary installed: every role uses it, and says why', r2.roster.every((o) => o.model === 'qwen3.5:9b' && o.note), r2.roster);
  check('suggestions offered for roles without a specialist (never auto-installed)', r2.suggestions.some((s) => s.role === 'fast') && r2.suggestions.some((s) => s.role === 'coder'), r2.suggestions.map((s) => s.model));
  check('suggestions are filtered by RAM', !resolveRoster({ installed: [inst('qwen3.5:9b', 6.6)], primary: 'qwen3.5:9b', ramTotal: 4 * GB }).suggestions.some((s) => s.sizeGB > 1.5));
  check('no suggestion for a role that already has a specialist', !r1.suggestions.some((s) => s.role === 'coder' && s.model === 'qwen2.5-coder:7b'));
  const r3 = resolveRoster({ installed: [inst('qwen3.5:9b', 6.6), inst('x-coder:3b', 2)], primary: 'qwen3.5:9b', overrides: { coder: 'x-coder:3b', fast: 'missing:1b' } });
  check('explicit choice wins; a missing chosen model falls back with a note', role(r3, 'coder').model === 'x-coder:3b' && role(r3, 'fast').model === 'qwen3.5:9b' && /not installed/.test(role(r3, 'fast').note), r3.roster);
  check('family prefs match any tag, tagged prefs match exactly', matches('qwen2.5-coder:7b', 'qwen2.5-coder') && matches('llama3.2:1b', 'llama3.2:1b') && !matches('llama3.2:3b', 'llama3.2:1b'));

  /* ---------- plan parsing ---------- */
  const agents = [{ name: 'coder', role: 'coder' }, { name: 'reviewer', role: 'reviewer' }];
  check('extractJson: fenced json inside prose', extractJson('Sure!\n```json\n{"steps":[{"id":"a"}]}\n```\nbye').steps[0].id === 'a');
  check('extractJson: bare json with braces in strings', extractJson('{"steps":[{"instruction":"use {x} and \\"}\\" ok"}]}').steps.length === 1);
  check('extractJson: garbage -> null', extractJson('no json here {') === null && extractJson('') === null);
  const good = validatePlan({ steps: [{ id: 's1', agent: 'CODER', instruction: 'x' }, { id: 's2', agent: 'reviewer', instruction: 'y', depends_on: ['s1'] }] }, agents, 8);
  check('validatePlan accepts a good plan (agent names case-insensitive)', good.steps && good.steps[0].agent === 'coder' && good.steps[1].depends_on[0] === 's1');
  for (const [obj, re, why] of [[{ steps: [] }, /no "steps"/, 'empty'], [{ steps: [{ id: 'a', agent: 'wizard', instruction: 'x' }] }, /unknown agent/, 'unknown agent'], [{ steps: [{ id: 'a', agent: 'coder', instruction: '' }] }, /no instruction/, 'no instruction'], [{ steps: [{ id: 'a', agent: 'coder', instruction: 'x', depends_on: ['b'] }] }, /not an earlier step/, 'forward dependency'], [{ steps: [{ id: 'a', agent: 'coder', instruction: 'x' }, { id: 'a', agent: 'coder', instruction: 'y' }] }, /used twice/, 'duplicate id'], [{ steps: Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, agent: 'coder', instruction: 'x' })) }, /limit is 8/, 'too many steps']]) {
    const v = validatePlan(obj, agents, 8);
    check('validatePlan rejects: ' + why, v.error && re.test(v.error), v);
  }
  check('verdict parsing', verdictOf('VERDICT: APPROVED ok') === 'approved' && verdictOf('verdict: changes needed\n- x') === 'changes-needed' && verdictOf('looks fine') === 'none');

  /* ---------- the full multi-model run ---------- */
  const d = await runDemo({ quiet: true });
  const { result, line, fake, ws, traceFile } = d;
  const E = line.entries();
  check('run finished successfully', result.ok && result.status === 'done', { s: result.status, steps: result.steps.map((s) => s.id + ':' + s.status + ':' + s.verdict) });
  check('the plan came from the conductor model and has 5 steps', result.plan.length === 5 && E.some((e) => e.kind === 'plan' && e.from === 'conductor' && e.model === MODELS.conductor));

  const byModel = {};
  for (const r of fake.requests) (byModel[r.model] ||= []).push(r);
  check('all four different models were actually called', Object.keys(byModel).sort().join() === Object.values(MODELS).sort().join(), Object.keys(byModel));
  const toolsOf = (m) => new Set((byModel[m] || []).flatMap((r) => r.tools));
  check('coder model had write tools', toolsOf(MODELS.coder).has('write_file') && toolsOf(MODELS.coder).has('run_command'));
  check('conductor, fast and reviewer models are read-only', [MODELS.conductor, MODELS.fast, MODELS.reviewer].every((m) => !toolsOf(m).has('write_file') && !toolsOf(m).has('edit_file') && !toolsOf(m).has('run_command') && toolsOf(m).has('read_file')));
  check('each agent talked to its OWN model (entries carry the right model)', E.filter((e) => e.kind === 'task' && e.to === 'coder').every((e) => e.model === MODELS.coder) && E.filter((e) => e.kind === 'task' && e.to === 'fast').every((e) => e.model === MODELS.fast) && E.filter((e) => e.kind === 'task' && e.to === 'reviewer').every((e) => e.model === MODELS.reviewer));
  check('system prompts differ per role', new Set(Object.values(byModel).map((rs) => rs[0].system)).size === 4);

  // hand-offs: results really travel between agents
  const taskText = (step) => E.find((e) => e.kind === 'task' && e.text.includes(`YOUR STEP ${step}:`)).text;
  check('s3 (fast model) received the coder results of s1 and s2', /\[s1 by coder\]\s+Created fizzbuzz\.js/.test(taskText('s3')) && /\[s2 by coder\]\s+Created test\.js/.test(taskText('s3')));
  check('s4 (coder) received the FAST model\'s description', /\[s3 by fast\]\s+fizzbuzz\.js exports fizzbuzz/.test(taskText('s4')));
  check('s5 (reviewer) received results from 3 earlier steps', ['s1', 's2', 's4'].every((s) => taskText('s5').includes(`[${s} by `)));
  check('steps ran in dependency order', (() => { const idx = (s) => E.findIndex((e) => e.kind === 'task' && e.text.includes(`YOUR STEP ${s}:`)); return idx('s3') > idx('s1') && idx('s3') > idx('s2') && idx('s4') > idx('s3') && idx('s5') > idx('s4'); })());
  check('reviewer asked for changes once; coder reworked; re-review approved', fake.seen.reviews === 2 && fake.seen.coderReworks === 1 && result.steps.find((s) => s.id === 's5').verdict === 'approved');
  check('rework is visible in the trace as a system entry + task to the coder', E.some((e) => e.kind === 'system' && /asked for changes/.test(e.text)) && E.some((e) => e.kind === 'task' && e.to === 'coder' && /asked for changes/.test(e.text)));
  check('conductor wrote the final answer', result.final.startsWith('FINAL:') && E.some((e) => e.kind === 'final'));

  // the work itself
  check('files exist in the workspace', ['fizzbuzz.js', 'test.js', 'README.md'].every((f) => fs.existsSync(path.join(ws, f))));
  check('the produced test.js really passes', d.testOk && /all fizzbuzz tests passed/.test(d.testOut), d.testOut);
  check('README got the usage section from the rework', /## Usage/.test(fs.readFileSync(path.join(ws, 'README.md'), 'utf8')));

  // transparency: nothing a model saw is missing from the trace
  const traceTexts = new Set(E.filter((e) => e.kind === 'task').map((e) => e.text));
  const toolResults = new Set(E.filter((e) => e.kind === 'tool-result').map((e) => e.text));
  const userMsgs = new Set(), toolMsgs = new Set();
  for (const r of fake.requests) for (const m of r.messages) { if (m.role === 'user') userMsgs.add(m.content); if (m.role === 'tool') toolMsgs.add(m.content); }
  const missingPrompts = [...userMsgs].filter((t) => !traceTexts.has(t));
  const missingTools = [...toolMsgs].filter((t) => !toolResults.has(t));
  check('EVERY prompt any model received is in the trace, word for word', userMsgs.size >= 8 && missingPrompts.length === 0, missingPrompts.map((t) => t.slice(0, 80)));
  check('EVERY tool result any model received is in the trace, word for word', toolMsgs.size >= 5 && missingTools.length === 0, missingTools.map((t) => t.slice(0, 80)));
  const taskCount = E.filter((e) => e.kind === 'task').length, replyCount = E.filter((e) => ['result', 'final', 'error'].includes(e.kind) && e.to === 'orchestrator').length;
  check('every task has exactly one reply entry (result / final / error)', taskCount === replyCount, { taskCount, replyCount });
  const sentCalls = fake.requests.length;
  check('one USAGE entry per model request', E.filter((e) => e.kind === 'usage').length === sentCalls, { usage: E.filter((e) => e.kind === 'usage').length, requests: sentCalls });
  check('every agent tool call is logged with its arguments', E.filter((e) => e.kind === 'tool').some((e) => e.text.startsWith('write_file {"path":"fizzbuzz.js"')) && E.filter((e) => e.kind === 'tool').length === E.filter((e) => e.kind === 'tool-result').length);
  check('the trace file on disk equals the in-memory trace and verifies', (() => { const f = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); return f.length === E.length && verify(f).ok; })());
  const tampered = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  tampered.find((e) => e.kind === 'result' && e.from === 'reviewer').text = 'VERDICT: APPROVED (edited later)';
  check('editing a logged message afterwards is detected', !verify(tampered).ok);
  check('the run ends with a verified-chain system line', /chain verified/.test(E[E.length - 1].text));
  const sum = line.summary();
  check('per-agent summary lists the model each agent used', ['conductor', 'coder', 'fast', 'reviewer'].every((a) => (sum.find((s) => s.agent === a) || { models: [] }).models.length === 1));
  await fake.close();

  /* ---------- variations ---------- */
  const mk = async (fo, oo = {}) => {
    const f = await startPersonaFake(fo);
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-orch-'));
    const l = createLine();
    const o = createOrchestrator({ host: f.url, workspace: w, line: l, mode: 'auto', roster: { conductor: { model: MODELS.conductor }, agents: [{ name: 'coder', role: 'coder', model: MODELS.coder }, { name: 'reviewer', role: 'reviewer', model: MODELS.reviewer }, { name: 'fast', role: 'fast', model: MODELS.fast }] }, ...oo });
    return { f, w, l, o };
  };

  // bad plan -> corrected once -> visible fallback
  { const { f, l, o } = await mk({ badPlan: true });
    const r = await o.run('Make a fizzbuzz');
    const E2 = l.entries();
    check('unusable plan: the conductor is asked to fix it, then a visible fallback plan is used', E2.filter((e) => /plan rejected/.test(e.text)).length === 2 && E2.some((e) => /fallback plan/.test(e.text)) && r.plan.length === 2 && r.plan[0].agent === 'coder');
    check('fallback run still completes with a final answer', !!r.final && ['done', 'finished-with-problems'].includes(r.status), r.status);
    await f.close(); }

  // reviewer never satisfied
  { const { f, l, o } = await mk({ alwaysReject: true });
    const r = await o.run('Make a fizzbuzz');
    check('reviewer never satisfied: one rework only, run is NOT reported as clean', r.status === 'finished-with-problems' && !r.ok && r.steps.find((s) => s.agent === 'reviewer').verdict === 'changes-needed' && f.seen.coderReworks === 1, { s: r.status, rw: f.seen.coderReworks });
    check('the final prompt told the conductor about the open review', l.entries().some((e) => e.kind === 'task' && /All steps are finished/.test(e.text) && /changes-needed/.test(e.text)));
    await f.close(); }

  // a model that is not installed is replaced, visibly
  { const { f, l, o } = await mk({}, { installed: [MODELS.conductor, MODELS.coder, MODELS.reviewer], fallbackModel: MODELS.conductor });
    await o.run('Make a fizzbuzz');
    check('missing model: substitution is announced in the trace', l.entries().some((e) => e.kind === 'system' && /fake-fast:1b is not installed; fast will use qwen3\.5:9b instead/.test(e.text)));
    check('missing model: the fast agent really used the substitute', !f.requests.some((r) => r.model === MODELS.fast) && l.entries().filter((e) => e.kind === 'task' && e.to === 'fast').every((e) => e.model === MODELS.conductor));
    await f.close(); }

  // parallel steps
  { const { f, o } = await mk({ delay: 120, s2Agent: 'coder2' }, { concurrency: 2 });
    o.addAgent({ name: 'coder2', role: 'coder', model: MODELS.coder });
    await o.run('Make a fizzbuzz');
    check('concurrency 2: two independent steps on two agents overlap on the server', f.maxInflight >= 2, f.maxInflight);
    await f.close(); }
  { const { f, o } = await mk({ delay: 120 }, { concurrency: 2 });
    const r = await o.run('Make a fizzbuzz');
    check('concurrency 2 but both independent steps belong to ONE agent: they take turns (no "already working" failure)', f.maxInflight === 1 && r.steps.every((s) => s.status === 'done'), { m: f.maxInflight, st: r.steps.map((s) => s.status) });
    await f.close(); }
  { const { f, o } = await mk({ delay: 60 }, { concurrency: 1 });
    await o.run('Make a fizzbuzz');
    check('concurrency 1 (CPU default): models take turns, never overlap', f.maxInflight === 1, f.maxInflight);
    await f.close(); }

  // timeout -> failure -> dependents skipped, honest final
  { const { f, l, o } = await mk({ delayByModel: { [MODELS.coder]: 900 } }, { stepTimeoutSec: 0.4 });
    const r = await o.run('Make a fizzbuzz');
    const st = Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
    check('a step that times out fails; steps that depend on it are skipped', st.s1 === 'failed' && st.s3 === 'skipped' && st.s4 === 'skipped' && st.s5 === 'skipped', st);
    check('timeout is in the trace as an error entry', l.entries().some((e) => e.kind === 'error' && /timed out/.test(e.text)));
    check('the conductor still writes an honest final answer', /FINAL/.test(r.final) && r.status === 'finished-with-problems');
    await f.close(); }

  // stop
  { const { f, l, o } = await mk({ delay: 150 });
    const p = o.run('Make a fizzbuzz');
    await new Promise((r) => setTimeout(r, 450));
    o.stop();
    const r = await p;
    const n = f.requests.length;
    await new Promise((r2) => setTimeout(r2, 500));
    check('stop: run ends as "stopped" and no further model requests are made', r.status === 'stopped' && f.requests.length === n && f.inflight === 0, { s: r.status, n, after: f.requests.length });
    check('stop is recorded in the trace', l.entries().some((e) => /stopped by the owner/.test(e.text)));
    await f.close(); }

  // approvals are part of the conversation with the owner
  { const asked = [];
    const { f, w, l, o } = await mk({}, { mode: 'ask', approve: async (kind, title) => { asked.push(title); return false; } });
    const r = await o.run('Make a fizzbuzz');
    const E3 = l.entries();
    check('approvals: the agent\'s request and the owner\'s answer are both in the trace', E3.some((e) => e.kind === 'question' && e.from === 'coder') && E3.some((e) => e.kind === 'answer' && e.from === 'owner' && e.text === 'denied'), E3.filter((e) => /question|answer/.test(e.kind)).map((e) => e.kind + ':' + e.text.slice(0, 40)));
    check('approvals: a denied write really did not happen', !fs.existsSync(path.join(w, 'fizzbuzz.js')) && asked.length > 0);
    await f.close(); }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
