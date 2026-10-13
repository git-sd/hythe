// CRLF test: Windows line endings must not make an untouched file look "unsaved", and must survive a save.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);   // unique per run so parallel test runs do not collide
const tmp = path.join(process.env.TEMP, 'faber-crlf-' + TAG);
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(path.join(process.env.TEMP, 'faber-smoke-' + TAG), { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', path.join(process.env.TEMP, 'faber-smoke-' + TAG));
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-crlf-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crlf = (s) => s.replace(/\n/g, '\r\n');

app.whenReady().then(async () => {
  await sleep(3000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  try {
    const f = path.join(tmp, 'index.py');
    fs.writeFileSync(f, crlf('import sys\nMOD = 10\nprint(MOD)\n'));
    await js(`api.openFolder(${JSON.stringify(tmp)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
    await js(`openFile(${JSON.stringify(f)})`);
    await sleep(800);
    check('untouched CRLF file is NOT dirty', (await js('isDirty(tabs[0])')) === false);

    // the AI (or terminal) rewrites it, with Windows line endings, while you have not typed anything
    fs.writeFileSync(f, crlf('def fib(n):\n    return n\n'));
    await sleep(1200);
    check('editor updates to the new code', (await js("$('edText').value")).startsWith('def fib(n):'));
    check('no conflict warning for an untouched file', (await js('tabs[0].conflict || false')) === false);

    // you type, then save: the file must keep CRLF
    await js(`$('edText').value += '# edited\\n'; $('edText').dispatchEvent(new Event('input')); saveTab()`);
    await sleep(800);
    const raw = fs.readFileSync(f, 'utf8');
    check('saving keeps CRLF line endings', raw.includes('\r\n') && !/[^\r]\n/.test(raw), JSON.stringify(raw.slice(0, 40)));
    check('saved tab is clean', (await js('isDirty(tabs[0])')) === false);

    // you have REAL unsaved typing and the file changes on disk: conflict bar, nothing lost
    await js(`$('edText').value = 'MY WORK\\n'; $('edText').dispatchEvent(new Event('input'));`);
    fs.writeFileSync(f, crlf('AI VERSION\n'));
    await sleep(1200);
    check('your typing is kept', (await js("$('edText').value")).startsWith('MY WORK'));
    check('conflict bar is shown', (await js("!$('edConflict').hidden")) === true);
    await js(`$('edReload').click()`);
    await sleep(600);
    check('Reload from disk takes the AI version', (await js("$('edText').value")).startsWith('AI VERSION'));
    check('conflict bar closes after reload', (await js("$('edConflict').hidden")) === true);
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
