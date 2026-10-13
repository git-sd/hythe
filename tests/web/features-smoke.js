// Exercises agents, git, models, plugins and debug through the real IPC + renderer, with a fake Ollama.
const fs = require('fs'), os = require('os'), path = require('path'), { execSync } = require('child_process');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep, waitFor } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-proj-'));
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'NOTES-123\n');
  const h = await launch({ ollama: fake.url, workspace: proj });
  const I = h.invoke;
  try {
    await h.open(); await sleep(500);
    const sid = await h.js(() => activeSid);
    const send = (t) => h.js((t) => { $('input').value = t; return submit(); }, t);
    const idle = (id) => waitFor(h.page, (id) => Faber.chat.sessions().find((s) => s.id === id).status === 'idle', id, 20000);

    /* agents */
    await send('[say hi from fake]'); await idle(sid);
    check('agent streams a reply', (await h.js((id) => views.get(id).el.textContent, sid)).includes('hi from fake'));
    await send('[read notes.txt]'); await idle(sid);
    check('read_file tool runs and result is shown', (await h.js((id) => views.get(id).el.textContent, sid)).includes('NOTES-123'));
    await send('[write out.txt|HELLO]');
    check('write needs approval', await waitFor(h.page, () => !!document.querySelector('.approval .btns button'), null, 8000));
    await h.js(() => document.querySelector('.approval .btns button').click()); await idle(sid);
    check('approved write created the file', fs.existsSync(path.join(proj, 'out.txt')));
    await send('[delegate researcher :: look at notes.txt]'); await idle(sid);
    check('delegate_task sub-agent block rendered', (await h.js((id) => views.get(id).el.querySelectorAll('details.sub').length, sid)) === 1);
    const s2 = (await h.js(() => Faber.chat.create())).id;
    check('new agent creates tab', (await h.js(() => document.querySelectorAll('#agentTabs .atab').length)) === 2);
    await h.js((id) => Faber.chat.switchTo(id), s2);
    await send('/effort high'); await sleep(300);
    check('per-agent effort', (await h.js(() => Faber.chat.activeInfo().effort)) === 'high');

    /* git */
    let st = await I('feat:git:status');
    check('git status without repo reports no repo', st && (st.ok === false || st.repo === false || st.isRepo === false || !st.branch), st);
    console.log('  git status (no repo):', JSON.stringify(st).slice(0, 200));
    await I('feat:git:init');
    execSync('git config user.email t@t && git config user.name T', { cwd: proj });
    st = await I('feat:git:status');
    console.log('  git status (repo):', JSON.stringify(st).slice(0, 300));
    check('git init works', st && st.ok !== false, st);
    await I('feat:git:stage', { paths: ['notes.txt'] });
    const c = await I('feat:git:commit', { message: 'first' });
    check('git commit works', c && c.ok !== false, c);
    const lg = await I('feat:git:log');
    check('git log has the commit', JSON.stringify(lg).includes('first'), lg);

    /* models */
    const ml = await I('feat:models:list');
    console.log('  models list:', JSON.stringify(ml).slice(0, 250));
    check('models list returns installed models', JSON.stringify(ml).includes('fake-b:1b'), ml);

    /* plugins */
    const pl = await I('feat:plugins:list');
    console.log('  plugins:', JSON.stringify(pl).slice(0, 200));
    check('plugins list has built-ins', JSON.stringify(pl).includes('todos'), pl);

    /* debug (opt-in) */
    await I('feat:debug:set', true);
    await send('[say debug me]'); await idle(sid);
    const dl = await I('feat:debug:list');
    check('debug captured requests', JSON.stringify(dl).length > 20, dl);

    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
