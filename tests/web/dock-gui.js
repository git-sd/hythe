// Dockable layout: drag panels to edges / stack them, editor groups with shared documents, save/restore layouts.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-dock-'));
  fs.writeFileSync(path.join(proj, 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(proj, 'b.js'), 'const b = 2;\n');
  const h = await launch({ ollama: fake.url, workspace: proj });
  const js = (c, a) => h.page.evaluate(c, a);
  const rect = (sel) => js((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; }, sel);
  const tabRect = (id) => rect(`.dTab[data-panel="${id}"]`);
  const leafRect = (id) => js((id) => { const t = document.querySelector(`.dTab[data-panel="${id}"]`); const l = t && t.closest('.dLeaf'); if (!l) return null; const r = l.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; }, id);
  const drag = async (panel, to) => {
    const t = await tabRect(panel);
    await h.page.mouse.move(t.l + 20, t.t + 12);
    await h.page.mouse.down();
    await h.page.mouse.move(t.l + 40, t.t + 30, { steps: 3 });
    await h.page.mouse.move(to.x, to.y, { steps: 8 });
    return { up: async () => { await h.page.mouse.up(); await sleep(250); } };
  };
  // compare layouts ignoring generated leaf ids and float noise in the size fractions
  const norm = (j) => j.replace(/"id":"L\d+",/g, '').replace(/(\d+\.\d{3})\d+/g, '$1');
  const noScroll = () => js(() => document.scrollingElement.scrollHeight <= innerHeight && scrollY === 0);
  try {
    await h.open(); await sleep(700);
    check('start: only the chat is docked', await js(() => Dock.visibleIds().join() === 'chat'));
    check('chat panel has a drag header', await js(() => !!document.querySelector('.dTab[data-panel="chat"]')));
    await js((p) => openFile(p), path.join(proj, 'a.js')); await sleep(500);
    let chat = await leafRect('chat'), ed = await leafRect('editor1');
    check('opening a file docks the editor to the right of the chat', ed && chat && ed.l >= chat.r - 2 && Math.abs(ed.t - chat.t) < 3, { chat, ed });
    await js(() => showTerm(true)); await sleep(700);
    let term = await leafRect('terminal');
    chat = await leafRect('chat');
    check('terminal docks under the chat', term && term.t >= chat.b - 2 && Math.abs(term.l - chat.l) < 3, { chat, term });
    check('terminal got a real size and a screen', await js(() => { const r = document.getElementById('termHost').getBoundingClientRect(); return r.width > 100 && r.height > 50 && !!activeTerm && activeTerm.term.cols > 10; }));
    await h.page.screenshot({ path: '/tmp/claude-0/dock-1.png' });

    // drag the terminal onto the RIGHT edge of the editor
    ed = await leafRect('editor1');
    let d = await drag('terminal', { x: ed.r - 30, y: ed.t + ed.h / 2 });
    check('drop overlay is shown while dragging', await js(() => getComputedStyle(document.querySelector('.dDrop')).display === 'block'));
    await d.up();
    term = await leafRect('terminal'); ed = await leafRect('editor1'); chat = await leafRect('chat');
    check('terminal now sits right of the editor, full height', term && term.l >= ed.r - 2 && term.h > 400 && Math.abs(term.t - ed.t) < 3, { chat, ed, term });
    check('chat leaf grew back to the full height', (await leafRect('chat')).h > 400);
    check('no panel is empty or off-screen', await js(() => [...document.querySelectorAll('.dLeaf')].every((l) => { const r = l.getBoundingClientRect(); return r.width > 80 && r.height > 60 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })));
    check('page does not scroll', await noScroll());

    // stack the terminal with the chat (drop in the middle)
    chat = await leafRect('chat');
    d = await drag('terminal', { x: chat.l + chat.w / 2, y: chat.t + chat.h / 2 });
    await d.up();
    check('stacked: chat leaf now has two tabs', await js(() => document.querySelectorAll('.dTab[data-panel="chat"]').length === 1 && document.querySelector('.dTab[data-panel="chat"]').closest('.dLeaf').querySelectorAll('.dTab').length === 2));
    check('stacked: the terminal is the active tab and visible', await js(() => !document.getElementById('term').hidden && document.getElementById('chatPanel').hidden));
    await js(() => document.querySelector('.dTab[data-panel="chat"]').click()); await sleep(250);
    check('clicking the Chat tab brings the chat back', await js(() => !document.getElementById('chatPanel').hidden && document.getElementById('term').hidden));
    check('chat content survived the move', await js(() => document.querySelectorAll('#chat .msg').length > 0));

    // move the editor under the chat (bottom edge)
    chat = await leafRect('chat');
    d = await drag('editor1', { x: chat.l + chat.w / 2, y: chat.b - 25 });
    await d.up();
    ed = await leafRect('editor1'); chat = await leafRect('chat');
    check('editor docked below the chat leaf', ed && ed.t >= chat.b - 2 && ed.w > 300, { chat, ed });
    // and to the left edge of the whole dock
    const dockR = await rect('#dock');
    d = await drag('editor1', { x: dockR.l + 6, y: dockR.t + 200 });
    await d.up();
    ed = await leafRect('editor1'); chat = await leafRect('chat');
    check('dropping on the outer left edge wraps the whole layout', ed && ed.l <= dockR.l + 2 && chat.l >= ed.r - 2 && ed.h > 400, { ed, chat });

    // Escape cancels a drag
    const before = await js(() => JSON.stringify(Dock.serialize()));
    d = await drag('editor1', { x: chat.l + chat.w / 2, y: chat.t + 80 });
    await h.page.keyboard.press('Escape'); await h.page.mouse.up(); await sleep(200);
    check('Escape cancels the drag (layout unchanged)', (await js(() => JSON.stringify(Dock.serialize()))) === before);
    check('overlay and ghost removed after cancel', await js(() => !document.querySelector('.dDrop') && !document.querySelector('.dGhost') && !document.body.classList.contains('dDragging')));

    // splitter between two leaves
    const sp = await rect('.dSp');
    const w0 = (await leafRect('editor1')).w;
    await h.page.mouse.move(sp.l + 2, sp.t + 100); await h.page.mouse.down(); await h.page.mouse.move(sp.l + 140, sp.t + 100, { steps: 6 }); await h.page.mouse.up(); await sleep(200);
    check('dragging a dock splitter resizes the panels', (await leafRect('editor1')).w > w0 + 60, { w0, w1: (await leafRect('editor1')).w });

    // ---- editor groups, shared documents ----
    await js(() => Dock.reset()); await sleep(300);
    await js((p) => openFile(p), path.join(proj, 'a.js')); await sleep(400);
    await js(() => Editors.split()); await sleep(500);
    check('Split creates a second editor group beside the first', await js(() => Editors.count() === 2 && Dock.visible('editor1') && Dock.visible('editor2')));
    const e1 = await leafRect('editor1'), e2 = await leafRect('editor2');
    check('the two editors are side by side', e2 && e1 && e2.l >= e1.r - 2 && Math.abs(e2.t - e1.t) < 3, { e1, e2 });
    check('both show a.js', await js(() => Editors.list().every((g) => g.tabs.length === 1 && /a\.js$/.test(g.tabs[0]))));
    check('exactly one group owns the legacy ids (the active one)', await js(() => document.querySelectorAll('#edText').length === 1 && document.querySelectorAll('textarea.edText').length === 2));
    // type in group 2 -> group 1 follows
    await js(() => { const ta = document.querySelectorAll('textarea.edText')[1]; ta.focus(); ta.value = 'const a = 42; // typed in group 2\n'; ta.dispatchEvent(new Event('input')); });
    await sleep(200);
    check('typing in one group shows up in the other', await js(() => document.querySelectorAll('textarea.edText')[0].value.includes('typed in group 2')));
    check('both groups mark the file as unsaved', await js(() => [...document.querySelectorAll('.edTabs .tab')].every((t) => t.classList.contains('dirty'))));
    check('Ctrl+S saves for both', await (async () => { await h.page.keyboard.press('Control+s'); await sleep(500); return fs.readFileSync(path.join(proj, 'a.js'), 'utf8').includes('typed in group 2') && await js(() => [...document.querySelectorAll('.edTabs .tab')].every((t) => !t.classList.contains('dirty'))); })());
    // different files in each group
    await js(() => { document.querySelectorAll('textarea.edText')[0].focus(); });
    await js((p) => openFile(p), path.join(proj, 'b.js')); await sleep(400);
    check('opening a file goes to the active group; the other keeps its file', await js(() => { const l = Editors.list(); return l[0].tabs.length === 2 && l[1].tabs.length === 1; }), await js(() => Editors.list()));
    // disk change reaches both groups
    fs.writeFileSync(path.join(proj, 'a.js'), 'const a = "from disk";\n'); await sleep(1800);
    check('a change on disk updates every group showing the file', await js(() => [...document.querySelectorAll('textarea.edText')].some((t) => t.value.includes('from disk'))));
    // close group 2
    await js(() => document.querySelector('.dTab[data-panel="editor2"] .dClose').click()); await sleep(300);
    check('closing the extra group removes it', await js(() => Editors.count() === 1 && !Dock.visible('editor2') && document.querySelectorAll('textarea.edText').length === 1));
    check('the remaining editor became the active one (owns ids)', await js(() => !!document.getElementById('edText') && document.getElementById('edText').closest('.edGroup') === document.querySelector('.edGroup')));

    // ---- save / restore ----
    await js(() => { showTerm(true); }); await sleep(500);
    await js(() => Editors.split()); await sleep(400);
    const snap = await js(() => JSON.stringify(Dock.serialize()));
    await js(() => F_save()).catch(() => {});
    await js(() => Faber.layout.saveNamed('three-panes')); await sleep(300);
    await js(() => Dock.reset()); await sleep(300);
    check('reset keeps panels but returns to the default arrangement', await js(() => Dock.visible('terminal') && Dock.visible('editor1')));
    await js(() => Faber.layout.loadNamed('three-panes')); await sleep(500);
    check('named layout restores the exact arrangement', norm(await js(() => JSON.stringify(Dock.serialize()))) === norm(snap));
    check('saved layouts are listed in settings', (await h.invoke('settings:get')).features.dock.named['three-panes'].groups === 2);

    // persistence across a renderer reload (settings.json on disk)
    await js(() => Dock.move('terminal', 'chat', 'center')); await sleep(900);
    const persisted = await js(() => JSON.stringify(Dock.serialize())); 
    await h.page.reload(); await h.page.waitForFunction(() => window.Faber && !document.querySelector('#app').hidden); await sleep(1500);
    const after = await js(() => JSON.stringify(Dock.serialize()));
    check('layout survives a restart', norm(after) === norm(persisted), { persisted, after });
    check('editor groups were recreated', await js(() => Editors.count() === 2));
    check('terminal still stacked with chat after restart', await js(() => document.querySelector('.dTab[data-panel="chat"]').closest('.dLeaf').querySelectorAll('.dTab').length === 2));
    await h.page.screenshot({ path: '/tmp/claude-0/dock-2.png' });
    check('chat still works after all that', await (async () => { await js(() => { document.querySelector('.dTab[data-panel="chat"]').click(); $('input').value = '[say still alive]'; return submit(); }); await sleep(1200); return js(() => document.getElementById('chat').textContent.includes('still alive')); })());
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
