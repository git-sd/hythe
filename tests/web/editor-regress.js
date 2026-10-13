// Regression for the editor: ports of tests/editor-live.js, editor-crlf.js and editor-reload.js to the browser harness.
// Run it before and after any change to renderer/editor.js.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep } = require('./harness');
const lines = (n, mark) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};${i + 1 === 250 ? ' // ' + mark : ''}`).join('\n') + '\n';
const crlf = (s) => s.replace(/\n/g, '\r\n');

(async () => {
  const check = checker();
  const fake = await startFake();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-ed-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-out-'));
  fs.mkdirSync(path.join(tmp, 'src')); fs.mkdirSync(path.join(tmp, 'dist'));
  const h = await launch({ ollama: fake.url, workspace: tmp });
  const js = (code) => h.page.evaluate(code);
  const open = (f) => js(`openFile(${JSON.stringify(f)})`);
  const hasRow = (n) => js(`[...document.querySelectorAll('#tree .nm')].some((x) => x.textContent === ${JSON.stringify(n)})`);
  try {
    await h.open(); await sleep(800);
    /* ---- live ---- */
    const a = path.join(tmp, 'src', 'a.js');
    fs.writeFileSync(a, lines(300, 'v1'));
    await js(`api.openFolder(${JSON.stringify(tmp)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
    await js(`[...document.querySelectorAll('#tree .row')].find((r) => r.querySelector('.nm').textContent === 'src').click()`); await sleep(800);
    await open(a); await sleep(800);
    check('live: file opened in editor', (await js('tabs.length')) === 1 && (await js('tabs[0].text')).includes('v1'));
    fs.writeFileSync(a, lines(300, 'v2-from-terminal')); await sleep(1500);
    check('live: open tab reloads from disk', (await js('tabs[0].text')).includes('v2-from-terminal'));
    check('live: textarea shows new text', (await js("$('edText').value")).includes('v2-from-terminal'));
    check('live: changed lines highlighted', (await js("$('edFlash').classList.contains('on')")) === true);
    check('live: scrolled to the change', (await js("$('edText').scrollTop")) > 0);
    const b = path.join(tmp, 'src', 'b.js');
    fs.writeFileSync(b, 'export const b = 1;\n');
    await js(`window.__push('chat:event', { type: 'file_changed', path: ${JSON.stringify(b)} })`); await sleep(1500);
    check('live: AI edit auto-opens the file', (await js('tabs.length')) === 2 && (await js('tabs[activeTab].name')) === 'b.js');
    await js(`activeTab = 0; paintEditor(); $('edText').value = 'MY UNSAVED WORK\\n'; $('edText').dispatchEvent(new Event('input'));`);
    fs.writeFileSync(a, lines(300, 'v3-while-dirty')); await sleep(1500);
    check('live: unsaved edits are protected', (await js("$('edText').value")).startsWith('MY UNSAVED WORK'));
    fs.writeFileSync(path.join(tmp, 'src', 'c.txt'), 'new'); await sleep(2000);
    check('live: new file shows up in tree', await js("[...document.querySelectorAll('#tree .nm')].some((n) => n.textContent === 'c.txt')"));
    fs.rmSync(path.join(tmp, 'src', 'c.txt')); await sleep(2000);
    check('live: deleted file leaves the tree', !(await js("[...document.querySelectorAll('#tree .nm')].some((n) => n.textContent === 'c.txt')")));

    /* ---- CRLF ---- */
    await js(`tabs.length = 0; activeTab = -1; paintEditor();`);
    const f = path.join(tmp, 'index.py');
    fs.writeFileSync(f, crlf('import sys\nMOD = 10\nprint(MOD)\n'));
    await open(f); await sleep(800);
    check('crlf: untouched CRLF file is NOT dirty', (await js('isDirty(tabs[0])')) === false);
    fs.writeFileSync(f, crlf('def fib(n):\n    return n\n')); await sleep(1500);
    check('crlf: editor updates to the new code', (await js("$('edText').value")).startsWith('def fib(n):'));
    check('crlf: no conflict warning for an untouched file', (await js('tabs[0].conflict || false')) === false);
    await js(`$('edText').value += '# edited\\n'; $('edText').dispatchEvent(new Event('input')); saveTab()`); await sleep(800);
    const raw = fs.readFileSync(f, 'utf8');
    check('crlf: saving keeps CRLF line endings', raw.includes('\r\n') && !/[^\r]\n/.test(raw), JSON.stringify(raw.slice(0, 40)));
    check('crlf: saved tab is clean', (await js('isDirty(tabs[0])')) === false);
    await js(`$('edText').value = 'MY WORK\\n'; $('edText').dispatchEvent(new Event('input'));`);
    fs.writeFileSync(f, crlf('AI VERSION\n')); await sleep(1500);
    check('crlf: your typing is kept', (await js("$('edText').value")).startsWith('MY WORK'));
    check('crlf: conflict bar is shown', (await js("!$('edConflict').hidden")) === true);
    await js(`$('edReload').click()`); await sleep(600);
    check('crlf: Reload from disk takes the AI version', (await js("$('edText').value")).startsWith('AI VERSION'));
    check('crlf: conflict bar closes after reload', (await js("$('edConflict').hidden")) === true);

    /* ---- reload ---- */
    await js(`tabs.length = 0; activeTab = -1; paintEditor();`);
    const ext = path.join(outside, 'ext.txt');
    fs.writeFileSync(ext, 'version one\n');
    fs.writeFileSync(path.join(tmp, 'dist', 'old.txt'), 'x');
    await js(`window.__marker = 'still here'`);
    await js(`refreshTree()`); await sleep(500);
    await open(ext); await sleep(600);
    fs.writeFileSync(ext, 'version two\n'); fs.writeFileSync(path.join(tmp, 'dist', 'new.txt'), 'y'); await sleep(1500);
    check('reload: baseline file outside the folder is stale', (await js("$('edText').value")).startsWith('version one'));
    await js(`[...document.querySelectorAll('#tree .row')].find((r) => r.querySelector('.nm').textContent === 'dist').click()`); await sleep(500);
    await js(`$('reloadBtn').click()`); await sleep(500);
    check('reload: button confirms', (await js("$('reloadBtn').textContent")) === 'Reloaded');
    await sleep(1000);
    check('reload: button updates the open file', (await js("$('edText').value")).startsWith('version two'));
    check('reload: button shows the new file in the tree', await hasRow('new.txt'));
    fs.writeFileSync(ext, 'version three\n'); fs.writeFileSync(path.join(tmp, 'dist', 'newer.txt'), 'z'); await sleep(500);
    await js(`window.__push('app:reload')`); await sleep(1800);
    check('reload: F5 updates the open file', (await js("$('edText').value")).startsWith('version three'));
    check('reload: F5 shows the newest file', await hasRow('newer.txt'));
    check('reload: window not reloaded', (await js('window.__marker')) === 'still here');

    /* ---- misc editor behaviours other code relies on ---- */
    check('editor toggle button shows/hides the editor', await (async () => { await js('toggleEditor(false)'); const hid = await js("$('editor').hidden"); await js('toggleEditor(true)'); return hid && !(await js("$('editor').hidden")); })());
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
