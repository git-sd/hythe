// Debug mode test in the real app against the fake Ollama.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startFake } = require('./fake-ollama-chat');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const base = path.join(process.env.TEMP, 'faber-debug-' + TAG);
const ud = path.join(base, 'ud');
const proj = path.join(base, 'proj');
const LOG = path.join(process.env.TEMP, 'faber-debug-' + TAG + '.log');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(proj, 'notes.txt'), 'NOTES-CONTENT-123\n');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', ud);

let fake, agentMod;
const ready = (async () => {
  fake = await startFake();
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ host: fake.url, workspace: proj, model: 'qwen3.5:9b', effort: 'low', mode: 'ask' }));
  require(path.join(root, 'main.js'));
  agentMod = require(path.join(root, 'src', 'agent.js'));
})();

app.whenReady().then(async () => {
  await ready;
  const win = await new Promise((res) => { const t = setInterval(() => { const w = BrowserWindow.getAllWindows()[0]; if (w) { clearInterval(t); res(w); } }, 100); });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errs.push(msg); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  const waitFor = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(code)) return true; } catch { /* retry */ } await sleep(100); } return false; };
  const send = (text) => js(`(async () => { $('input').value = ${JSON.stringify(text)}; await submit(); })()`);
  const idle = () => waitFor("Faber.chat.sessions().every((s) => s.status === 'idle')", 20000);
  const list = () => js("Faber.call('feat:debug:list')");
  const entry = (seq) => js(`Faber.call('feat:debug:entry', ${seq})`);

  try {
    await waitFor("Faber.chat && document.querySelectorAll('#agentTabs .atab').length > 0", 15000);
    const sid = await js('Faber.chat.active()');

    // ---- off by default, zero overhead ----
    check('debug is off by default', (await js("Faber.call('feat:debug:get')")).enabled === false);
    check('no debug sink attached while off', agentMod.hasDebugSink() === false);
    check('no Debug tab while off', !(await js("!!document.getElementById('pane-debug')")));
    await send('[say hello-off]'); await idle();
    check('off logs nothing', (await list()).length === 0);

    // ---- on ----
    check('Run > Debug Mode menu item exists', await js("Faber.menus().get('Run').some((i) => i.id === 'run.debug')"));
    check('Settings section exists', await js("Faber.settingsSections().some((s) => s.id === 'debug')"));
    await js("runCommand('/debug on')");
    check('/debug on attaches the sink', await waitFor("document.getElementById('pane-debug') !== null") && agentMod.hasDebugSink() === true);
    check('menu item shows checked', await js("Faber.menus().get('Run').find((i) => i.id === 'run.debug').checked()"));
    await send('[read notes.txt]'); await idle();
    await sleep(200);
    const es = await list();
    const kinds = es.map((e) => e.kind);
    check('captures request, response and tool entries', ['request', 'response', 'tool'].every((k) => kinds.includes(k)), kinds.join(','));
    const req = await entry(es.find((e) => e.kind === 'request').seq);
    const d = req.data;
    check('request fields', d.model === 'qwen3.5:9b' && d.options.num_ctx === 16384 && d.messageCount >= 2 && d.promptTokensEst > 0 && d.tools.includes('read_file') && d.think === false && typeof d.system === 'string', JSON.stringify({ m: d.model, c: d.options && d.options.num_ctx, n: d.messageCount, t: d.promptTokensEst }));
    const resp = (await Promise.all(es.filter((e) => e.kind === 'response').map((e) => entry(e.seq)))).map((e) => e.data);
    const r = resp[0];
    check('response fields', r.eval_count > 0 && r.prompt_eval_count > 0 && r.load_duration === 100e6 && r.total_duration === 900e6 && typeof r.done_reason === 'string', JSON.stringify({ e: r.eval_count, p: r.prompt_eval_count, d: r.done_reason }));
    check('tokens/sec computed from eval_duration', Math.abs(r.tokens_per_sec - r.eval_count / (r.eval_duration / 1e9)) < 0.05, 'tps=' + r.tokens_per_sec);
    check('context usage recorded', r.ctxUsed === r.prompt_eval_count + r.eval_count && r.numCtx === 16384);
    const tool = (await entry(es.find((e) => e.kind === 'tool').seq)).data;
    check('tool fields', tool.name === 'read_file' && tool.args.path === 'notes.txt' && tool.ok === true && tool.resultLength > 10 && typeof tool.durationMs === 'number' && tool.session === sid, JSON.stringify({ n: tool.name, a: tool.args, l: tool.resultLength }));

    // approvals
    await send('[write dbg.txt|x]');
    await waitFor("document.querySelector('.chatView:not([hidden]) .approval button.primary')");
    await js("document.querySelector('.chatView:not([hidden]) .approval button.primary').click()");
    await idle();
    const ap = (await list()).filter((e) => e.kind === 'approval').map((e) => e.summary.split(' ')[0]);
    check('approval asked and allowed logged', ap.includes('asked') && ap.includes('allowed'), ap.join(','));
    await send('[write dbg2.txt|x]');
    await waitFor("document.querySelector('.chatView:not([hidden]) .approval button')");
    await js("[...document.querySelectorAll('.chatView:not([hidden]) .approval')].pop().querySelectorAll('button')[1].click()");
    await idle();
    check('approval denied logged', (await list()).some((e) => e.kind === 'approval' && e.summary.startsWith('denied')));

    // sub-agent
    await send('[delegate researcher :: [read notes.txt]]'); await idle();
    const sub = (await list()).filter((e) => e.kind === 'subagent');
    check('sub-agent start and finish logged', sub.some((e) => /^start +researcher/.test(e.summary)) && sub.some((e) => e.summary.startsWith('finish')));
    const fin = (await entry(sub.find((e) => /^finish/.test(e.summary)).seq)).data;
    check('sub-agent finish has ok/steps/duration', fin.ok === true && fin.steps >= 2 && typeof fin.durationMs === 'number');
    const subReqs = (await Promise.all((await list()).filter((e) => e.kind === 'request').map((e) => entry(e.seq)))).filter((e) => e.data.depth === 1);
    check('sub-agent requests are tagged', subReqs.length >= 2 && subReqs[0].data.agent === 'researcher');

    // errors
    await send('[err]'); await idle();
    await sleep(200);
    const er = (await list()).find((e) => e.kind === 'error');
    check('error logged with stack', !!er && (await entry(er.seq)).data.stack.includes('Error'));

    // system prompt + meter
    const sp = await js(`Faber.call('feat:debug:system', ${JSON.stringify(sid)})`);
    check('exact system prompt available', sp && sp.system.includes('You are Faber') && sp.system.includes(proj));
    await js("Faber.showSideTab('debug')");
    check('context meter shows used / num_ctx', await waitFor("document.querySelector('.dbgMeterText') && /\\/ 16384/.test(document.querySelector('.dbgMeterText').textContent)"));

    // UI rows + filters
    const total = await js("document.querySelectorAll('.dbgRow').length");
    check('log rows rendered', total === (await list()).length, `rows=${total}`);
    await js("[...document.querySelectorAll('.dbgKinds button')].find((b) => b.textContent === 'tool').click()");
    const toolRows = await js("document.querySelectorAll('.dbgRow').length");
    check('filter by kind', toolRows > 0 && toolRows === (await list()).filter((e) => e.kind === 'tool').length && await js("[...document.querySelectorAll('.dbgRow')].every((r) => r.classList.contains('k-tool'))"));
    await js("[...document.querySelectorAll('.dbgKinds button')].find((b) => b.textContent === 'all').click()");
    await js("Faber.chat.create('Other')");
    await waitFor("Faber.chat.sessions().length === 2");
    await js("(() => { const s = document.querySelector('.dbgFilt select'); s.value = Faber.chat.sessions()[1].id; s.dispatchEvent(new Event('change')); })()");
    check('filter by session', (await js("document.querySelectorAll('.dbgRow').length")) === 0);
    await js("(() => { const s = document.querySelector('.dbgFilt select'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()");

    await js(`Faber.chat.switchTo(${JSON.stringify(sid)})`);
    // detail modal
    await js("document.querySelector('.dbgRow.k-tool, .dbgRow').click()");
    check('click opens the raw JSON', await waitFor("document.querySelector('.modalCard .dbgJson') && (() => { try { JSON.parse(document.querySelector('.modalCard .dbgJson').textContent); return true; } catch { return false; } })()"));
    await js("document.querySelector('.modalCard .ghost').click()");
    await js("[...document.querySelectorAll('.dbgTools button')].find((b) => b.textContent === 'Raw messages').click()");
    check('raw messages of the active session', await waitFor("document.querySelector('.modalCard .dbgJson') && document.querySelector('.modalCard .dbgJson').textContent.includes('NOTES-CONTENT-123')"));
    await js("document.querySelector('.modalCard .ghost').click()");

    // secrets never logged
    agentMod.debugEmit({ kind: 'tool', session: sid, name: 'x', args: agentMod.scrub({ apiKey: 'SECRETVAL-1', nested: { password: 'SECRETVAL-2' }, ok: 'fine' }), ok: true });
    agentMod.debugEmit({ kind: 'note', session: sid, note: 'n', password: 'SECRETVAL-3', headers: { Authorization: 'SECRETVAL-4' } });
    await sleep(200);
    const all = JSON.stringify(await Promise.all((await list()).slice(-2).map((e) => entry(e.seq))));
    check('secrets are redacted', !/SECRETVAL/.test(all) && all.includes('[redacted]') && all.includes('fine'));

    // pause
    const rows0 = await js("document.querySelectorAll('.dbgRow').length");
    await js("[...document.querySelectorAll('.dbgTools button')].find((b) => b.textContent === 'Pause').click()");
    for (let i = 0; i < 3; i++) agentMod.debugEmit({ kind: 'note', session: sid, note: 'while paused ' + i });
    await sleep(200);
    check('pause freezes the view', (await js("document.querySelectorAll('.dbgRow').length")) === rows0);
    await js("[...document.querySelectorAll('.dbgTools button')].find((b) => b.textContent === 'Resume').click()");
    check('resume catches up', await waitFor(`document.querySelectorAll('.dbgRow').length === ${rows0 + 3}`));

    // export
    const out = path.join(base, 'export.json');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
    await js("[...document.querySelectorAll('.dbgTools button')].find((b) => b.textContent === 'Export').click()");
    check('export writes the log file', await new Promise(async (res) => { for (let i = 0; i < 30; i++) { if (fs.existsSync(out)) return res(true); await sleep(100); } res(false); }));
    const ex = JSON.parse(fs.readFileSync(out, 'utf8'));
    check('export content', ex.count === ex.entries.length && ex.entries.some((e) => e.kind === 'request' && e.data.model));

    // cap
    for (let i = 0; i < 2100; i++) agentMod.debugEmit({ kind: 'note', session: sid, note: 'bulk ' + i, big: 'x'.repeat(10) });
    await sleep(500);
    check('log capped at 2000 entries', (await list()).length === 2000);
    check('big payloads are truncated', (() => { agentMod.debugEmit({ kind: 'note', note: 'huge', blob: 'y'.repeat(50000) }); return true; })());
    await sleep(200);
    const huge = await entry((await list()).slice(-1)[0].seq);
    check('long strings clipped', JSON.stringify(huge.data).length < 6000);
    await js("[...document.querySelectorAll('.dbgTools button')].find((b) => b.textContent === 'Clear').click()");
    check('clear empties the log', await waitFor("document.querySelectorAll('.dbgRow').length === 0") && (await list()).length === 0);

    // off again
    await js("runCommand('/debug off')");
    check('/debug off detaches the sink', (await sleep(400), true) && agentMod.hasDebugSink() === false);
    await send('[say after-off]'); await idle();
    check('nothing logged after off', (await list()).length === 0);
    check('no page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
  } catch (e) { print('SMOKE ERROR', e.stack); }
  print('DONE');
  await fake.close();
  app.exit(0);
});
