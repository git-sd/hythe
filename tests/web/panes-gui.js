// Split chat panes: layouts, per-pane send, parallel streaming, approvals inside a pane, broadcast, splitters, persistence.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep, waitFor } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-proj-'));
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'NOTES-123\n');
  const h = await launch({ ollama: fake.url, workspace: proj, settings: {} });
  try {
    await h.open(); await sleep(600);
    check('single mode: no panes, chat visible', await h.js(() => document.getElementById('panes').hidden && !document.getElementById('chat').hidden));
    await h.js(() => Faber.chat.sessions().length === 1);
    await h.js(() => runCommand('/split columns')); await sleep(900);
    let st = await h.js(() => Faber.panes.state());
    check('/split creates a second agent when only one exists, 2 panes', st.mode === 'columns' && st.panes.length === 2, st);
    check('two pane cells with header, strip, body, input', await h.js(() => document.querySelectorAll('.pane').length === 2 && document.querySelectorAll('.pane .pHead').length === 2 && document.querySelectorAll('.pane .pBody').length === 2 && document.querySelectorAll('.pane .pInput textarea').length === 2));
    const [a, b] = st.panes;
    check('chat views live inside pane bodies', await h.js(([a, b]) => views.get(a).el.parentNode.classList.contains('pBody') && views.get(b).el.parentNode.classList.contains('pBody'), [a, b]));
    check('global input hidden (each pane has its own)', await h.js(() => document.querySelector('.inputWrap').hidden));
    check('side by side: panes share one row', await h.js(([a, b]) => { const r1 = document.querySelector(`.pane[data-sid="${a}"]`).getBoundingClientRect(), r2 = document.querySelector(`.pane[data-sid="${b}"]`).getBoundingClientRect(); return Math.abs(r1.top - r2.top) < 2 && r2.left > r1.left + 100; }, [a, b]));
    await h.page.screenshot({ path: '/tmp/claude-0/panes-cols.png' });

    // two agents working at once, each in its own pane
    const type = (sid, t) => h.js(([sid, t]) => { const ta = document.querySelector(`.pane[data-sid="${sid}"] textarea`); ta.value = t; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, [sid, t]);
    await type(a, '[slow 40]'); await type(b, '[slow 40]');
    await sleep(500);
    const strips = await h.js(([a, b]) => [a, b].map((s) => document.querySelector(`.pane[data-sid="${s}"] .pStrip`).textContent), [a, b]);
    check('activity strips show live work in both panes', strips.every((t) => /working|writing/.test(t)), strips);
    check('both agents ran concurrently (server saw 2 in flight)', await waitFor(h.page, () => true) && fake.maxInflight >= 2, fake.maxInflight);
    const idle = () => waitFor(h.page, ([a, b]) => [a, b].every((s) => Faber.chat.sessions().find((x) => x.id === s).status === 'idle'), [a, b], 20000);
    check('both finish', await idle());
    check('each pane shows only its own streamed text', await h.js(([a, b]) => views.get(a).el.textContent.includes('w39') && views.get(b).el.textContent.includes('w39') && !views.get(a).el.textContent.includes('NOTES'), [a, b]));

    // approval appears inside the right pane
    await type(b, '[write out.txt|HI]');
    check('approval card appears inside the pane that asked', await waitFor(h.page, (b) => !!document.querySelector(`.pane[data-sid="${b}"] .approval .btns button`), b, 8000) && await h.js((a) => !document.querySelector(`.pane[data-sid="${a}"] .approval`), a));
    check('strip says waiting for approval', await h.js((b) => /approval/.test(document.querySelector(`.pane[data-sid="${b}"] .pStrip`).textContent), b));
    await h.js((b) => document.querySelector(`.pane[data-sid="${b}"] .approval .btns button`).click(), b);
    await waitFor(h.page, (b) => Faber.chat.sessions().find((x) => x.id === b).status === 'idle', b, 15000);
    check('approved write happened', fs.existsSync(path.join(proj, 'out.txt')));

    // the approved write opened the editor beside the chat; close it so the widths below are the full area
    await h.js(() => { if (!document.getElementById('editor').hidden) toggleEditor(); }); await sleep(200);
    // layouts
    for (const m of ['rows', 'grid', 'focus', 'columns']) {
      await h.js((m) => Faber.panes.setMode(m), m); await sleep(250);
      const ok = await h.js((m) => document.querySelectorAll('.pane').length === 2 && Faber.panes.state().mode === m && [...document.querySelectorAll('.pane')].every((p) => p.getBoundingClientRect().width > 100 && p.getBoundingClientRect().height > 80), m);
      check('layout ' + m + ' renders both panes with real size', ok);
    }
    // rows are stacked
    await h.js(() => Faber.panes.setMode('rows')); await sleep(200);
    check('rows: panes stacked vertically', await h.js(([a, b]) => { const r1 = document.querySelector(`.pane[data-sid="${a}"]`).getBoundingClientRect(), r2 = document.querySelector(`.pane[data-sid="${b}"]`).getBoundingClientRect(); return r2.top > r1.top + 80 && Math.abs(r1.left - r2.left) < 2; }, [a, b]));
    await h.js(() => Faber.panes.setMode('columns')); await sleep(200);

    // add third and fourth, grid
    await h.js(() => Faber.chat.create().then((i) => Faber.panes.addPane(i.id))); await sleep(300);
    await h.js(() => Faber.chat.create().then((i) => Faber.panes.addPane(i.id))); await sleep(300);
    await h.js(() => Faber.panes.setMode('grid')); await sleep(300);
    check('grid of 4: two rows of two', await h.js(() => { const r = [...document.querySelectorAll('.pane')].map((p) => p.getBoundingClientRect()); const tops = [...new Set(r.map((x) => Math.round(x.top)))]; return r.length === 4 && tops.length === 2; }));
    await h.page.screenshot({ path: '/tmp/claude-0/panes-grid.png' });
    await h.js(() => Faber.panes.setMode('focus')); await sleep(300);
    const fr = await h.js(() => [...document.querySelectorAll('.pane')].map((p) => Math.round(p.getBoundingClientRect().width)));
    check('focus: big pane + small others', fr.length === 4 && fr.filter((w) => w > 500).length === 1, [fr, await h.js(() => ['panes', 'chat'].map((i) => Math.round(document.getElementById(i).getBoundingClientRect().width)).concat([Math.round(document.querySelector('main').getBoundingClientRect().width), document.getElementById('side').hidden, innerWidth]))]);
    await h.js(() => Faber.panes.setMode('columns')); await sleep(300);

    // splitter drag
    const before = await h.js(() => [...document.querySelectorAll('#panes > .pGroup > .pCell')].map((c) => c.getBoundingClientRect().width));
    const sp = await h.js(() => { const s = document.querySelector('#panes .pSplit.v').getBoundingClientRect(); return { x: s.left + s.width / 2, y: s.top + s.height / 2 }; });
    await h.page.mouse.move(sp.x, sp.y); await h.page.mouse.down(); await h.page.mouse.move(sp.x + 120, sp.y, { steps: 6 }); await h.page.mouse.up(); await sleep(200);
    const after = await h.js(() => [...document.querySelectorAll('#panes > .pGroup > .pCell')].map((c) => c.getBoundingClientRect().width));
    check('dragging a splitter resizes the neighbours', after[0] > before[0] + 40 && after[1] < before[1] - 40, { before, after });
    check('sizes were saved', await waitFor(h.page, () => true) && (await sleep(500), Object.keys((await h.invoke('settings:get')).features.panes.sizes).length > 0));

    // broadcast
    st = await h.js(() => Faber.panes.state());
    await h.js(() => { const c = document.querySelector('#paneBar .pBroadcast input'); c.checked = true; c.dispatchEvent(new Event('change')); }); await sleep(200);
    check('broadcast shows the shared input', await h.js(() => !document.querySelector('.inputWrap').hidden));
    const n0 = fake.requests.length;
    await h.js(() => { $('input').value = '[say broadcast-ok]'; return submit(); }); await sleep(1500);
    const got = await h.js((ids) => ids.filter((s) => views.get(s).el.textContent.includes('broadcast-ok')).length, st.panes);
    check('broadcast reached every pane', got === st.panes.length, got);
    check('one request per pane', fake.requests.length - n0 === st.panes.length, fake.requests.length - n0);

    // hide a pane, back to single, restore
    await h.js((id) => Faber.panes.removePane(id), st.panes[3]); await sleep(200);
    check('hiding a pane removes only the pane, not the agent', await h.js(() => document.querySelectorAll('.pane').length === 3 && Faber.chat.sessions().length === 4));
    await h.js(() => Faber.panes.setMode('single')); await sleep(300);
    check('back to single: chat visible with content', await h.js(() => !document.getElementById('chat').hidden && document.getElementById('panes').hidden && views.get(Faber.chat.active()).el.parentNode.id === 'chat' && !views.get(Faber.chat.active()).el.hidden));
    check('layout persisted', (await h.invoke('settings:get')).features.panes.mode === 'single');
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
