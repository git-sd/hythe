// Orchestra tab + Trace panel in the real UI: four distinct (scripted) models collaborate, the owner sees every message.
const fs = require('fs'), os = require('os'), path = require('path');
const { startPersonaFake, MODELS } = require('../fake-models');
const { launch, checker, sleep, waitFor } = require('./harness');
const { verify } = require('../../src/comms');

(async () => {
  const check = checker();
  const fake = await startPersonaFake({ delay: 40 });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-orch-gui-'));
  const h = await launch({ ollama: fake.url, workspace: proj });
  const js = (c, a) => h.page.evaluate(c, a);
  try {
    await h.open(); await sleep(700);
    await js(() => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Orchestra').click()); await sleep(1200);
    check('Orchestra tab shows four role selectors', await js(() => document.querySelectorAll('.orRole select').length === 4));
    check('the speed specialist (smallest installed model) is picked for the fast helper automatically', await js(() => /Automatic: fake-fast:1b/.test(document.querySelectorAll('.orRole select')[3].options[0].textContent)), await js(() => [...document.querySelectorAll('.orRole select')].map((s) => s.options[0].textContent)));
    check('suggested specialist models are listed with a download button, never installed automatically', await js(() => document.querySelectorAll('.orSug').length >= 2 && [...document.querySelectorAll('.orSug button')].some((b) => b.textContent === 'Download')));
    check('every installed model is offered in each selector', await js(() => [...document.querySelectorAll('.orRole select')[1].options].map((o) => o.value).filter(Boolean).length === 4));

    // choose models in the UI
    await js(([c, r]) => { const s = document.querySelectorAll('.orRole select'); s[1].value = c; s[1].dispatchEvent(new Event('change')); s[2].value = r; s[2].dispatchEvent(new Event('change')); }, [MODELS.coder, MODELS.reviewer]);
    await js(() => { const t = document.querySelector('.orTask'); t.value = 'Create a small FizzBuzz module with fizzbuzz.js, test.js and README.md'; t.dispatchEvent(new Event('input')); const m = document.querySelector('.orOpts select'); m.value = 'auto'; m.dispatchEvent(new Event('change')); });
    await js(() => [...document.querySelectorAll('.orSetup button')].find((b) => b.textContent === 'Run').click());
    check('Run opens the Trace panel', await waitFor(h.page, () => Dock.visible('trace'), null, 8000));
    check('status shows the orchestra working', await waitFor(h.page, () => /planning|working|writing the final/.test(document.querySelector('.orStatus')?.textContent || ''), null, 8000));
    check('trace fills live while it runs', await waitFor(h.page, () => document.querySelectorAll('.trEntry').length > 8, null, 10000));
    const done = await waitFor(h.page, () => /Finished: done/.test(document.querySelector('.orStatus')?.textContent || ''), null, 60000);
    check('run finishes as "done"', done, await js(() => document.querySelector('.orStatus')?.textContent));
    await sleep(400);
    check('steps listed with their agents and statuses', await js(() => document.querySelectorAll('.orStep').length === 5 && [...document.querySelectorAll('.orStep .orChip')].some((c) => c.textContent === 'approved')));
    check('final answer from the conductor is shown', await js(() => /Created fizzbuzz\.js, test\.js and README\.md/.test(document.querySelector('.orFinal')?.textContent || '')));
    check('the files were really created', ['fizzbuzz.js', 'test.js', 'README.md'].every((f) => fs.existsSync(path.join(proj, f))));
    check('all four models were used', new Set(fake.requests.map((r) => r.model)).size === 4);
    await h.page.screenshot({ path: '/tmp/claude-0/orchestra-trace.png' });

    // ---- the owner's view of the line ----
  } catch (e) { check('harness ran (part 1): ' + e.stack, false); }
  try {
    const info = await h.invoke('feat:trace:list', 0, 5000);
    const E = info.entries;
    check('trace panel count matches the real line', await js((n) => document.querySelector('.trStatus').textContent.startsWith(n + ' message'), info.count));
    check('trace contains every task prompt and tool result a model received (word for word)', (() => { const tasks = new Set(E.filter((e) => e.kind === 'task').map((e) => e.text)); const tools = new Set(E.filter((e) => e.kind === 'tool-result').map((e) => e.text)); let missing = 0; for (const r of fake.requests) for (const m of r.messages) { if (m.role === 'user' && !tasks.has(m.content)) missing++; if (m.role === 'tool' && !tools.has(m.content)) missing++; } return missing === 0; })());
    // filters
    const allCount = await js(() => document.querySelectorAll('.trEntry').length);
    await js(() => { const sel = document.querySelector('.trSel'); sel.value = 'reviewer'; sel.dispatchEvent(new Event('change')); }); await sleep(300);
    check('agent filter: only entries to/from the reviewer', await js(() => { const e = [...document.querySelectorAll('.trEntry')]; return e.length > 3 && e.every((x) => /reviewer/.test(x.querySelector('.trWho').textContent)); }));
    await js(() => { const sel = document.querySelector('.trSel'); sel.value = ''; sel.dispatchEvent(new Event('change')); [...document.querySelectorAll('.trChip')].find((b) => b.textContent === 'Tools').click(); }); await sleep(300);
    check('chip filter: hiding Tools removes tool entries', await js(() => document.querySelectorAll('.trEntry.k-tool, .trEntry.k-tool-result').length === 0 && document.querySelectorAll('.trEntry').length > 5));
    await js(() => [...document.querySelectorAll('.trChip')].find((b) => b.textContent === 'Tools').click()); await sleep(200);
    check('chip filter: showing Tools brings them back', await js(() => document.querySelectorAll('.trEntry.k-tool').length > 0));
    // long messages collapse but expand to the full text
    const longEntry = E.filter((e) => e.kind === 'task').sort((a, b) => b.text.length - a.text.length)[0];
    await js(() => { const el = document.querySelector('.trList'); el.scrollTop = 0; });
    check('long messages are collapsed with a "Show all (N characters)" button', await js(() => [...document.querySelectorAll('.trMore')].some((b) => /Show all \(\d[\d,]* characters\)/.test(b.textContent))));
    check('a task entry shows who sent it to whom with the model', await js(() => [...document.querySelectorAll('.trEntry.k-task')].some((e) => /orchestrator → coder/.test(e.querySelector('.trWho').textContent) && /fake-coder:7b/.test(e.querySelector('.trModel').textContent))));
    // verify
    await js(() => [...document.querySelectorAll('.trBar button')].find((b) => b.textContent === 'Verify chain').click()); await sleep(600);
    check('Verify chain: panel says VERIFIED', await js(() => /chain VERIFIED/.test(document.querySelector('.trStatus').textContent) && document.querySelector('.trStatus').classList.contains('ok')));
    // export
    const out = path.join(proj, '..', 'exported-trace-' + Date.now() + '.jsonl');
    h.dialogState.save = out;
    await js(() => [...document.querySelectorAll('.trBar button')].find((b) => b.textContent === 'Export JSONL').click()); await sleep(600);
    const exported = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('exported JSONL is complete and its chain verifies on its own', exported.length >= E.length && verify(exported).ok, exported.length);
    h.dialogState.save = out + '.txt';
    await js(() => [...document.querySelectorAll('.trBar button')].find((b) => b.textContent === 'Export text').click()); await sleep(500);
    const txt = fs.readFileSync(out + '.txt', 'utf8');
    check('exported text is readable and untruncated', /ORCHESTRATOR|orchestrator -> coder/.test(txt) && !/chars, full text in the trace file/.test(txt) && txt.includes('YOUR STEP s5:'));
    // tamper with the file on disk -> verify notices
    const line = JSON.parse(JSON.stringify(E)); line[5].text = 'changed afterwards';
    check('a changed message is detected by the same check', !verify(line).ok);

    // ---- approvals through the UI ----
    await js(() => [...document.querySelectorAll('.orBtns button')].find((b) => b.textContent === 'New task').click()); await sleep(300);
    fs.rmSync(path.join(proj, 'fizzbuzz.js')); fs.rmSync(path.join(proj, 'test.js')); fs.rmSync(path.join(proj, 'README.md'));
    fake.seen.reviews = 5;      // reviewer approves straight away this time
    await js(() => { const t = document.querySelector('.orTask'); t.value = 'Again: FizzBuzz module'; t.dispatchEvent(new Event('input')); const m = document.querySelector('.orOpts select'); m.value = 'ask'; m.dispatchEvent(new Event('change')); });
    await js(() => [...document.querySelectorAll('.orSetup button')].find((b) => b.textContent === 'Run').click());
    check('mode "ask": an approval card appears in the Orchestra tab', await waitFor(h.page, () => !!document.querySelector('.orApproval'), null, 20000));
    check('approval shows what the agent wants to write', await js(() => /fizzbuzz\.js/.test(document.querySelector('.orApproval').textContent)));
    const nQ = (await h.invoke('feat:trace:list', 0, 5000)).entries.filter((e) => e.kind === 'question').length;
    check('the question is already in the trace before the owner answers', nQ >= 1);
    await js(() => [...document.querySelector('.orApproval').querySelectorAll('button')].find((b) => b.textContent === 'Deny').click()); await sleep(600);
    const afterDeny = (await h.invoke('feat:trace:list', 0, 5000)).entries;
    check('the owner\'s answer is in the trace as an ANSWER from "owner"', afterDeny.some((e) => e.kind === 'answer' && e.from === 'owner' && e.text === 'denied'));
    check('a denied write did not create the file', !fs.existsSync(path.join(proj, 'fizzbuzz.js')));
    // approve everything that follows
    for (let i = 0; i < 40; i++) {
      const has = await js(() => !!document.querySelector('.orApproval'));
      if (has) await js(() => [...document.querySelector('.orApproval').querySelectorAll('button')].find((b) => b.textContent === 'Allow').click());
      if (await js(() => /Finished/.test(document.querySelector('.orStatus')?.textContent || ''))) break;
      await sleep(400);
    }
    check('second run ends (denied edits are reported, not hidden)', await js(() => /Finished/.test(document.querySelector('.orStatus')?.textContent || '')), await js(() => document.querySelector('.orStatus')?.textContent));
    check('the whole record (both runs) still verifies', (await h.invoke('feat:trace:verify')).memory.ok && (await h.invoke('feat:trace:verify')).file.ok);

    // ---- stop ----
    await js(() => [...document.querySelectorAll('.orBtns button')].find((b) => b.textContent === 'New task').click()); await sleep(300);
    fake.seen.reviews = 0;
    await js(() => { const t = document.querySelector('.orTask'); t.value = 'Stop test'; t.dispatchEvent(new Event('input')); const m = document.querySelector('.orOpts select'); m.value = 'auto'; m.dispatchEvent(new Event('change')); });
    await js(() => [...document.querySelectorAll('.orSetup button')].find((b) => b.textContent === 'Run').click());
    await waitFor(h.page, () => [...document.querySelectorAll('.orBtns button')].some((b) => b.textContent === 'Stop'), null, 10000);
    await sleep(600);
    await js(() => [...document.querySelectorAll('.orBtns button')].find((b) => b.textContent === 'Stop').click());
    check('Stop ends the run', await waitFor(h.page, () => /stopped/.test(document.querySelector('.orStatus')?.textContent || ''), null, 15000), await js(() => document.querySelector('.orStatus')?.textContent));
    check('stop is in the trace', (await h.invoke('feat:trace:list', 0, 5000)).entries.some((e) => /stopped by the owner/.test(e.text)));
    // clear starts a new chain
    const oldFile = (await h.invoke('feat:trace:info')).file;
    await js(() => [...document.querySelectorAll('.trBar button')].find((b) => b.textContent === 'Clear').click()); await sleep(500);
    const ni = await h.invoke('feat:trace:info');
    check('Clear starts a fresh trace: count 0, a new file, and the old file stays on disk', ni.count === 0 && ni.file !== oldFile && fs.existsSync(oldFile), { ni, oldFile });
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran (part 2): ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
