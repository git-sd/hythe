// Running a model efficiently on the CPU. Pure functions + two network helpers that only talk to the configured Ollama.
// Exports an object, not a function, so the feature loader never treats this file as a feature.
//
// What actually decides CPU speed (honest version):
//  * Generating a token reads (almost) the whole model from RAM, so for BIG models speed is limited by MEMORY BANDWIDTH and
//    fewer bytes per weight = faster. But it depends on the CPU: on a processor with int8 instructions (AVX-512 VNNI / AMX)
//    a small model is limited by compute instead, and Q8_0 can be FASTER than Q4 (measured: 0.8B model, Q8_0 35 tokens/s vs
//    Q4_K_M 25 on a Xeon with AMX). So quantization advice is a starting point; benchmark() on your PC decides.
//  * llama.cpp (the engine inside Ollama) is fastest with one thread per PHYSICAL core. Using hyper-threads usually
//    makes it slower. Faber cannot know your core count exactly, so detectCpu() asks the OS and the benchmark verifies.
//  * Prompt processing (reading a long prompt) is compute-bound and slow on a CPU, so a smaller context and keeping the
//    model loaded (keep_alive) matter a lot for an agent that sends long prompts.
//  * Ollama's own environment variables (flash attention, KV-cache type, parallelism) are set outside Faber.
// Numbers below are ESTIMATES. benchmark() / autoTune() measure the real thing on this PC.
const GB = 1073741824;

/* ---------- CPU detection ---------- */
// os.cpus() lists LOGICAL processors. Hyper-threading / SMT doubles that on most Intel and AMD parts.
function guessCores(cpus) {
  const logical = Array.isArray(cpus) ? cpus.length : Number(cpus) || 1;
  const model = (Array.isArray(cpus) && cpus[0] && cpus[0].model) || '';
  const arm = /apple|\bM[1-9]\b|snapdragon|qualcomm|arm|graviton/i.test(model);
  if (arm || logical < 4 || logical % 2) return { logical, physical: logical, smt: false, source: 'guess', model };
  return { logical, physical: logical / 2, smt: true, source: 'guess', model };
}

// Instruction-set features that change how fast a quantization runs (from /proc/cpuinfo or lscpu flags).
function parseFeatures(flags) {
  const f = ' ' + String(flags || '').toLowerCase() + ' ';
  const has = (x) => f.includes(' ' + x + ' ');
  const out = [];
  if (has('avx2')) out.push('avx2');
  if (has('avx512f')) out.push('avx512');
  if (has('avx512_vnni') || has('avx_vnni')) out.push('vnni');
  if (has('amx_int8') || has('amx_bf16')) out.push('amx');
  if (has('neon') || has('asimd')) out.push('neon');
  return out;
}
// lscpu (Linux): "Core(s) per socket", "Socket(s)", "Thread(s) per core", "Model name"
function parseLscpu(text) {
  const g = (re) => { const m = re.exec(text); return m ? m[1].trim() : ''; };
  const per = Number(g(/Core\(s\) per socket:\s*(\d+)/)), sock = Number(g(/Socket\(s\):\s*(\d+)/)) || 1, tpc = Number(g(/Thread\(s\) per core:\s*(\d+)/)) || 1;
  if (!per) return null;
  return { physical: per * sock, logical: per * sock * tpc, smt: tpc > 1, source: 'lscpu', model: g(/Model name:\s*(.+)/), features: parseFeatures(g(/Flags:\s*(.+)/)) };
}
// Windows: Get-CimInstance Win32_Processor | Select Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json
function parseCim(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(j) ? j : [j];
  const cores = list.reduce((n, p) => n + (Number(p.NumberOfCores) || 0), 0);
  const logical = list.reduce((n, p) => n + (Number(p.NumberOfLogicalProcessors) || 0), 0);
  if (!cores || !logical) return null;
  return { physical: cores, logical, smt: logical > cores, source: 'windows', model: String((list[0] && list[0].Name) || '').trim() };
}

// Ask the OS for the real physical core count (PowerShell on Windows, lscpu on Linux); fall back to the guess.
function detectCpu({ os = require('os'), execFile = require('child_process').execFile, platform = process.platform } = {}) {
  const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 6000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))));
  return (async () => {
    let c = null;
    if (platform === 'win32') c = parseCim(await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress']));
    else if (platform === 'linux') c = parseLscpu(await run('lscpu', []));
    return c || guessCores(os.cpus());
  })();
}

/* ---------- speed estimate ---------- */
// tokens/s ~ usable memory bandwidth / bytes read per token. Usable bandwidth for a typical laptop or desktop: 25-50 GB/s.
// Rough only. Token speed on a CPU is about (memory bandwidth) / (model file size). Measured: a 9B Q4_K_M (5.3 GiB) ran at 3.7 to 4.0
// tokens/s on a 4-core 2.1 GHz server CPU, i.e. about 20 GiB/s effective, so the low end is 15, not the 25 a laptop might reach.
function estimateTokPerSec(weightsBytes, bandwidthGBs = [15, 50]) {
  if (!weightsBytes) return null;
  const g = weightsBytes / GB;
  const r = (bw) => Math.round((bw / g) * 10) / 10;
  return { low: r(bandwidthGBs[0]), high: r(bandwidthGBs[1]) };
}

/* ---------- quantization advice ---------- */
const BITS = { F32: 32, F16: 16, BF16: 16, Q8_0: 8.5, Q6_K: 6.6, Q5_K_M: 5.7, Q5_K_S: 5.5, Q5_0: 5.5, Q4_K_M: 4.9, Q4_K_S: 4.6, Q4_0: 4.5, IQ4_XS: 4.3, Q3_K_M: 3.9, Q3_K_S: 3.5, Q2_K: 3.0 };
const bitsOf = (q) => { const k = String(q || '').toUpperCase().replace(/-/g, '_'); return BITS[k] || (/^F16|^BF16/.test(k) ? 16 : /^Q8/.test(k) ? 8.5 : /^Q6/.test(k) ? 6.6 : /^Q5/.test(k) ? 5.6 : /^Q4/.test(k) ? 4.8 : /^Q3/.test(k) ? 3.8 : /^Q2/.test(k) ? 3 : 0); };

// params in billions; returns what to do about the quantization the model already has. This is advice from general rules;
// the measured numbers (benchmark) override it, and on CPUs with int8 instructions (vnni / amx) Q8_0 can win on small models.
function quantAdvice({ quant, paramsB, weights, features = [] }) {
  const bits = bitsOf(quant);
  const size = (b) => (paramsB ? `about ${((paramsB * 1e9 * b) / 8 / GB).toFixed(1)} GB` : 'smaller');
  const int8 = features.includes('vnni') || features.includes('amx');
  const measure = ' Compare variants on this PC with Benchmark (or "bench --models a,b").';
  if (!bits) return { level: 'unknown', text: 'The quantization of this model is unknown. Q4_K_M is the usual starting point on a CPU.' + measure };
  if (bits >= 12) return { level: 'slow', text: `${quant} is the unquantized size: every token reads ${weights ? (weights / GB).toFixed(1) + ' GB' : 'all the weights'}. It is almost always the slowest and uses the most memory. Q8_0 or Q4_K_M are much lighter (Q4_K_M ${size(4.9)}).` + measure };
  if (bits >= 8) return { level: int8 ? 'ok' : 'slow', text: `${quant} keeps the best quality. ${int8 ? 'This CPU has int8 instructions (' + features.filter((x) => x === 'vnni' || x === 'amx').join(', ') + '), so Q8_0 can be as fast as Q4 or faster on small models, but a big model is still limited by memory.' : 'On a CPU without int8 instructions it is usually slower than Q4 because it reads about twice the data.'} Q4_K_M would be ${size(4.9)}.` + measure };
  if (bits >= 5) return { level: 'ok', text: `${quant} is a quality-leaning choice. Q4_K_M (${size(4.9)}) is smaller and usually faster for big models.` + measure };
  if (bits >= 4.2) return { level: 'best', text: `${quant} is the usual best balance of size, quality and speed for a CPU, especially for larger models (memory-bound).${int8 ? ' Measured on a CPU with ' + features.filter((x) => x === 'vnni' || x === 'amx').join(' and ') + ': a 9B in Q8_0 wrote 4.8 tokens/s against 3.7 for Q4_K_M (+30%) at 1.7x the file size, so if you have the RAM it is worth a Benchmark here.' : ''}` + measure };
  return { level: 'fast', text: `${quant} is very small, but quality drops noticeably. Use it only for simple jobs (for example as the fast helper model).` + measure };
}

/* ---------- the profile ---------- */
// cpu: { logical, physical, smt }   ram: { total, free } (bytes)   model: { weights (bytes), paramsB, quant, kvPerTokenBytes? }
function cpuProfile({ cpu, ram, model, goal = 'cpu', hasGpu = false } = {}) {
  const warnings = [];
  const physical = Math.max(1, cpu.physical || cpu.logical || 1);
  const threads = physical >= 6 ? physical - 1 : physical;       // leave a core for the UI on bigger machines
  const weights = model.weights || 0;
  // context: a smaller window = less memory and a faster prompt pass. KV cache ~ 0.1 MB per token as a rough guess.
  const kvPerTok = model.kvPerTokenBytes || 0.12 * 1048576;
  const avail = ram.free * 0.9;
  let ctx = ram.total < 12 * GB || weights > ram.free * 0.55 ? 4096 : 8192;
  const need = (c) => weights + c * kvPerTok + 0.5 * GB;
  while (ctx > 2048 && need(ctx) > avail) ctx /= 2;
  if (need(ctx) > avail) warnings.push(`This model needs about ${(need(ctx) / GB).toFixed(1)} GB but only ${(ram.free / GB).toFixed(1)} GB of RAM is free. Close other programs or use a smaller model / quantization, or Windows will swap to disk and everything will crawl.`);
  const options = { num_thread: threads, num_ctx: ctx, use_mmap: true, keep_alive: '30m' };
  if (goal === 'cpu' || !hasGpu) options.num_gpu = 0;
  // Measured twice on a real 9B on a 4-core CPU (evidence/flash-attention-kv-cache.txt): flash attention made no difference to speed
  // (+4% in one run, -4% in the next: noise), and a q8_0 KV cache left writing speed alone but made reading the prompt 10 to 15% slower.
  // So flash attention is kept for its memory behaviour, and the quantized cache is only recommended when RAM is tight.
  const tight = need(ctx) > avail * 0.85;
  const env = {
    OLLAMA_FLASH_ATTENTION: '1',
    ...(tight ? { OLLAMA_KV_CACHE_TYPE: 'q8_0' } : {}),
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_MAX_LOADED_MODELS: '1',
  };
  const why = {
    num_thread: `${threads} threads: one per physical core${physical >= 6 ? ' minus one so Windows stays responsive' : ''}${cpu.smt ? '. Hyper-threads are left unused on purpose: they usually slow llama.cpp down' : ''}.`,
    num_ctx: `Context ${ctx.toLocaleString()} tokens keeps memory use and the prompt pass small. Raise it only if you need long files in one request.`,
    use_mmap: 'Memory-mapping lets Windows load the model file once and share it with the cache.',
    keep_alive: 'Keeps the model in RAM for 30 minutes so the next message does not wait for a reload (loading a big model takes many seconds).',
    num_gpu: options.num_gpu === 0 ? 'Forces CPU-only. Remove this if your graphics card can hold the whole model: a GPU is far faster.' : '',
  };
  const envWhy = {
    OLLAMA_FLASH_ATTENTION: 'Uses less memory as the context grows, and Ollama needs it for a quantized context cache. Measured: no change in speed on a CPU (within noise).',
    OLLAMA_KV_CACHE_TYPE: 'Halves the context memory, but reading your prompt measured 10 to 15% SLOWER (writing speed unchanged). Only recommended because RAM is tight here.',
    OLLAMA_NUM_PARALLEL: 'One request at a time: parallel requests multiply memory use and slow each other on a CPU.',
    OLLAMA_MAX_LOADED_MODELS: 'One model in RAM at a time. With several specialist models they take turns, and each swap costs about 10 to 30 seconds on a CPU (measured). Raise it to 2 to 4 for orchestrations if all those models fit in RAM.',
  };
  const speed = estimateTokPerSec(weights);
  return {
    options, env, why, envWhy, warnings, speed,
    quant: quantAdvice({ quant: model.quant, paramsB: model.paramsB, weights, features: cpu.features || [] }),
    cpu: { physical, logical: cpu.logical, smt: !!cpu.smt, source: cpu.source || '', model: cpu.model || '', features: cpu.features || [] },
    notes: [
      'Speed on a CPU is limited by memory bandwidth: faster RAM (dual channel, DDR5) helps more than a faster processor.',
      'The first message after a pause includes the model load time. With keep_alive it only happens once per session.',
    ],
  };
}

// PowerShell lines the user can paste to set Ollama's environment (the Ollama app must be restarted afterwards).
function envCommands(env) {
  return [
    '# Run in PowerShell, then quit Ollama from the tray icon and start it again:',
    ...Object.entries(env).map(([k, v]) => `[Environment]::SetEnvironmentVariable("${k}", "${v}", "User")`),
  ].join('\n');
}

/* ---------- measuring ---------- */
const PROMPT = 'Write the numbers from 1 to 60 separated by commas, then stop.';
async function post(host, url, body, timeoutMs, fetchImpl = fetch) {
  let res;
  try { res = await fetchImpl(`${host.replace(/\/+$/, '')}${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? `The model took longer than ${Math.round(timeoutMs / 1000)}s to answer.` : `Cannot reach Ollama at ${host}.`); }
  if (!res.ok) { let t = ''; try { t = await res.text(); } catch { /* ignore */ } throw new Error(/not found/i.test(t) ? `Model not installed: ${body.model}` : `Ollama error ${res.status}: ${t.slice(0, 200)}`); }
  return res.json();
}

// One measurement. The model is loaded first by a tiny warm-up call so the load time is reported separately.
async function benchmark({ host, model, options = {}, keepAlive = '30m', numPredict = 48, timeoutMs = 600000, fetchImpl, warm = true, prompt = PROMPT } = {}) {
  try {
    const opt = { ...options, temperature: 0 };
    let loadMs = 0;
    if (warm) {
      const w = await post(host, '/api/generate', { model, prompt: 'hi', stream: false, keep_alive: keepAlive, options: { ...opt, num_predict: 1 } }, timeoutMs, fetchImpl);
      loadMs = Math.round((w.load_duration || 0) / 1e6);
    }
    const t0 = Date.now();
    const j = await post(host, '/api/generate', { model, prompt, stream: false, keep_alive: keepAlive, options: { ...opt, num_predict: numPredict } }, timeoutMs, fetchImpl);
    const evalS = (j.eval_duration || 0) / 1e9, promptS = (j.prompt_eval_duration || 0) / 1e9;
    return {
      ok: true, model, options: { ...options },
      tokPerSec: evalS && j.eval_count ? Math.round((j.eval_count / evalS) * 100) / 100 : null,
      promptTokPerSec: promptS && j.prompt_eval_count ? Math.round((j.prompt_eval_count / promptS) * 10) / 10 : null,
      evalCount: j.eval_count || 0, loadMs, wallMs: Date.now() - t0,
    };
  } catch (e) { return { ok: false, model, error: e.message, options: { ...options } }; }
}

// Try several thread counts and keep the fastest. Candidates default to around the physical core count.
function threadCandidates(cpu) {
  const p = cpu.physical || 1, l = cpu.logical || p;
  const set = new Set([Math.max(1, Math.round(p / 2)), Math.max(1, p - 1), p, Math.min(l, p + Math.max(1, Math.round(p / 2))), l]);
  return [...set].filter((n) => n >= 1 && n <= l).sort((a, b) => a - b);
}
async function autoTune({ host, model, cpu, base = {}, candidates, numPredict = 48, onProgress, bench = benchmark, fetchImpl } = {}) {
  const list = candidates && candidates.length ? candidates : threadCandidates(cpu);
  const table = [];
  for (const n of list) {
    const r = await bench({ host, model, options: { ...base, num_thread: n }, numPredict, fetchImpl, warm: table.length === 0 });
    table.push({ threads: n, ...r });
    if (onProgress) { try { onProgress({ threads: n, result: r, done: table.length, total: list.length }); } catch { /* ignore */ } }
    if (!r.ok) return { ok: false, error: r.error, table };
  }
  const good = table.filter((t) => t.tokPerSec);
  if (!good.length) return { ok: false, error: 'No measurement produced a speed.', table };
  const top = Math.max(...good.map((t) => t.tokPerSec));
  // within 3% of the best: prefer fewer threads (cooler, quieter, leaves the UI responsive)
  const best = good.filter((t) => t.tokPerSec >= top * 0.97).sort((a, b) => a.threads - b.threads)[0];
  return { ok: true, best: { threads: best.threads, tokPerSec: best.tokPerSec }, table, gainVsWorst: Math.round((top / Math.min(...good.map((t) => t.tokPerSec)) - 1) * 100) };
}

// A prompt of roughly `tokens` tokens, for measuring how fast the model READS (an agent sends long prompts).
const longPrompt = (tokens) => Array.from({ length: Math.max(1, Math.round(tokens / 11)) }, (_, i) => `Item ${i}: the quick brown fox jumps over the lazy dog.`).join('\n') + '\n\nSay OK.';

// How many of these models can stay in RAM together? Each needs its file plus about 1 GB for the context and compute buffers, and the OS
// and the app need the rest, so the budget is 70% of total RAM. Largest first. An estimate: on a 16 GB PC an Ollama server with four
// models resident (11 GB of files) had its model runner killed by the system twice during a real orchestration run.
function maxLoadedModels({ sizes, ramTotal }) {
  const need = (sizes || []).filter((x) => x > 0).map((x) => x + 1 * GB).sort((a, b) => b - a);
  const budget = (ramTotal || 0) * 0.7;
  let used = 0, max = 0;
  for (const n of need) { if (used + n > budget) break; used += n; max++; }
  const total = need.reduce((a, b) => a + b, 0);
  return { max: Math.max(1, Math.min(max, need.length || 1)), budgetGB: +(budget / GB).toFixed(1), allGB: +(total / GB).toFixed(1), models: need.length };
}

module.exports = { longPrompt, parseFeatures, detectCpu, guessCores, parseLscpu, parseCim, estimateTokPerSec, quantAdvice, bitsOf, cpuProfile, envCommands, benchmark, autoTune, threadCandidates, maxLoadedModels, GB };
