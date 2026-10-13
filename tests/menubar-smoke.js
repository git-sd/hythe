// Menu bar test (real app).
const { app, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const ud = path.join(process.env.TEMP, 'faber-smoke-' + TAG);
const tmp = path.join(process.env.TEMP, 'faber-menu-' + TAG);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', ud);
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-menubar-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  const openMenu = (name) => js(`(() => { const b = [...document.querySelectorAll('#menubar .mbtn')].find((x) => x.textContent === ${JSON.stringify(name)}); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return !!document.querySelector('.mpanel'); })()`);
  const items = () => js(`[...document.querySelectorAll('.mpanel:not(.msub) .mitem .mlab')].map((x) => x.textContent)`);
  const clickItem = (label) => js(`(() => { const r = [...document.querySelectorAll('.mitem')].find((x) => x.querySelector('.mlab').textContent === ${JSON.stringify(label)}); r.click(); return true; })()`);
  try {
    const f = path.join(tmp, 'hello.py');
    fs.writeFileSync(f, 'print("hi")\n');
    await js(`api.openFolder(${JSON.stringify(tmp)}).then(async (s) => { settings = s; render(); await refreshTree(); Faber.emit('folder', s.workspace); })`);

    const names = await js(`[...document.querySelectorAll('#menubar .mbtn')].map((x) => x.textContent)`);
    check('menu bar shows the VS Code style menus', ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'].every((n) => names.includes(n)), names.join(','));
    check('empty menus (Agents/Git/Tools) stay hidden', !names.includes('Agents') && !names.includes('Git'));
    check('old Reload button is gone from the header', (await js(`document.getElementById('reloadBtn').hidden`)) === true);

    check('clicking a menu opens it', (await openMenu('View')) === true);
    const view = await items();
    check('View lists sidebar/editor/terminal/reload', ['Sidebar', 'Editor', 'Terminal', 'Reload Files'].every((x) => view.includes(x)), view.join(','));
    check('hovering another menu switches to it', await js(`(() => { const b = [...document.querySelectorAll('#menubar .mbtn')].find((x) => x.textContent === 'File'); b.dispatchEvent(new MouseEvent('mouseenter')); return [...document.querySelectorAll('.mpanel .mlab')].some((x) => x.textContent === 'Open Folder…'); })()`));
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    check('Escape closes the menu', (await js(`!document.querySelector('.mpanel')`)) === true);

    await openMenu('View'); await clickItem('Terminal'); await sleep(2500);
    check('View > Terminal opens the terminal', (await js(`!document.getElementById('term').hidden`)) === true);
    await openMenu('Terminal'); await clickItem('Show / Hide Terminal'); await sleep(300);
    check('Terminal > Show/Hide hides it', (await js(`document.getElementById('term').hidden`)) === true);
    check('menu closes after choosing an item', (await js(`!document.querySelector('.mpanel')`)) === true);

    await openMenu('View'); await clickItem('Sidebar');
    check('View > Sidebar toggles the sidebar', (await js(`document.getElementById('side').hidden`)) === true);
    await openMenu('View'); await clickItem('Sidebar');

    await openMenu('File');
    check('File > Open Recent has a submenu entry', (await items()).includes('Open Recent'));
    const sub = await js(`(() => { const r = [...document.querySelectorAll('.mitem')].find((x) => x.querySelector('.mlab').textContent === 'Open Recent'); r.dispatchEvent(new MouseEvent('mouseenter')); return [...document.querySelectorAll('.msub .mlab')].map((x) => x.textContent); })()`);
    check('recent folders are listed', sub.length >= 1 && sub[0].includes('faber-menu'), JSON.stringify(sub));
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    await js(`openFile(${JSON.stringify(f)})`); await sleep(700);
    await openMenu('Run');
    check('Run Current File enabled for a .py file', (await js(`![...document.querySelectorAll('.mitem')].find((x) => x.querySelector('.mlab').textContent === 'Run Current File').classList.contains('off')`)) === true);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    await openMenu('View'); await clickItem('Reload Files'); await sleep(600);
    check('View > Reload Files works', (await js(`document.getElementById('reloadBtn').textContent`)) === 'Reloaded');

    await js(`Faber.addMenuItem('Agents', { id: 'x', label: 'New Agent', action: () => { window.__agent = 1; } }); 0`);
    check('a feature can add a new top-level menu', (await js(`[...document.querySelectorAll('#menubar .mbtn')].map((x) => x.textContent)`)).includes('Agents'));
    const order = await js(`[...document.querySelectorAll('#menubar .mbtn')].map((x) => x.textContent)`);
    check('new menus sit before Help', order.indexOf('Agents') < order.indexOf('Help'), order.join(','));
    await openMenu('Agents'); await clickItem('New Agent'); await sleep(100);
    check('feature menu item runs', (await js('window.__agent')) === 1);

    await openMenu('Help'); await clickItem('Keyboard Shortcuts');
    check('Help > Keyboard Shortcuts lists shortcuts', (await js(`document.querySelectorAll('.ktable tr').length`)) > 8);
    await js(`document.querySelector('.modalHead button').click()`);

    // keyboard behaviour with Electron's default menu removed
    await js(`document.getElementById('input').focus(); document.getElementById('input').value = 'select me please';`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await sleep(300);
    check('Ctrl+A selects all text in the chat box', (await js(`(() => { const i = document.getElementById('input'); return i.selectionEnd - i.selectionStart; })()`)) === 'select me please'.length);
    clipboard.writeText(' PASTED');
    await js(`(() => { const i = document.getElementById('input'); i.setSelectionRange(i.value.length, i.value.length); })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    await sleep(400);
    check('Ctrl+V still pastes', (await js(`document.getElementById('input').value`)).endsWith('PASTED'), JSON.stringify(await js(`document.getElementById('input').value`)));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] });
    await sleep(600);
    check('Ctrl+W closes the editor tab, not the window', !win.isDestroyed() && (await js('tabs.length')) === 0);
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
