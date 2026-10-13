// Running a model efficiently on the CPU. Pure functions + two network helpers that only talk to the configured Ollama.
// Exports an object, not a function, so the feature loader never treats this file as a feature.
//
// What actually decides CPU speed (honest version):
//  * Generating a token reads (almost) the whole model from RAM, so speed is limited by MEMORY BANDWIDTH, not by clock
//    speed. Fewer bytes per weight = faster: Q4 beats Q8 by about 2x. That is why quantization is the biggest lever.
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

// lscpu (Linux): "Core(s) per socket", "Socket(s)", "Thread(s) per core", "Model name"
function parseLscpu(text) {
  const g = (re) => { const m = re.exec(text); return m ? m[1].trim() : ''; };
  const per = Number(g(/Core\(s\) per socket:\s*(\d+)/)), sock = Number(g(/Socket\(s\):\s*(\d+)/)) || 1, tpc = Number(g(/Thread\(s\) per core:\s*(\d+)/)) || 1;
  if (!per) return null;
  return { physical: per * sock, logical: per * sock * tpc, smt: tpc > 1, source: 'lscpu', model: g(/Model name:\s*(.+)/) };
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

/* ---------- speed estimate ---------- */
// tokens/s ~ usable memory bandwidth / bytes read per token. Usable bandwidth for a typical laptop or desktop: 25-50 GB/s.
function estimateTokPerSec(weightsBytes, bandwidthGBs = [25, 50]) {
  if (!weightsBytes) return null;
  const g = weightsBytes / GB;
  const r = (bw) => Math.round((bw / g) * 10) / 10;
  return { low: r(bandwidthGBs[0]), high: r(bandwidthGBs[1]) };
}

/* ---------- quantization advice ---------- */
const BITS = { F32: 32, F16: 16, BF16: 16, Q8_0: 8.5, Q6_K: 6.6, Q5_K_M: 5.7, Q5_K_S: 5.5, Q5_0: 5.5, Q4_K_M: 4.9, Q4_K_S: 4.6, Q4_0: 4.5, IQ4_XS: 4.3, Q3_K_M: 3.9, Q3_K_S: 3.5, Q2_K: 3.0 };
const bitsOf = (q) => { const k = String(q || '').toUpperCase().replace(/-/g, '_'); return BITS[k] || (/^F16|^BF16/.test(k) ? 16 : /^Q8/.test(k) ? 8.5 : /^Q6/.test(k) ? 6.6 : /^Q5/.test(k) ? 5.6 : /^Q4/.test(k) ? 4.8 : /^Q3/.test(k) ? 3.8 : /^Q2/.test(k) ? 3 : 0); };

// params in billions; returns what to do about the quantization the model already has.
function quantAdvice({ quant, paramsB, weights }) {
  const bits = bitsOf(quant);
  const size = (b) => (paramsB ? `about ${((paramsB * 1e9 * b) / 8 / GB).toFixed(1)} GB` : 'smaller');
  if (!bits) return { level: 'unknown', text: 'The quantization of this model is unknown. Check it with /model info; Q4_K_M is the usual best choice on a CPU.' };
  if (bits >= 8) return { level: 'slow', text: `${quant} is large for a CPU: every token reads ${weights ? (weights / GB).toFixed(1) + ' GB' : 'all the weights'}. A Q4_K_M version (${size(4.9)}) would generate roughly ${(bits / 4.9).toFixed(1)}x faster with a small quality loss.` };
  if (bits >= 5) return { level: 'ok', text: `${quant} is fine for quality but Q4_K_M (${size(4.9)}) would generate about ${(bits / 4.9).toFixed(1)}x faster.` };
  if (bits >= 4.2) return { level: 'best', text: `${quant} is the best size / quality / speed balance for a CPU. Nothing to change.` };
  return { level: 'fast', text: `${quant} is very small and fast, but quality drops noticeably. Use it only for simple jobs (for example as the fast helper model).` };
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
  const env = {
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
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
    OLLAMA_FLASH_ATTENTION: 'Cheaper attention, less memory at long contexts.',
    OLLAMA_KV_CACHE_TYPE: 'q8_0 halves the context memory (needs flash attention).',
    OLLAMA_NUM_PARALLEL: 'One request at a time: parallel requests multiply memory use and slow each other on a CPU.',
    OLLAMA_MAX_LOADED_MODELS: 'One model in RAM at a time. Several specialist models will take turns (a swap costs a few seconds each).',
  };
  const speed = estimateTokPerSec(weights);
  return {
    options, env, why, envWhy, warnings, speed,
    quant: quantAdvice({ quant: model.quant, paramsB: model.paramsB, weights }),
    cpu: { physical, logical: cpu.logical, smt: !!cpu.smt, source: cpu.source || '', model: cpu.model || '' },
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
async function benchmark({ host, model, options = {}, keepAlive = '30m', numPredict = 48, timeoutMs = 600000, fetchImpl, warm = true } = {}) {
  try {
    const opt = { ...options, temperature: 0 };
    let loadMs = 0;
    if (warm) {
      const w = await post(host, '/api/generate', { model, prompt: 'hi', stream: false, keep_alive: keepAlive, options: { ...opt, num_predict: 1 } }, timeoutMs, fetchImpl);
      loadMs = Math.round((w.load_duration || 0) / 1e6);
    }
    const t0 = Date.now();
    const j = await post(host, '/api/generate', { model, prompt: PROMPT, stream: false, keep_alive: keepAlive, options: { ...opt, num_predict: numPredict } }, timeoutMs, fetchImpl);
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

module.exports = { guessCores, parseLscpu, parseCim, estimateTokPerSec, quantAdvice, bitsOf, cpuProfile, envCommands, benchmark, autoTune, threadCandidates, GB };
