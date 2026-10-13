// Agents feature test in the real app against a fake Ollama (tests/fake-ollama.js).
// Phase 1 runs everything, then relaunches itself (PHASE=2) on the same userData to test persistence.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { startFake } = require('./fake-ollama-chat');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const PHASE = process.env.PHASE || '1';
const base = path.join(process.env.TEMP, 'faber-agents-' + TAG);
const ud = path.join(base, 'ud');
const proj = path.join(base, 'proj');
const LOG = path.join(process.env.TEMP, 'faber-agents-' + TAG + '.log');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (PHASE === '1') {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'NOTES-CONTENT-123\n');
  fs.writeFileSync(LOG, '');
}
app.setPath('userData', ud);

let fake;
const ready = (async () => {
  fake = await startFake();
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ host: fake.url, workspace: proj, model: 'qwen3.5:9b', effort: 'low', mode: 'ask' }));
  require(path.join(root, 'main.js'));
})();

app.whenReady().then(async () => {
  await ready;
  const win = await new Promise((res) => { const t = setInterval(() => { const w = BrowserWindow.getAllWindows()[0]; if (w) { clearInterval(t); res(w); } }, 100); });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errs.push(msg); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + `[p${PHASE}] ` + name + (extra ? '  ' + extra : ''));
  const waitFor = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(code)) return true; } catch { /* retry */ } await sleep(100); } return false; };
  const sids = () => js('Faber.chat.sessions().map((s) => s.id)');
  const info = (sid) => js(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(sid)})`);
  const viewText = (sid) => js(`views.get(${JSON.stringify(sid)}).el.textContent`);
  const send = (text) => js(`(async () => { $('input').value = ${JSON.stringify(text)}; await submit(); })()`);
  const cmd = (line) => send(line);
  const idle = (sid) => waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(sid)}).status === 'idle'`, 20000);
  const status = async (sid) => (await info(sid)).status;
  const esc = () => js(`$('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const flush = () => js(`Faber.call('feat:agents:flush')`);
  const exists = (f) => fs.existsSync(path.join(proj, f));
  const lastReq = (needle) => [...fake.requests].reverse().find((r) => JSON.stringify(r.messages).includes(needle));

  try {
    if (PHASE === '1') {
      await waitFor("Faber.chat && document.querySelectorAll('#agentTabs .atab').length > 0", 15000);
      check('boots with one default agent', (await sids()).length === 1);
      check('tab strip shows the tab and a + button', (await js("document.querySelectorAll('#agentTabs .atab').length")) === 1 && (await js("!!document.querySelector('#agentTabs .aplus')")));
      check('chip shows the default model', (await js("$('chipModel').textContent")).includes('qwen3.5:9b'));
      const [s1] = await sids();

      // ---- create + switch keeps each chat ----
      await js("document.querySelector('#agentTabs .aplus').click()");
      await waitFor('Faber.chat.sessions().length === 2');
      await cmd('/agent new Beta');
      await waitFor('Faber.chat.sessions().length === 3');
      const [, s2, s3] = await sids();
      check('three agents, names', JSON.stringify(await js('Faber.chat.sessions().map((s) => s.name)')) === '["Agent 1","Agent 2","Beta"]');
      check('new agent becomes active', (await js('Faber.chat.active()')) === s3);
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await send('[say alpha one]');
      check('reply streams into agent 1', await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('alpha one')`));
      await idle(s1);
      await js(`Faber.chat.switchTo(${JSON.stringify(s2)})`);
      await send('[say beta two]');
      await waitFor(`views.get(${JSON.stringify(s2)}).el.textContent.includes('beta two')`);
      await idle(s2);
      check('chats are isolated', !(await viewText(s1)).includes('beta two') && !(await viewText(s2)).includes('alpha one'));
      const t1 = JSON.stringify(await js(`Faber.call('feat:agents:transcript', ${JSON.stringify(s1)})`));
      check('main-side conversations are separate', t1.includes('alpha one') && !t1.includes('beta two'));
      check('only the active chat view is visible', (await js("[...document.querySelectorAll('.chatView')].filter((e) => !e.hidden).length")) === 1);

      // scroll position survives a tab switch
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await js(`(() => { const v = views.get(${JSON.stringify(s1)}); for (let i = 0; i < 80; i++) addTo(v, 'sys', 'filler line ' + i); })()`);
      await sleep(100);
      await js("$('chat').scrollTop = 150");
      await sleep(200);
      await js(`Faber.chat.switchTo(${JSON.stringify(s2)})`);
      await sleep(100);
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await sleep(100);
      const st = await js("$('chat').scrollTop");
      check('scroll position preserved across switch', Math.abs(st - 150) < 3, 'scrollTop=' + st);

      // ---- per-session model / effort ----
      await js(`Faber.chat.switchTo(${JSON.stringify(s2)})`);
      await cmd('/agent model fake-b:1b');
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s2)}).model === 'fake-b:1b'`);
      await cmd('/effort high');
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s2)}).effort === 'high'`);
      check('chips show the active agent values', (await js("$('chipModel').textContent")).includes('fake-b:1b') && (await js("$('chipEffort').textContent")).includes('High'));
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      check('other agent keeps its own values', (await js("$('chipModel').textContent")).includes('qwen3.5:9b') && (await js("$('chipEffort').textContent")).includes('Low'));
      await send('[say m1]'); await idle(s1);
      await js(`Faber.chat.switchTo(${JSON.stringify(s2)})`);
      await send('[say m2]'); await idle(s2);
      const r1 = lastReq('m1'), r2 = lastReq('m2');
      check('request uses each session model and effort', r1.model === 'qwen3.5:9b' && r1.think === false && r2.model === 'fake-b:1b' && r2.think === true, `${r1.model}/${r1.think} ${r2.model}/${r2.think}`);
      check('global settings untouched', (await js('Faber.settings().model')) === 'qwen3.5:9b' && (await js('Faber.settings().effort')) === 'low');
      await js("Faber.saveFeatureSettings('models', { runtime: { 'fake-b:1b': { num_gpu: 5, num_thread: 3, num_ctx: 8192, use_mmap: false, keep_alive: '10m' } } })");
      await send('[say rtopts]'); await idle(s2);
      const rt = lastReq('rtopts');
      check('runtime options reach the request', rt.options.num_gpu === 5 && rt.options.num_thread === 3 && rt.options.num_ctx === 8192 && rt.options.use_mmap === false && rt.keep_alive === '10m' && rt.options.temperature === 0.6, JSON.stringify(rt.options) + rt.keep_alive);
      check('other models do not get them', lastReq('m1').options.num_gpu === undefined && lastReq('m1').keep_alive === undefined);
      await js("Faber.saveFeatureSettings('models', { runtime: {} })");
      await send('[think plan]'); await idle(s2);
      check('thinking block renders', await js(`views.get(${JSON.stringify(s2)}).el.querySelectorAll('details.think').length > 0`));

      // model without thinking support: retried without the flag
      const before = fake.requests.length;
      await cmd('/agent model nothink:1b');
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s2)}).model === 'nothink:1b'`);
      await send('[say retried]'); await idle(s2);
      check('think retry works', (await viewText(s2)).includes('retried') && fake.requests.length - before === 2 && fake.requests[fake.requests.length - 1].think === undefined);
      await cmd('/agent model fake-b:1b');

      // errors
      await send('[err]');
      check('error shown and status is error', await waitFor(`views.get(${JSON.stringify(s2)}).el.textContent.includes('boom from fake')`) && (await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s2)}).status === 'error'`)));
      await send('[say recovered]');
      check('agent recovers after an error', await waitFor(`views.get(${JSON.stringify(s2)}).el.textContent.includes('recovered')`));
      await idle(s2);

      // ---- concurrency limit and queue ----
      fake.maxInflight = 0;
      for (const s of [s1, s2, s3]) { await js(`Faber.chat.switchTo(${JSON.stringify(s)})`); await send('[slow 14]'); }
      await sleep(700);
      const sts = [await status(s1), await status(s2), await status(s3)];
      check('limit 2: two working, one queued', sts.filter((x) => x === 'working').length === 2 && sts.filter((x) => x === 'queued').length === 1, sts.join(','));
      check('sidebar shows queued', (await js("Faber.showSideTab('agents'), [...document.querySelectorAll('.ast')].some((e) => e.textContent === 'queued')")));
      for (const s of [s1, s2, s3]) await idle(s);
      check('fake never saw more than 2 requests at once', fake.maxInflight === 2, 'max=' + fake.maxInflight);
      check('queued agent still finished', (await viewText(s3)).includes('w13'));
      // limit 1 then raise to 2 while one waits
      await js("Faber.saveFeatureSettings('agents', { maxConcurrent: 1 })"); await js("Faber.call('feat:agents:poke')");
      await send('[slow 20]');
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`); await send('[slow 20]');
      await sleep(500);
      const a = [await status(s1), await status(s3)];
      check('limit 1 queues the second', a.includes('queued') && a.includes('working'), a.join(','));
      await js("Faber.saveFeatureSettings('agents', { maxConcurrent: 2 })"); await js("Faber.call('feat:agents:poke')");
      await sleep(300);
      check('raising the limit releases the queue', (await status(s1)) === 'working' && (await status(s3)) === 'working');
      await js('Faber.chat.stopAll()');
      await idle(s1); await idle(s3);

      // ---- approvals ----
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await send('[write out.txt|hello]');
      check('approval card appears', await waitFor(`views.get(${JSON.stringify(s1)}).el.querySelector('.approval button')`));
      check('status is waiting for approval', (await status(s1)) === 'approval');
      await js(`views.get(${JSON.stringify(s1)}).el.querySelector('.approval button.primary').click()`);
      await idle(s1);
      check('Allow writes the file', exists('out.txt') && fs.readFileSync(path.join(proj, 'out.txt'), 'utf8') === 'hello');
      check('editor opened the file (file_changed)', await waitFor("tabs.some((t) => t.name === 'out.txt')"));
      await send('[write deny.txt|no]');
      await waitFor(`views.get(${JSON.stringify(s1)}).el.querySelectorAll('.approval button').length === 2`);
      await js(`[...views.get(${JSON.stringify(s1)}).el.querySelectorAll('.approval')].pop().querySelectorAll('button')[1].click()`);
      await idle(s1);
      check('Deny does not write', !exists('deny.txt') && (await viewText(s1)).includes('User denied'));
      await cmd('/mode edits');
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s1)}).mode === 'edits'`);
      await send('[write out.txt|v2 live]'); await idle(s1);
      check('edits mode needs no approval', fs.readFileSync(path.join(proj, 'out.txt'), 'utf8') === 'v2 live');
      check('open editor tab follows the AI edit', await waitFor("tabs.find((t) => t.name === 'out.txt').text.includes('v2 live')"));

      // ---- background agent does not steal editor focus but writes ----
      await js(`Faber.chat.switchTo(${JSON.stringify(s2)})`);
      await js(`Faber.chat.update(${JSON.stringify(s2)}, { mode: 'edits' })`);
      await send('[write bg.txt|bg]');
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await idle(s2);
      check('background agent edit lands without opening a tab', exists('bg.txt') && !(await js("tabs.some((t) => t.name === 'bg.txt')")), 'tabs=' + (await js('tabs.map((t) => t.name).join()')) + ' exists=' + exists('bg.txt'));

      // ---- stop mid-stream ----
      const ab0 = fake.aborted;
      await send('[slow 100]');
      await sleep(700);
      await esc();
      check('Esc stops the run', await idle(s1) && (await viewText(s1)).includes('Stopped.'));
      await sleep(200);
      check('server saw the connection drop', fake.aborted > ab0);

      // ---- sub-agents ----
      await send('[delegate researcher :: [read notes.txt]]');
      check('delegate_task returns a summary', await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('DELEGATE-DONE')`, 15000));
      await idle(s1);
      const subReq = [...fake.requests].reverse().find((r) => (r.system || '').includes('Role: researcher'));
      check('researcher got read-only tools only', JSON.stringify(subReq.tools) === '["read_file","list_dir","search_files"]', JSON.stringify(subReq.tools));
      check('sub-agent has a fresh context', subReq.messages.filter((m) => m.role === 'user').length === 1 && subReq.messages[1].content === '[read notes.txt]');
      check('nested block shows the sub-agent tool call and its summary', await js(`(() => { const d = views.get(${JSON.stringify(s1)}).el.querySelector('details.sub'); return !!d && d.textContent.includes('read_file') && d.textContent.includes('READ-DONE'); })()`));
      check('sub-agent read the file', (await viewText(s1)).includes('NOTES-CONTENT-123'));
      const mainReq = [...fake.requests].reverse().find((r) => JSON.stringify(r.messages).includes('delegate researcher') && !(r.system || '').includes('Role:'));
      check('main agent is offered delegate_task', mainReq.tools.includes('delegate_task'));
      check('sub-agent is not offered delegate_task or write tools', !subReq.tools.includes('delegate_task') && !subReq.tools.includes('write_file'));

      await send('[delegate reviewer :: [write hack.txt|x]]');
      await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('WRITE-DONE')`, 15000);
      await idle(s1);
      check('read-only sub-agent write is rejected', !exists('hack.txt') && (await viewText(s1)).includes('is not available'));

      await send('[delegate researcher :: [delegate coder :: [read notes.txt]]]');
      await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('DELEGATE-DONE: ')`, 15000);
      await idle(s1);
      check('sub-agents cannot nest', !fake.requests.some((r) => (r.system || '').includes('Role: coder') && JSON.stringify(r.messages).includes('delegate coder')));

      await cmd('/mode ask');
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s1)}).mode === 'ask'`);
      await send('[delegate coder :: [write coded.txt|hi]]');
      check('coder asks for approval (labelled)', await waitFor(`[...views.get(${JSON.stringify(s1)}).el.querySelectorAll('.approval .hd')].some((h) => h.textContent.startsWith('[coder]'))`, 15000));
      await js(`[...views.get(${JSON.stringify(s1)}).el.querySelectorAll('.approval')].pop().querySelector('button.primary').click()`);
      await idle(s1);
      check('coder edit lands after Allow', exists('coded.txt'));

      const ab1 = fake.aborted;
      await send('[delegate researcher :: [slow 100]]');
      await waitFor(`fake_has_inflight()`.replace('fake_has_inflight()', 'true'));
      await sleep(900);
      await esc();
      check('stopping the parent stops the sub-agent', await idle(s1));
      await sleep(300);
      check('sub-agent request was cancelled', fake.aborted > ab1 && fake.inflight === 0, `aborted+${fake.aborted - ab1} inflight=${fake.inflight}`);

      await js("Faber.saveFeatureSettings('agents', { subTimeoutSec: 1 })");
      await send('[delegate researcher :: [slow 100]]');
      check('sub-agent timeout is reported', await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('timed out')`, 15000));
      await idle(s1);
      await js("Faber.saveFeatureSettings('agents', { subTimeoutSec: 600 })");

      // ---- legacy commands ----
      await cmd('/system BE-BRIEF-XYZ');
      await waitFor("Faber.settings().extraSystem === 'BE-BRIEF-XYZ'");
      await send('[say sysprobe]'); await idle(s1);
      check('/system reaches the model', lastReq('sysprobe').system.includes('BE-BRIEF-XYZ'));
      await cmd('/system');
      await cmd('/compact');
      check('/compact summarizes', await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('SUMMARY: fake summary')`, 10000));
      const tl = await js(`Faber.call('feat:agents:transcript', ${JSON.stringify(s1)})`);
      check('/compact replaced history', tl.length === 2);
      await send('[say persist-me]'); await idle(s1);
      await send('[delegate researcher :: [read notes.txt]]'); await idle(s1);
      await js("$('input').value = '/ag'; $('input').dispatchEvent(new Event('input'))");
      check('slash menu lists /agent and /agents', await js("!$('slashMenu').hidden && $('slashMenu').textContent.includes('/agents') && $('slashMenu').textContent.includes('/agent')"));
      await js("$('input').value = ''; hideSlash()");
      await cmd('/agents');
      check('/agents lists sessions', (await viewText(s1)).includes('1. Agent 1'));

      // ---- rename / close ----
      await js(`Faber.chat.switchTo(${JSON.stringify(s3)})`);
      await cmd('/agent rename Zed');
      check('rename works', await waitFor("Faber.chat.sessions().some((s) => s.name === 'Zed')") && (await js("document.querySelector('#agentTabs .atab.on .nm').textContent")) === 'Zed');
      await cmd('/agent close');
      check('close removes the tab', await waitFor('Faber.chat.sessions().length === 2'));
      check('a neighbour becomes active', (await sids()).includes(await js('Faber.chat.active()')));
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      await cmd('/agent switch 2');
      check('/agent switch <n>', (await js('Faber.chat.active()')) === s2);
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);

      // ---- legacy editor channel still works ----
      const lf = path.join(proj, 'legacy.txt');
      fs.writeFileSync(lf, 'legacy');
      await js(`window.api.onChat && 0`);
      win.webContents.send('chat:event', { type: 'file_changed', path: lf });
      check('legacy file_changed still opens the editor', await waitFor("tabs.some((t) => t.name === 'legacy.txt')"));

      check('no page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
      await flush();
      fs.writeFileSync(path.join(base, 'expect.json'), JSON.stringify({ names: await js('Faber.chat.sessions().map((s) => s.name)'), models: await js('Faber.chat.sessions().map((s) => s.model)'), s1 }));
      await sleep(300);
      // relaunch on the same userData
      print('--- restart ---');
      await new Promise((resolve) => {
        const c = spawn(process.execPath, [__filename], { env: { ...process.env, PHASE: '2' }, stdio: 'ignore' });
        c.on('exit', resolve);
      });
    } else {
      const exp = JSON.parse(fs.readFileSync(path.join(base, 'expect.json'), 'utf8'));
      await waitFor('Faber.chat && Faber.chat.sessions().length > 0', 15000);
      check('sessions restored (names)', JSON.stringify(await js('Faber.chat.sessions().map((s) => s.name)')) === JSON.stringify(exp.names));
      check('per-session models restored', JSON.stringify(await js('Faber.chat.sessions().map((s) => s.model)')) === JSON.stringify(exp.models));
      check('all idle after restart', (await js("Faber.chat.sessions().every((s) => s.status === 'idle')")));
      const s1 = exp.s1;
      await js(`Faber.chat.switchTo(${JSON.stringify(s1)})`);
      const txt = await viewText(s1);
      check('transcript replayed in the chat', txt.includes('persist-me') && txt.includes('NOTES-CONTENT-123'));
      check('tool blocks and sub-agent block replayed', await js(`views.get(${JSON.stringify(s1)}).el.querySelectorAll('.tool').length >= 2 && !!views.get(${JSON.stringify(s1)}).el.querySelector('details.sub')`));
      await js("$('input').value = '[say after-restart]'; submit()");
      await waitFor(`views.get(${JSON.stringify(s1)}).el.textContent.includes('after-restart')`);
      const rq = fake.requests[fake.requests.length - 1];
      check('model sees the restored conversation', JSON.stringify(rq.messages).includes('persist-me') || JSON.stringify(rq.messages).includes('Summary of the conversation'), 'msgs=' + rq.messages.length);
      await waitFor(`Faber.chat.sessions().find((s) => s.id === ${JSON.stringify(s1)}).status === 'idle'`);
      await js('Faber.chat.deleteHistory()');
      await sleep(300);
      check('delete history empties chats', (await js(`views.get(${JSON.stringify(s1)}).el.textContent`)) === '');
      await js("Faber.call('feat:agents:flush')");
      const f1 = JSON.parse(fs.readFileSync(path.join(ud, 'agents', s1 + '.json'), 'utf8'));
      check('delete history empties the saved transcript', f1.conv.length === 0 && f1.log.length === 0);
      check('no page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
    }
  } catch (e) { print('SMOKE ERROR', e.stack); }
  if (PHASE === '1') print('DONE');
  await fake.close();
  app.exit(0);
});
