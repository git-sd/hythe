// CPU tuning: detection parsing, profile rules, quantization advice, benchmark + auto-tune against a fake Ollama whose
// speed depends on the thread count (so the tuner has something real to find). Not a real-hardware measurement.
const http = require('http');
const T = require('../src/cpu-tune');
const GB = T.GB;
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : '')); };

(async () => {
  /* ---- detection ---- */
  const cpus = (n, model) => Array.from({ length: n }, () => ({ model }));
  check('8 logical Intel threads -> 4 physical cores (SMT guess)', T.guessCores(cpus(8, 'Intel(R) Core(TM) i7')).physical === 4);
  check('Apple silicon: no SMT, all cores physical', T.guessCores(cpus(8, 'Apple M2')).physical === 8);
  check('odd or tiny counts are left alone', T.guessCores(cpus(3, 'Intel')).physical === 3 && T.guessCores(cpus(2, 'Intel')).physical === 2);
  const ls = T.parseLscpu('Model name:          AMD Ryzen 7 7840HS\nThread(s) per core:  2\nCore(s) per socket:  8\nSocket(s):           1\n');
  check('lscpu parsed', ls && ls.physical === 8 && ls.logical === 16 && ls.smt && /Ryzen/.test(ls.model), ls);
  check('lscpu garbage -> null', T.parseLscpu('nothing useful') === null);
  const cim = T.parseCim(JSON.stringify({ Name: 'Intel(R) Core(TM) i5-12500H', NumberOfCores: 12, NumberOfLogicalProcessors: 16 }));
  check('Windows CIM json parsed (single object)', cim && cim.physical === 12 && cim.logical === 16 && cim.smt, cim);
  check('Windows CIM json parsed (two sockets)', T.parseCim(JSON.stringify([{ NumberOfCores: 8, NumberOfLogicalProcessors: 16 }, { NumberOfCores: 8, NumberOfLogicalProcessors: 16 }])).physical === 16);
  check('CIM garbage -> null', T.parseCim('oops') === null);

  /* ---- quantization ---- */
  check('Q8_0 on a CPU without int8 instructions: flagged slower, with a pointer to measure', T.quantAdvice({ quant: 'Q8_0', paramsB: 9, weights: 9.5 * GB }).level === 'slow' && /Benchmark/.test(T.quantAdvice({ quant: 'Q8_0', paramsB: 9 }).text));
check('Q8_0 on a CPU WITH vnni/amx: not flagged slow, and says why (measured on a Xeon with AMX)', (() => { const a = T.quantAdvice({ quant: 'Q8_0', paramsB: 0.8, features: ['avx512', 'vnni', 'amx'] }); return a.level === 'ok' && /vnni, amx/.test(a.text) && /faster on small models/.test(a.text); })());
check('CPU feature flags are parsed from lscpu', (() => { const l = T.parseLscpu('Core(s) per socket: 4\nSocket(s): 1\nThread(s) per core: 1\nFlags: fpu avx2 avx512f avx512_vnni amx_int8 amx_bf16'); return l.features.join() === 'avx2,avx512,vnni,amx'; })());
  check('Q4_K_M is "best, nothing to change"', T.quantAdvice({ quant: 'Q4_K_M', paramsB: 9 }).level === 'best' && !/Q8_0/.test(T.quantAdvice({ quant: 'Q4_K_M', paramsB: 9 }).text));
  check('Q4_K_M on a CPU with vnni/amx mentions the measured Q8_0 advantage (4.8 vs 3.7 tokens/s) and the RAM cost', (() => { const a = T.quantAdvice({ quant: 'Q4_K_M', paramsB: 9, features: ['avx512', 'vnni', 'amx'] }); return a.level === 'best' && /4\.8 tokens\/s against 3\.7/.test(a.text) && /1\.7x the file size/.test(a.text); })());
  check('F16/BF16 is flagged slow (unquantized)', T.quantAdvice({ quant: 'F16', paramsB: 9, weights: 18 * GB }).level === 'slow' && T.quantAdvice({ quant: 'BF16', paramsB: 1 }).level === 'slow');
  check('Q2_K: fast but quality warning', T.quantAdvice({ quant: 'Q2_K' }).level === 'fast');
  check('unknown quant gives guidance, not a guess', T.quantAdvice({ quant: '' }).level === 'unknown');
  check('speed estimate: Q4 9B (6.6 GB) lands in a plausible CPU range, wide enough to include the measured 3.7-4.0 tokens/s of a 5.3 GB 9B on a 4-core server CPU', (() => { const e = T.estimateTokPerSec(6.6 * GB); return e.low >= 2 && e.low <= 3.7 && e.high >= 7 && e.high <= 9 && e.low < e.high; })());
  check('no weights -> no estimate', T.estimateTokPerSec(0) === null);

  /* ---- profile ---- */
  const lap = { cpu: { physical: 4, logical: 8, smt: true }, ram: { total: 15 * GB, free: 10 * GB }, model: { weights: 6.6 * GB, paramsB: 9, quant: 'Q4_K_M' } };
  const p = T.cpuProfile(lap);
  check('threads = physical cores on a 4-core machine', p.options.num_thread === 4);
  check('on 8+ physical cores one is left free', T.cpuProfile({ ...lap, cpu: { physical: 8, logical: 16, smt: true } }).options.num_thread === 7);
  check('CPU goal forces num_gpu 0, mmap on, keep_alive set', p.options.num_gpu === 0 && p.options.use_mmap === true && p.options.keep_alive === '30m');
  check('goal "auto" with a GPU does NOT force CPU-only', T.cpuProfile({ ...lap, goal: 'auto', hasGpu: true }).options.num_gpu === undefined);
  check('context shrinks when RAM is tight, with a warning when it still cannot fit', (() => { const t = T.cpuProfile({ ...lap, ram: { total: 8 * GB, free: 5 * GB } }); return t.options.num_ctx <= 4096 && t.warnings.length >= 1; })(), T.cpuProfile({ ...lap, ram: { total: 8 * GB, free: 5 * GB } }));
  check('plenty of RAM: 8192 context, no warnings', T.cpuProfile({ ...lap, ram: { total: 32 * GB, free: 24 * GB } }).options.num_ctx === 8192 && T.cpuProfile({ ...lap, ram: { total: 32 * GB, free: 24 * GB } }).warnings.length === 0);
  check('every option has a plain-language reason', ['num_thread', 'num_ctx', 'use_mmap', 'keep_alive'].every((k) => p.why[k] && p.why[k].length > 20));
  check('Ollama env: flash attention on, NO quantized KV cache when RAM is fine (it measured slower), every var has a reason', p.env.OLLAMA_FLASH_ATTENTION === '1' && p.env.OLLAMA_KV_CACHE_TYPE === undefined && p.env.OLLAMA_NUM_PARALLEL === '1' && Object.keys(p.env).every((k) => p.envWhy[k]));
const tightP = T.cpuProfile({ ...lap, ram: { total: 8 * GB, free: 7.2 * GB } });
check('KV cache q8_0 is recommended only when RAM is tight, with the speed cost stated', tightP.env.OLLAMA_KV_CACHE_TYPE === 'q8_0' && /SLOWER/.test(tightP.envWhy.OLLAMA_KV_CACHE_TYPE), tightP.env);
  check('env commands are pasteable PowerShell', /SetEnvironmentVariable\("OLLAMA_FLASH_ATTENTION", "1", "User"\)/.test(T.envCommands(p.env)));
  check('expected speed range is included and labelled by quant advice', p.speed && p.quant.level === 'best');

  /* ---- benchmark + auto-tune against a fake Ollama whose speed depends on num_thread ---- */
  const PHYS = 4;
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      calls.push(b);
      res.setHeader('content-type', 'application/json');
      if (b.model === 'ghost') { res.statusCode = 404; return res.end('{"error":"model \\"ghost\\" not found"}'); }
      if (b.model === 'slow') return;      // never answers
      const t = (b.options && b.options.num_thread) || PHYS;
      // up to the physical core count speed scales; hyper-threads hurt by 20%
      const speed = t <= PHYS ? 2 * t : 2 * PHYS * 0.8;
      const n = (b.options && b.options.num_predict) || 48;
      res.end(JSON.stringify({ response: 'x', done: true, load_duration: 3.2e9, prompt_eval_count: 30, prompt_eval_duration: 1.5e9, eval_count: n, eval_duration: (n / speed) * 1e9 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;

  const b1 = await T.benchmark({ host, model: 'm', options: { num_thread: 4 }, numPredict: 40 });
  check('benchmark returns tokens/s, prompt tokens/s and load time', b1.ok && b1.tokPerSec === 8 && b1.promptTokPerSec === 20 && b1.loadMs === 3200, b1);
  check('benchmark warms the model first (load time excluded from speed)', calls.length === 2 && calls[0].options.num_predict === 1 && calls[1].options.num_predict === 40);
  check('benchmark is deterministic (temperature 0) and sends the options', calls[1].options.temperature === 0 && calls[1].options.num_thread === 4 && calls[1].keep_alive === '30m');
  const b2 = await T.benchmark({ host, model: 'ghost' });
  check('missing model -> clear error, not a crash', !b2.ok && /not installed: ghost/.test(b2.error), b2);
  const b3 = await T.benchmark({ host: 'http://127.0.0.1:1', model: 'm' });
  check('Ollama not running -> clear error', !b3.ok && /Cannot reach Ollama/.test(b3.error), b3);
  const b4 = await T.benchmark({ host, model: 'slow', timeoutMs: 400 });
  check('a hung model times out with a readable message', !b4.ok && /longer than/.test(b4.error), b4);

  calls.length = 0;
  const progress = [];
  const tune = await T.autoTune({ host, model: 'm', cpu: { physical: PHYS, logical: 8 }, numPredict: 32, onProgress: (e) => progress.push(e.threads) });
  check('auto-tune tries a spread of thread counts', tune.table.length >= 4 && tune.table.map((t) => t.threads).join() === '2,3,4,6,8', tune.table.map((t) => t.threads));
  check('auto-tune finds the physical core count as best', tune.ok && tune.best.threads === 4 && tune.best.tokPerSec === 8, tune.best);
  check('hyper-thread counts measured slower (the tuner saw why)', tune.table.find((t) => t.threads === 8).tokPerSec < tune.table.find((t) => t.threads === 4).tokPerSec);
  check('progress callback fired for each candidate', progress.join() === '2,3,4,6,8');
  check('the model is only warmed once for the whole tuning run', calls.filter((c) => c.options.num_predict === 1).length === 1);
  check('gain vs the worst setting is reported', tune.gainVsWorst >= 100, tune.gainVsWorst);
  const tie = await T.autoTune({ host, model: 'm', cpu: { physical: 4, logical: 4 }, candidates: [3, 4], bench: async ({ options }) => ({ ok: true, tokPerSec: options.num_thread === 4 ? 10 : 9.8 }) });
  check('within 3% of the best: fewer threads preferred', tie.best.threads === 3, tie.best);
  const bad = await T.autoTune({ host, model: 'ghost', cpu: { physical: 4, logical: 8 } });
  check('auto-tune stops at the first failing measurement', !bad.ok && bad.table.length === 1);
  check('thread candidates stay within 1..logical and are sorted', (() => { const c = T.threadCandidates({ physical: 2, logical: 4 }); return c.every((n) => n >= 1 && n <= 4) && c.join() === [...c].sort((a, b) => a - b).join(); })());

  /* ---- how many models fit in RAM together (the roster) ---- */
  const rosterGB = [5.7, 2.7, 2.5, 0.5].map((x) => x * GB);
  check('maxLoadedModels: the real 16 GB roster (9B + 4B + 4B + 0.8B) fits two at a time', T.maxLoadedModels({ sizes: rosterGB, ramTotal: 15.7 * GB }).max === 2, T.maxLoadedModels({ sizes: rosterGB, ramTotal: 15.7 * GB }));
  check('maxLoadedModels: small RAM -> 1, never 0; big RAM -> all of them', T.maxLoadedModels({ sizes: rosterGB, ramTotal: 8 * GB }).max === 1 && T.maxLoadedModels({ sizes: rosterGB, ramTotal: 64 * GB }).max === 4 && T.maxLoadedModels({ sizes: [], ramTotal: 16 * GB }).max === 1);

  server.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
