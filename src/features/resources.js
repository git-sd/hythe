// feature: resources (main process). Live CPU / RAM / GPU numbers, what Ollama has loaded, and the fit advisor
// (src/features/models-fit.js) wired to real model info, plus per-model runtime options (GPU layers, threads,
// context, mmap, keep_alive) saved to settings.features.models.runtime[model], which src/agent.js merges into requests.
// Everything is local: Ollama on the configured host and the system's own nvidia-smi. Nothing goes online.
// Channels: feat:resources:sample advise whatif getRuntime setRuntime clearRuntime
const { execFile } = require('child_process');
const fit = require('./models-fit');
const tune = require('../cpu-tune');

const GB = fit.GB;
const KEEP_RE = /^(-1|0|\d+(\.\d+)?(ms|s|m|h))$/;

// "name, total MiB, used MiB, util %, temp C" lines from nvidia-smi (csv, noheader, nounits)
function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = line.split(',').map((x) => x.trim());
    if (p.length < 3 || !p[0]) continue;
    const mib = (v) => (Number.isFinite(Number(v)) ? Number(v) * 1048576 : null);
    const total = mib(p[1]), used = mib(p[2]);
    if (total === null || used === null) continue;
    out.push({ name: p[0], total, used, free: Math.max(0, total - used), util: Number.isFinite(Number(p[3])) ? Number(p[3]) : null, temp: Number.isFinite(Number(p[4])) ? Number(p[4]) : null });
  }
  return out;
}

// CPU percentage from two os.cpus() snapshots
function cpuPercent(a, b) {
  let idle = 0, total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const t = (x) => Object.values(x.times).reduce((s, v) => s + v, 0);
    idle += b[i].times.idle - a[i].times.idle;
    total += t(b[i]) - t(a[i]);
  }
  return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
}

function validateRuntime(p, cores) {
  const out = {};
  const int = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };
  if (p.num_gpu !== undefined && p.num_gpu !== null && p.num_gpu !== '') out.num_gpu = int(p.num_gpu, 0, 999, 'GPU layers');
  if (p.num_thread !== undefined && p.num_thread !== null && p.num_thread !== '') out.num_thread = int(p.num_thread, 1, Math.max(2, cores * 2), 'Threads');
  if (p.num_ctx !== undefined && p.num_ctx !== null && p.num_ctx !== '') out.num_ctx = int(p.num_ctx, 512, 4194304, 'Context');
  if (p.use_mmap !== undefined && p.use_mmap !== null && p.use_mmap !== '') out.use_mmap = !!p.use_mmap;
  if (p.keep_alive !== undefined && p.keep_alive !== null && p.keep_alive !== '') {
    const k = String(p.keep_alive).trim();
    if (!KEEP_RE.test(k)) throw new Error('Keep loaded must look like 5m, 1h, 30s, 0 (unload now) or -1 (forever).');
    out.keep_alive = /^-?\d+$/.test(k) ? Number(k) : k;
  }
  return out;
}

module.exports = function (ctx) {
  const { os } = ctx;
  const host = () => String(ctx.getSettings().host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const j = async (p, opt = {}) => {
    const res = await fetch(host() + p, { ...opt, signal: AbortSignal.timeout(opt.timeout || 8000) });
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    return res.json();
  };

  /* ---------- sampling ---------- */
  let prevCpu = os.cpus();
  let gpuCache = { at: 0, gpus: null, note: '' };
  function readGpu() {
    return new Promise((resolve) => {
      if (Date.now() - gpuCache.at < 1500) return resolve(gpuCache);
      // a missing nvidia-smi is remembered for a minute so we do not spawn it again and again
      if (gpuCache.gpus === null && gpuCache.note && Date.now() - gpuCache.at < 60000) return resolve(gpuCache);
      execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) gpuCache = { at: Date.now(), gpus: null, note: err.code === 'ENOENT' ? 'nvidia-smi was not found. Only NVIDIA graphics cards are measured here (it ships with the NVIDIA driver).' : 'Could not read the GPU (' + String(err.message).split('\n')[0] + ').' };
        else { const g = parseNvidiaSmi(stdout); gpuCache = { at: Date.now(), gpus: g.length ? g : null, note: g.length ? '' : 'nvidia-smi returned no GPU.' }; }
        resolve(gpuCache);
      });
    });
  }
  async function ollamaPs() {
    try {
      const r = await j('/api/ps', { timeout: 3000 });
      return { up: true, models: (r.models || []).map((m) => ({ name: m.name, size: m.size || 0, sizeVram: m.size_vram || 0, expires: m.expires_at || '', ctx: m.context_length || 0 })) };
    } catch { return { up: false, models: [] }; }
  }
  async function sample() {
    const now = os.cpus();
    const cpu = cpuPercent(prevCpu, now);
    prevCpu = now;
    const [g, ps] = await Promise.all([readGpu(), ollamaPs()]);
    return {
      cpu, cores: now.length, cpuModel: (now[0] && now[0].model || '').trim(),
      ram: { total: os.totalmem(), free: os.freemem() },
      gpus: g.gpus, gpuNote: g.note, ollama: ps, at: Date.now(),
    };
  }

  /* ---------- advisor ---------- */
  const bigGpu = (gpus) => (gpus && gpus.length ? [...gpus].sort((a, b) => b.total - a.total)[0] : null);
  async function envFor(name) {
    const s = await sample();
    const g = bigGpu(s.gpus);
    const loaded = s.ollama.models.find((m) => m.name === name || m.name === name + ':latest');
    return {
      s, g,
      mem: {
        gpuFree: g ? g.free : null, gpuTotal: g ? g.total : 0, ramFree: s.ram.free, ramTotal: s.ram.total,
        loadedGpu: loaded ? loaded.sizeVram : 0, loadedRam: loaded ? Math.max(0, loaded.size - loaded.sizeVram) : 0,
      },
    };
  }
  async function modelFacts(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('Pick a model first.');
    const [show, tags] = await Promise.all([j('/api/show', { method: 'POST', body: JSON.stringify({ model: n }) }), j('/api/tags')]);
    const t = (tags.models || []).find((m) => m.name === n || m.name === n + ':latest');
    const arch = fit.parseArch(show.model_info);
    return { arch, weights: t ? t.size : 0, params: (show.details && show.details.parameter_size) || '', quant: (show.details && show.details.quantization_level) || '' };
  }
  function present(e) {
    return { ...e, text: e.text, warn: e.needsConfirm ? e.guardText : '' };
  }
  async function advise(name, opt = {}) {
    const f = await modelFacts(name);
    const { mem, s, g } = await envFor(name);
    const kvType = ['f16', 'q8_0', 'q4_0'].includes(opt.kvType) ? opt.kvType : 'f16';
    const base = { weights: f.weights, arch: f.arch, kvType, ...mem };
    const rec = fit.recommend({ ...base, ctx: Number(opt.ctx) || 8192 });
    const ctxNow = Number(opt.ctx) || rec.num_ctx;
    const gpuLayers = Number.isInteger(opt.gpuLayers) ? opt.gpuLayers : undefined;
    const est = fit.estimate({ ...base, ctx: ctxNow, gpuLayers });
    return {
      model: name, params: f.params, quant: f.quant, weights: f.weights, layers: f.arch.blocks || est.layers, ctxMax: f.arch.ctxMax,
      approx: f.arch.approx, ctxSteps: fit.CTX_STEPS.filter((c) => !f.arch.ctxMax || c <= f.arch.ctxMax),
      estimate: present(est), recommended: { num_gpu: rec.num_gpu, num_ctx: rec.num_ctx, maxCtx: rec.maxCtx },
      gpu: g ? { name: g.name, total: g.total, free: g.free } : null, ram: s.ram, cores: s.cores,
      runtime: (ctx.featureSettings('models').runtime || {})[name] || {},
    };
  }
  // What-if for a model that is not installed: parameter count in billions and bits per weight.
  function whatif(o = {}) {
    const b = Number(o.billions), bits = Number(o.bits) || 4.5;
    if (!(b > 0 && b < 5000)) throw new Error('Enter the model size in billions of parameters, for example 80.');
    const weights = b * 1e9 * bits / 8;
    return sample().then((s) => {
      const gg = bigGpu(s.gpus);
      const arch = { ...fit.parseArch({}), blocks: Math.max(24, Math.round(b ** 0.45 * 6)), approx: true };
      const e = fit.estimate({
        weights, arch, ctx: Number(o.ctx) || 8192, kvType: 'f16', gpuFree: gg ? gg.free : null, gpuTotal: gg ? gg.total : 0,
        ramFree: s.ram.free, ramTotal: s.ram.total,
      });
      return { weights, estimate: present(e), gpu: gg ? { name: gg.name, total: gg.total, free: gg.free } : null, ram: s.ram };
    });
  }

  /* ---------- CPU optimisation (src/cpu-tune.js) ---------- */
  let cpuCache = null;
  const detectCpu = async () => (cpuCache ||= await tune.detectCpu({ os }));
  async function cpuProfile(name, opt = {}) {
    const f = await modelFacts(name);
    const [cpu, s] = await Promise.all([detectCpu(), sample()]);
    const paramsB = parseFloat(f.params) || 0;
    const kv = f.arch && !f.arch.approx ? fit.kvBytes(f.arch, 1, 'f16') : 0;
    const profile = tune.cpuProfile({
      cpu, ram: { total: s.ram.total, free: s.ram.free }, goal: opt.goal === 'auto' ? 'auto' : 'cpu', hasGpu: !!(s.gpus && s.gpus.length),
      model: { weights: f.weights, paramsB, quant: f.quant, kvPerTokenBytes: kv },
    });
    return { model: name, params: f.params, quant: f.quant, weights: f.weights, profile, envScript: tune.envCommands(profile.env), saved: (ctx.featureSettings('models').runtime || {})[name] || {} };
  }
  let tuning = null;     // one measurement job at a time: they load the model and use every core
  async function benchmark(name, opt = {}) {
    if (tuning) throw new Error('A measurement is already running.');
    tuning = true;
    try {
      const saved = (ctx.featureSettings('models').runtime || {})[name] || {};
      const options = { ...saved };
      delete options.keep_alive;
      return await tune.benchmark({ host: host(), model: name, options: { ...options, ...(opt.options || {}) }, keepAlive: '30m', numPredict: 48 });
    } finally { tuning = null; }
  }
  async function autoTune(name) {
    if (tuning) throw new Error('A measurement is already running.');
    tuning = true;
    try {
      const cpu = await detectCpu();
      const saved = (ctx.featureSettings('models').runtime || {})[name] || {};
      const base = { ...saved }; delete base.keep_alive; delete base.num_thread;
      const r = await tune.autoTune({ host: host(), model: name, cpu, base, numPredict: 40, onProgress: (e) => ctx.send('feat:resources:tune', { model: name, threads: e.threads, result: e.result, done: e.done, total: e.total }) });
      return { ...r, cpu };
    } finally { tuning = null; }
  }

  /* ---------- runtime options ---------- */
  const runtimeAll = () => ({ ...((ctx.featureSettings('models') || {}).runtime || {}) });
  function writeRuntime(name, value) {
    const all = runtimeAll();
    if (value && Object.keys(value).length) all[name] = value; else delete all[name];
    ctx.setFeatureSettings('models', { runtime: all });
    return all[name] || {};
  }

  const H = ctx.handle;
  H('feat:resources:sample', () => sample());
  H('feat:resources:cpuInfo', () => detectCpu());
  H('feat:resources:cpuProfile', (name, opt) => cpuProfile(name, opt || {}));
  H('feat:resources:benchmark', (name, opt) => benchmark(name, opt || {}));
  H('feat:resources:autoTune', (name) => autoTune(name));
  H('feat:resources:advise', (name, opt) => advise(name, opt || {}));
  H('feat:resources:whatif', (o) => whatif(o));
  H('feat:resources:getRuntime', (name) => runtimeAll()[String(name)] || {});
  H('feat:resources:setRuntime', async (name, patch, force) => {
    name = String(name || '').trim();
    if (!name) throw new Error('Pick a model first.');
    const clean = validateRuntime(patch || {}, os.cpus().length);
    // refuse settings that would need over 90% of system RAM unless the user confirmed
    if (!force && clean.num_ctx !== undefined) {
      const a = await advise(name, { ctx: clean.num_ctx, gpuLayers: clean.num_gpu });
      if (a.estimate.needsConfirm || a.estimate.verdict === 'toobig') return { ok: false, needsConfirm: true, warning: a.estimate.guardText || a.estimate.text };
    }
    const merged = { ...(runtimeAll()[name] || {}), ...clean };
    for (const k of Object.keys(patch || {})) if (patch[k] === null || patch[k] === '') delete merged[k];
    return { ok: true, runtime: writeRuntime(name, merged) };
  });
  H('feat:resources:clearRuntime', (name) => { writeRuntime(String(name), null); return {}; });
};

module.exports.parseNvidiaSmi = parseNvidiaSmi;
module.exports.cpuPercent = cpuPercent;
module.exports.validateRuntime = validateRuntime;
