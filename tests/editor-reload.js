// Manual reload test: use places the auto-watcher cannot see, then check Reload / F5 catch up.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);   // unique per run so parallel test runs do not collide
const base = path.join(process.env.TEMP, 'faber-reload-' + TAG);
const proj = path.join(base, 'proj');
const outside = path.join(base, 'outside');
fs.rmSync(base, { recursive: true, force: true });
fs.rmSync(path.join(process.env.TEMP, 'faber-smoke-' + TAG), { recursive: true, force: true });
fs.mkdirSync(path.join(proj, 'dist'), { recursive: true });   // "dist" is ignored by the watcher on purpose
fs.mkdirSync(outside, { recursive: true });
app.setPath('userData', path.join(process.env.TEMP, 'faber-smoke-' + TAG));
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-reload-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  const hasRow = (n) => js(`[...document.querySelectorAll('#tree .nm')].some((x) => x.textContent === ${JSON.stringify(n)})`);
  try {
    const ext = path.join(outside, 'ext.txt');
    fs.writeFileSync(ext, 'version one\n');
    fs.writeFileSync(path.join(proj, 'dist', 'old.txt'), 'x');
    await js(`api.openFolder(${JSON.stringify(proj)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
    await js(`window.__marker = 'still here'; document.querySelector('#tree .row').click()`);   // expand dist
    await sleep(800);
    await js(`openFile(${JSON.stringify(ext)})`);
    await sleep(600);

    // changes the watcher cannot see
    fs.writeFileSync(ext, 'version two\n');
    fs.writeFileSync(path.join(proj, 'dist', 'new.txt'), 'y');
    await sleep(1500);
    check('baseline: file outside the folder is stale without a reload', (await js("$('edText').value")).startsWith('version one'));
    check('baseline: ignored folder does not show new file yet', (await hasRow('new.txt')) === false);

    // 1) click the Reload button
    await js(`$('reloadBtn').click()`);
    await sleep(500);
    check('button confirms', (await js("$('reloadBtn').textContent")) === 'Reloaded');
    await sleep(1000);
    check('Reload button updates the open file', (await js("$('edText').value")).startsWith('version two'));
    check('Reload button shows the new file in the tree', (await hasRow('new.txt')) === true);

    // 2) F5 does the same and must NOT reload the whole window (that would wipe the chat)
    fs.writeFileSync(ext, 'version three\n');
    fs.writeFileSync(path.join(proj, 'dist', 'newer.txt'), 'z');
    await sleep(500);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
    await sleep(1800);
    check('F5 updates the open file', (await js("$('edText').value")).startsWith('version three'));
    check('F5 shows the newest file in the tree', (await hasRow('newer.txt')) === true);
    check('F5 did not reload the window', (await js('window.__marker')) === 'still here');

    // 3) Ctrl+R too
    fs.writeFileSync(ext, 'version four\n');
    await sleep(400);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    await sleep(1500);
    check('Ctrl+R updates the open file', (await js("$('edText').value")).startsWith('version four'));
    check('Ctrl+R did not reload the window', (await js('window.__marker')) === 'still here');
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
