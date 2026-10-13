// Port of tests/layout-scroll-smoke.js: the app always fills the window, the page never scrolls. Needs the fake terminal.
// (Electron zoom is not available in the browser harness, so the zoom part is not covered here.)
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-scroll-'));
  fs.mkdirSync(path.join(proj, 'src'));
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(proj, 'src', 'file' + String(i).padStart(2, '0') + '.js'), 'const x = ' + i + ';\n'.repeat(200));
  const h = await launch({ ollama: fake.url, workspace: proj });
  const js = (code) => h.page.evaluate(code);
  const metrics = () => js(`({ sh: document.scrollingElement.scrollHeight, ih: innerHeight, sy: scrollY, headerTop: Math.round(document.querySelector('header').getBoundingClientRect().top), appBottom: Math.round(document.getElementById('app').getBoundingClientRect().bottom), barBottom: Math.round(document.getElementById('bar').getBoundingClientRect().bottom) })`);
  try {
    await h.open(); await sleep(800);
    const m0 = await metrics();
    check('page is not taller than the window at startup', m0.sh <= m0.ih, m0);
    await js(`[...document.querySelectorAll('#tree .row')][0].click(); 0`); await sleep(500);
    await js(`openFile(${JSON.stringify(path.join(proj, 'src', 'file05.js'))})`); await sleep(600);
    await js(`newTerminal()`); await sleep(1500);
    check('terminal opened (fake pty)', await js(`Object.keys(terms).length === 1 && !$('term').hidden`));
    await js(`document.querySelector('#tabs .tab')?.scrollIntoView(); document.getElementById('bar').scrollIntoView(); document.getElementById('edText').focus(); 0`);
    await js(`window.scrollTo(0, 400); document.scrollingElement.scrollTop = 400; document.body.scrollTop = 400; 0`); await sleep(300);
    const m1 = await metrics();
    check('page cannot be scrolled', m1.sy === 0, m1);
    check('top bar stays at the top', m1.headerTop === 0, m1);
    check('bottom bar stays inside the window', m1.barBottom <= m1.ih, m1);
    await js(`const d = document.createElement('div'); d.id = 'oversize'; d.style.cssText = 'height:3000px;width:10px'; document.getElementById('chat').appendChild(d); document.getElementById('chat').scrollTop = 99999; window.scrollTo(0, 500); 0`); await sleep(300);
    const m2 = await metrics();
    check('oversized chat content scrolls inside the chat only', m2.sy === 0 && m2.headerTop === 0 && m2.barBottom <= m2.ih, m2);
    await js(`toggleEditor(true); showTerm(true); 0`); await sleep(300);
    const m3 = await metrics();
    check('still fits with editor + terminal', m3.sy === 0 && m3.sh <= m3.ih && m3.headerTop === 0, m3);
    await js(`[...document.querySelectorAll('#menubar .mbtn')].find((b) => b.textContent === 'View').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 0`); await sleep(200);
    const m4 = await metrics();
    check('open menu does not scroll the page', m4.sy === 0 && m4.headerTop === 0, m4);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 0`);
    for (const [w, hh] of [[1000, 600], [1280, 640]]) {
      await h.page.setViewportSize({ width: w, height: hh }); await sleep(500);
      await js(`window.scrollTo(0, 300); document.scrollingElement.scrollTop = 300; 0`);
      const ms = await metrics();
      check(`window ${w}x${hh}: fits, no scroll, header visible`, ms.sy === 0 && ms.sh <= ms.ih && ms.headerTop === 0 && ms.barBottom <= ms.ih, ms);
    }
    // the terminal really renders and takes input
    await js(`api.termInput(activeTerm.id, 'echo hi\\r'); 0`); await sleep(400);
    check('terminal shows output', (await js(`activeTerm.term.buffer.active.getLine(0).translateToString()`)).includes('fake-shell'));
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
