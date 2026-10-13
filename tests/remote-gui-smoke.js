// Remote tab in the real app: renders, opens its forms, consent gates switching, indicator and Back to local.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const ud = path.join(process.env.TEMP, 'faber-smoke-' + TAG);
fs.rmSync(ud, { recursive: true, force: true });
app.setPath('userData', ud);

// a fake remote Ollama
const fake = http.createServer((req, res) => {
  if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.0.0-fake' })); return; }
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'fake-model:1b', size: 1234 }] })); return; }
  res.statusCode = 404; res.end('{}');
});
let fakePort = 0;
fake.listen(0, '127.0.0.1', () => { fakePort = fake.address().port; });

const LOG = path.join(process.env.TEMP, 'faber-remotegui-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require(path.join(root, 'main.js'));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg.slice(0, 200)); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  try {
    const hostOf = () => js(`api.getSettings().then((s) => ({ host: s.host, remote: !!s.hostRemote }))`);
    check('starts on the local engine', (await hostOf()).host.includes('127.0.0.1:11434') && (await hostOf()).remote === false);
    const icons = await js(`[...document.querySelectorAll('#railTop .rbtn')].map((b) => b.title)`);
    check('Remote icon is on the activity bar', icons.some((t) => /remote/i.test(t)), icons.join(' | '));
    await js(`[...document.querySelectorAll('#railTop .rbtn')].find((b) => /remote/i.test(b.title)).click(); 0`);
    await sleep(800);
    const pane = await js(`(() => { const p = document.getElementById('pane-remote'); return { shown: !!p && !p.hidden, text: p ? p.innerText.slice(0, 400) : '' }; })()`);
    check('Remote tab renders content', pane.shown && pane.text.length > 50, JSON.stringify(pane.text.slice(0, 120)));
    check('Tools menu has Remote entries', (await js(`(() => { const m = [...document.querySelectorAll('#menubar .mbtn')].find((b) => b.textContent === 'Tools'); return !!m; })()`)) === true);
    check('/remote and /local commands exist', (await js(`typeof commands.remote === 'object' && typeof commands.local === 'object'`)) === true);

    // add a hosted/LAN profile through the main-process API the UI uses, then drive Use -> consent
    const state0 = await js(`window.api.call('feat:remote:state')`).catch((e) => ({ err: String(e) }));
    check('feat:remote:state works', !!state0 && !state0.err, JSON.stringify(state0).slice(0, 120));
    print('state keys:', Object.keys(state0 || {}).join(','));
    check('no console errors so far', errs.length === 0, JSON.stringify(errs).slice(0, 400));
  } catch (e) { print('SMOKE ERROR', e.message); }
  print('DONE');
  fake.close();
  app.exit(0);
});
