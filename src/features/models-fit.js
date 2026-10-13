// Memory fit advisor (pure functions, no I/O). Exports an object, not a function, so the feature loader skips it.
// Everything is an ESTIMATE: weights = file size, KV cache from the model's attention layout, plus fixed overhead.
const GB = 1073741824;
const KV_BYTES = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 };   // bytes per KV element
const CTX_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
const CPU_LAYER_COST = 8;        // a layer on the CPU takes about this many times longer than on the GPU
const OVERHEAD_BASE = 0.5 * GB;  // compute buffers, CUDA context etc.
const GPU_HEADROOM = 0.3 * GB;   // never plan to fill the card completely

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : null);

// Read what we need from /api/show model_info. Missing fields give approx:true.
function parseArch(info) {
  const mi = info || {};
  const a = mi['general.architecture'] || '';
  const g = (k) => mi[`${a}.${k}`];
  const blocks = num(g('block_count'));
  const headRaw = g('attention.head_count'), kvRaw = g('attention.head_count_kv');
  const maxOf = (v) => (arr(v) ? Math.max(0, ...v.map(num)) : num(v));
  const heads = maxOf(headRaw), kvHeads = maxOf(kvRaw) || heads;
  const emb = num(g('embedding_length'));
  const keyLen = num(g('attention.key_length')) || (heads && emb ? Math.floor(emb / heads) : 0);
  const valLen = num(g('attention.value_length')) || keyLen;
  let attnLayers = blocks;
  const rec = arr(g('attention.recurrent_layers'));
  const interval = num(g('full_attention_interval'));
  if (rec) attnLayers = rec.filter((x) => !x).length;
  else if (interval > 1 && blocks) attnLayers = Math.ceil(blocks / interval);
  const ok = !!(blocks && kvHeads && keyLen);
  return { arch: a, blocks, heads, kvHeads, keyLen, valLen, attnLayers, ctxMax: num(g('context_length')), params: num(mi['general.parameter_count']), approx: !ok };
}

// KV cache bytes for a context length.
function kvBytes(arch, ctx, kvType) {
  const b = KV_BYTES[kvType] || 2;
  if (arch.approx) return ctx * 131072 * (b / 2);   // generic guess: 128 KB per token at f16
  return ctx * arch.attnLayers * arch.kvHeads * (arch.keyLen + arch.valLen) * b;
}

/* Estimate one model.
   in: { weights, arch (parseArch), ctx, kvType, gpuFree (bytes or null=unknown), gpuTotal, ramFree, ramTotal,
         loadedGpu (bytes this model already holds on the GPU), loadedRam, gpuLayers (optional fixed num_gpu) } */
function estimate(i) {
  const W = i.weights || 0;
  const arch = i.arch || parseArch({});
  const kvType = KV_BYTES[i.kvType] ? i.kvType : 'f16';
  const ctx = Math.max(128, Math.floor(i.ctx || 4096));
  const kv = kvBytes(arch, ctx, kvType);
  const overhead = OVERHEAD_BASE + 0.03 * W;
  const total = W + kv + overhead;
  const L = arch.blocks || 32;
  const perLayer = (W + kv) / L;
  const gpuKnown = i.gpuFree !== null && i.gpuFree !== undefined;
  const gpuAvail = gpuKnown ? Math.max(0, i.gpuFree + (i.loadedGpu || 0) - GPU_HEADROOM - overhead) : 0;
  let layers = Math.min(L, Math.floor(gpuAvail / perLayer));
  if (Number.isInteger(i.gpuLayers) && i.gpuLayers >= 0) layers = Math.min(L, i.gpuLayers);
  const fullGpu = layers >= L && total <= (gpuKnown ? gpuAvail + overhead + 1 : 0);
  const gpuBytes = fullGpu ? total : layers * perLayer + (layers > 0 ? overhead : 0);
  const ramBytes = Math.max(0, total - gpuBytes);
  const ramFree = (i.ramFree || 0) + (i.loadedRam || 0);
  const spill = Math.max(0, ramBytes - ramFree * 0.92);
  const frac = layers / L;
  const slowdown = fullGpu ? 1 : Math.round((frac + (1 - frac) * CPU_LAYER_COST) * 10) / 10;
  const guard = ramBytes > 0.9 * (i.ramTotal || Infinity);

  let verdict, level, text;
  if (spill > 0) {
    verdict = 'toobig'; level = 'bad';
    text = `Too big: about ${(spill / GB).toFixed(1)} GB will not fit in RAM and Windows will swap to disk, which is extremely slow and can freeze the PC. Use a smaller quant or a shorter context.`;
  } else if (fullGpu) {
    verdict = 'gpu'; level = 'ok';
    text = 'Fits fully on the GPU.';
  } else if (layers > 0) {
    verdict = 'split'; level = 'warn';
    text = `Runs with ${layers} of ${L} layers on the GPU, the rest on the CPU: expect roughly ${slowdown}x slower than fully on the GPU.`;
  } else {
    verdict = 'cpu'; level = gpuKnown || i.ramTotal ? 'warn' : 'ok';
    text = gpuKnown ? `Does not fit on the GPU; runs on the CPU from system RAM: expect roughly ${CPU_LAYER_COST}x slower than on a GPU.`
      : 'GPU memory is unknown, so this assumes CPU only (system RAM). It may run faster if your GPU is used.';
  }
  return {
    weights: W, kv, overhead, total, ctx, kvType, layers: L, gpuLayers: fullGpu ? L : layers,
    gpuBytes, ramBytes, spill, verdict, level, text, slowdown, gpuKnown, approx: arch.approx,
    recNumGpu: fullGpu ? L : layers, needsConfirm: guard,
    guardText: guard ? `This setting needs about ${(ramBytes / GB).toFixed(1)} GB of system RAM, over 90% of the ${(i.ramTotal / GB).toFixed(1)} GB this PC has. It may freeze the computer.` : '',
  };
}

// Largest context from CTX_STEPS (up to the model's maximum) that still avoids spilling and the 90% guard.
function maxSafeCtx(i) {
  const cap = i.arch && i.arch.ctxMax ? i.arch.ctxMax : 131072;
  let best = 0;
  for (const c of CTX_STEPS) {
    if (c > cap) break;
    const r = estimate({ ...i, ctx: c, gpuLayers: undefined });
    if (r.verdict === 'toobig' || r.needsConfirm || r.ramBytes > (i.ramFree || 0) * 0.8 + (i.loadedRam || 0)) break;
    best = c;
  }
  return best;
}

// The advisor's recommended runtime settings: all layers that fit on the GPU and a context that is safe.
function recommend(i) {
  const safe = maxSafeCtx(i);
  const ctx = safe ? Math.min(i.ctx || safe, safe) : 2048;
  const r = estimate({ ...i, ctx, gpuLayers: undefined });
  return { num_gpu: r.recNumGpu, num_ctx: ctx, maxCtx: safe, estimate: r };
}

module.exports = { parseArch, kvBytes, estimate, maxSafeCtx, recommend, KV_BYTES, CTX_STEPS, GB };
