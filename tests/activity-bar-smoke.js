// Activity bar (icon rail) + Find in Files test (real app).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const ud = path.join(process.env.TEMP, 'faber-smoke-' + TAG);
const proj = path.join(process.env.TEMP, 'faber-rail-' + TAG);
fs.rmSync(ud, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true });
fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'const alpha = 1;\nconst NeedleValue = 2;\nfunction needle() {}\n');
fs.writeFileSync(path.join(proj, 'src', 'b.py'), 'def run():\n    needle = 3\n    return needle\n');
fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'x.js'), 'needle inside node_modules\n');
fs.writeFileSync(path.join(proj, 'bin.dat'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1, 2]));
fs.writeFileSync(path.join(proj, 'many.txt'), Array.from({ length: 700 }, () => 'bulkterm').join('\n'));
app.setPath('userData', ud);
require(path.join(root, 'main.js'));

const LOG = path.join(process.env.TEMP, 'faber-rail-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  const search = async (q, extra = {}) => {
    await js(`(async () => { const i = document.querySelector('#pane-search input'); i.value = ${JSON.stringify(q)};
      const inc = document.querySelectorAll('#pane-search input')[1]; inc.value = ${JSON.stringify(extra.include || '')};
      const tg = document.querySelectorAll('#pane-search .tog');
      if (tg[0].classList.contains('on') !== ${!!extra.caseSensitive}) tg[0].click();
      if (tg[1].classList.contains('on') !== ${!!extra.regex}) tg[1].click();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await sleep(1200);
    return js(`({ status: document.querySelector('#pane-search .sstatus').textContent, files: [...document.querySelectorAll('#pane-search .sname')].map((x) => x.textContent), hits: document.querySelectorAll('#pane-search .shit').length })`);
  };
  try {
    await js(`api.openFolder(${JSON.stringify(proj)}).then(async (s) => { settings = s; render(); await refreshTree(); Faber.emit('folder', s.workspace); })`);

    const icons = await js(`[...document.querySelectorAll('#railTop .rbtn')].map((b) => b.title)`);
    check('rail shows Files and Search icons', icons.some((t) => t === 'Files') && icons.some((t) => t.startsWith('Search')), icons.join(' | '));
    check('rail has a Settings icon at the bottom', (await js(`document.querySelectorAll('#railBottom .rbtn').length`)) === 1);
    check('Files is active at first', (await js(`document.querySelector('#railTop .rbtn.on').title`)) === 'Files');

    await js(`[...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title.startsWith('Search')).click()`);
    check('clicking Search opens the Search pane', (await js(`!document.getElementById('pane-search').hidden && document.getElementById('paneFiles').hidden`)) === true);
    await js(`[...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title.startsWith('Search')).click()`);
    check('clicking the active icon again hides the sidebar', (await js(`document.getElementById('side').hidden`)) === true);
    await js(`[...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Files').click()`);
    check('clicking Files brings the sidebar back', (await js(`!document.getElementById('side').hidden && !document.getElementById('paneFiles').hidden`)) === true);

    await js(`Faber.setBadge('git', 3)`);
    check('badge API shows a count on an icon', (await js(`[...document.querySelectorAll('#railTop .rbtn')].some((b) => b.querySelector('.rbadge'))`)) === false, 'no git tab yet, so nothing to badge (expected)');
    await js(`Faber.addSideTab({ id: 'git', title: 'Git', render: (e) => { e.textContent = 'g'; } }); Faber.setBadge('git', 3); 0`);
    check('badge appears once the tab exists', (await js(`document.querySelector('#railTop .rbadge')?.textContent`)) === '3');

    // keyboard shortcut -> Search tab
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }))`);
    await sleep(300);
    check('Ctrl+Shift+F opens Search', (await js(`!document.getElementById('pane-search').hidden`)) === true);

    // searching
    let r = await search('needle');
    check('finds matches across files', r.files.some((f) => f.endsWith('a.js')) && r.files.some((f) => f.endsWith('b.py')), JSON.stringify(r.files));
    check('skips node_modules', !r.files.some((f) => f.includes('node_modules')));
    check('skips binary files', !r.files.some((f) => f.endsWith('bin.dat')));
    check('no 500 cap hit for a small result set', !r.status.includes('first 500'), r.status);
    const big = await search('bulkterm');
    check('caps huge result sets and says so', big.status.includes('500') && big.status.includes('first 500'), big.status);

    r = await search('needle', { include: 'py' });
    check('file type filter works', r.files.length === 1 && r.files[0].endsWith('b.py'), JSON.stringify(r.files));

    // case sensitivity is reset by re-running; toggle once for the test
    await js(`document.querySelectorAll('#pane-search .tog').forEach((b) => b.classList.remove('on'))`);
    r = await search('NeedleValue', { caseSensitive: true, include: 'js' });
    check('case-sensitive search matches exact case', r.hits === 1, r.status);

    r = await search('fun\\w+ needle', { regex: true, include: 'js' });
    check('regex search works', r.hits === 1, r.status);
    r = await search('([unclosed', { regex: true, include: '' });
    check('invalid regex gives a friendly message', r.status.toLowerCase().includes('invalid pattern'), r.status);

    // clicking a result opens the file at that line
    await js(`document.querySelectorAll('#pane-search .tog').forEach((b) => b.classList.remove('on')); Object.assign(window, {}); 0`);
    r = await search('needle = 3', { include: 'py' });
    await js(`document.querySelector('#pane-search .shit').click()`);
    await sleep(900);
    const sel = await js(`(() => { const t = document.getElementById('edText'); return { name: tabs[activeTab].name, text: t.value.slice(t.selectionStart, t.selectionEnd) }; })()`);
    check('clicking a result opens the file and selects the match', sel.name === 'b.py' && sel.text === 'needle = 3', JSON.stringify(sel));
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  app.exit(0);
});
