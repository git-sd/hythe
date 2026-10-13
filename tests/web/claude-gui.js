// Claude (online) in the real UI: key entry, consent, picker, indicator, chat, turn off, key never leaks.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep, waitFor } = require('./harness');
const KEY = 'sk-ant-api03-SECRETSECRETSECRET1234';
(async () => {
  const check = checker();
  let hits = 0;
  const api = http.createServer((req, res) => {
    let d = ''; req.on('data', (x) => { d += x; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
      hits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (e, o) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...o })}\n\n`);
      w('message_start', { message: { usage: { input_tokens: 10 } } });
      w('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      w('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello from the fake Claude.' } });
      w('content_block_stop', { index: 0 });
      w('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      w('message_stop', {}); res.end();
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  process.env.FABER_CLAUDE_BASE_URL = `http://127.0.0.1:${api.address().port}`;
  const fake = await startFake();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-proj-'));
  const h = await launch({ ollama: fake.url, workspace: proj });
  try {
    await h.open(); await sleep(600);
    const sid = await h.js(() => activeSid);
    check('no Claude indicator at start', await h.js(() => !document.querySelector('.clInd') || document.querySelector('.clInd').hidden));
    check('picker has no online models while off', await h.js(() => Faber.claudeModels().length === 0));

    await h.js(() => Faber.openSettings('claude')); await sleep(400);
    check('settings section shows the warning', await h.js(() => /Online feature/.test(document.querySelector('.clBox')?.textContent || '')));
    check('"Turn on" disabled without a key', await h.js(() => [...document.querySelectorAll('.clBox button')].find((b) => /Turn on/.test(b.textContent)).disabled));
    // bad key
    await h.js(() => { const i = document.querySelector('.clBox input'); i.value = 'not-a-key'; [...document.querySelectorAll('.clBox button')].find((b) => b.textContent === 'Save key').click(); });
    await sleep(300);
    check('bad key rejected with a message', await h.js(() => /does not look like/.test(document.querySelector('.clBox').textContent)));
    // good key
    await h.js((k) => { const i = document.querySelector('.clBox input'); i.value = k; [...document.querySelectorAll('.clBox button')].find((b) => b.textContent === 'Save key').click(); }, KEY);
    await sleep(500);
    check('key saved; only the last 4 characters are shown', await h.js(() => /ending in 1234/.test(document.querySelector('.clBox').textContent)));
    const pub = JSON.stringify(await h.invoke('settings:get')) + JSON.stringify(await h.invoke('feat:claude:state'));
    check('renderer-visible state never contains the key', !pub.includes('SECRETSECRET'));
    check('settings.json on disk has no plaintext key', !fs.readFileSync(path.join(h.userData, 'settings.json'), 'utf8').includes('SECRETSECRET'));
    // turn on with consent
    await h.js(() => [...document.querySelectorAll('.clBox button')].find((b) => /Turn on/.test(b.textContent)).click());
    await sleep(300);
    check('consent dialog explains what leaves the PC', await h.js(() => /leaves this PC/.test(document.body.textContent) && /Your prompts/.test(document.body.textContent)));
    check('still off before consent', (await h.invoke('feat:claude:state')).enabled === false);
    await h.js(() => [...document.querySelectorAll('.modalFoot button')].find((b) => b.textContent === 'Turn on').click());
    await sleep(500);
    check('enabled after consent', (await h.invoke('feat:claude:state')).enabled === true);
    check('persistent ONLINE indicator is visible', await h.js(() => { const i = document.querySelector('.clInd'); return i && !i.hidden && /Claude is on/.test(i.textContent); }));
    check('claude models now offered', await h.js(() => Faber.claudeModels().length === 3));

    // pick a Claude model from the real picker
    await h.js(() => { document.querySelectorAll('.modalBack').forEach((m) => m.remove()); Faber.pickModel('x', () => {}); }); await sleep(600);
    const rows = await h.js(() => [...document.querySelectorAll('.mpRow')].map((r) => r.textContent));
    check('picker lists Claude models marked online', rows.some((t) => /Claude Sonnet 5\.5/.test(t) && /online/.test(t)), rows);
    await h.js(() => document.querySelector('.mpRow[data-name="claude:claude-sonnet-5-5"]').click()); await sleep(300);
    await h.js((id) => Faber.chat.update(id, { model: 'claude:claude-sonnet-5-5' }), sid); await sleep(300);
    check('indicator turns into ONLINE: model', await h.js(() => /ONLINE: Claude Sonnet 5\.5/.test(document.querySelector('.clInd').textContent)));
    await h.js(() => { $('input').value = 'say hi'; return submit(); });
    await waitFor(h.page, (id) => Faber.chat.sessions().find((s) => s.id === id).status === 'idle', sid, 15000);
    check('reply streamed from the (fake) Claude API', await h.js((id) => views.get(id).el.textContent.includes('Hello from the fake Claude.'), sid));
    check('exactly one API call', hits === 1, hits);
    await h.page.screenshot({ path: '/tmp/claude-0/claude-on.png' });

    // a saved Claude model must not trigger the "model not installed, download?" card at startup
    await h.page.reload(); await h.page.waitForFunction(() => window.Faber && !document.querySelector('#app').hidden); await sleep(1500);
    check('after a restart, a Claude agent does not offer an Ollama download', await h.js(() => !document.querySelector('.pullBody') && Faber.chat.activeInfo().model === 'claude:claude-sonnet-5-5'));
    check('and the chip shows the friendly name', await h.js(() => /Claude Sonnet 5\.5/.test(document.getElementById('chipModel').textContent)));

    // turn off from the indicator
    await h.js(() => [...document.querySelectorAll('.clInd button')].find((b) => b.textContent === 'Turn off').click()); await sleep(500);
    check('indicator gone after turning off', await h.js(() => document.querySelector('.clInd').hidden));
    await h.js(() => { $('input').value = 'again'; return submit(); }); await sleep(900);
    check('send while off is refused, no network call', hits === 1 && await h.js((id) => /turned off/.test(views.get(id).el.textContent), sid), hits);
    // remove key
    await h.invoke('feat:claude:clearKey');
    check('key removed', (await h.invoke('feat:claude:state')).hasKey === false);
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close(); api.close();
  process.exit(check.done() ? 1 : 0);
})();
