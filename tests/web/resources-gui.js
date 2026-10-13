// Resources view in the Models tab, and the saved runtime options actually reaching Ollama requests.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep, waitFor } = require('./harness');
(async () => {
  const check = checker();
  const fake = await startFake({ sizes: { 'qwen3.5:9b': 6.6e9, 'fake-b:1b': 1.2e9 }, loaded: [{ name: 'qwen3.5:9b', size: 7.4e9, size_vram: 6.0e9, context_length: 16384 }] });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-proj-'));
  const h = await launch({ ollama: fake.url, workspace: proj });
  try {
    await h.open(); await sleep(500);
    await h.js(() => [...document.querySelectorAll('#railTop .rbtn')].find((b) => b.title === 'Models').click()); await sleep(500);
    check('Models tab has Models + Resources switch', await h.js(() => [...document.querySelectorAll('.mgSegBtn')].map((b) => b.textContent).join() === 'Models,Resources'));
    await h.js(() => [...document.querySelectorAll('.mgSegBtn')].find((b) => b.textContent === 'Resources').click()); await sleep(1500);
    check('model list hidden, resources shown', await h.js(() => document.querySelector('.mgMain').hidden && !document.querySelector('.mgView').hidden));
    const vals = await h.js(() => [...document.querySelectorAll('.rsRow .rsVal')].map((x) => x.textContent));
    console.log('  meters:', vals.join(' | '));
    check('CPU and RAM meters have live values', /%/.test(vals[0]) && /GB|MB/.test(vals[1]), vals);
    check('GPU says not measured when no NVIDIA GPU (honest)', /not measured/.test(vals[2]) || /%/.test(vals[2]), vals);
    check('loaded model listed with GPU split', await h.js(() => /qwen3\.5:9b.*81% on GPU/.test(document.querySelector('.rsLoadedBox').textContent)), await h.js(() => document.querySelector('.rsLoadedBox').textContent));
    check('advisor lists installed models', await h.js(() => [...document.querySelectorAll('.rsSel option')].some((o) => o.textContent === 'fake-b:1b')));
    check('advisor shows an estimate + verdict', await h.js(() => !!document.querySelector('.rsVerdict') && /about .* GB \(estimate\)/.test(document.querySelector('.rsOut').textContent)));
    // what-if 80B
    await h.js(() => { document.querySelector('.rsNum').value = '80'; [...document.querySelectorAll('.rsSec button')].find((b) => b.textContent === 'Check').click(); }); await sleep(800);
    check('80B what-if is honestly too big', await h.js(() => [...document.querySelectorAll('.rsVerdict')].some((v) => /Too big/i.test(v.textContent))), await h.js(() => [...document.querySelectorAll('.rsVerdict')].map((v) => v.textContent)));
    // save runtime for qwen with a small ctx so no confirm is needed
    await h.js(() => { const s = document.querySelectorAll('.rsSel')[0]; s.value = 'qwen3.5:9b'; s.dispatchEvent(new Event('change')); }); await sleep(800);
    await h.js(() => { const c = document.querySelectorAll('.rsSel')[1]; c.value = '4096'; c.dispatchEvent(new Event('change')); }); await sleep(700);
    await h.js(() => { const r = document.querySelector('.rsCtl input[type=range]'); r.value = '20'; r.dispatchEvent(new Event('input')); }); await sleep(700);
    await h.js(() => { document.querySelector('.rsCtl input[type=text]').value = '30m'; });
    await h.js(() => [...document.querySelectorAll('.rsCtl button')].find((b) => b.textContent === 'Save for this model').click()); await sleep(700);
    const rt = (await h.invoke('settings:get')).features.models.runtime['qwen3.5:9b'];
    check('runtime saved to settings', rt && rt.num_gpu === 20 && rt.num_ctx === 4096 && rt.keep_alive === '30m', rt);
    await h.page.screenshot({ path: '/tmp/claude-0/resources.png', fullPage: false });
    // the agent really sends them to Ollama
    const sid = await h.js(() => activeSid);
    await h.js(() => { $('input').value = '[say hi]'; return submit(); });
    await waitFor(h.page, (id) => Faber.chat.sessions().find((s) => s.id === id).status === 'idle', sid, 15000);
    const req = [...fake.requests].reverse().find((r) => r.model === 'qwen3.5:9b');
    check('chat request carries num_gpu / num_ctx / keep_alive', req && req.options.num_gpu === 20 && req.options.num_ctx === 4096 && req.keep_alive === '30m', req && { o: req.options, k: req.keep_alive });
    // dangerous ctx needs confirmation
    const guard = await h.invoke('feat:resources:setRuntime', 'qwen3.5:9b', { num_ctx: 131072, num_gpu: 0 }, false);
    check('huge context with no GPU asks for confirmation instead of saving', guard.needsConfirm === true, guard);
    const bad = await h.invoke('feat:resources:setRuntime', 'qwen3.5:9b', { num_gpu: -5 }).catch((e) => ({ err: e.message }));
    check('invalid value rejected', bad.err && /GPU layers/.test(bad.err), bad);
    await h.invoke('feat:resources:clearRuntime', 'qwen3.5:9b');
    check('reset clears saved options', !((await h.invoke('settings:get')).features.models.runtime || {})['qwen3.5:9b']);
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
