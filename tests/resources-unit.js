// Pure-logic checks for the resources feature and the fit advisor, using the user's hardware as the scenario:
// 8 GB RTX 5050 laptop GPU, 15 GB RAM.
const R = require('../src/features/resources');
const fit = require('../src/features/models-fit');
const GB = fit.GB;
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };

const g = R.parseNvidiaSmi('NVIDIA GeForce RTX 5050 Laptop GPU, 8151, 1200, 37, 52\n');
check('nvidia-smi line parsed', g.length === 1 && g[0].name.includes('5050') && Math.round(g[0].total / 1048576) === 8151 && g[0].util === 37 && g[0].temp === 52, g);
check('garbage nvidia-smi output ignored', R.parseNvidiaSmi('No devices were found\n').length === 0 && R.parseNvidiaSmi('').length === 0);
check('two GPUs parsed', R.parseNvidiaSmi('A, 1000, 100, 1, 40\nB, 2000, 200, 2, 41').length === 2);

const cpus = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
check('cpu percent from two snapshots', R.cpuPercent(cpus(0, 0), cpus(50, 50)) === 50 && R.cpuPercent(cpus(0, 0), cpus(100, 0)) === 0);

check('runtime: valid values accepted', JSON.stringify(R.validateRuntime({ num_gpu: '20', num_thread: 6, num_ctx: 8192, use_mmap: false, keep_alive: '10m' }, 8)) === '{"num_gpu":20,"num_thread":6,"num_ctx":8192,"use_mmap":false,"keep_alive":"10m"}');
for (const [bad, why] of [[{ num_gpu: -1 }, 'negative gpu layers'], [{ num_gpu: 1.5 }, 'fractional'], [{ num_thread: 99 }, 'threads over 2x cores'], [{ num_ctx: 100 }, 'tiny ctx'], [{ keep_alive: 'soon' }, 'bad keep_alive'], [{ num_ctx: 'abc' }, 'non-numeric']]) {
  let threw = false; try { R.validateRuntime(bad, 8); } catch { threw = true; }
  check('runtime rejects ' + why, threw);
}
check('keep_alive -1 and 0 allowed as numbers', R.validateRuntime({ keep_alive: '-1' }, 8).keep_alive === -1 && R.validateRuntime({ keep_alive: '0' }, 8).keep_alive === 0);

// scenario hardware
const hw = { gpuFree: 7.2 * GB, gpuTotal: 8 * GB, ramFree: 9 * GB, ramTotal: 15 * GB };
const llama = (blocks, heads, kv, emb) => fit.parseArch({ 'general.architecture': 'llama', 'llama.block_count': blocks, 'llama.attention.head_count': heads, 'llama.attention.head_count_kv': kv, 'llama.embedding_length': emb, 'llama.context_length': 131072 });
const e9 = fit.estimate({ ...hw, weights: 5.5 * GB, arch: llama(32, 32, 8, 4096), ctx: 8192 });
check('9B Q4 at 8k context is (almost) all on the 8 GB GPU', (e9.verdict === 'gpu' || e9.verdict === 'split') && e9.gpuLayers >= 28, e9);
const e9s = fit.estimate({ ...hw, weights: 5.5 * GB, arch: llama(32, 32, 8, 4096), ctx: 4096 });
check('9B Q4 at 4k context fits fully on the GPU', e9s.verdict === 'gpu', e9s);
const e14 = fit.estimate({ ...hw, weights: 9 * GB, arch: llama(40, 40, 8, 5120), ctx: 8192 });
check('14B Q4 splits across GPU and CPU', e14.verdict === 'split' && e14.gpuLayers > 0 && e14.gpuLayers < 40, e14);
const e32 = fit.estimate({ ...hw, weights: 19 * GB, arch: llama(64, 40, 8, 5120), ctx: 8192 });
check('32B Q4 does not fit 8 GB GPU + 9 GB free RAM', e32.verdict === 'toobig', e32);
const e80 = fit.estimate({ ...hw, weights: 45 * GB, arch: llama(80, 64, 8, 8192), ctx: 8192 });
check('80B Q4 is flagged too big, honestly', e80.verdict === 'toobig' && /swap|too big/i.test(e80.text), e80);
const r = fit.recommend({ ...hw, weights: 9 * GB, arch: llama(40, 40, 8, 5120), ctx: 32768 });
check('advisor recommends fewer GPU layers than all and a safe context', r.num_gpu > 0 && r.num_gpu < 40 && r.num_ctx >= 2048, r);
const guard = fit.estimate({ ...hw, weights: 12 * GB, arch: llama(40, 40, 8, 5120), ctx: 8192, gpuLayers: 0 });
check('CPU-only 12 GB model on 15 GB RAM trips the 90% guard', guard.needsConfirm === true, guard);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
