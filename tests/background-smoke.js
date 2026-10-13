// background feature test (real app, fake Ollama). Log: %TEMP%\faber-background-<TAG>.log
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const T = process.env.TEMP;
const ud = path.join(T, 'faber-bg-ud-' + TAG);
const base = path.join(T, 'faber-bg-' + TAG);
const proj = path.join(base, 'proj');
const outside = path.join(base, 'outside');
const LOG = path.join(T, 'faber-background-' + TAG + '.log');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = require('./fake-ollama')();

fs.writeFileSync(LOG, '');
for (const d of [ud, base]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(proj, 'dist'), { recursive: true });     // "dist" is ignored by the folder watcher on purpose
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(ud, { recursive: true });
app.setPath('userData', ud);
// the test window is often covered by other windows; do not let Chromium report it as hidden
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
setTimeout(() => { print('WATCHDOG: timed out'); app.exit(1); }, 150000);

fake.listen().then(() => {
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ host: 'http://127.0.0.1:' + fake.port, features: { background: { enabled: true, interval: 2, whenUnfocused: true } } }));
  require(path.join(root, 'main.js'));
  run();
});

function run() {
  app.whenReady().then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const js = (code) => win.webContents.executeJavaScript(code);
    const errs = [];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { if (await js(`!$('app').hidden && !!settings.model && $('setup').hidden`)) break; } catch { /* loading */ }
    }
    await sleep(500);
    const hasRow = (n) => js(`[...document.querySelectorAll('#tree .nm')].some((x) => x.textContent === ${JSON.stringify(n)})`);
    const st = () => js('Faber.background.state()');
    const label = () => js(`document.querySelector('#bgStatus .lbl').textContent`);
    const key = (o) => js(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true }, ${JSON.stringify(o)})))`);
    try {
      win.focus();
      await js(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))`);       // the test window may be covered or in the background
      await js(`window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); }).observe(document.body, { childList: true, subtree: true })`);

      /* ---------- setup + indicator ---------- */
      check('status chip is in the bottom bar', await js(`!!document.querySelector('#bar #bgStatus')`));
      await sleep(4500);
      check('indicator shows Ollama connected', (await label()) === 'Ollama connected', await label());
      check('hover title lists the last refresh time', /Last refresh: \d/.test(await js(`document.getElementById('bgStatus').title`)));
      check('settings read (interval 2 s, enabled)', (await st()).cfg.interval === 2 && (await st()).cfg.enabled === true);
      check('Faber.call ping answers in one round trip', await js(`Faber.call('feat:background:ping', { paths: [], dirs: [] }).then((r) => r.up === true && r.models.includes('qwen3.5:9b'))`));
      check('ping tolerates bad input', await js(`Faber.call('feat:background:ping', { paths: 5, dirs: [1, null] }).then((r) => r.up === true, () => false)`));

      /* ---------- files outside the folder + ignored folders, no Reload click ---------- */
      const ext = path.join(outside, 'ext.txt');
      fs.writeFileSync(ext, 'version one\n');
      fs.writeFileSync(path.join(proj, 'dist', 'old.txt'), 'x');
      await js(`api.openFolder(${JSON.stringify(proj)}).then(async (s) => { settings = s; render(); await refreshTree(); })`);
      await js(`document.querySelector('#tree .row').click()`);        // expand dist
      await sleep(800);
      await js(`openFile(${JSON.stringify(ext)})`);
      await sleep(500);
      check('baseline: file open, dist expanded', (await js("$('edText').value")).startsWith('version one') && (await hasRow('old.txt')));
      await js(`window.__row = [...document.querySelectorAll('#tree .row')].find((r) => r.textContent.includes('old.txt'))`);
      await sleep(3000);        // a few quiet rounds with nothing to do
      check('nothing changed: the tree is not rebuilt (same DOM node)', await js(`window.__row.isConnected`));
      fs.writeFileSync(ext, 'version two\n');
      fs.writeFileSync(path.join(proj, 'dist', 'new.txt'), 'y');
      await sleep(4200);
      check('file outside the folder refreshed without clicking Reload', (await js("$('edText').value")).startsWith('version two'));
      check('new file in an ignored folder appears in the tree', await hasRow('new.txt'));
      check('expanded folder stays expanded after refresh', await js(`document.querySelector('#tree .row.open') !== null`));

      /* ---------- unsaved edits are never clobbered ---------- */
      await js(`$('edText').value = 'MY UNSAVED WORK\\n'; $('edText').dispatchEvent(new Event('input'))`);
      fs.writeFileSync(ext, 'version three\n');
      await sleep(4200);
      check('dirty tab keeps the user text', (await js("$('edText').value")).startsWith('MY UNSAVED WORK'));
      check('conflict bar is offered instead', (await js("!$('edConflict').hidden")) === true);
      const edits = await js(`tabs[0].conflict`);
      check('disk version kept aside for the choice', typeof edits === 'string' && edits.startsWith('version three'));
      await js(`$('edReload').click()`);
      await sleep(300);

      /* ---------- skipping work ---------- */
      const p0 = (await st()).pings;
      await sleep(4500);
      const p1 = (await st()).pings;
      check('rounds keep running at the interval (2 s)', p1 - p0 >= 1 && p1 - p0 <= 3, 'rounds=' + (p1 - p0) + ' ' + JSON.stringify(await st()));

      /* ---------- hidden / unfocused windows pause the refresher ---------- */
      await js(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
      await sleep(300);
      const h0 = (await st()).pings;
      fs.writeFileSync(ext, 'version four\n');
      await sleep(5500);
      const h1 = await st();
      check('no rounds while the window is hidden', h1.pings === h0 && h1.active === false, h0 + ' -> ' + h1.pings);
      check('file not refreshed while hidden', (await js("$('edText').value")).startsWith('version three'));
      await js(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`);
      await sleep(1200);
      check('immediate refresh when the window is visible again', (await js("$('edText').value")).startsWith('version four') && (await st()).pings > h0);
      await js(`Faber.background.configure({ whenUnfocused: false }); window.dispatchEvent(new Event('blur'))`);
      await sleep(300);
      const b0 = (await st()).pings;
      fs.writeFileSync(ext, 'version five\n');
      await sleep(4500);
      check('no rounds while the window is unfocused', (await st()).pings === b0 && (await js("$('edText').value")).startsWith('version four'));
      await js(`window.dispatchEvent(new Event('focus'))`);
      await sleep(1200);
      await js(`Faber.background.configure({ whenUnfocused: true })`);
      check('refresh runs as soon as focus returns', (await js("$('edText').value")).startsWith('version five'));

      /* ---------- Ollama down / back, model list ---------- */
      const port = fake.port;
      await fake.stop();
      await sleep(4500);
      check('indicator shows Ollama not running', (await label()) === 'Ollama not running' && (await js(`document.getElementById('bgStatus').classList.contains('down')`)), await label());
      check('going down is quiet (no toast)', !(await js('window.__toasts')).some((t) => /Ollama/.test(t)), JSON.stringify(await js('window.__toasts')));
      await fake.listen(port);
      await sleep(4500);
      check('indicator shows connected again', (await label()) === 'Ollama connected');
      const toasts = (await js('window.__toasts')).filter((t) => /Ollama is back/.test(t));
      check('"back" toast shown exactly once', toasts.length === 1, JSON.stringify(toasts));
      fake.models = ['qwen3.5:9b', 'brand-new:1b'];
      await sleep(4500);
      check('model list refreshed (loadModels)', await js(`modelNames.includes('brand-new:1b')`));

      /* ---------- settings section + actions ---------- */
      await js(`Faber.openSettings('background')`);
      await sleep(200);
      await js(`(() => { const n = document.querySelector('.bgRow input[type=number]'); n.value = 3; n.dispatchEvent(new Event('change')); })()`);
      await sleep(900);
      check('interval change is applied and saved', (await st()).cfg.interval === 3 && (await js(`Faber.featureSettings('background').interval`)) === 3);
      await js(`(() => { const n = document.querySelector('.bgRow input[type=number]'); n.value = 500; n.dispatchEvent(new Event('change')); })()`);
      check('interval is clamped to 2-60 s', (await st()).cfg.interval === 60);
      await js(`(() => { const n = document.querySelector('.bgRow input[type=number]'); n.value = 1; n.dispatchEvent(new Event('change')); })()`);
      check('interval lower bound is 2 s', (await st()).cfg.interval === 2);
      check('palette has a Refresh now action', await js(`Faber.actions().some((a) => a.id === 'background-refresh')`));
      const r0 = (await st()).pings;
      await js(`document.querySelector('.uisPane .bgRow:last-of-type button').click()`);
      await sleep(600);
      check('Refresh now button runs a round', (await st()).pings > r0);
      await js(`document.querySelector('.bgSw').click()`);
      await sleep(300);
      const o0 = (await st()).pings;
      check('switching it off updates the indicator', (await label()) === 'Auto-refresh off' && (await st()).cfg.enabled === false);
      await sleep(4200);
      check('no rounds while switched off', (await st()).pings === o0);
      await js(`document.querySelector('.bgSw').click()`);
      await sleep(2800);
      check('switching it on resumes', (await st()).pings > o0 && (await label()) === 'Ollama connected');
      check('no console errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
    } catch (e) { print('SMOKE ERROR', e.stack || e.message); }
    await fake.stop();
    for (const d of [base]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked; harmless */ } }
    print('DONE');
    app.exit(0);
  });
}
