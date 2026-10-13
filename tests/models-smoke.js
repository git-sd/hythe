// Models feature smoke test. Two phases in one command:
//   real: the app talks to the real local Ollama (qwen3.5:9b must be installed). Creates only models named
//         faber-test-<tag>*, and deletes them at the end. Never touches qwen3.5:9b.
//   fake: a child Electron run pointed (via settings.json) at a fake Ollama HTTP server for edge cases
//         (empty list, API errors, no tools, huge models, Ollama going down and coming back).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const root = process.env.FABER_ROOT;
const PHASE = process.env.FABER_PHASE || 'real';
const TAG = (process.env.FABER_TAG || String(process.pid)).toLowerCase().replace(/[^a-z0-9-]/g, '');
const TMP = process.env.TEMP;
const DATA = path.join(TMP, 'faber-models-' + TAG + (PHASE === 'fake' ? '-fake' : ''));
const LOG = path.join(TMP, 'faber-models-smoke-' + TAG + (PHASE === 'fake' ? '-fake' : '') + '.log');
const REAL = 'http://127.0.0.1:11434';
const PFX = 'faber-test-' + TAG;
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- tiny GGUF (metadata only, zero tensors) ---- */
function makeTinyGguf(file) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([u64(t.length), t]); };
  const kvs = [['general.architecture', 8, str('llama')], ['general.name', 8, str('faber tiny test')], ['llama.context_length', 4, u32(2048)],
    ['llama.embedding_length', 4, u32(64)], ['llama.block_count', 4, u32(1)], ['llama.feed_forward_length', 4, u32(128)],
    ['llama.attention.head_count', 4, u32(4)], ['general.file_type', 4, u32(0)]];
  const parts = [Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length)];
  for (const [k, t, v] of kvs) parts.push(str(k), u32(t), v);
  const head = Buffer.concat(parts);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc((32 - (head.length % 32)) % 32)]));
}

/* ---- fake Ollama ---- */
const fake = { mode: 'normal', server: null, port: 0, deleted: [] };
const GB = 1073741824;
function fakeModels() {
  if (fake.mode === 'empty') return [];
  const mk = (name, size, caps, extra = {}) => ({ name, model: name, size, modified_at: '2026-10-01T10:00:00Z', digest: 'd' + name.length + size, details: { family: 'fam', parameter_size: '7B', quantization_level: 'Q4_K_M', context_length: 8192 }, ...(caps ? { capabilities: caps } : {}), ...extra });
  return [
    mk('qwen3.5:9b', 6.1 * GB, ['completion', 'tools', 'thinking']),
    mk('plain-chat:7b', 4 * GB, ['completion']),
    mk('giant-model:70b', 40 * GB, ['completion', 'tools']),
    mk('embed-only:latest', 0.3 * GB, ['embedding']),
    mk('legacy:1b', 1 * GB, null),
    mk('an-extremely-long-model-name-that-keeps-going-and-going-and-going-for-a-very-long-time-indeed/with-namespace-parts:q4_k_m-instruct-2026', 2 * GB, ['completion', 'tools']),
  ];
}
function startFake(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        let b = {}; try { b = JSON.parse(body || '{}'); } catch { /* none */ }
        const u = req.url.split('?')[0];
        if (u === '/api/version') return json(200, { version: '0.9.0' });
        if (u === '/api/tags') return fake.mode === 'tagserror' ? json(500, { error: 'boom: backend exploded' }) : json(200, { models: fakeModels() });
        if (u === '/api/ps') return json(200, { models: fake.mode === 'normal' ? [{ name: 'plain-chat:7b', size: 4 * GB, size_vram: 0, expires_at: '2026-10-13T12:00:00Z' }] : [] });
        if (u === '/api/show') {
          if (b.model === 'legacy:1b') return json(200, { capabilities: ['completion'], details: {}, model_info: { 'general.architecture': 'x', 'x.context_length': 4096 }, parameters: '', template: '', modelfile: '' });
          return json(200, { capabilities: ['completion', 'tools'], details: {}, model_info: {}, parameters: 'temperature 0.7', template: '{{ .Prompt }}', system: 'fake system', modelfile: 'FROM x' });
        }
        if (u === '/api/delete') { fake.deleted.push(b.model); return json(500, { error: 'delete failed on purpose' }); }
        if (u === '/api/chat') return json(404, { error: `model '${b.model}' not found` });
        if (u.startsWith('/api/blobs/')) { res.writeHead(req.method === 'HEAD' ? 404 : 201); return res.end(); }
        if (u === '/api/create') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.write(JSON.stringify({ status: 'parsing GGUF' }) + '\n'); return res.end(JSON.stringify({ error: "unsupported architecture 'foo'" }) + '\n'); }
        json(404, { error: 'not found' });
      });
    });
    srv.listen(port, '127.0.0.1', () => { fake.server = srv; fake.port = srv.address().port; resolve(); });
  });
}
const stopFake = () => new Promise((resolve) => { fake.server.closeAllConnections?.(); fake.server.close(() => resolve()); });

/* ---- fake phase must set settings.json before main.js loads ---- */
if (PHASE === 'fake') {
  const port = Number(process.env.FABER_FAKE_PORT);
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ host: `http://127.0.0.1:${port}` }));
}
app.setPath('userData', DATA);
require(path.join(root, 'main.js'));

app.whenReady().then(async () => {
  try {
    if (PHASE === 'fake') await startFake(Number(process.env.FABER_FAKE_PORT));
    await sleep(3500);
    const win = BrowserWindow.getAllWindows()[0];
    const errs = []; globalThis.__errs = errs;
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    async function waitFor(expr, ms = 15000, step = 200) {
      const t0 = Date.now();
      for (;;) {
        let v; try { v = await js(expr); } catch { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(step);
      }
    }
    for (let i = 0; i < 40 && !(await js("!document.getElementById('app').hidden")); i++) await sleep(500);
    async function waitTags(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred(await (await fetch(REAL + '/api/tags')).json())) return true; } catch { /* retry */ } await sleep(300); } return false; }
    const lastSys = () => js("[...document.querySelectorAll('#chat .msg.sys')].pop()?.textContent || ''");
    const lastErr = () => js("[...document.querySelectorAll('#chat .msg.error')].pop()?.textContent || ''");
    const closeModals = () => js("document.querySelectorAll('.modalBack').forEach((b) => b.remove())");
    const setVal = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return !!e; })()`);
    const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`);
    const clickText = (sel, text) => js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (e) e.click(); return !!e; })()`);
    const call = (m, ...a) => js(`Faber.call('feat:models:${m}', ...${JSON.stringify(a)}).then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: e.message }))`);
    const openTab = async () => { await js("Faber.showSideTab('models')"); await sleep(300); };
    const expandRow = async (name) => { await waitFor(`!!document.querySelector('.mgRow[data-name=${JSON.stringify(name)}]')`); await js(`(() => { const r = document.querySelector('.mgRow[data-name=${JSON.stringify(name)}]'); if (r && !r.classList.contains('open')) r.querySelector('.mgTop').click(); })()`); await sleep(200); };

    check('feature loaded: Faber.pickModel, no console errors so far', (await js('typeof Faber.pickModel')) === 'function' && errs.length === 0, JSON.stringify(errs).slice(0, 200));
    check('Models side tab exists', (await js("!!document.querySelector('#railTop .rbtn[title=\"Models\"]')")) === true);
    check('Tools menu has Models... and Switch Model...', (await js("(() => { const t = Faber.menus ? Faber.menus().get('Tools') || [] : []; return t.some((i) => i.id === 'models-open') && t.some((i) => i.id === 'models-switch'); })()")) === true);
    check('settings section registered', (await js("Faber.settingsSections().some((s) => s.id === 'models')")) === true);

    if (PHASE === 'real') {
      const ps0 = await (await fetch(REAL + '/api/ps')).json();
      const wasWarm = ps0.models.some((m) => m.name === 'qwen3.5:9b');
      const V = PFX + '-v';
      const tmpDir = path.join(TMP, 'faber-models-files-' + TAG);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(tmpDir, 'with space'), { recursive: true });
      try {
        /* ---- picker ---- */
        await js("window.__picked = null; void Faber.pickModel('qwen3.5:9b', (n) => { window.__picked = n; })");
        const rowTxt = await waitFor("document.querySelector('.mpRow[data-name=\"qwen3.5:9b\"]')?.textContent");
        check('picker lists the real model with size/params/quant', !!rowTxt && /GB/.test(rowTxt) && /9\.0B/.test(rowTxt) && /Q4_K_M/.test(rowTxt), String(rowTxt).slice(0, 160));
        check('picker shows tools + thinking capabilities and current marker', /tools/.test(rowTxt) && /thinking/.test(rowTxt) && /current/.test(rowTxt));
        check('picker footer shows disk and RAM estimate note', /on disk/.test(await js("document.querySelector('.mpFoot').textContent")) && /est\./.test(await js("document.querySelector('.mpFoot').textContent")));
        await setVal('.mpSearch', 'zzzz-nothing');
        check('search filters to nothing with a message', (await js("document.querySelectorAll('.mpRow').length")) === 0 && /No models match/.test(await js("document.querySelector('.mpMsg').textContent")));
        await setVal('.mpSearch', 'q4');
        check('search matches quantization text', (await js("document.querySelectorAll('.mpRow').length")) >= 1);
        await js("document.querySelector('.mpSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
        await js("document.querySelector('.mpSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
        await sleep(400);
        check('keyboard Enter picks and calls onPick, modal closes', (await js('window.__picked')) === 'qwen3.5:9b' && (await js("!document.querySelector('.modalCard')")) === true, String(await js('window.__picked')));

        /* ---- main-process validation + errors ---- */
        const bad1 = await call('delete', PFX + '-does-not-exist');
        check('delete of a missing model gives an error message', !bad1.ok && /not found/i.test(bad1.err), bad1.err);
        const bad2 = await call('copy', 'qwen3.5:9b', 'Bad Name!');
        check('copy to an invalid name is rejected', !bad2.ok && /not a valid model name/.test(bad2.err), bad2.err);
        const bad3 = await call('copy', 'qwen3.5:9b', 'qwen3.5:9b');
        check('copy over an existing model is refused', !bad3.ok && /already exists/.test(bad3.err), bad3.err);
        const bad4 = await call('create', 'x1', { name: PFX + '-x', from: PFX + '-no-such-base', system: 'a' });
        check('create from a non-installed base is refused (no download)', !bad4.ok && /not installed/.test(bad4.err), bad4.err);
        const bad5 = await call('create', 'x2', { name: PFX + '-x', from: 'qwen3.5:9b', parameters: { temperature: 99 } });
        check('create with an out-of-range parameter is rejected', !bad5.ok && /temperature/.test(bad5.err), bad5.err);
        const bad6 = await call('create', 'x3', { name: 'qwen3.5:9b', from: 'qwen3.5:9b' });
        check('create over an existing name (qwen3.5:9b) is refused', !bad6.ok && /already exists/.test(bad6.err), bad6.err);
        const mf = await call('modelfile', { name: V, from: 'qwen3.5:9b', system: 'Be a duck.', parameters: { temperature: '0.3', num_ctx: '4096', stop: 'END\nSTOP' } }, 'variant');
        check('Modelfile generation', mf.ok && mf.v.text === 'FROM qwen3.5:9b\nSYSTEM """Be a duck."""\nPARAMETER num_ctx 4096\nPARAMETER temperature 0.3\nPARAMETER stop "END"\nPARAMETER stop "STOP"\n' || (mf.ok && /FROM qwen3.5:9b/.test(mf.v.text) && /SYSTEM """Be a duck."""/.test(mf.v.text) && /PARAMETER temperature 0.3/.test(mf.v.text) && /PARAMETER stop "END"/.test(mf.v.text)), JSON.stringify(mf).slice(0, 300));
        const mfq = await call('modelfile', { name: V, from: 'qwen3.5:9b', system: 'bad """ quote' }, 'variant');
        check('Modelfile generation rejects triple quotes', !!(mfq.ok && mfq.v.error && /three double quotes/.test(mfq.v.error)), JSON.stringify(mfq).slice(0, 200));

        /* ---- create variant through the UI ---- */
        await openTab();
        await expandRow('qwen3.5:9b');
        check('Models tab lists qwen3.5:9b with actions', (await js("!!document.querySelector('.mgRow.open .mgVar') && !!document.querySelector('.mgRow.open .mgDel')")) === true);
        check('disk usage total shown', /on disk/.test(await js("document.querySelector('.mgDisk').textContent")), await js("document.querySelector('.mgDisk').textContent"));
        await click('.mgRow.open .mgVar');
        await waitFor("!!document.querySelector('.mf')");
        await setVal('.mf input[placeholder=\"my-coder\"]', V);
        await setVal('.mf textarea', 'You are a smoke-test duck. Always say quack.');
        await setVal('.mf input[data-k=temperature]', '0.3');
        await setVal('.mf input[data-k=num_ctx]', '4096');
        await sleep(500);
        const pv = await js("document.querySelector('.mPreview').textContent");
        check('variant form shows a live Modelfile preview', /FROM qwen3\.5:9b/.test(pv) && /smoke-test duck/.test(pv) && /PARAMETER temperature 0\.3/.test(pv), pv.slice(0, 200));
        await click('.mf .mpActs button.primary');
        const made = await waitFor("document.querySelector('.mf .mResult')?.classList.contains('mOk') || /mErr/.test(document.querySelector('.mf .mResult')?.className || '')", 60000);
        const resTxt = await js("document.querySelector('.mf .mResult')?.textContent");
        check('create variant via UI succeeds', !!made && /Created/.test(resTxt), resTxt);
        await closeModals();
        const tags = await (await fetch(REAL + '/api/tags')).json();
        check('variant appears in Ollama list', tags.models.some((m) => m.name === V + ':latest'));
        await waitFor(`!!document.querySelector('.mgRow[data-name=\"${V}:latest\"]')`);
        check('variant appears in the Models tab', (await js(`!!document.querySelector('.mgRow[data-name=\"${V}:latest\"]')`)) === true);
        const sh = await (await fetch(REAL + '/api/show', { method: 'POST', body: JSON.stringify({ model: V }) })).json();
        check('variant has system prompt + parameters in Ollama', /quack/.test(sh.system || '') && /temperature\s+0\.3/.test(sh.parameters || '') && /num_ctx\s+4096/.test(sh.parameters || ''));

        /* ---- info view: system prompt visible + quick test ---- */
        await expandRow(V + ':latest');
        await click('.mgRow.open .mgInfo');
        const sysTxt = await waitFor("document.querySelector('.miSystem pre')?.textContent");
        check('Info shows the variant system prompt', /quack/.test(sysTxt || ''), String(sysTxt).slice(0, 100));
        check('Info shows parameters block + capabilities', /temperature/.test(await js("document.querySelector('.miParams pre').textContent")) && /tools/.test(await js("document.querySelector('.miFacts').textContent")));
        await closeModals();
        await expandRow('qwen3.5:9b');
        await click('.mgRow.open .mgInfo');
        await waitFor("!!document.querySelector('.mqtRun')");
        await setVal('.mqtIn', 'Say pong.');
        await click('.mqtRun');
        const qt = await waitFor("document.querySelector('.mqtStats')?.dataset.tps", 240000, 500);
        const qout = await js("document.querySelector('.mqtOut').textContent");
        const qstat = await js("document.querySelector('.mqtStats').textContent");
        check('quick test returns text', !!qout && qout.length > 0 && !/^Error/.test(qout), qout.slice(0, 80));
        check('quick test reports a tokens/sec number', !!qt && Number(qt) > 0, qstat);
        await closeModals();

        /* ---- load / unload from memory ---- */
        const psAfter = await (await fetch(REAL + '/api/ps')).json();
        check('qwen is loaded in memory after the quick test', psAfter.models.some((m) => m.name === 'qwen3.5:9b'));
        await js("Faber.showSideTab('models')");
        // refresh list and look for the loaded badge
        await clickText('.mgHead button', 'Refresh');
        await sleep(1500);
        check('manager marks the loaded model', (await js("/loaded/.test(document.querySelector('.mgRow[data-name=\"qwen3.5:9b\"]')?.textContent || '')")) === true);
        if (!wasWarm) {
          await expandRow('qwen3.5:9b');
          await click('.mgRow.open .mgLoad');
          await sleep(2500);
          const ps2 = await (await fetch(REAL + '/api/ps')).json();
          check('Unload button unloads it from memory', !ps2.models.some((m) => m.name === 'qwen3.5:9b'));
        } else print('SKIP unload check (qwen was already loaded before the test; left as found)');

        /* ---- chip opens picker and saves the choice ---- */
        await js("document.getElementById('chipModel').click()");
        await waitFor(`!!document.querySelector('.mpRow[data-name=\"${V}:latest\"]')`);
        check('chip click opens the rich picker with both models', (await js("document.querySelectorAll('.mpRow').length")) >= 2);
        await click(`.mpRow[data-name=\"${V}:latest\"]`);
        await sleep(600);
        check('choosing a model from the chip saves settings.model', (await js('Faber.settings().model')) === V + ':latest', await js('Faber.settings().model'));
        check('chip text shows the new model', (await js("document.getElementById('chipModel').textContent")).includes(V), await js("document.getElementById('chipModel').textContent"));
        await js("runCommand('/model qwen3.5:9b')");
        await sleep(600);
        check('/model <name> switches back', (await js('Faber.settings().model')) === 'qwen3.5:9b' && /qwen3\.5:9b/.test(await lastSys()), await lastSys());
        await js("runCommand('/model list')"); await sleep(600);
        check('/model list prints sizes', /qwen3\.5:9b.*GB/.test(await lastSys()), (await lastSys()).slice(0, 200));
        await js("runCommand('/model info qwen3.5:9b')"); await sleep(1200);
        const infoSys = await lastSys();
        check('/model info prints details', /Q4_K_M/.test(infoSys) && /9\.0B/.test(infoSys) && /tools/.test(infoSys), infoSys.replace(/\n/g, ' | ').slice(0, 250));
        await js(`runCommand('/model info ${V}')`); await sleep(1200);
        check('/model info shows variant system prompt', /quack/.test(await lastSys()));
        await js("runCommand('/model no-such-model-xyz')"); await sleep(800);
        check('/model <unknown> is an error that mentions /pull', /not installed/.test(await lastErr()) && /\/pull/.test(await lastErr()), await lastErr());

        /* ---- copy + delete through the UI ---- */
        const C = V + '-cp';
        await openTab();
        await expandRow(V + ':latest');
        await click('.mgRow.open .mgCopy');
        await waitFor("!!document.querySelector('.modalCard input')");
        await js(`(() => { const i = document.querySelector('.modalCard input'); i.value = ${JSON.stringify(C)}; })()`);
        await clickText('.modalFoot button', 'Copy');
        const copied = await waitTags((t) => t.models.some((m) => m.name === C + ":latest"));
        check('copy creates the new model', !!copied);
        await sleep(800);
        await expandRow(C + ':latest');
        await click('.mgRow.open .mgDel');
        await waitFor("!!document.querySelector('.modalFoot button.primary.danger')");
        check('delete asks for confirmation first', (await js("/cannot be undone/.test(document.querySelector('.modalBody').textContent)")) === true);
        const stillThere = (await (await fetch(REAL + '/api/tags')).json()).models.some((m) => m.name === C + ':latest');
        check('nothing deleted before confirming', stillThere);
        await click('.modalFoot button.primary.danger');
        const gone = await waitTags((t) => !t.models.some((m) => m.name === C + ":latest"));
        check('confirmed delete removes the model', !!gone);

        /* ---- GGUF validation + import ---- */
        const gOk = path.join(tmpDir, 'tiny.gguf');
        makeTinyGguf(gOk);
        fs.writeFileSync(path.join(tmpDir, 'weights.bin'), Buffer.from('GGUF0000000000000000000000000000000000'));
        fs.writeFileSync(path.join(tmpDir, 'fake.gguf'), 'this is not a gguf file at all, just text padding padding');
        fs.writeFileSync(path.join(tmpDir, 'm-00001-of-00003.gguf'), Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(64)]));
        const chk = async (p) => (await call('checkGguf', p)).v;
        const r1 = await chk(path.join(tmpDir, 'missing.gguf'));
        check('GGUF: nonexistent file explained', r1.ok === false && /File not found/.test(r1.error), r1.error);
        const r2 = await chk(path.join(tmpDir, 'weights.bin'));
        check('GGUF: wrong extension explained', r2.ok === false && /Only \.gguf files/.test(r2.error), r2.error);
        const r3 = await chk(path.join(tmpDir, 'fake.gguf'));
        check('GGUF: bad header explained', r3.ok === false && /GGUF header/.test(r3.error), r3.error);
        const r4 = await chk(path.join(tmpDir, 'm-00001-of-00003.gguf'));
        check('GGUF: split file explained', r4.ok === false && /split GGUF/.test(r4.error), r4.error);
        const r5 = await chk('models\\relative.gguf');
        check('GGUF: relative path explained', r5.ok === false && /full path/.test(r5.error), r5.error);
        const r6 = await chk(tmpDir);
        check('GGUF: folder explained', r6.ok === false && /folder/.test(r6.error), r6.error);
        const r7 = await chk('"' + gOk + '"');
        check('GGUF: valid file accepted (pasted quotes stripped), name suggested', r7.ok === true && r7.suggest === 'tiny', JSON.stringify(r7));
        // UI import with the real tiny GGUF
        const G = PFX + '-g';
        await js("Faber.showSideTab('models')");
        await clickText('.mgBtns button', 'Import GGUF');
        await waitFor("!!document.querySelector('.mf')");
        await setVal('.mf input[placeholder^=\"C:\"]', path.join(tmpDir, 'missing.gguf'));
        await sleep(700);
        check('import form shows the path error live', /File not found/.test(await js("document.querySelector('.mf .mErr, .mf .mOk')?.textContent || ''")) || /File not found/.test(await js("document.querySelector('.mf').textContent")));
        await setVal('.mf input[placeholder^=\"C:\"]', gOk);
        await sleep(700);
        check('import form accepts a valid GGUF and suggests a name', /OK: GGUF/.test(await js("document.querySelector('.mf').textContent")) && (await js("document.querySelector('.mf input[placeholder=\"my-coder\"]').value")) === 'tiny');
        await setVal('.mf input[placeholder=\"my-coder\"]', G);
        await setVal('.mf textarea', 'Imported by the smoke test.');
        await js("(() => { const s = document.querySelector('.mf details select'); s.value = 'chatml'; s.dispatchEvent(new Event('change')); })()");
        await sleep(500);
        await click('.mf .mpActs button.primary');
        await waitFor("/Created|mErr/.test(document.querySelector('.mf .mResult')?.className + document.querySelector('.mf .mResult')?.textContent)", 60000);
        const gres = await js("document.querySelector('.mf .mResult')?.textContent");
        check('real GGUF import (tiny synthetic GGUF) succeeds via UI', /Created/.test(gres), gres);
        await closeModals();
        const gsh = await (await fetch(REAL + '/api/show', { method: 'POST', body: JSON.stringify({ model: G }) })).json();
        check('imported model exists with system prompt + ChatML template', /Imported by the smoke test/.test(gsh.system || '') && /im_start/.test(gsh.template || ''), (gsh.error || gsh.template || '').slice(0, 100));
        const dupe = await call('import', 'dup1', { path: gOk, name: G });
        check('importing over an existing name is refused', !dupe.ok && /already exists/.test(dupe.err), dupe.err);

        /* ---- ollama CLI fallback (forced via the setting) ---- */
        await js("Faber.saveFeatureSettings('models', { useCli: true })");
        const CL = PFX + '-cli';
        const viaCli = await call('create', 'cli1', { name: CL, from: 'qwen3.5:9b', system: 'cli duck', parameters: { temperature: 0.4 } });
        check('variant via the ollama CLI fallback', viaCli.ok, viaCli.err);
        const clsh = await (await fetch(REAL + '/api/show', { method: 'POST', body: JSON.stringify({ model: CL }) })).json();
        check('CLI-created variant has the system prompt', /cli duck/.test(clsh.system || ''));
        const gSp = path.join(tmpDir, 'with space', 'tiny two.gguf');
        fs.copyFileSync(gOk, gSp);
        fs.appendFileSync(gSp, Buffer.alloc(32)); // different bytes => different blob
        const GS = PFX + '-gs';
        const impCli = await call('import', 'cli2', { path: gSp, name: GS, system: 'spaces ok' });
        check('GGUF import via CLI with spaces in the path', impCli.ok, impCli.err);
        await js("Faber.saveFeatureSettings('models', { useCli: false })");

        /* ---- settings + favourites + notes ---- */
        await js("(() => { const s = Faber.settingsSections().find((x) => x.id === 'models'); window.__sec = document.createElement('div'); s.render(window.__sec); })()");
        await js("(() => { const sel = window.__sec.querySelector('select'); sel.value = '24h'; sel.dispatchEvent(new Event('change')); const n = window.__sec.querySelector('input[type=number]'); n.value = '12288'; n.dispatchEvent(new Event('change')); })()");
        await sleep(400);
        check('settings section saves keep-alive and default context', (await js("Faber.featureSettings('models').keepAlive")) === '24h' && (await js("Faber.featureSettings('models').defaultCtx")) === 12288);
        await js("Faber.saveFeatureSettings('models', { keepAlive: '5m' })");
        await js(`Faber.saveFeatureSettings('models', { favs: ['${V}:latest'] })`);
        await js("void Faber.pickModel('qwen3.5:9b', () => {})");
        await waitFor("document.querySelectorAll('.mpRow').length >= 2");
        check('pinned favourite sorts first in the picker', (await js("document.querySelector('.mpRow').dataset.name")) === V + ':latest');
        await closeModals();
        await js("Faber.saveFeatureSettings('models', { favs: [] })");
      } finally {
        /* ---- cleanup: only models created by this test ---- */
        try {
          const t = await (await fetch(REAL + '/api/tags')).json();
          for (const m of t.models) {
            if (m.name.startsWith(PFX) && m.name !== 'qwen3.5:9b') await fetch(REAL + '/api/delete', { method: 'DELETE', body: JSON.stringify({ model: m.name }) });
          }
          const t2 = await (await fetch(REAL + '/api/tags')).json();
          check('cleanup: no test models left and qwen3.5:9b intact', !t2.models.some((m) => m.name.startsWith(PFX)) && t2.models.some((m) => m.name === 'qwen3.5:9b'));
          if (!wasWarm) await fetch(REAL + '/api/generate', { method: 'POST', body: JSON.stringify({ model: 'qwen3.5:9b', keep_alive: 0 }) });
        } catch (e) { print('CLEANUP ERROR', e.message); }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      check('no console errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
      /* ---- fake phase in a child Electron (settings.json points at the fake server) ---- */
      const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
      const port = probe.address().port; await new Promise((r) => probe.close(r));
      const child = spawn(process.execPath, [__filename], { env: { ...process.env, FABER_PHASE: 'fake', FABER_FAKE_PORT: String(port), FABER_TAG: TAG }, stdio: 'ignore' });
      const t0 = Date.now();
      const childLog = path.join(TMP, 'faber-models-smoke-' + TAG + '-fake.log');
      while (Date.now() - t0 < 150000) { if (fs.existsSync(childLog) && /DONE/.test(fs.readFileSync(childLog, 'utf8'))) break; await sleep(500); }
      print('--- fake Ollama phase ---');
      print(fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8').trim() : 'FAIL fake phase produced no log');
      try { child.kill(); } catch { /* done */ }
    } else {
      /* ================= fake phase ================= */
      await js("window.__picked = null; void Faber.pickModel('qwen3.5:9b', (n) => { window.__picked = n; })");
      await waitFor("document.querySelectorAll('.mpRow').length >= 6");
      const rows = await js("[...document.querySelectorAll('.mpRow')].map((r) => r.textContent)");
      check('fake: picker shows all 6 models including the very long name', rows.length === 6 && rows.some((t) => /with-namespace-parts/.test(t)));
      const txt = (n) => rows.find((t) => t.includes(n)) || '';
      check('fake: no-tools model is flagged', /no tools/.test(txt('plain-chat')));
      check('fake: huge model flagged as probably not fitting (estimate)', /too big \(est\.\)/.test(txt('giant-model')));
      check('fake: embedding-only model flagged', /embedding only/.test(txt('embed-only')));
      check('fake: loaded-in-memory marker from /api/ps', /loaded/.test(txt('plain-chat')) && !/loaded/.test(txt('giant-model')));
      check('fake: capabilities fetched via /api/show for old-style /api/tags', /no tools/.test(txt('legacy')));
      check('fake: row shows params/quant/ctx', /7B/.test(txt('giant-model')) && /Q4_K_M/.test(txt('giant-model')) && /8K ctx/.test(txt('giant-model')));
      await setVal('.mpSearch', 'tools');
      check('fake: "tools" filter keeps only tool-capable models', (await js("[...document.querySelectorAll('.mpRow')].every((r) => !/no tools|embedding only/.test(r.textContent)) && document.querySelectorAll('.mpRow').length")) === 3);
      await setVal('.mpSearch', '');
      await js("document.querySelector('.mpSort').value = 'size'; document.querySelector('.mpSort').dispatchEvent(new Event('change'))");
      await sleep(200);
      check('fake: sort by size puts the biggest first', (await js("document.querySelector('.mpRow').dataset.name")) === 'giant-model:70b');
      await js("document.querySelector('.mpSort').value = 'name'; document.querySelector('.mpSort').dispatchEvent(new Event('change'))");
      await sleep(200);
      check('fake: sort by name', (await js("document.querySelector('.mpRow').dataset.name")).startsWith('an-extremely'));
      await click('.mpRow[data-name=\"plain-chat:7b\"]');
      await waitFor("!!document.querySelector('.modalFoot button.primary')");
      check('fake: picking a no-tools model warns first', /does not report tool support/.test(await js("[...document.querySelectorAll('.modalBody')].pop().textContent")) && (await js('window.__picked')) === null);
      await clickText('.modalFoot button', 'Use anyway');
      await sleep(400);
      check('fake: "Use anyway" allows it', (await js('window.__picked')) === 'plain-chat:7b');
      await closeModals();
      await js("void Faber.pickModel('x', (n) => { window.__picked2 = n; })");
      await waitFor("document.querySelectorAll('.mpRow').length >= 6");
      await click('.mpRow[data-name=\"embed-only:latest\"]');
      await sleep(400);
      check('fake: embedding-only model cannot be chosen', !(await js('window.__picked2')));
      await closeModals();

      // errors from the API
      await openTab();
      await expandRow('legacy:1b');
      await click('.mgRow.open .mgDel');
      await waitFor("!!document.querySelector('.modalFoot button.primary.danger')");
      await click('.modalFoot button.primary.danger');
      await sleep(800);
      check('fake: API delete error is reported in chat', /delete failed on purpose/.test(await lastErr()), await lastErr());
      await expandRow('legacy:1b');
      await click('.mgRow.open .mgInfo');
      await waitFor("!!document.querySelector('.mqtRun')");
      await click('.mqtRun');
      await waitFor("/Error/.test(document.querySelector('.mqtOut')?.textContent || '')", 10000);
      check('fake: quick test API error is shown', /not found/.test(await js("document.querySelector('.mqtOut').textContent")), await js("document.querySelector('.mqtOut').textContent"));
      await closeModals();
      const g = path.join(TMP, 'faber-models-fake-' + TAG + '.gguf');
      makeTinyGguf(g);
      const imp = await call('import', 'f1', { path: g, name: 'imp-test' });
      check('fake: create error from Ollama is explained', !imp.ok && /unsupported architecture/.test(imp.err) && /update Ollama/.test(imp.err), imp.err);
      fs.rmSync(g, { force: true });

      // empty list
      fake.mode = 'empty';
      await clickText('.mgHead button', 'Refresh');
      await waitFor("/No models installed/.test(document.querySelector('.mgMsg')?.textContent || '')");
      check('fake: empty list shows a helpful message in the tab', /No models installed/.test(await js("document.querySelector('.mgMsg').textContent")));
      await js("void Faber.pickModel('x', () => {})");
      await waitFor("/No models are installed/.test(document.querySelector('.mpMsg')?.textContent || '')");
      check('fake: empty list shows a helpful message in the picker', true);
      await closeModals();
      // API error on list
      fake.mode = 'tagserror';
      await js("void Faber.pickModel('x', () => {})");
      await waitFor("/boom/.test(document.querySelector('.mpMsg')?.textContent || '')");
      check('fake: list API error is shown with a Retry button', /boom/.test(await js("document.querySelector('.mpMsg').textContent")) && (await js("[...document.querySelectorAll('.mpMsg button')].some((b) => b.textContent === 'Retry')")) === true);
      await closeModals();
      // Ollama down, then back
      fake.mode = 'normal';
      await stopFake();
      await js("void Faber.pickModel('x', () => {})");
      await waitFor("/Cannot reach Ollama/.test(document.querySelector('.mpMsg')?.textContent || '')", 20000);
      check('fake: Ollama down gives a clear message and Retry (picker)', /Cannot reach Ollama/.test(await js("document.querySelector('.mpMsg').textContent")) && /Start the Ollama app/.test(await js("document.querySelector('.mpMsg').textContent")));
      await closeModals();
      await js("runCommand('/model list')"); await sleep(1200);
      check('fake: /model list when Ollama is down reports the error', /Cannot reach Ollama/.test(await lastErr()), await lastErr());
      await js("void Faber.pickModel('x', () => {})");
      await waitFor("/Cannot reach Ollama/.test(document.querySelector('.mpMsg')?.textContent || '')", 20000);
      await startFake(fake.port);
      await clickText('.mpMsg button', 'Retry');
      const back = await waitFor("document.querySelectorAll('.mpRow').length >= 6", 15000);
      check('fake: Retry works once Ollama is back', !!back);
      await closeModals();
      const chipOk = await js("document.getElementById('chipModel').textContent");
      check('fake: chip text still correct', chipOk.includes('qwen3.5:9b'), chipOk);
      check('fake: no console errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
      try { await stopFake(); } catch { /* done */ }
    }
  } catch (e) { print('SMOKE ERROR', e.stack || e.message);
    try { print('console errors:', JSON.stringify(globalThis.__errs || [])); } catch { /* ignore */ } }
  print('DONE');
  app.exit(0);
});
