// The transparent communication line: logging, structural request() guarantee, hash chain, tamper detection, file, format.
const fs = require('fs'), os = require('os'), path = require('path');
const { createLine, verify, GENESIS } = require('../src/comms');
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-comms-'));
  const file = path.join(dir, 't.jsonl');
  const echoed = [];
  const line = createLine({ file, echo: (s) => echoed.push(s), clip: 40 });
  line.startRun('unit');
  const a = { name: 'coder', model: 'm-coder', run: async (t) => `done: ${t}` };
  const b = { name: 'bad', model: 'm-bad', run: async () => { throw new Error('model crashed'); } };
  const c = { name: 'stopper', model: 'm-s', run: async () => ({ text: 'half', stopped: true }) };

  const r = await line.request('conductor', a, 'write fizzbuzz');
  check('request returns the agent reply', r === 'done: write fizzbuzz');
  let e1 = line.entries();
  check('task is logged BEFORE the reply (order)', e1[1].kind === 'task' && e1[2].kind === 'result' && e1[1].seq < e1[2].seq);
  check('task entry: sender, receiver, model, full text', e1[1].from === 'conductor' && e1[1].to === 'coder' && e1[1].model === 'm-coder' && e1[1].text === 'write fizzbuzz');
  check('result entry flows back to the requester with timing', e1[2].from === 'coder' && e1[2].to === 'conductor' && typeof e1[2].meta.ms === 'number');

  // the log happens even if delivery blows up
  const slowTask = { name: 'x', model: 'm', run: async (t) => { check('the task was already in the log when the agent started', line.entries().some((e) => e.kind === 'task' && e.to === 'x' && e.text === 'secret plan')); return 'ok'; } };
  await line.request('conductor', slowTask, 'secret plan');
  let threw = null;
  try { await line.request('conductor', b, 'boom'); } catch (e) { threw = e; }
  check('an agent that throws: error is rethrown and logged', threw && /model crashed/.test(threw.message) && line.entries().some((e) => e.kind === 'error' && e.from === 'bad' && /model crashed/.test(e.text)));
  await line.request('conductor', c, 'stop me');
  check('a stopped agent is logged as an error entry, partial text kept', line.entries().some((e) => e.kind === 'error' && e.from === 'stopper' && /half/.test(e.text)));

  // verify
  const all = line.entries();
  check('fresh chain verifies', line.verify().ok && line.verify().count === all.length);
  check('first entry anchors on the genesis hash', all[0].prev === GENESIS);
  const edit = JSON.parse(JSON.stringify(all)); edit[3].text = 'I never said that';
  const v1 = verify(edit);
  check('an edited entry is detected, with its number', !v1.ok && v1.brokenAt === edit[3].seq && /altered/.test(v1.reason), v1);
  const del = all.filter((_, i) => i !== 4);
  const v2 = verify(del);
  check('a deleted entry is detected', !v2.ok && /missing/.test(v2.reason), v2);
  const swap = all.slice(); [swap[2], swap[3]] = [swap[3], swap[2]];
  check('reordered entries are detected', !verify(swap).ok);
  const forged = JSON.parse(JSON.stringify(all)); forged[2].text = 'x'; forged[2].hash = require('../src/comms').hashOf(forged[2]);
  check('re-hashing a forged entry breaks the NEXT link', !verify(forged).ok && verify(forged).brokenAt === forged[3].seq, verify(forged));
  check('a window of the log verifies (older entries dropped from memory)', verify(all.slice(3)).ok);

  // file
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('every entry is in the JSONL file, in order', lines.length === all.length && lines.every((e, i) => e.seq === all[i].seq));
  check('the file alone verifies', verify(lines).ok);

  // formatting + echo
  check('echo printed every entry as it happened', echoed.length === all.length);
  const long = line.log({ from: 'a', to: 'b', kind: 'result', text: 'x'.repeat(200) });
  const short = line.format(long), full = line.format(long, { full: true });
  check('console format clips long bodies and says so', /\+160 chars/.test(short) && short.length < full.length);
  check('full format keeps everything', full.includes('x'.repeat(200)));
  check('format shows sequence, who -> whom, kind', /#\d{3} .*RESULT\s+a -> b/.test(short), short);
  const coloured = createLine({ color: true }).log({ from: 'a', kind: 'error', text: 'boom' });
  check('colour mode wraps in ANSI codes', /\x1b\[31m/.test(createLine({ color: true }).format(coloured)));

  // subscribers + summary
  const seen = [];
  const off = line.on((e) => seen.push(e.seq));
  line.log({ from: 'x', kind: 'usage', model: 'm1', meta: { prompt: 10, eval: 5 } });
  off();
  line.log({ from: 'x', kind: 'usage', model: 'm1', meta: { prompt: 1, eval: 1 } });
  check('subscribers get live entries until they unsubscribe', seen.length === 1);
  check('a throwing subscriber never breaks logging', (() => { const o = line.on(() => { throw new Error('viewer bug'); }); const n = line.count(); line.log({ from: 'x', text: 'still works' }); o(); return line.count() === n + 1; })());
  const sum = line.summary().find((s) => s.agent === 'x');
  check('summary counts tokens per agent', sum && sum.tokens === 17 && sum.models.includes('m1'), sum);
  let bad = false; try { line.log({ text: 'no sender' }); } catch { bad = true; }
  check('an entry without a sender is refused', bad);
  check('unknown kinds are stored as "system", not dropped', line.log({ from: 'q', kind: 'weird' }).kind === 'system');

  // memory window
  const small = createLine({ keep: 5 });
  for (let i = 0; i < 12; i++) small.log({ from: 'a', text: String(i) });
  check('memory keeps only the newest entries but the count is total', small.entries().length === 5 && small.count() === 12 && small.verify().ok);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
