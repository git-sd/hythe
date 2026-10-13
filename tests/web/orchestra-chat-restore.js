// The saved team and conversation come back after a restart (the settings file is seeded the way the app writes it).
const fs = require('fs'), os = require('os'), path = require('path');
const { startPersonaFake } = require('../fake-models');
const { launch, checker, sleep } = require('./harness');

(async () => {
  const check = checker();
  const fake = await startPersonaFake({});
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-orch-restore-'));
  const chat = {
    team: [{ name: 'coder1', role: 'coder', model: 'fake-coder:7b' }, { name: 'tester1', role: 'coder', model: 'fake-coder:7b', focus: 'writing and running tests; you check that the code really works by running it' }, { name: 'reviewer1', role: 'reviewer', model: 'fake-review:3b' }],
    conductor: 'qwen3.5:9b', concurrency: 2, mode: 'ask',
    history: [{ id: 1, from: 'you', text: 'I want a coder, a tester and a reviewer', kind: 'text', ts: 1 }, { id: 2, from: 'orchestrator', text: 'I created 3 agents:\n  coder1  coder\n  tester1  tester\n  reviewer1  reviewer', kind: 'team', ts: 2 }],
  };
  const h = await launch({ ollama: fake.url, workspace: proj, settings: { features: { orchestra: { chat } } } });
  const js = (c, a) => h.page.evaluate(c, a);
  try {
    await h.open(); await sleep(700);
    await js(() => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Orchestra').click()); await sleep(1500);
    check('the saved team is shown as cards', await js(() => [...document.querySelectorAll('.orAgent b')].map((b) => b.textContent).join() === 'coder1,tester1,reviewer1'));
    check('the saved settings (2 at a time, permissions ask) are shown', await js(() => /2 at a time, permissions: ask/.test(document.querySelector('.orModelsLine').textContent)));
    check('the saved conversation is shown, in order, and the greeting is gone', await js(() => { const m = [...document.querySelectorAll('.orMsg')].map((x) => x.textContent); return m.length === 2 && /I want a coder, a tester and a reviewer/.test(m[0]) && /I created 3 agents/.test(m[1]); }));
    const st = await h.invoke('feat:orchestra:chat-state');
    check('the main process loaded the same state', st.team.length === 3 && st.concurrency === 2 && st.mode === 'ask' && st.history.length === 2 && st.conductor === 'qwen3.5:9b');
    const r = await h.invoke('feat:orchestra:chat-sendWait', 'add a reviewer');
    check('names keep counting after a restore, and the tester keeps its specialty', r.team.map((a) => a.name).join() === 'coder1,tester1,reviewer1,reviewer2' && /tests/.test(r.team[1].focus));
    check('"chat-reset" clears the team and the conversation', await (async () => { const z = await h.invoke('feat:orchestra:chat-reset'); return z.team.length === 0 && z.history.length === 0; })());
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
