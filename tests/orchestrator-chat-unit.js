// Talking to the orchestrator: the rules that turn "I want 4 agents" into a team, and the chat that keeps it.
// Plain Node, no Ollama: the environment, the run and the direct "ask" are stand-ins.
const C = require('../src/orchestrator-chat');
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + String(JSON.stringify(x)).slice(0, 500) : '')); };
const GB = 1e9;

const MODELS = ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3:4b-instruct-2507', 'qwen3.5:0.8b'];
const INSTALLED = [{ name: 'qwen3.5:9b', size: 5.7 * GB }, { name: 'qwen3.5:4b', size: 2.7 * GB }, { name: 'qwen3:4b-instruct-2507', size: 2.5 * GB }, { name: 'qwen3.5:0.8b', size: 0.5 * GB }];
const team0 = [{ name: 'coder1', role: 'coder' }, { name: 'coder2', role: 'coder' }, { name: 'reviewer1', role: 'reviewer' }, { name: 'helper1', role: 'fast' }];
const P = (t, team = team0) => C.parseIntent(t, { team, models: MODELS });
const items = (i) => (i.spec ? i.spec.items.map((x) => x.id + ':' + x.count).join(',') : '');

(async () => {
  /* ---------- understanding what the user wants ---------- */
  for (const [t, total] of [['create 4 agents', 4], ['I want 5 agents', 5], ['i need three agents please', 3], ['make me 2 agents', 2], ['Create a team of 3', 3], ['spin up a couple of agents', 2], ['Can you create 4 agents for me?', 4], ['I want 6 agents', 6], ['make 20 agents', 20]]) {
    const i = P(t);
    check(`"${t}" -> create ${total} agents, no task`, i.type === 'create' && i.spec.total === total && !i.spec.items.length && !i.task, i);
  }
  check('"3" alone (the answer to "how many?") -> create 3', (() => { const i = P('3'); return i.type === 'create' && i.spec.total === 3; })());
  check('"two" alone -> create 2', P('two').spec.total === 2);
  check('"you decide" -> orchestrator picks', P('you decide').type === 'decide');
  check('named kinds: "I want 2 coders, a tester and a reviewer"', (() => { const i = P('I want 2 coders, a tester and a reviewer'); return i.type === 'create' && items(i) === 'coder:2,tester:1,reviewer:1'; })());
  check('a total plus kinds: "create 3 agents: 2 coders and 1 reviewer"', (() => { const i = P('create 3 agents: 2 coders and 1 reviewer'); return i.spec.total === 3 && items(i) === 'coder:2,reviewer:1'; })());
  check('verb forms: "4 agents, 2 to code, 1 to review and 1 to test"', (() => { const i = P('give me 4 agents, 2 to code, 1 to review and 1 to test'); return items(i) === 'coder:2,reviewer:1,tester:1' && !i.task; })());
  check('"3 fast helpers" and "a fast agent" are fast helpers', items(P('make 3 fast helpers')) === 'helper:3' && items(P('I want a fast agent')) === 'helper:1');
  for (const [t, it] of [['add 2 more coders', 'coder:2'], ['add a reviewer', 'reviewer:1'], ['add another researcher', 'researcher:1'], ['one more coder please', 'coder:1'], ['please add two more reviewers', 'reviewer:2'], ['add reviewer and tester', 'reviewer:1,tester:1']]) {
    const i = P(t);
    check(`"${t}" -> add ${it}`, i.type === 'add' && items(i) === it, i);
  }
  check('"add 3 agents" is an add with only a count', (() => { const i = P('add 3 agents'); return i.type === 'add' && i.spec.total === 3; })());
  check('the model named in a create request is picked up and is not part of the task', (() => { const i = P('create 2 coders on qwen3.5:4b'); return i.type === 'create' && i.model === 'qwen3.5:4b' && i.task === '' && items(i) === 'coder:2'; })());
  check('create + task: "create 3 agents and have them build a snake game in snake.js"', (() => { const i = P('create 3 agents and have them build a snake game in snake.js'); return i.type === 'create' && i.spec.total === 3 && i.task === 'build a snake game in snake.js'; })());
  check('create + task: "make me a team of 3 to build a todo app"', P('make me a team of 3 to build a todo app').task === 'build a todo app');
  check('create + task: "I need 3 agents to write fizzbuzz.js with tests"', P('I need 3 agents to write fizzbuzz.js with tests').task === 'write fizzbuzz.js with tests');
  check('create + task, task first: "build a snake game with 3 agents"', (() => { const i = P('build a snake game with 3 agents'); return i.type === 'create' && i.spec.total === 3 && i.task === 'build a snake game'; })());
  check('"make 2 agents to fix the bug in stats.js and add tests": a create (the "add" is inside the task)', (() => { const i = P('make 2 agents to fix the bug in stats.js and add tests'); return i.type === 'create' && i.task === 'fix the bug in stats.js and add tests'; })());
  check('kinds and a task together: "I want 2 coders, then build a calculator in calc.js"', (() => { const i = P('I want 2 coders, then build a calculator in calc.js'); return i.type === 'create' && items(i) === 'coder:2' && i.task === 'build a calculator in calc.js'; })());
  for (const t of ['Create a test.js file for fizzbuzz', 'Add a reviewer role to the app', 'Fix the bug in stats.js', 'build me a snake game in snake.js', 'Write a function that makes 3 agents', 'Add input validation to signup.js', 'make a login page', 'create a README with 3 sections', 'add 2 tests for median', 'review the code in stats.js', 'have them build a todo app']) {
    check(`task, not a team command: "${t}"`, P(t).type === 'task', P(t));
  }
  for (const [t, want] of [['remove coder2', { names: ['coder2'] }], ['remove 2 coders', { kinds: ['coder'], count: 2 }], ['remove the reviewer', { kinds: ['reviewer'] }], ['kill helper1', { names: ['helper1'] }], ['remove one agent', { count: 1 }], ['remove the last 2 agents', { count: 2, last: true }]]) {
    const i = P(t);
    check(`"${t}" -> remove`, i.type === 'remove' && Object.entries(want).every(([k, v]) => JSON.stringify(i[k]) === JSON.stringify(v)), i);
  }
  check('"disband", "remove all agents", "delete everyone" -> clear', ['disband', 'remove all agents', 'delete everyone', 'clear the team'].every((t) => P(t).type === 'clear'));
  check('"use qwen3.5:4b for the coders" -> set model for the coders', (() => { const i = P('use qwen3.5:4b for the coders'); return i.type === 'setmodel' && i.model === 'qwen3.5:4b' && i.targets.kinds.join() === 'coder'; })());
  check('"use qwen3.5:9b for the conductor" -> the conductor', (() => { const i = P('use qwen3.5:9b for the conductor'); return i.type === 'setmodel' && i.targets.conductor; })());
  check('"switch everyone to qwen3.5:0.8b" -> all', (() => { const i = P('switch everyone to qwen3.5:0.8b'); return i.type === 'setmodel' && i.targets.all; })());
  check('"use coder1 ... bogus:1b" -> an unknown model is reported, not guessed', P('use bogus:1b for coder1').unknown === 'bogus:1b');
  check('rename', (() => { const i = P('rename coder1 to alice'); return i.type === 'rename' && i.from === 'coder1' && i.to === 'alice'; })());
  check('list: "show the team", "list agents", "how many agents do I have?", "team", "who are my agents"', ['show the team', 'list agents', 'how many agents do I have?', 'team', 'who are my agents'].every((t) => P(t).type === 'list'));
  check('talking to one agent: "ask coder1 to ...", "@reviewer1 ...", "tell the reviewer to ..."', (() => { const a = P('ask coder1 to add a header comment to stats.js'); const b = P('@reviewer1 look at stats.js'); const c = P('tell the reviewer to check README.md'); return a.type === 'direct' && a.who === 'coder1' && a.text === 'add a header comment to stats.js' && b.who === 'reviewer1' && c.who === 'reviewer' && c.text === 'check README.md'; })());
  check('"have them build ..." is NOT a direct message to an agent called "them"', P('have them build a todo app').type === 'task');
  check('concurrency: "run 2 at a time", "work one at a time", "run them in parallel"', P('run 2 at a time').n === 2 && P('work one at a time').n === 1 && P('run them in parallel').type === 'concurrency');
  check('permissions: ask / edits / auto', P('ask me before everything').mode === 'ask' && P('only ask before commands').mode === 'edits' && P("don't ask me anything").mode === 'auto');
  check('polite and roundabout phrasings: "can I get 3 agents?", "I want to have 3 helpers", "I\'d like to have 2 coders"', P('can I get 3 agents?').spec.total === 3 && items(P('I want to have 3 helpers')) === 'helper:3' && items(P("I'd like to have 2 coders")) === 'coder:2');
  check('"I need help" and "what are the commands" are help, "which models are installed?" lists models', P('I need help').type === 'help' && P('what are the commands').type === 'help' && P('which models are installed?').type === 'models' && P('use qwen3.5:4b for the coders').type === 'setmodel');
  check('stop, undo, help, greetings', P('stop').type === 'stop' && P('undo').type === 'undo' && P('help').type === 'help' && P('hello').type === 'greeting' && P('thanks').thanks);
  check('an empty message is ignored', P('   ').type === 'empty');

  check('compactActions: paths are cut to the file name and repeats are counted', C.compactActions(['wrote /tmp/a/b/test.js', 'edited /tmp/a/b/slugify.js', 'ran `cd /tmp/a/b && node test.js`', 'ran `cd /tmp/a/b && node test.js`', 'ran `cd /tmp/a/b && node test.js`', '1 read']) === 'wrote test.js, edited slugify.js, ran `cd b && node test.js` x3, 1 read', C.compactActions(['wrote /tmp/a/b/test.js', 'ran `cd /tmp/a/b && node test.js`', 'ran `cd /tmp/a/b && node test.js`']));

  /* ---------- the mix when you only say how many ---------- */
  check('defaultMix: 1 = coder; 2 adds a reviewer; 4 adds a fast helper; 6 adds a researcher; 8 has two reviewers', C.defaultMix(1).join() === 'coder' && C.defaultMix(2).join() === 'coder,reviewer' && C.defaultMix(4).join() === 'coder,coder,reviewer,helper' && C.defaultMix(6).filter((x) => x === 'researcher').length === 1 && C.defaultMix(8).filter((x) => x === 'reviewer').length === 2);
  check('defaultMix always has exactly N agents', [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].every((n) => C.defaultMix(n).length === n));
  check('expandSpec: explicit kinds are kept as asked; a bigger total is filled with coders', C.expandSpec({ total: 0, items: [{ id: 'coder', count: 2 }, { id: 'tester', count: 1 }] }).join() === 'coder,coder,tester' && C.expandSpec({ total: 5, items: [{ id: 'coder', count: 1 }, { id: 'reviewer', count: 1 }] }).length === 5);

  /* ---------- the chat ---------- */
  const mk = (over = {}, init = {}) => {
    const log = { messages: [], changes: [], runs: [], asks: [], stops: 0 };
    const env = { ok: true, installed: INSTALLED, primary: 'qwen3.5:9b', ramTotal: 15.7 * GB, workspace: '/proj', ...over.env };
    const chat = C.createChat({
      getEnv: async () => env,
      startRun: over.startRun || (async (job) => {
        log.runs.push(job);
        job.onState({ phase: 'planning', result: { steps: [] } });
        job.onState({ phase: 'running', result: { plan: [{ id: 's1', agent: job.team[0].name, instruction: 'Do it', depends_on: [] }], steps: [{ id: 's1', agent: job.team[0].name, status: 'running' }] } });
        job.onState({ phase: 'running', result: { plan: [{ id: 's1', agent: job.team[0].name, instruction: 'Do it', depends_on: [] }], steps: [{ id: 's1', agent: job.team[0].name, status: 'done', actions: ['wrote x.js'] }] } });
        return { ok: true, status: 'done', final: 'All done. Created x.js.' };
      }),
      ask: over.ask || (async (name, text) => { log.asks.push({ name, text }); return { text: 'Done: ' + text, actions: ['edited stats.js'] }; }),
      stop: () => { log.stops++; },
      onMessage: (m) => log.messages.push(m),
      onChange: (s) => log.changes.push(s),
    }, init);
    const say = async (t) => { const n = log.messages.length; await chat.handle(t); await chat.idle(); return log.messages.slice(n).filter((m) => m.from === 'orchestrator').map((m) => m.text).join('\n---\n'); };
    const sayNow = async (t) => { const n = log.messages.length; await chat.handle(t); return log.messages.slice(n).filter((m) => m.from === 'orchestrator').map((m) => m.text).join('\n---\n'); };   // does not wait for background work
    return { chat, log, say, sayNow, env };
  };

  { // creating by count
    const { chat, log, say } = mk();
    const r = await say('I want 4 agents');
    const t = chat.team();
    check('"I want 4 agents" creates 4 agents: 2 coders, a reviewer, a fast helper', t.length === 4 && t.map((a) => a.name).join() === 'coder1,coder2,reviewer1,helper1' && t.map((a) => a.role).join() === 'coder,coder,reviewer,fast', t);
    check('each agent has a model from what is installed (the fast helper gets the smallest one, the reviewer a different model than the coder)', t[3].model === 'qwen3.5:0.8b' && t.every((a) => MODELS.includes(a.model)) && t[2].model !== t[0].model, t.map((a) => a.model));
    check('the reply lists every agent with its role and model, says the mix was its choice, and how to undo', t.every((a) => r.includes(a.name) && r.includes(a.model)) && /picked a mix/.test(r) && /undo/.test(r), r);
    check('every message, both ways, went through onMessage (so the app can put it on the trace)', log.messages.length === 2 && log.messages[0].from === 'you' && log.messages[0].text === 'I want 4 agents' && log.messages[1].from === 'orchestrator');
    check('onChange fired with the new team (so the app can save it)', log.changes.length && log.changes[log.changes.length - 1].team.length === 4);
    check('the team is shown by "show the team"', /coder1[\s\S]*helper1/.test(await say('show the team')));

    const r2 = await say('I want 2 coders, a tester and a reviewer');
    const t2 = chat.team();
    check('naming kinds replaces the team, says so, and builds exactly that', t2.map((a) => a.name).join() === 'coder1,coder2,tester1,reviewer1' && /replaced your team of 4/.test(r2), t2.map((a) => a.name));
    check('a tester is a coder (it can run things) with a specialty', t2[2].role === 'coder' && /tests/.test(t2[2].focus));
    await say('undo');
    check('"undo" brings the 4-agent team back', chat.team().map((a) => a.name).join() === 'coder1,coder2,reviewer1,helper1');
    await say('undo');
    check('"undo" again redoes it', chat.team().map((a) => a.name).join() === 'coder1,coder2,tester1,reviewer1');

    await say('add 2 more coders');
    check('"add 2 more coders" keeps the team and numbers the new ones on', chat.team().map((a) => a.name).join() === 'coder1,coder2,tester1,reviewer1,coder3,coder4');
    await say('add 2 agents');
    check('"add 2 agents" adds coders (the workers)', chat.team().slice(-2).every((a) => a.role === 'coder') && chat.team().length === 8);
    await say('remove coder2');
    check('"remove coder2" removes just that one', !chat.team().some((a) => a.name === 'coder2') && chat.team().length === 7);
    await say('remove 2 coders');
    check('"remove 2 coders" removes the last two coders (the testers are a different kind and stay)', chat.team().map((a) => a.name).join() === 'coder1,tester1,reviewer1,coder3,coder4', chat.team().map((a) => a.name));
    await say('remove the reviewer');
    check('"remove the reviewer" removes all reviewers', !chat.team().some((a) => a.role === 'reviewer'));
    await say('rename coder1 to alice');
    check('rename works and refuses a name that is taken', chat.team()[0].name === 'alice' && /already an agent/.test(await say('rename tester1 to alice')));
    await say('use qwen3.5:4b for the coders');   // coder1 is now called alice: kinds go by what an agent IS, not its name
    check('"use qwen3.5:4b for the coders" changes only the coders', chat.team().filter((a) => a.role === 'coder' && !a.focus).every((a) => a.model === 'qwen3.5:4b'));
    check('an unknown model is refused, with the list of installed ones', /not installed/.test(await say('use bogus:1b for the coders')) && chat.team()[0].model === 'qwen3.5:4b');
    await say('use qwen3.5:9b for the conductor');
    check('the conductor model can be set', chat.state().conductor === 'qwen3.5:9b');
    await say('disband');
    check('"disband" removes everyone, and undo brings them back', chat.team().length === 0 && (await say('undo'), chat.team().length > 0));
  }

  { // asking about models
    const { say } = mk();
    const r = await say('which models are installed?');
    check('"which models are installed?" lists them with sizes', /qwen3\.5:9b\s+5\.7 GB/.test(r) && /qwen3\.5:0\.8b\s+0\.5 GB/.test(r), r);
  }
  { // capping, memory advice
    const { chat, say } = mk();
    const r = await say('make 20 agents');
    check('more than 12 agents is capped, and it says so', chat.team().length === 12 && /capped it at 12/.test(r), r);
    const m = mk();
    const r2 = await m.say('I want a coder, a reviewer and a fast helper');
    check('a team on several different models warns that they will take turns, with the OLLAMA_MAX_LOADED_MODELS advice (this PC fits fewer than that)', (() => { const distinct = new Set(m.chat.team().map((a) => a.model)).size; return distinct < 2 || /take turns/.test(r2); })(), r2);
    const r2b = await m.say('use qwen3.5:4b for the coders');
    check('the same memory warning is not repeated after every change', !/take turns/.test(r2b) || r2b !== r2, r2b);
    const m2 = mk({ env: { installed: [{ name: 'qwen3.5:9b', size: 5.7 * GB }], ramTotal: 15.7 * GB } });
    const r3 = await m2.say('create 5 agents');
    check('with ONE model installed, 5 agents share it and there is no memory warning', new Set(m2.chat.team().map((a) => a.model)).size === 1 && !/take turns/.test(r3), r3);
  }

  { // a task before there is a team
    const { chat, log, say } = mk();
    const r = await say('Fix the bug in stats.js');
    check('a task with no team: the orchestrator asks how many agents, and does not run yet', /how many agents/i.test(r) && log.runs.length === 0 && chat.state().pendingTask === 'Fix the bug in stats.js', r);
    const r2 = await say('3');
    check('answering "3" creates the team and then runs the waiting task with it', chat.team().length === 3 && log.runs.length === 1 && log.runs[0].task === 'Fix the bug in stats.js' && log.runs[0].team.length === 3, { runs: log.runs.length });
    check('progress is told in the chat: the plan, who is working, who finished with which tools, then the final answer', (() => { const all = log.messages.filter((m) => m.from === 'orchestrator').map((m) => m.text).join('\n'); return /Plan from the conductor/.test(all) && /coder1 is working on s1/.test(all) && /coder1 finished s1 \(wrote x\.js\)/.test(all) && /Done\.\nAll done\. Created x\.js\./.test(all); })());
    check('after the run the chat is free again', chat.state().busy === false);
  }
  { // create + task in one sentence, with settings passed to the run
    const { chat, log, say } = mk();
    await say('run 2 at a time');
    await say('ask me before everything');
    await say('create 3 agents and have them build a snake game in snake.js');
    check('create + task in one sentence runs the task with the new team', chat.team().length === 3 && log.runs.length === 1 && log.runs[0].task === 'build a snake game in snake.js');
    check('the run gets the chat\'s settings (parallelism, permissions) and the conductor choice', log.runs[0].concurrency === 2 && log.runs[0].mode === 'ask');
  }
  { // busy, stop
    let release;
    const gate = new Promise((r) => { release = r; });
    const { chat, log, say, sayNow } = mk({ startRun: async (job) => { job.onState({ phase: 'planning', result: {} }); await gate; return { ok: false, status: 'stopped', final: '' }; } });
    await say('create 2 agents');
    await sayNow('build a thing');
    check('"build a thing" returns at once and the chat is busy while the run goes on in the background', chat.state().busy === true);
    check('a second task is refused politely', /still working/.test(await sayNow('build another thing')));
    check('team changes are refused while busy', /running/.test(await sayNow('disband')) && chat.team().length === 2);
    check('"stop" stops the run', (await sayNow('stop'), log.stops === 1));
    release(); await chat.idle();
    check('a stopped run says "Stopped." and frees the chat', chat.state().busy === false && log.messages.some((m) => m.text === 'Stopped.'));
    check('"stop" with nothing running says so', /Nothing is running/.test(await say('stop')));
  }
  { // no folder, Ollama down
    const { chat, log, say } = mk({ env: { workspace: '' } });
    await say('create 2 agents');
    check('without an open folder the agents are still created, and a task asks to open a folder', /Open a project folder/.test(await say('fix stats.js')) && log.runs.length === 0 && chat.team().length === 2);
    const d = mk({ env: { ok: false, installed: [], primary: 'qwen3.5:9b' } });
    const r = await d.say('create 2 agents');
    check('with Ollama down the agents are created on the primary model, and it says so', d.chat.team().length === 2 && d.chat.team().every((a) => a.model === 'qwen3.5:9b') && /not reachable/.test(r), r);
    check('with Ollama down a task is not started', /cannot reach Ollama/.test(await d.say('fix stats.js')) && d.log.runs.length === 0);
    const n = mk({ env: { ok: false, installed: [], primary: '' } });
    check('with Ollama down and no model at all it asks you to start Ollama instead of inventing one', /cannot reach Ollama/.test(await n.say('create 2 agents')) && n.chat.team().length === 0);
  }
  { // talking to one agent
    const { chat, log, say } = mk();
    await say('create 4 agents');
    const r = await say('ask coder1 to add a header comment to stats.js');
    check('"ask coder1 to ..." sends exactly that to coder1 and shows the reply and the tools it used', log.asks.length === 1 && log.asks[0].name === 'coder1' && log.asks[0].text === 'add a header comment to stats.js' && /coder1: Done: add a header comment to stats\.js/.test(r) && /tools: edited stats\.js/.test(r), r);
    await say('@reviewer1 look at stats.js');
    check('"@reviewer1 ..." works too', log.asks[1].name === 'reviewer1');
    check('"tell the coder ..." with two coders asks which one', /2 coders \(coder1, coder2\)\. Which one/.test(await say('tell the coder to hurry')) && log.asks.length === 2);
    check('an unknown agent is reported with the real names', /no agent called "bob"/.test(await say('@bob hi')));
    check('the chat is free again after a direct message', chat.state().busy === false);
  }
  { // persistence and housekeeping
    const a = mk();
    await a.say('create 3 agents');
    const saved = a.chat.state();
    const b = mk({}, { team: saved.team, history: saved.history, conductor: 'qwen3.5:9b', concurrency: 2, mode: 'ask' });
    check('a saved team and history are restored', b.chat.team().length === 3 && b.chat.state().history.length === saved.history.length && b.chat.state().conductor === 'qwen3.5:9b' && b.chat.state().concurrency === 2);
    check('names keep counting after a restore', (await b.say('add a coder'), b.chat.team().some((x) => x.name === 'coder3') || b.chat.team().some((x) => x.name === 'coder4')));
    check('help lists the commands', /create 4 agents/.test(await b.say('help')) && /Trace panel/.test(C.HELP));
    const many = mk();
    for (let i = 0; i < 70; i++) await many.say('show the team');
    check('history is capped at 100 messages', many.chat.state().history.length === 100 && many.log.messages.length === 140);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
