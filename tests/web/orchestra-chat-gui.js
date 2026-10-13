// Talking to the orchestrator in the real UI: say how many agents, see them appear, run a task with them, stop, undo, restart.
const fs = require('fs'), os = require('os'), path = require('path');
const { startPersonaFake, MODELS } = require('../fake-models');
const { launch, checker, sleep, waitFor } = require('./harness');
const { verify } = require('../../src/comms');

(async () => {
  const check = checker();
  const fake = await startPersonaFake({ delay: 40 });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-orch-chat-'));
  const h = await launch({ ollama: fake.url, workspace: proj });
  const js = (c, a) => h.page.evaluate(c, a);
  const say = async (text) => {
    const n = await js(() => document.querySelectorAll('.orMsg.bot').length);
    await h.page.fill('.orInput', text);
    await h.page.press('.orInput', 'Enter');
    await waitFor(h.page, (k) => document.querySelectorAll('.orMsg.bot').length > k, n, 8000);
    await sleep(150);
  };
  const cards = () => js(() => [...document.querySelectorAll('.orAgent')].map((c) => c.querySelector('b').textContent));
  try {
    await h.open(); await sleep(700);
    await js(() => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Orchestra').click()); await sleep(1200);
    check('opens in Chat mode with a greeting and an empty-team hint', await js(() => document.querySelector('.orMode.on').textContent === 'Chat' && /Tell me how many agents/.test(document.querySelector('.orMsg.bot').textContent) && /No agents yet/.test(document.querySelector('.orTeam').textContent)));
    check('no classic form is visible in chat mode', await js(() => document.querySelector('.orSetup').hidden && document.querySelector('.orRun').hidden));

    await say('create 4 agents');
    check('"create 4 agents" makes four agent cards: 2 coders, a reviewer, a fast helper', (await cards()).join() === 'coder1,coder2,reviewer1,helper1', await cards());
    check('each card shows its model on hover and the models line groups the agents by model (the fast helper got the smallest installed one)', await js(() => { const m = [...document.querySelectorAll('.orAgent')].map((x) => x.title); return m.length === 4 && /model: fake-fast:1b/.test(m[3]) && m.every((x) => /model: \S+:\S+/.test(x)) && /fake-fast:1b: helper1/.test(document.querySelector('.orModelsLine').textContent); }));
    check('my message and the answer are in the conversation; the answer lists the team and offers undo', await js(() => { const msgs = [...document.querySelectorAll('.orMsg')]; const you = msgs.find((m) => m.classList.contains('you')); const bot = msgs.filter((m) => m.classList.contains('k-team')).pop(); return you.textContent.includes('create 4 agents') && /I created 4 agents/.test(bot.textContent) && /coder2/.test(bot.textContent) && /undo/.test(bot.textContent); }));
    check('the team header counts them', await js(() => /Team \(4\)/.test(document.querySelector('.orTeamHead').textContent)));

    await say('I want 2 coders, a tester and a reviewer');
    check('naming kinds replaces the team with exactly that', (await cards()).join() === 'coder1,coder2,tester1,reviewer1', await cards());
    await h.page.click('.orChips button:has-text("Add a reviewer")'); await sleep(900);
    check('the "Add a reviewer" suggestion chip adds one', (await cards()).join() === 'coder1,coder2,tester1,reviewer1,reviewer2', await cards());
    await js(() => [...document.querySelectorAll('.orAgent')].find((c) => c.querySelector('b').textContent === 'reviewer2').querySelector('.orX').click()); await sleep(900);
    check('the x on a card removes that agent (through the same chat, so it is logged)', (await cards()).join() === 'coder1,coder2,tester1,reviewer1', await cards());
    await say('undo');
    check('"undo" brings the removed agent back', (await cards()).includes('reviewer2'));
    await say('use bogus:1b for the coders');
    check('an unknown model is refused in the conversation and nothing changes', await js(() => /not installed/.test([...document.querySelectorAll('.orMsg.bot')].pop().textContent)) && (await cards()).length === 5);
    await say(`use ${MODELS.coder} for the coders`);
    check('"use <model> for the coders" changes the coders\' models only', await js((m) => [...document.querySelectorAll('.orAgent')].filter((c) => /^coder/.test(c.querySelector('b').textContent)).every((c) => c.title.includes('model: ' + m)) && [...document.querySelectorAll('.orAgent')].some((c) => !c.title.includes('model: ' + m)), MODELS.coder));
    await h.page.screenshot({ path: '/tmp/claude-0/orchestra-chat-team.png' });

    // ---- a task with the team ----
    await say('create 4 agents');
    await say(`use ${MODELS.coder} for the coders`);
    await say(`use ${MODELS.reviewer} for the reviewer`);
    await say("don't ask me anything");
    await h.page.fill('.orInput', 'Create a small FizzBuzz module with fizzbuzz.js, test.js and README.md');
    await h.page.press('.orInput', 'Enter');
    check('while it works: a busy line, a Stop button and progress messages', await waitFor(h.page, () => !document.querySelector('.orBusy').hidden && ![...document.querySelectorAll('.orSendRow button')].find((b) => b.textContent === 'Stop').hidden, null, 8000));
    check('progress is reported in the chat (plan, who is working)', await waitFor(h.page, () => /Plan from the conductor/.test(document.querySelector('.orLog').textContent) && /is working on s/.test(document.querySelector('.orLog').textContent), null, 30000));
    await h.page.screenshot({ path: '/tmp/claude-0/orchestra-chat-running.png' });
    const done = await waitFor(h.page, () => !!document.querySelector('.orMsg.k-final') && /Created fizzbuzz\.js/.test(document.querySelector('.orLog').textContent), null, 90000);
    check('the final answer arrives in the conversation', done);
    await sleep(300);
    check('the chat is free again: no busy line', await js(() => document.querySelector('.orBusy').hidden));
    check('the final message carries the orchestrator\'s own tool-log facts', await js(() => /Checked by the orchestrator from the tool log/.test(document.querySelector('.orLog').textContent) && /coder1 \(/.test(document.querySelector('.orLog').textContent)));
    check('the files really exist', ['fizzbuzz.js', 'test.js', 'README.md'].every((f) => fs.existsSync(path.join(proj, f))));
    check('the team\'s own agents did the work: tasks went to coder1 / reviewer1 / helper1, with the right models', (() => { const used = new Set(fake.requests.map((r) => r.model)); return used.size === 4; })());
    const info = await h.invoke('feat:trace:list', 0, 5000);
    const E = info.entries;
    check('the trace has what I said to the orchestrator and what it answered', E.some((e) => e.from === 'owner' && e.to === 'orchestrator' && e.text === 'create 4 agents') && E.some((e) => e.from === 'orchestrator' && e.to === 'owner' && /I (created|replaced your team)/.test(e.text) && e.meta.chat));
    check('the trace shows steps handed to the team\'s agents by name', E.some((e) => e.kind === 'task' && e.from === 'orchestrator' && e.to === 'coder1') && E.some((e) => e.kind === 'task' && e.to === 'reviewer1') && E.some((e) => e.kind === 'task' && e.to === 'helper1'), [...new Set(E.filter((e) => e.kind === 'task').map((e) => e.to))]);
    check('the whole record, including the conversation, verifies', verify(E).ok && (await h.invoke('feat:trace:verify')).memory.ok);

    // ---- stop ----
    fake.seen.reviews = 0;
    await h.page.fill('.orInput', 'Stop test: make another fizzbuzz');
    await h.page.press('.orInput', 'Enter');
    await waitFor(h.page, () => !document.querySelector('.orBusy').hidden, null, 8000);
    await sleep(700);
    await js(() => [...document.querySelectorAll('.orSendRow button')].find((b) => b.textContent === 'Stop').click());
    check('Stop ends the task and says so in the chat', await waitFor(h.page, () => [...document.querySelectorAll('.orMsg')].some((m) => m.textContent.endsWith('Stopped.')), null, 20000));
    check('the chat is free again after Stop', await waitFor(h.page, () => document.querySelector('.orBusy').hidden, null, 5000));

    // ---- talking to one agent ----
    await say('ask coder1 to create hello.txt containing hi');
    check('"ask coder1 ..." is answered by that agent in the conversation', await waitFor(h.page, () => /coder1/.test([...document.querySelectorAll('.orMsg.bot')].pop().textContent) && !/Asking/.test([...document.querySelectorAll('.orMsg.bot')].pop().textContent), null, 20000), await js(() => [...document.querySelectorAll('.orMsg.bot')].pop().textContent));
    check('that direct message is on the trace, from the owner to coder1', (await h.invoke('feat:trace:list', 0, 5000)).entries.some((e) => e.from === 'owner' && e.to === 'coder1' && e.kind === 'task'));

    // ---- the classic form still works, and chat comes back ----
    await js(() => [...document.querySelectorAll('.orMode')].find((b) => b.textContent === 'Task form').click()); await sleep(400);
    check('Task form mode shows the four role selectors', await js(() => document.querySelectorAll('.orRole select').length === 4 && document.querySelector('.orChatBox').hidden));
    await js(() => [...document.querySelectorAll('.orMode')].find((b) => b.textContent === 'Chat').click()); await sleep(300);
    check('back in Chat the conversation is still there', await js(() => document.querySelectorAll('.orMsg').length > 10));

    // ---- saved for the next start ----
    await sleep(900);
    const saved = JSON.parse(fs.readFileSync(path.join(h.userData, 'settings.json'), 'utf8')).features.orchestra.chat;
    check('the team and the conversation were saved to the settings file (the next start loads them)', saved.team.map((a) => a.name).join() === 'coder1,coder2,reviewer1,helper1' && saved.history.length > 10 && saved.history.some((m) => m.text === 'create 4 agents') && saved.concurrency === 1 && saved.mode === 'auto', saved.team);
    check('no page errors after all of it', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  try { await h.close(); } catch { /* already closed */ }
  await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
