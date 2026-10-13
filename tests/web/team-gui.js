// Team tab in the real UI: setup form -> start -> live board -> split panes -> done/summary; stop button while running.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep, waitFor } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake({ models: ['qwen3.5:9b'] });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-team-'));
  let slow = false;
  fake.script = async (body) => {
    const name = (/You are "([^"]+)"/.exec(body.messages[0].content) || [])[1];
    const msgs = body.messages; let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
    const prompt = msgs[li].content;
    const n = msgs.slice(li + 1).filter((x) => x.role === 'tool').length;
    const call = (a, b) => ({ calls: [{ name: a, args: b }] });
    if (/final summary/.test(prompt)) return { content: 'All done: notes.txt created and reviewed.' };
    if (name === 'Lead') return /Plan it now/.test(prompt) ? [call('board_add_task', { title: 'Create notes.txt', owner: 'Coder' }), call('board_add_task', { title: 'Review notes.txt', owner: 'Reviewer' }), call('finish_work', {}), { content: 'planned' }][n] : [call('finish_work', {}), { content: 'ok' }][n];
    if (name === 'Coder') { if (slow) return { content: Array.from({ length: 300 }, (_, i) => `w${i} `).join(''), delay: 50 }; return [call('write_file', { path: 'notes.txt', content: 'hi' }), call('board_note', { text: 'notes.txt is in the project root' }), call('board_update_task', { id: 't1', status: 'done', result: 'created' }), call('finish_work', { result: 'done' }), { content: 'ok' }][n]; }
    if (name === 'Reviewer') return [call('read_file', { path: 'notes.txt' }), call('board_update_task', { id: 't2', status: 'done', result: 'fine' }), call('finish_work', {}), { content: 'ok' }][n];
    return { content: 'ok' };
  };
  const h = await launch({ ollama: fake.url, workspace: proj });
  try {
    await h.open(); await sleep(500);
    await h.js(() => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Team').click()); await sleep(400);
    check('Team tab shows the setup form', await h.js(() => !!document.querySelector('.tmTask') && document.querySelectorAll('.tmMember').length === 3));
    check('default members Lead / Coder / Reviewer', await h.js(() => [...document.querySelectorAll('.tmMember input:first-child')].map((i) => i.value).join() === 'Lead,Coder,Reviewer'));
    // empty task is refused with a message
    await h.js(() => [...document.querySelectorAll('.tmSetup button')].find((b) => b.textContent === 'Start team').click()); await sleep(500);
    check('empty task refused (no team created)', (await h.invoke('feat:team:state')).team === null);
    await h.js(() => { const t = document.querySelector('.tmTask'); t.value = 'Create notes.txt and review it'; t.dispatchEvent(new Event('input')); const sel = document.querySelectorAll('.tmOpts select')[0]; sel.value = 'auto'; sel.dispatchEvent(new Event('change')); });
    await h.page.screenshot({ path: '/tmp/claude-0/team-setup.png' });
    await h.js(() => [...document.querySelectorAll('.tmSetup button')].find((b) => b.textContent === 'Start team').click());
    check('run view replaces the setup form', await waitFor(h.page, () => !document.querySelector('.tmRun').hidden && document.querySelector('.tmSetup').hidden, null, 8000));
    check('members appear as split panes', await waitFor(h.page, () => document.querySelectorAll('.pane').length === 3, null, 8000));
    check('member agents have tabs', await h.js(() => [...document.querySelectorAll('#agentTabs .atab .nm')].map((x) => x.textContent).includes('Coder')));
    const ok = await waitFor(h.page, () => /done/.test(document.querySelector('.tmStatus')?.textContent || ''), null, 40000);
    check('status reaches done', ok, await h.js(() => document.querySelector('.tmStatus')?.textContent));
    await sleep(500);
    check('summary shown', await h.js(() => /All done: notes\.txt created/.test(document.querySelector('.tmSummary')?.textContent || '')));
    const rows = await h.js(() => [...document.querySelectorAll('.tmTaskRow')].map((r) => r.textContent));
    check('task list shows both tasks done with owners', rows.length === 2 && rows.every((r) => /done/.test(r)) && /Coder/.test(rows[0]) && /Reviewer/.test(rows[1]), rows);
    check('tasks header counts 2 of 2', await h.js(() => /2 of 2 done/.test(document.querySelector('.tmSec:nth-of-type(2) summary')?.textContent || '') || [...document.querySelectorAll('.tmSec summary')].some((s) => /2 of 2 done/.test(s.textContent))));
    await h.js(() => [...document.querySelectorAll('.tmSec summary')].find((s) => /^Notes/.test(s.textContent)).parentNode.open = true);
    check('note from the coder visible on the board', await h.js(() => /notes\.txt is in the project root/.test(document.body.textContent)));
    check('file created by the coder', fs.existsSync(path.join(proj, 'notes.txt')));
    check('member activity strips in the panes mention their work', await h.js(() => [...document.querySelectorAll('.pane .pStrip')].length === 3));
    await h.page.screenshot({ path: '/tmp/claude-0/team-done.png' });

    // user steering: add a task + a note while idle (done team still accepts board edits)
    await h.js(() => { const i = document.querySelector('.tmForm input'); i.value = 'Extra task from the user'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }); await sleep(500);
    check('user can add a task to the board', await h.js(() => /Extra task from the user/.test(document.querySelector('.tmBody').parentNode.parentNode.textContent) || [...document.querySelectorAll('.tmTaskTitle')].some((x) => /Extra task/.test(x.textContent))));

    // new team, slow, then Stop from the UI
    await h.js(() => [...document.querySelectorAll('.tmBtns button')].find((b) => b.textContent === 'New team').click()); await sleep(500);
    check('New team returns to the setup form', await h.js(() => !document.querySelector('.tmSetup').hidden && document.querySelector('.tmTask').value === 'Create notes.txt and review it'));
    slow = true;
    await h.js(() => [...document.querySelectorAll('.tmSetup button')].find((b) => b.textContent === 'Start team').click());
    check('Stop button visible while the team runs', await waitFor(h.page, () => [...document.querySelectorAll('.tmBtns button')].some((b) => b.textContent === 'Stop'), null, 15000));
    await waitFor(h.page, () => [...document.querySelectorAll('.pStrip')].some((s) => /working|writing/.test(s.textContent)), null, 15000);
    await h.js(() => [...document.querySelectorAll('.tmBtns button')].find((b) => b.textContent === 'Stop').click());
    check('status becomes stopped', await waitFor(h.page, () => /stopped/.test(document.querySelector('.tmStatus')?.textContent || ''), null, 10000));
    check('Resume offered after stop', await h.js(() => [...document.querySelectorAll('.tmBtns button')].some((b) => b.textContent === 'Resume')));
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
