// Live-update test: change files on disk from outside the editor, check the editor follows.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);   // unique per run so parallel test runs do not collide
const tmp = path.join(process.env.TEMP, 'faber-live-' + TAG);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(path.join(process.env.TEMP, 'faber-smoke-' + TAG), { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
app.setPath('userData', path.join(process.env.TEMP, 'faber-smoke-' + TAG));
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-live-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (n, mark) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};${i + 1 === 250 ? ' // ' + mark : ''}`).join('\n') + '\n';

app.whenReady().then(async () => {
  await sleep(3000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  try {
    const a = path.join(tmp, 'src', 'a.js');
    fs.writeFileSync(a, lines(300, 'v1'));
    await js(`api.openFolder(${JSON.stringify(tmp)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
    await js(`document.querySelector('#tree .row').click()`);          // expand src
    await sleep(800);
    await js(`openFile(${JSON.stringify(a)})`);
    await sleep(800);
    check('file opened in editor', (await js('tabs.length')) === 1 && (await js('tabs[0].text')).includes('v1'));

    // 1) something else (terminal / claude / run_command) rewrites the open file
    fs.writeFileSync(a, lines(300, 'v2-from-terminal'));
    await sleep(1200);
    check('open tab reloads from disk', (await js('tabs[0].text')).includes('v2-from-terminal'));
    check('textarea shows new text', (await js("$('edText').value")).includes('v2-from-terminal'));
    check('changed lines highlighted', (await js("$('edFlash').classList.contains('on')")) === true, 'top=' + (await js("$('edFlash').style.top")) + ' h=' + (await js("$('edFlash').style.height")));
    check('scrolled to the change (line 250)', (await js("$('edText').scrollTop")) > 0, 'scrollTop=' + (await js("$('edText').scrollTop")));

    // 2) the AI edits a file that is NOT open: it should open and take focus
    const b = path.join(tmp, 'src', 'b.js');
    fs.writeFileSync(b, 'export const b = 1;\n');
    win.webContents.send('chat:event', { type: 'file_changed', path: b });
    await sleep(1200);
    check('AI edit auto-opens the file', (await js('tabs.length')) === 2 && (await js('tabs[activeTab].name')) === 'b.js');

    // 3) you have unsaved typing: external change must NOT overwrite it
    await js(`activeTab = 0; paintEditor(); $('edText').value = 'MY UNSAVED WORK\\n'; $('edText').dispatchEvent(new Event('input'));`);
    fs.writeFileSync(a, lines(300, 'v3-while-dirty'));
    await sleep(1200);
    check('unsaved edits are protected', (await js("$('edText').value")).startsWith('MY UNSAVED WORK'));

    // 4) a new file appears in the tree
    fs.writeFileSync(path.join(tmp, 'src', 'c.txt'), 'new');
    await sleep(1800);
    check('new file shows up in tree', (await js("[...document.querySelectorAll('#tree .nm')].some((n) => n.textContent === 'c.txt')")) === true);

    // 5) deleted file disappears from the tree
    fs.rmSync(path.join(tmp, 'src', 'c.txt'));
    await sleep(1800);
    check('deleted file leaves the tree', (await js("[...document.querySelectorAll('#tree .nm')].some((n) => n.textContent === 'c.txt')")) === false);
    print('console/page errors:', await js('window.__errs ? JSON.stringify(window.__errs) : "n/a"'));
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
