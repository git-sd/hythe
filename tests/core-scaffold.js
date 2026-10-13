// Scaffold test: does the extension API work inside the real app?
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);   // unique per run so parallel test runs do not collide
fs.rmSync(path.join(process.env.TEMP, 'faber-smoke-' + TAG), { recursive: true, force: true });
app.setPath('userData', path.join(process.env.TEMP, 'faber-smoke-' + TAG));
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-scaffold-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  try {
    check('Faber API present', (await js('typeof Faber.addSideTab')) === 'function');
    check('app is usable (setup passed)', (await js("!document.getElementById('app').hidden")) === true);
    check('activity bar shows only Files at first', (await js("document.querySelectorAll('#railTop .rbtn').length")) === 1);

    await js(`Faber.addSideTab({ id: 't1', title: 'Test', render: (el) => { el.textContent = 'hello pane'; } })`);
    check('activity bar gets a second icon', (await js("document.querySelectorAll('#railTop .rbtn').length")) === 2);
    await js(`document.querySelectorAll('#railTop .rbtn')[1].click()`);
    check('clicking the tab shows its pane', (await js("document.getElementById('pane-t1').textContent")) === 'hello pane' && (await js("document.getElementById('pane-t1').hidden")) === false);
    check('Files pane hidden meanwhile', (await js("document.getElementById('paneFiles').hidden")) === true);
    await js(`document.querySelectorAll('#railTop .rbtn')[0].click()`);
    check('Files pane returns', (await js("document.getElementById('paneFiles').hidden")) === false);

    await js(`Faber.addCommand('hello', '', 'test command', () => { window.__ran = true; })`);
    await js(`runCommand('/hello')`);
    check('custom slash command runs', (await js('window.__ran')) === true);

    await js(`Faber.addHeaderButton({ id: 'hb', label: 'HB', onClick: () => { window.__hb = 1; } })`);
    await js(`document.getElementById('hb').click()`);
    check('header button works', (await js('window.__hb')) === 1);

    check('modal opens and closes', (await js(`(() => { const m = Faber.modal({ title: 'T', body: (el) => { el.textContent = 'x'; } }); const open = !!document.querySelector('.modalCard'); m.close(); return open && !document.querySelector('.modalCard'); })()`)) === true);

    await js(`Faber.saveFeatureSettings('demo', { a: 1 })`);
    await js(`Faber.saveFeatureSettings('demo', { b: 2 })`);
    check('feature settings merge per feature', JSON.stringify(await js("Faber.featureSettings('demo')")) === '{"a":1,"b":2}');

    const blocked = await js(`window.api.call('settings:get').then(() => 'ALLOWED', () => 'blocked')`);
    check('non-feat channels blocked', blocked === 'blocked');
    const unknown = await js(`window.api.call('feat:nope:x').then(() => 'ok', (e) => 'rejected')`);
    check('unknown feat channel rejects cleanly', unknown === 'rejected');
    check('no console errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
