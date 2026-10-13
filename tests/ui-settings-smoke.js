// ui-settings test (real app). Phase 1 drives the settings UI; then it starts phase 2 in a fresh process with the
// SAME userData to prove the settings persist and are applied on start. Log: %TEMP%\faber-uisettings-<TAG>.log
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const PHASE = process.env.FABER_PHASE || '1';
const T = process.env.TEMP;
const ud = path.join(T, 'faber-uis-ud-' + TAG);
const proj = path.join(T, 'faber-uis-proj-' + TAG);
const exportFile = path.join(T, 'faber-uis-export-' + TAG + '.json');
const LOG = path.join(T, 'faber-uisettings-' + TAG + '.log');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = require('./fake-ollama')();

if (PHASE === '1') {
  fs.writeFileSync(LOG, '');
  for (const d of [ud, proj]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(ud, { recursive: true });
} else print('--- phase 2 (pid ' + process.pid + ')');
app.setPath('userData', ud);
setTimeout(() => { print('WATCHDOG: timed out'); app.exit(1); }, 120000);

const lines = (n, mark) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};${i + 1 === 80 ? ' // ' + mark : ''}`).join('\n') + '\n';

fake.listen().then(() => {
  const sf = path.join(ud, 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* fresh */ }
  s.host = 'http://127.0.0.1:' + fake.port;
  fs.writeFileSync(sf, JSON.stringify(s));
  require(path.join(root, 'main.js'));
  run();
});

function run() {
  app.whenReady().then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const js = (code) => win.webContents.executeJavaScript(code);
    const errs = [];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    let early = null;
    win.webContents.once('dom-ready', async () => {
      try { early = await js(`({ bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), appHidden: document.getElementById('app').hidden })`); } catch { /* ignore */ }
    });
    const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { if (await js(`!$('app').hidden && !!settings.model && $('setup').hidden`)) break; } catch { /* loading */ }
    }
    await sleep(800);
    const cs = (sel, prop) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).getPropertyValue(${JSON.stringify(prop)}).trim()`);
    const rootVar = (v) => js(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(v)}).trim()`);
    const key = (o) => js(`(() => { const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(o)})); (document.activeElement || document.body).dispatchEvent(e); return e.defaultPrevented; })()`);
    const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const setRange = (label, v) => js(`(() => { const r = document.querySelector('[data-k="rg:${label}"]'); r.value = ${v}; r.dispatchEvent(new Event('input', { bubbles: true })); return r.value; })()`);
    const section = async (id) => { await js(`Faber.openSettings(${JSON.stringify(id)})`); await sleep(150); };
    const closeWin = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); !document.querySelector('.uisWin')`);
    try {
      if (PHASE === '2') return await phase2({ js, check, cs, rootVar, early, errs });

      /* ---------- window, sections ---------- */
      check('openSettings was replaced by the real window', !(await js('String(Faber.openSettings)')).includes('not available'));
      await js(`Faber.addSettingsSection({ id: 'tsec', title: 'Test Section', render: (el) => { el.textContent = 'hello section'; } })`);
      await js(`Faber.addCommand('uitest', '', 'ui test command', () => { window.__uitest = (window.__uitest || 0) + 1; })`);
      await js(`Faber.openSettings()`);
      await sleep(200);
      check('settings window opens', await js(`!!document.querySelector('.uisWin .uisNav')`));
      const navs = await js(`[...document.querySelectorAll('.uisNav [role=tab]')].map((b) => b.textContent)`);
      check('lists built-in sections', ['Appearance', 'Editor', 'Terminal', 'Layout', 'Keyboard', 'Data'].every((n) => navs.includes(n)), navs.join(','));
      check('lists sections registered by features', navs.includes('Test Section') && navs.includes('Background refresh'), navs.join(','));
      await click('.uisNav [data-sec="tsec"]');
      check('registered section renders', (await js(`document.querySelector('.uisPane').textContent`)) === 'hello section');
      await click('.uisNav [data-sec="background"]');
      check('background section renders its controls', (await js(`document.querySelectorAll('.uisPane .bgRow').length`)) >= 3);
      await js(`document.querySelector('.uisNav [aria-selected=true]').focus(); document.querySelector('.uisNav').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
      check('arrow keys move between sections', (await js(`document.querySelector('.uisNav [aria-selected=true]').dataset.sec`)) === 'keyboard');
      check('Escape closes the window', await closeWin());
      await runJs(js, `runCommand('/settings keyboard')`);
      await sleep(200);
      check('/settings <section> opens that section', (await js(`document.querySelector('.uisNav [aria-selected=true]')?.dataset.sec`)) === 'keyboard');
      await closeWin();
      await key({ key: ',', code: 'Comma', ctrlKey: true });
      await sleep(200);
      check('Ctrl+, opens settings', await js(`!!document.querySelector('.uisWin')`));
      await closeWin();
      await js(`Faber.menus().get('File').find((i) => i.id === 'file.settings').action()`);
      await sleep(150);
      check('File > Settings menu item opens settings', await js(`!!document.querySelector('.uisWin')`));
      await closeWin();

      /* ---------- defaults unchanged ---------- */
      check('default theme equals the core look', (await rootVar('--bg')) === '#0e0e10' && (await rootVar('--accent')) === '#8b5cf6' && (await rootVar('--sel')) === '#2d2640');
      check('default sizes equal the core look', (await cs('#tree', 'font-size')) === '13px' && (await cs('#edBody', 'line-height')) === '20px' && (await cs('#side', 'width')) === '250px');

      /* ---------- appearance ---------- */
      await section('appearance');
      await click('[data-theme="midnight"]');
      await sleep(100);
      check('theme preset changes the CSS variables', (await rootVar('--bg')) === '#0b1020' && (await rootVar('--panel')) === '#101729');
      check('theme changes computed styles', (await cs('body', 'background-color')) === 'rgb(11, 16, 32)');
      check('theme default accent follows the theme', (await rootVar('--accent')) === '#3b82f6');
      await click('[data-accent="#f97316"]');
      await sleep(100);
      check('accent preset changes the accent', (await rootVar('--accent')) === '#f97316' && (await cs('button.primary', 'background-color')) === 'rgb(249, 115, 22)');
      await sleep(900);
      check('core accent setting mirrors it (/accent keeps working)', (await js('settings.accent')) === '#f97316');
      await js(`runCommand('/accent #22c55e')`);
      await sleep(600);
      check('/accent command still changes the accent', (await rootVar('--accent')) === '#22c55e');
      await click('[data-theme="daylight"]');
      check('light theme applies', (await rootVar('--bg')) === '#ffffff' && (await cs('body', 'color')) === 'rgb(29, 29, 34)');
      check('light theme sets color-scheme', (await js(`getComputedStyle(document.documentElement).colorScheme`)) === 'light');
      await click('[data-theme="violet"]');
      await click('[data-accent="#8b5cf6"]');
      await setRange('UI font size', 17);
      check('UI font size changes body and tree sizes', (await cs('body', 'font-size')) === '17px' && (await cs('#tree', 'font-size')) === '16px');
      await click('[data-k="Density:compact"]');
      check('compact density shrinks tree rows', (await js(`(() => { const r = document.querySelector('#tree .row'); return r ? getComputedStyle(r).height : getComputedStyle(document.documentElement).getPropertyValue('--row-h').trim(); })()`)) === '20px');
      await click('[data-k="Corner radius:none"]');
      check('corner radius none removes rounding', (await cs('#sendBtn', 'border-top-left-radius')) === '0px');
      await click('[data-k="Corner radius:small"]');
      check('radius small restores 4px', (await cs('#sendBtn', 'border-top-left-radius')) === '4px');
      await js(`document.querySelector('.uisHead button').click()`);
      await sleep(100);
      check('Reset section restores appearance defaults', (await cs('body', 'font-size')) === '14px' && (await rootVar('--bg')) === '#0e0e10');
      await closeWin();

      /* ---------- editor: font size, alignment, flash, tab, wrap ---------- */
      const a = path.join(proj, 'a.js');
      fs.writeFileSync(a, lines(120, 'v1'));
      await js(`api.openFolder(${JSON.stringify(proj)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
      await js(`openFile(${JSON.stringify(a)})`);
      await sleep(700);
      await section('editor');
      await setRange('Editor font size', 18);
      await sleep(100);
      const lh = async (id) => cs('#' + id, 'line-height');
      check('editor font size applies to the three layers', (await cs('#edText', 'font-size')) === '18px' && (await cs('#edHl', 'font-size')) === '18px' && (await cs('#edGutter', 'font-size')) === '18px');
      check('edHl/edText/edGutter share line-height 28px', (await lh('edHl')) === '28px' && (await lh('edText')) === '28px' && (await lh('edGutter')) === '28px');
      check('editor reads the new LINE_H', (await js('readEdMetrics(); LINE_H')) === 28);
      await closeWin();
      fs.writeFileSync(a, lines(120, 'v2'));
      await sleep(1200);
      const align = (target) => js(`(() => {
        const hl = document.getElementById('edHl'); let line = 0, found = null;
        const w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
        for (let n; !found && (n = w.nextNode());) { const s = n.nodeValue; for (let i = 0; i < s.length; i++) { if (line === ${target}) { found = [n, i]; break; } if (s[i] === '\\n') line++; } }
        if (!found) return { err: 'line not found' };
        const r = document.createRange(); r.setStart(found[0], found[1]); r.setEnd(found[0], found[1] + 1);
        const tr = r.getBoundingClientRect(), fl = document.getElementById('edFlash').getBoundingClientRect();
        return { on: document.getElementById('edFlash').classList.contains('on'), textMid: tr.top + tr.height / 2, flashMid: fl.top + fl.height / 2, flashH: fl.height };
      })()`);
      let al = await align(79);
      check('changed-line flash lands on the changed line (font 18)', al.on && Math.abs(al.textMid - al.flashMid) <= 2, JSON.stringify(al));
      const gutLines = await js(`document.getElementById('edGutter').textContent.split('\\n').length`);
      check('gutter has one number per line', gutLines === 121 || gutLines === 120, 'n=' + gutLines);
      await section('editor');
      await setRange('Line height', 2);
      check('line height change keeps layers equal (36px)', (await lh('edHl')) === '36px' && (await lh('edText')) === '36px' && (await lh('edGutter')) === '36px');
      await click('[data-k="Tab size:4"]');
      check('tab size applies (css + Tab key width)', (await cs('#edText', 'tab-size')) === '4' && (await js('edCfg.tab')) === 4);
      await click('[data-k="sw:Line numbers"]');
      check('line numbers can be hidden', (await cs('#edGutter', 'display')) === 'none');
      await click('[data-k="sw:Line numbers"]');
      // word wrap with a very long line: gutter must have one entry per visual line
      const longLine = 'word '.repeat(150);
      fs.writeFileSync(a, lines(10, 'x').replace('const line5 = 5;', 'const line5 = "' + longLine + '";') + lines(120, 'w').split('\n').slice(0, 118).join('\n') + '\n');
      await sleep(1200);
      await click('[data-k="sw:Word wrap"]');
      await sleep(300);
      check('word wrap turns the wrap classes on', await js(`document.documentElement.classList.contains('uis-wrap') && document.getElementById('edText').getAttribute('wrap') === 'soft'`));
      const wrapInfo = await js(`(() => { const ta = document.getElementById('edText'), hl = document.getElementById('edHl'); readEdMetrics();
        return { vis: Math.round((ta.scrollHeight - 16) / LINE_H), gut: document.getElementById('edGutter').textContent.split('\\n').length, taW: ta.clientWidth, hlSH: hl.scrollHeight, taSH: ta.scrollHeight, starts: edLayout.starts && edLayout.starts.length }; })()`);
      check('wrapped gutter matches the visual line count', wrapInfo.vis === wrapInfo.gut && wrapInfo.vis > 130, JSON.stringify(wrapInfo));
      check('highlight layer wraps like the textarea', Math.abs(wrapInfo.hlSH - wrapInfo.taSH) <= 40, JSON.stringify(wrapInfo));
      fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace('const line20 = 20;', 'const line20 = 20; // CHANGED'));
      await sleep(1200);
      al = await align(await js(`(() => { let i = $('edText').value.split('\\n').findIndex((l) => l.includes('CHANGED')); return i; })()`).then((i) => i + 0));
      // align() walks logical lines, so it validates the flash against the real wrapped position
      check('flash lands on the right visual line with word wrap on', al.on && Math.abs(al.textMid - al.flashMid) <= 2, JSON.stringify(al));
      await click('[data-k="sw:Word wrap"]');
      await sleep(200);
      check('word wrap off restores plain layout', (await js('edLayout.starts === null')) === true && !(await js(`document.documentElement.classList.contains('uis-wrap')`)));
      await closeWin();

      /* ---------- terminal ---------- */
      await section('terminal');
      await setRange('Terminal font size', 16);
      await click('[data-k="Cursor style:bar"]');
      await setRange('Scrollback', 2000);
      check('terminal options stored for new terminals', (await js('JSON.stringify([termConfig.fontSize, termConfig.cursorStyle, termConfig.scrollback])')) === '[16,"bar",2000]');
      await js(`newTerminal()`);
      await sleep(1500);
      const tinfo = await js(`(() => { const t = Object.values(terms)[0]; return t ? [t.term.options.fontSize, t.term.options.cursorStyle, t.term.options.scrollback] : null; })()`);
      check('new terminal uses the options', JSON.stringify(tinfo) === '[16,"bar",2000]', JSON.stringify(tinfo));
      await setRange('Terminal font size', 11);
      await sleep(100);
      check('open terminal updates live', (await js(`Object.values(terms)[0] ? Object.values(terms)[0].term.options.fontSize : -1`)) === 11);
      await click('.uisPane .uisHead button');
      check('terminal reset', (await js('termConfig.fontSize')) === 13);
      await closeWin();
      await js(`showTerm(false)`);

      /* ---------- layout ---------- */
      await section('layout');
      await click('[data-k="Sidebar position:right"]');
      check('sidebar can move right', (await js(`document.documentElement.dataset.side`)) === 'right' && (await cs('#side', 'order')) === '9');
      await click('[data-k="Sidebar position:left"]');
      await setRange('Sidebar width', 320);
      check('sidebar width applies', (await js(`document.getElementById('side').getBoundingClientRect().width`)) === 320);
      await js(`(() => { const h = document.getElementById('sideResize'); const r = document.getElementById('side').getBoundingClientRect();
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.right })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 410 })); window.dispatchEvent(new MouseEvent('mouseup')); })()`);
      await sleep(100);
      check('drag handle resizes the sidebar', Math.abs((await js(`document.getElementById('side').getBoundingClientRect().width`)) - 410) <= 1);
      check('dragged width is stored', (await js('Faber.ui.get().layout.sideW')) === 410);
      await section('layout');
      await setRange('Chat width', 700);
      const pad = await js(`(() => { const c = document.getElementById('chat'); return [parseFloat(getComputedStyle(c).paddingLeft), Math.max(16, (c.clientWidth - 700) / 2)]; })()`);
      check('chat width variable is set', (await rootVar('--chat-w')) === '700px');
      check('chat max width applies', Math.abs(pad[0] - pad[1]) <= 1, JSON.stringify(pad));
      await setRange('Terminal height', 360);
      await js(`showTerm(true)`);
      await sleep(300);
      check('default terminal height applies', (await js(`document.getElementById('term').getBoundingClientRect().height`)) >= 358);
      await js(`showTerm(false)`);
      await click('[data-k="sw:Show Reasoning effort"]');
      check('status bar chip can be hidden', (await cs('#chipEffort', 'display')) === 'none');
      await click('[data-k="sw:Show Reasoning effort"]');
      check('status bar chip comes back', (await cs('#chipEffort', 'display')) !== 'none');
      const railCount = await js(`document.querySelectorAll('#railTop .rbtn').length`);
      await click('[data-k="sw:Show Git icon"]');
      check('activity bar icon can be hidden', railCount > 0 && (await js(`[...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Git') ? getComputedStyle([...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Git')).display : 'missing'`)) === 'none');
      await click('[data-k="sw:Show Git icon"]');
      await click('[data-k="Activity bar position:right"]');
      check('activity bar can move right', (await js(`document.documentElement.dataset.rail`)) === 'right' && (await cs('#rail', 'order')) === '10');
      await click('[data-k="Activity bar position:left"]');
      await click('.uisPane .uisHead button');
      check('layout reset', (await js(`document.getElementById('side').getBoundingClientRect().width`)) === 250);
      await closeWin();

      /* ---------- keyboard ---------- */
      const rebind = async (action, o) => {
        await section('keyboard');
        await click(`[data-k="key:${action}"]`);
        await key(o);
        await sleep(120);
        return js(`document.querySelector('.uisMsg').textContent`);
      };
      let m = await rebind('focusChat', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
      check('rebinding a shortcut works', (await js('Faber.ui.get().keys.focusChat')) === 'Ctrl+Alt+K', m);
      await closeWin();
      await js(`document.getElementById('input').blur(); document.body.focus()`);
      await key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
      check('new focus-chat shortcut fires', (await js(`document.activeElement.id`)) === 'input');
      await js(`document.getElementById('input').blur()`);
      await key({ key: '1', code: 'Digit1', ctrlKey: true });
      check('old binding no longer fires', (await js(`document.activeElement.id`)) !== 'input');
      check('menu bar shows the new shortcut', (await js(`Faber.menus().get('Go').find((i) => i.id === 'go.chat').shortcut`)) === 'Ctrl+Alt+K');
      m = await rebind('toggleEditor', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
      check('conflict with another action is detected', /already used by/.test(m) && (await js('Faber.ui.get().keys.toggleEditor')) === 'Ctrl+Alt+E', m);
      await closeWin();
      m = await rebind('toggleEditor', { key: 'r', code: 'KeyR', ctrlKey: true });
      check('reserved keys (Ctrl+R) are refused', /reserved/.test(m), m);
      await closeWin();
      m = await rebind('openSettings', { key: 'a', code: 'KeyA' });
      check('shortcut without Ctrl/Alt is refused', /Ctrl or Alt/.test(m), m);
      await closeWin();
      m = await rebind('openSettings', { key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
      await closeWin();
      await key({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
      await sleep(200);
      check('rebound open-settings shortcut opens settings', await js(`!!document.querySelector('.uisWin')`));
      await section('keyboard');
      await click('[data-k="keyreset:openSettings"]');
      check('per-shortcut reset restores the default', (await js('Faber.ui.get().keys.openSettings')) === 'Ctrl+,');
      await click('[data-k="keyreset:focusChat"]');
      await closeWin();
      // terminal toggle: default Ctrl+` (core) and a rebound key
      const termHidden = () => js(`document.getElementById('term').hidden`);
      const t0 = await termHidden();
      await key({ key: '`', code: 'Backquote', ctrlKey: true });
      await sleep(300);
      check('default Ctrl+` toggles the terminal exactly once', (await termHidden()) !== t0);
      await js(`showTerm(false)`);
      await rebind('toggleTerminal', { key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
      await closeWin();
      await js(`showTerm(false)`);
      await key({ key: '`', code: 'Backquote', ctrlKey: true });
      await sleep(200);
      check('old Ctrl+` is released after rebinding', (await termHidden()) === true);
      await key({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
      await sleep(300);
      check('rebound terminal shortcut toggles it', (await termHidden()) === false);
      await js(`showTerm(false)`);
      await section('keyboard');
      await click('.uisPane .uisHead button');
      check('Reset section restores every shortcut', JSON.stringify(await js('Faber.ui.get().keys')) === JSON.stringify(await js('Faber.ui.defaults().keys')));
      await closeWin();

      /* ---------- command palette ---------- */
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] });
      await sleep(400);
      let viaReal = await js(`!!document.getElementById('uisPalette')`);
      if (!viaReal) { await key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }); await sleep(300); }
      check('Ctrl+Shift+P opens the palette' + (viaReal ? ' (real key event)' : ' (synthetic event; real one failed)'), await js(`!!document.getElementById('uisPalette')`));
      const typeQ = (q) => js(`(() => { const i = document.querySelector('#uisPalette input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return [...document.querySelectorAll('#uisPalette .it b')].map((b) => b.textContent); })()`);
      let res = await typeQ('uitest');
      check('palette lists slash commands', res.includes('/uitest'), res.join(','));
      await key({ key: 'Enter' });
      await sleep(300);
      check('Enter runs the selected command', (await js('window.__uitest')) === 1 && !(await js(`!!document.getElementById('uisPalette')`)));
      await js(`Faber.ui.openPalette()`);
      res = await typeQ('theme');
      check('palette lists registered actions', res.includes('Theme: Midnight') && res.includes('/theme'), res.join(','));
      res = await typeQ('toggle terminal');
      check('palette search filters', res.length >= 1 && res.length < 12 && res.includes('Toggle terminal'), res.join(','));
      await key({ key: 'Enter' });
      await sleep(300);
      check('palette runs an action', (await termHidden()) === false);
      await js(`showTerm(false)`);
      await js(`Faber.ui.openPalette()`);
      await typeQ('theme midnight');
      await key({ key: 'Enter' });
      await sleep(200);
      check('palette action changes the theme', (await rootVar('--bg')) === '#0b1020');
      await js(`Faber.ui.openPalette()`);
      await typeQ('run');
      res = await js(`[...document.querySelectorAll('#uisPalette .it b')].map((b) => b.textContent)`);
      await key({ key: 'ArrowDown' });
      await key({ key: 'Escape' });
      check('Escape closes the palette', !(await js(`!!document.getElementById('uisPalette')`)));
      await js(`runCommand('/theme violet')`);
      await sleep(100);
      check('/theme command switches theme', (await rootVar('--bg')) === '#0e0e10');
      check('View > Appearance submenu exists', await js(`!!Faber.menus().get('View').find((i) => i.id === 'view.appearance') && Faber.menus().get('View').find((i) => i.id === 'view.appearance').submenu().length === 5`));
      check('View > Command Palette is enabled', await js(`typeof Faber.openPalette === 'function'`));

      /* ---------- export / import / reset ---------- */
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportFile });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportFile] });
      await section('appearance');
      await click('[data-theme="ember"]');
      await click('[data-accent="#ec4899"]');
      await section('data');
      await click('[data-k="data:export"]');
      await sleep(500);
      let ex = {};
      try { ex = JSON.parse(fs.readFileSync(exportFile, 'utf8')); } catch { /* missing */ }
      check('export writes a settings file', ex.app === 'Faber' && ex.ui && ex.ui.theme === 'ember' && ex.ui.accent === '#ec4899', JSON.stringify(ex).slice(0, 120));
      check('export has no secrets or remote settings', !/token|secret|passw/i.test(JSON.stringify(ex.features || {})) && !(ex.features || {}).remote);
      await section('appearance');
      await click('[data-theme="violet"]');
      await click('[data-accent="#8b5cf6"]');
      check('changed away before import', (await rootVar('--bg')) === '#0e0e10');
      await section('data');
      await click('[data-k="data:import"]');
      await sleep(600);
      check('import restores the exported settings', (await rootVar('--bg')) === '#130f0d' && (await rootVar('--accent')) === '#ec4899');
      fs.writeFileSync(exportFile, '{ not json');
      await click('[data-k="data:import"]');
      await sleep(400);
      check('invalid import is reported, nothing changes', /not valid JSON/.test(await js(`document.querySelector('.uisMsg').textContent`)) && (await rootVar('--bg')) === '#130f0d');
      await click('[data-k="data:reset"]');
      check('reset needs a second click', (await rootVar('--bg')) === '#130f0d');
      await click('[data-k="data:reset"]');
      await sleep(300);
      check('reset everything restores defaults', (await rootVar('--bg')) === '#0e0e10' && (await rootVar('--accent')) === '#8b5cf6' && (await cs('#tree', 'font-size')) === '13px');
      await closeWin();

      /* ---------- leave a distinctive state, then restart ---------- */
      await section('appearance');
      await click('[data-theme="ember"]');
      await click('[data-accent="#ec4899"]');
      await setRange('UI font size', 16);
      await click('[data-k="Density:compact"]');
      await section('editor');
      await setRange('Editor font size', 16);
      await click('[data-k="Tab size:4"]');
      await click('[data-k="sw:Word wrap"]');
      await section('layout');
      await click('[data-k="Sidebar position:right"]');
      await setRange('Sidebar width', 300);
      await section('keyboard');
      await click('[data-k="key:focusChat"]');
      await key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
      await closeWin();
      await js('Faber.ui.flush()');
      await sleep(800);
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')); } catch { /* missing */ }
      const u = (saved.features || {})['ui-settings'] || {};
      check('settings are written to settings.json', u.theme === 'ember' && u.uiFont === 16 && u.layout && u.layout.side === 'right' && u.ed && u.ed.wrap === true && u.keys.focusChat === 'Ctrl+Alt+K', JSON.stringify(u).slice(0, 160));
      check('core accent persisted too', saved.accent === '#ec4899');
      check('window background colour saved for next start', u.bg === '#130f0d');
      check('no console errors in phase 1', errs.length === 0, JSON.stringify(errs).slice(0, 300));
      print('PHASE1 COMPLETE');
      // close the window normally so localStorage is flushed, then start phase 2 once this process is gone
      let started = false;
      const next = () => { if (started) return; started = true; spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore', env: { ...process.env, FABER_PHASE: '2' } }).unref(); };
      app.once('quit', next);
      win.close();
      await sleep(10000);
      next();
      app.exit(0);
    } catch (e) { print('SMOKE ERROR', e.stack || e.message); print('DONE'); app.exit(0); }
  });
}

function runJs(js, code) { return js(code); }

async function phase2({ js, check, cs, rootVar, early, errs }) {
  check('theme applied from the cache at script load, before settings were fetched', (await js('Faber.ui.early')) === 'ember', JSON.stringify(early));
  check('theme restored after restart', (await rootVar('--bg')) === '#130f0d' && (await rootVar('--accent')) === '#ec4899');
  check('UI font size restored', (await cs('body', 'font-size')) === '16px');
  check('density restored', (await js(`document.documentElement.dataset.density`)) === 'compact');
  check('editor settings restored', (await cs('#edBody', 'font-size')) === '16px' && (await js('edCfg.tab')) === 4 && (await js(`document.documentElement.classList.contains('uis-wrap')`)));
  check('layout restored', (await js(`document.documentElement.dataset.side`)) === 'right' && (await js(`document.getElementById('side').getBoundingClientRect().width`)) === 300);
  check('settings come from the real settings file', (await js(`Faber.featureSettings('ui-settings').theme`)) === 'ember' && (await js('Faber.settings().accent')) === '#ec4899');
  check('rebound shortcut restored', (await js('Faber.ui.get().keys.focusChat')) === 'Ctrl+Alt+K');
  check('terminal option restored', (await js('termConfig.fontSize')) === 13);
  await js(`Faber.openSettings('appearance')`);
  await sleep(200);
  check('settings window shows the restored theme', (await js(`document.querySelector('[data-theme="ember"]').getAttribute('aria-checked')`)) === 'true');
  check('no console errors in phase 2', errs.length === 0, JSON.stringify(errs).slice(0, 300));
  for (const d of [ud, proj, exportFile]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* cache files still locked; harmless */ } }
  print('DONE');
  app.exit(0);
}
