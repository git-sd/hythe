// The app must always fill the window: no page scroll, top bar never moves (real app).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const ud = path.join(process.env.TEMP, 'faber-smoke-' + TAG);
const proj = path.join(process.env.TEMP, 'faber-scroll-' + TAG);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(proj, 'src', 'file' + String(i).padStart(2, '0') + '.js'), 'const x = ' + i + ';\n'.repeat(200));
app.setPath('userData', ud);
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-scroll-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg.slice(0, 200)); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  const metrics = () => js(`({ sh: document.scrollingElement.scrollHeight, ih: innerHeight, sy: scrollY, headerTop: Math.round(document.querySelector('header').getBoundingClientRect().top), appBottom: Math.round(document.getElementById('app').getBoundingClientRect().bottom), barBottom: Math.round(document.getElementById('bar').getBoundingClientRect().bottom) })`);
  try {
    const m0 = await metrics();
    print('startup metrics', JSON.stringify(m0));
    check('page is not taller than the window at startup', m0.sh <= m0.ih, JSON.stringify(m0));

    await js(`api.openFolder(${JSON.stringify(proj)}).then(async (s) => { settings = s; render(); await refreshTree(); return 1; })`);
    await js(`document.querySelector('#tree .row').click(); 0`);
    await sleep(800);
    await js(`openFile(${JSON.stringify(path.join(proj, 'src', 'file05.js'))})`);
    await sleep(600);
    await js(`newTerminal()`);
    await sleep(2500);
    // the things that used to be able to scroll the whole page
    await js(`document.querySelector('#tabs .tab')?.scrollIntoView(); document.getElementById('bar').scrollIntoView(); document.querySelector('#tree .row:last-child')?.scrollIntoView(); document.getElementById('edText').focus(); 0`);
    await js(`window.scrollTo(0, 400); document.scrollingElement.scrollTop = 400; document.body.scrollTop = 400; 0`);
    await sleep(300);
    const m1 = await metrics();
    print('after scroll attempts', JSON.stringify(m1));
    check('page cannot be scrolled', m1.sy === 0, JSON.stringify(m1));
    check('top bar stays at the top', m1.headerTop === 0, JSON.stringify(m1));
    check('bottom bar stays inside the window', m1.barBottom <= m1.ih, JSON.stringify(m1));

    // an oversized element must not make the page scroll either
    await js(`const d = document.createElement('div'); d.id = 'oversize'; d.style.cssText = 'height:3000px;width:10px'; document.getElementById('chat').appendChild(d); document.getElementById('chat').scrollTop = 99999; window.scrollTo(0, 500); 0`);
    await sleep(300);
    const m2 = await metrics();
    check('oversized chat content scrolls inside the chat only', m2.sy === 0 && m2.headerTop === 0 && m2.barBottom <= m2.ih, JSON.stringify(m2));

    // mimic opening many things at once
    await js(`Faber.addMenuItem('Tools', { id: 'zz', label: 'z', action() {} }); toggleEditor(true); showTerm(true); 0`);
    await sleep(300);
    const m3 = await metrics();
    check('still fits with editor + terminal + tools menu', m3.sy === 0 && m3.sh <= m3.ih && m3.headerTop === 0, JSON.stringify(m3));

    // a tall menu must not push the layout
    await js(`[...document.querySelectorAll('#menubar .mbtn')].find((b) => b.textContent === 'View').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 0`);
    await sleep(200);
    const m4 = await metrics();
    check('open menu does not scroll the page', m4.sy === 0 && m4.headerTop === 0, JSON.stringify(m4));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 0`);
    // zoom (View > Zoom In) and small windows are the usual way a page grows taller than the window
    for (const z of [1.2, 1.5]) {
      await js(`api.setZoom(${z}); window.scrollTo(0, 400); document.scrollingElement.scrollTop = 400; 0`);
      await sleep(250);
      const mz = await metrics();
      check('zoom ' + z + ': page does not scroll and header stays', mz.sy === 0 && mz.sh <= mz.ih && mz.headerTop === 0 && mz.appBottom === mz.ih, JSON.stringify(mz));
    }
    await js(`api.setZoom(1); 0`);
    for (const [w, h] of [[1000, 600], [1280, 640]]) {
      win.setSize(w, h);
      await sleep(500);
      await js(`window.scrollTo(0, 300); document.scrollingElement.scrollTop = 300; 0`);
      const ms = await metrics();
      check('window ' + w + 'x' + h + ': fits, no scroll, header visible', ms.sy === 0 && ms.sh <= ms.ih && ms.headerTop === 0 && ms.barBottom <= ms.ih, JSON.stringify(ms));
    }
    check('no console errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
