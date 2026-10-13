// feature: models (main process).
// Offline model manager. Everything here talks ONLY to the Ollama server in ctx.getSettings().host
// (normally http://127.0.0.1:11434). Nothing here downloads: pulling stays in main.js and is user-initiated.
// Channels (all "feat:models:*"): list show setLoaded copy delete modelfile create import checkGguf pickFile
// cancel quickTest quickStop. Events: feat:models:progress, feat:models:qt.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const NAME_HELP = 'Use lowercase letters, digits and . _ - (optionally with a :tag), for example my-coder or my-coder:v2.';
const API_CREATE_MIN = [0, 5, 5];   // first Ollama whose /api/create takes from/files/system/parameters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Modelfile PARAMETERs we accept: [type, min, max]
const PARAMS = {
  temperature: ['float', 0, 5], top_p: ['float', 0, 1], top_k: ['int', 0, 1000], min_p: ['float', 0, 1],
  num_ctx: ['int', 128, 4194304], num_predict: ['int', -2, 1000000], repeat_penalty: ['float', 0, 5],
  repeat_last_n: ['int', -1, 1000000], seed: ['int', 0, 2147483647],
  presence_penalty: ['float', -2, 2], frequency_penalty: ['float', -2, 2],
};

module.exports = function (ctx) {
  const { fs, path, os } = ctx;
  const host = () => String(ctx.getSettings().host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const fset = () => ctx.featureSettings('models') || {};
  const canon = (n) => (String(n).includes(':') ? String(n) : String(n) + ':latest');
  const memInfo = () => ({ free: os.freemem(), total: os.totalmem() });

  /* ---------- http to Ollama ---------- */
  function explain(msg) {
    const m = String(msg || '').trim();
    if (/invalid model name/i.test(m)) return `Ollama rejected the model name. ${NAME_HELP}`;
    if (/digest mismatch/i.test(m)) return 'The file was damaged while being sent to Ollama (digest mismatch). Try the import again.';
    if (/no space left|not enough space|disk full|ENOSPC/i.test(m)) return `${m} Free some disk space (Ollama keeps its models in its own folder) and try again.`;
    if (/invalid (file )?magic|not a gguf|bad magic|invalid gguf|unsupported gguf/i.test(m)) return `${m}. The file is not a valid GGUF model (it may be damaged or an incomplete download).`;
    if (/unknown (model )?architecture|unsupported (model )?architecture|unknown model format|failed to (decode|parse|load)/i.test(m)) return `${m}. This file may use a model type your Ollama version does not support (update Ollama) or be damaged.`;
    return m;
  }
  async function failure(res) {
    let text = '';
    try { text = await res.text(); } catch { /* body already gone */ }
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error || j.message || text; } catch { /* plain text error */ }
    const e = new Error(explain(msg) || `Ollama error ${res.status}`);
    e.status = res.status; e.raw = String(msg || '');
    return e;
  }
  // fetch with a timeout that only covers waiting for the response headers
  async function rawFetch(p, { method = 'GET', body, timeout = 10000, signal } = {}) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    let timedOut = false;
    const t = timeout ? setTimeout(() => { timedOut = true; ac.abort(); }, timeout) : null;
    try {
      return await fetch(host() + p, {
        method, signal: ac.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
      if (timedOut) throw new Error(`Ollama at ${host()} did not answer in ${Math.round(timeout / 1000)} s. It may still be starting; press Retry.`);
      throw new Error(`Cannot reach Ollama at ${host()}. Start the Ollama app (or run "ollama serve"), then press Retry.`);
    } finally { if (t) clearTimeout(t); }
  }
  async function req(p, opts) {
    const res = await rawFetch(p, opts);
    if (!res.ok) throw await failure(res);
    return res;
  }
  async function* ndjson(res) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { yield JSON.parse(line); } catch { /* ignore a garbled line */ } }
      }
    }
    if (buf.trim()) { try { yield JSON.parse(buf); } catch { /* ignore */ } }
  }

  const verOf = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
  function verLt(a, b) {
    const x = verOf(a), y = b;
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
    return false;
  }
  async function serverVersion() {
    try { return (await (await req('/api/version', { timeout: 2500 })).json()).version || ''; } catch { return ''; }
  }

  /* ---------- names, parameters, Modelfile ---------- */
  function checkName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw new Error('Enter a model name.');
    if (n.length > 120) throw new Error('That model name is too long (120 characters at most).');
    if (!NAME_RE.test(n)) throw new Error(`"${n}" is not a valid model name. ${NAME_HELP}`);
    return n;
  }
  function cleanParams(src) {
    const out = {};
    const p = src && typeof src === 'object' ? src : {};
    for (const [k, [type, lo, hi]] of Object.entries(PARAMS)) {
      const raw = p[k];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const v = Number(String(raw).trim());
      if (!Number.isFinite(v)) throw new Error(`${k} must be a number (got "${raw}").`);
      if (type === 'int' && !Number.isInteger(v)) throw new Error(`${k} must be a whole number (got "${raw}").`);
      if (v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi} (got ${v}).`);
      out[k] = v;
    }
    let stop = p.stop;
    if (typeof stop === 'string') stop = stop.split(/\r?\n/);
    if (Array.isArray(stop)) {
      stop = stop.map((s) => String(s)).filter((s) => s.trim() !== '');
      if (stop.length > 8) throw new Error('At most 8 stop sequences.');
      if (stop.some((s) => s.length > 100 || /["\r\n]/.test(s))) throw new Error('Stop sequences must be short and must not contain quotes or line breaks.');
      if (stop.length) out.stop = stop;
    }
    return out;
  }
  function cleanText(label, v, max) {
    const t = v == null ? '' : String(v).replace(/\r\n/g, '\n');
    if (t.length > max) throw new Error(`${label} is too long.`);
    if (t.includes('"""')) throw new Error(`${label} cannot contain three double quotes in a row ("""). Use single quotes inside it.`);
    return t.trim() ? t : '';
  }
  // Validate + normalise what the forms send. kind: 'variant' (FROM an installed model) or 'gguf'.
  function normalizeSpec(spec, kind) {
    if (!spec || typeof spec !== 'object') throw new Error('Missing model details.');
    const out = { name: checkName(spec.name) };
    if (kind === 'variant') {
      out.from = String(spec.from || '').trim();
      if (!out.from) throw new Error('Choose a base model.');
    }
    out.system = cleanText('The system prompt', spec.system, 60000);
    out.template = cleanText('The template', spec.template, 60000);
    out.parameters = cleanParams(spec.parameters);
    return out;
  }
  function buildModelfile(s, fromText) {
    const L = [`FROM ${fromText || s.from}`];
    if (s.template) L.push(`TEMPLATE """${s.template}"""`);
    if (s.system) L.push(`SYSTEM """${s.system}"""`);
    for (const [k, v] of Object.entries(s.parameters || {})) {
      if (k === 'stop') for (const x of v) L.push(`PARAMETER stop "${x}"`);
      else L.push(`PARAMETER ${k} ${v}`);
    }
    return L.join('\n') + '\n';
  }

  /* ---------- listing ---------- */
  const showCache = new Map();   // name@digest -> {caps, ctx}  (only used when /api/tags lacks them: older Ollama)
  async function fillFromShow(m) {
    const key = m.name + '@' + m.digest;
    if (!showCache.has(key)) {
      let val = { caps: null, ctx: 0 };
      try {
        const j = await (await req('/api/show', { method: 'POST', body: { model: m.name }, timeout: 8000 })).json();
        const info = j.model_info || {};
        const arch = info['general.architecture'];
        val = { caps: Array.isArray(j.capabilities) ? j.capabilities : null, ctx: Number(info[`${arch}.context_length`]) || 0 };
      } catch { /* leave unknown */ }
      showCache.set(key, val);
    }
    return showCache.get(key);
  }
  async function listModels() {
    const base = { host: host(), mem: memInfo() };
    let tags;
    try { tags = (await (await req('/api/tags', { timeout: 8000 })).json()).models || []; } catch (e) {
      return { ok: false, error: e.message, models: [], ...base };
    }
    let ps = [], psOk = true;
    try { ps = (await (await req('/api/ps', { timeout: 3000 })).json()).models || []; } catch { psOk = false; }
    const live = new Map(ps.map((p) => [p.name || p.model, p]));
    const models = tags.map((t) => {
      const d = t.details || {};
      const run = live.get(t.name) || live.get(t.model);
      return {
        name: t.name, size: t.size || 0, modified: t.modified_at || '', digest: t.digest || '',
        family: d.family || '', params: d.parameter_size || '', quant: d.quantization_level || '', format: d.format || '',
        parent: d.parent_model && !/\.gguf$/i.test(d.parent_model) ? d.parent_model : '',
        ctx: Number(d.context_length) || 0, caps: Array.isArray(t.capabilities) ? t.capabilities : null,
        loaded: !!run, expires: run ? run.expires_at || '' : '', vram: run ? run.size_vram || 0 : 0,
      };
    });
    // Older Ollama lacks capabilities / context in /api/tags: look them up once per model (cached, 4 at a time).
    const missing = models.filter((m) => !m.caps || !m.ctx);
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async (m) => {
        const v = await fillFromShow(m);
        if (!m.caps) m.caps = v.caps;
        if (!m.ctx) m.ctx = v.ctx;
      }));
    }
    // Disk use: variants and copies share their base weights, so count each digest once and skip variants of an installed base.
    const names = new Set(models.map((m) => canon(m.name)));
    const seen = new Set();
    let disk = 0, sum = 0;
    for (const m of models) {
      sum += m.size;
      if (seen.has(m.digest) || (m.parent && names.has(canon(m.parent)))) continue;
      seen.add(m.digest);
      disk += m.size;
    }
    return { ok: true, models, psOk, version: await serverVersion(), disk, sum, ...base };
  }
  async function installed() {
    const r = await listModels();
    if (!r.ok) throw new Error(r.error);
    return new Set(r.models.map((m) => canon(m.name)));
  }

  /* ---------- show ---------- */
  const parseParams = (txt) => String(txt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const i = l.search(/\s/); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i).trim()]; });
  async function showModel(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('Missing model name.');
    const j = await (await req('/api/show', { method: 'POST', body: { model: n }, timeout: 15000 })).json();
    const info = j.model_info || {};
    const arch = info['general.architecture'] || '';
    return {
      name: n, details: j.details || {}, caps: Array.isArray(j.capabilities) ? j.capabilities : null,
      parameters: parseParams(j.parameters), template: j.template || '', system: j.system || '', license: j.license || '',
      modelfile: String(j.modelfile || '').replace(/LICENSE\s+"""[\s\S]*?"""\s*/g, 'LICENSE (see License above)\n'),
      modified: j.modified_at || '', requires: j.requires || '',
      info: {
        arch, ctx: Number(info[`${arch}.context_length`]) || 0, embedding: Number(info[`${arch}.embedding_length`]) || 0,
        blocks: Number(info[`${arch}.block_count`]) || 0, paramCount: Number(info['general.parameter_count']) || 0,
      },
    };
  }

  /* ---------- simple actions ---------- */
  function keepAlive() {
    const k = String(fset().keepAlive == null ? '5m' : fset().keepAlive).trim();
    if (/^-?\d+$/.test(k)) return Number(k);
    return /^\d+(\.\d+)?(ms|s|m|h)$/.test(k) ? k : '5m';
  }
  async function setLoaded(name, on) {
    const n = String(name || '').trim();
    if (!n) throw new Error('Missing model name.');
    const ka = on ? keepAlive() : 0;
    try {
      await req('/api/generate', { method: 'POST', body: { model: n, keep_alive: ka, stream: false }, timeout: 300000 });
    } catch (e) {
      // embedding-only models cannot "generate"; loading them through /api/embed works
      if (!/embed|does not support|not support/i.test(e.message)) throw e;
      await req('/api/embed', { method: 'POST', body: { model: n, input: ' ', keep_alive: ka }, timeout: 300000 });
    }
    return true;
  }
  async function copyModel(src, dst) {
    const from = String(src || '').trim();
    const to = checkName(dst);
    if (!from) throw new Error('Missing source model.');
    if ((await installed()).has(canon(to))) throw new Error(`A model named "${to}" already exists. Choose another name.`);
    await req('/api/copy', { method: 'POST', body: { source: from, destination: to }, timeout: 30000 });
    return to;
  }
  async function deleteModel(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('Missing model name.');
    await req('/api/delete', { method: 'DELETE', body: { model: n }, timeout: 60000 });
    showCache.clear();
    return true;
  }

  /* ---------- create / import jobs (one at a time) ---------- */
  let job = null;   // {id, kind, ac, kill}
  const progress = (data) => ctx.send('feat:models:progress', { job: job ? job.id : '', kind: job ? job.kind : '', ...data });
  let lastSent = 0;
  const progressThrottled = (data) => { const t = Date.now(); if (t - lastSent > 150) { lastSent = t; progress(data); } };

  async function viaApi(payload) {
    const res = await req('/api/create', { method: 'POST', body: { ...payload, stream: true }, timeout: 30000, signal: job.ac.signal });
    let ok = false;
    for await (const j of ndjson(res)) {
      if (j.error) throw new Error(explain(j.error));
      if (j.status === 'success') ok = true;
      progressThrottled({ phase: 'create', status: j.status || '', completed: j.completed, total: j.total });
    }
    if (!ok) throw new Error('Ollama stopped before the model was created. Check that Ollama is still running and try again.');
  }
  function ollamaExe() {
    const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    return process.platform === 'win32' && fs.existsSync(local) ? local : 'ollama';
  }
  function viaCli(name, modelfile) {
    return new Promise((resolve, reject) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-modelfile-'));
      const file = path.join(dir, 'Modelfile');
      fs.writeFileSync(file, modelfile);
      const done = (err) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp only */ } err ? reject(err) : resolve(); };
      let p;
      try {
        p = spawn(ollamaExe(), ['create', name, '-f', file], { windowsHide: true, env: { ...process.env, OLLAMA_HOST: host() } });
      } catch (e) { return done(e); }
      job.kill = () => { try { p.kill(); } catch { /* gone */ } };
      const tail = [];
      let ok = false;
      const feed = (buf) => {
        for (const part of buf.toString().replace(ANSI, '').split(/[\r\n]+/)) {
          const t = part.trim();
          if (!t || /CHECK failed/i.test(t)) continue;
          if (/^success$/i.test(t)) ok = true;
          tail.push(t); if (tail.length > 6) tail.shift();
          progressThrottled({ phase: 'create', status: t });
        }
      };
      p.stdout.on('data', feed);
      p.stderr.on('data', feed);
      p.on('error', (e) => done(new Error(e.code === 'ENOENT' ? 'The "ollama" command was not found. Install Ollama or turn off "Use the ollama command" in Settings > Models.' : e.message)));
      p.on('close', (code) => {
        if (job.ac.signal.aborted) return done(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
        if (code === 0 && ok) return done();
        done(new Error(explain(tail.filter((l) => /error/i.test(l)).pop() || tail.pop() || `ollama create exited with code ${code}`).replace(/^Error:\s*/i, '')));
      });
    });
  }
  async function runJob(id, kind, work) {
    if (job) throw new Error('Another create or import is already running. Wait for it to finish or cancel it.');
    job = { id: String(id || Date.now()), kind, ac: new AbortController(), kill: null };
    try { return await work(); } catch (e) {
      throw e.name === 'AbortError' ? new Error('Cancelled.') : e;
    } finally { job = null; }
  }
  const useCli = async () => !!fset().useCli || verLt(await serverVersion() || '99.0.0', API_CREATE_MIN);

  async function createVariant(id, spec) {
    const s = normalizeSpec(spec, 'variant');
    return runJob(id, 'variant', async () => {
      const have = await installed();
      if (have.has(canon(s.name))) throw new Error(`A model named "${s.name}" already exists. Choose another name (creating over it would replace it).`);
      if (!have.has(canon(s.from))) throw new Error(`The base model "${s.from}" is not installed. Faber never downloads anything here; install it first (Download needs internet).`);
      progress({ phase: 'create', status: 'Starting' });
      if (await useCli()) await viaCli(s.name, buildModelfile(s));
      else await viaApi({ model: s.name, from: s.from, system: s.system || undefined, template: s.template || undefined, parameters: Object.keys(s.parameters).length ? s.parameters : undefined });
      return { name: s.name };
    });
  }

  /* ---------- GGUF import ---------- */
  function checkGguf(p0) {
    let p = String(p0 == null ? '' : p0).trim().replace(/^["']+|["']+$/g, '');
    if (!p) throw new Error('Choose a .gguf file first.');
    if (!path.isAbsolute(p)) throw new Error(`Enter the full path of the file (for example C:\\Models\\mymodel.gguf). "${p}" is not a full path.`);
    p = path.normalize(p);
    let st;
    try { st = fs.statSync(p); } catch (e) {
      throw new Error(e.code === 'ENOENT' ? `File not found: ${p}` : `Cannot read ${p}: ${e.message}`);
    }
    if (!st.isFile()) throw new Error(`${p} is a folder, not a file. Choose the .gguf file itself.`);
    const ext = path.extname(p).toLowerCase();
    if (ext !== '.gguf') throw new Error(`Only .gguf files can be imported (this one is "${ext || 'no extension'}"). Convert the model to GGUF first, for example with llama.cpp.`);
    if (/-\d{5}-of-\d{5}\.gguf$/i.test(p)) throw new Error('This is one part of a split GGUF. Merge the parts into a single file first (llama.cpp: llama-gguf-split --merge), then import that file.');
    if (st.size < 32) throw new Error('This file is too small to be a GGUF model.');
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(8);
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1', 0, 4) !== 'GGUF') throw new Error('This file does not start with the GGUF header, so it is not a GGUF model. It may be damaged, incomplete, or a different format renamed to .gguf.');
    const base = path.basename(p, path.extname(p)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-.]+$/g, '').slice(0, 80);
    return { ok: true, path: p, size: st.size, version: head.readUInt32LE(4), suggest: base || 'imported-model' };
  }
  function sha256File(file, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const total = fs.statSync(file).size;
      let done = 0;
      const rs = fs.createReadStream(file);
      const stop = () => { rs.destroy(); reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); };
      signal.addEventListener('abort', stop, { once: true });
      rs.on('data', (c) => { h.update(c); done += c.length; onProgress(done, total); });
      rs.on('error', reject);
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }
  async function blobExists(hex) {
    const res = await rawFetch(`/api/blobs/sha256:${hex}`, { method: 'HEAD', timeout: 8000 });
    return res.ok;
  }
  function uploadBlob(file, hex, size, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const u = new URL(`${host()}/api/blobs/sha256:${hex}`);
      const lib = u.protocol === 'https:' ? https : http;
      const r = lib.request(u, { method: 'POST', headers: { 'Content-Length': size, 'Content-Type': 'application/octet-stream' }, signal }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          let msg = body; try { msg = JSON.parse(body).error || body; } catch { /* plain */ }
          reject(new Error(explain(msg) || `Ollama refused the upload (HTTP ${res.statusCode}).`));
        });
      });
      r.on('error', (e) => reject(e.name === 'AbortError' || signal.aborted ? Object.assign(new Error('Cancelled.'), { name: 'AbortError' }) : new Error(`Upload to Ollama failed: ${e.message}`)));
      const rs = fs.createReadStream(file);
      let sent = 0;
      rs.on('data', (c) => { sent += c.length; onProgress(sent, size); });
      rs.on('error', (e) => r.destroy(e));
      rs.pipe(r);
    });
  }
  async function importGguf(id, spec) {
    const g = checkGguf(spec && spec.path);
    const s = normalizeSpec(spec, 'gguf');
    return runJob(id, 'import', async () => {
      if ((await installed()).has(canon(s.name))) throw new Error(`A model named "${s.name}" already exists. Choose another name.`);
      if (await useCli()) {
        progress({ phase: 'create', status: 'Sending the file to Ollama with the ollama command' });
        await viaCli(s.name, buildModelfile(s, g.path));
        return { name: s.name };
      }
      const hex = await sha256File(g.path, (d, t) => progressThrottled({ phase: 'hash', status: 'Checking the file', completed: d, total: t }), job.ac.signal);
      if (!(await blobExists(hex))) {
        await uploadBlob(g.path, hex, g.size, (d, t) => progressThrottled({ phase: 'upload', status: 'Sending the file to Ollama', completed: d, total: t }), job.ac.signal);
      }
      progress({ phase: 'create', status: 'Creating the model' });
      await viaApi({
        model: s.name, files: { [path.basename(g.path)]: `sha256:${hex}` },
        system: s.system || undefined, template: s.template || undefined,
        parameters: Object.keys(s.parameters).length ? s.parameters : undefined,
      });
      return { name: s.name };
    });
  }

  /* ---------- quick test ---------- */
  const tests = new Map();   // id -> AbortController
  async function quickTest(id, name, prompt) {
    const n = String(name || '').trim();
    const text = String(prompt || '').trim().slice(0, 2000);
    if (!n) throw new Error('Missing model name.');
    if (!text) throw new Error('Type a short prompt first.');
    const ac = new AbortController();
    tests.set(id, ac);
    const emit = (ev) => ctx.send('feat:models:qt', { id, ...ev });
    const t0 = Date.now();
    let first = 0, reply = '', chunks = 0, last = null;
    const body = {
      model: n, stream: true, think: false, keep_alive: keepAlive(),
      messages: [{ role: 'user', content: text }],
      options: { temperature: 0.2, num_predict: 64, num_ctx: Number(ctx.getSettings().numCtx) || 16384 },
    };
    try {
      let res;
      try { res = await req('/api/chat', { method: 'POST', body, timeout: 60000, signal: ac.signal }); } catch (e) {
        if (e.status === 400 && /think/i.test(e.raw || '')) { delete body.think; res = await req('/api/chat', { method: 'POST', body, timeout: 60000, signal: ac.signal }); } else throw e;
      }
      for await (const part of ndjson(res)) {
        if (part.error) throw new Error(explain(part.error));
        const m = part.message || {};
        const piece = m.content || '';
        if (piece || m.thinking) { if (!first) first = Date.now() - t0; chunks++; }
        if (piece) { reply += piece; emit({ type: 'token', text: piece }); }
        if (part.done) last = part;
      }
      const wall = Date.now() - t0;
      const evalNs = last && last.eval_duration, evalN = last && last.eval_count;
      const stats = {
        tokens: evalN || chunks, tps: evalNs && evalN ? Math.round((evalN / (evalNs / 1e9)) * 10) / 10 : 0,
        loadMs: last && last.load_duration ? Math.round(last.load_duration / 1e6) : 0,
        promptTokens: (last && last.prompt_eval_count) || 0, firstMs: first, totalMs: wall, reply, stopped: false,
      };
      emit({ type: 'done', stats });
      return stats;
    } catch (e) {
      if (e.name === 'AbortError' || ac.signal.aborted) {
        const stats = { tokens: chunks, tps: 0, loadMs: 0, promptTokens: 0, firstMs: first, totalMs: Date.now() - t0, reply, stopped: true };
        emit({ type: 'done', stats });
        return stats;
      }
      emit({ type: 'error', message: e.message });
      throw e;
    } finally { tests.delete(id); }
  }

  /* ---------- channels ---------- */
  const H = (name, fn) => ctx.handle('feat:models:' + name, fn);
  H('list', () => listModels());
  H('show', (name) => showModel(name));
  H('setLoaded', (name, on) => setLoaded(name, !!on));
  H('copy', (src, dst) => copyModel(src, dst));
  H('delete', (name) => deleteModel(name));
  H('modelfile', (spec, kind, fromPath) => {
    try {
      const s = normalizeSpec(spec, kind === 'gguf' ? 'gguf' : 'variant');
      return { text: buildModelfile(s, kind === 'gguf' ? String(fromPath || '<path to your .gguf>') : undefined) };
    } catch (e) { return { error: e.message }; }
  });
  H('create', (id, spec) => createVariant(id, spec));
  H('import', (id, spec) => importGguf(id, spec));
  H('checkGguf', (p) => {
    try { return checkGguf(p); } catch (e) { return { ok: false, error: e.message }; }
  });
  H('pickFile', async () => {
    const r = await ctx.dialog.showOpenDialog(ctx.window(), {
      title: 'Choose a GGUF model file', properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  H('cancel', () => { if (job) { job.ac.abort(); if (job.kill) job.kill(); } return !!job; });
  H('quickTest', (id, name, prompt) => quickTest(String(id), name, prompt));
  H('quickStop', (id) => { const ac = tests.get(String(id)); if (ac) ac.abort(); return !!ac; });
};
