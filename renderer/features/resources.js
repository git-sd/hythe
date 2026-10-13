/* feature: resources (renderer). A "Resources" view inside the Models tab: live CPU / RAM / GPU meters, what Ollama
   has loaded, a fit advisor for the installed models, GPU layers / threads / context controls, and a what-if
   calculator for models you do not have. All numbers are local; estimates are labelled as estimates. */
Faber.register('resources', (F) => {
  const { el } = F;
  const NS = 'feat:resources:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a);
  const GB = 1073741824;
  const gb = (n) => (n >= GB / 10 ? (n / GB).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB');
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 0);

  let box = null, timer = null, active = false;

  /* ---------- meters ---------- */
  function meter(label) {
    const row = el('div', 'rsRow');
    const name = el('span', 'rsName', label);
    const bar = el('div', 'rsBar');
    const fill = el('div', 'rsFill');
    bar.appendChild(fill);
    const val = el('span', 'rsVal', '...');
    row.append(name, val, bar);
    return { row, set(p, text) { fill.style.width = p + '%'; fill.classList.toggle('hot', p >= 90); val.textContent = text; }, hide(text) { fill.style.width = '0%'; val.textContent = text; } };
  }
  const M = {};
  let live = null, loadedBox = null, gpuNote = null;

  async function tick() {
    if (!active || !box || !box.isConnected) return stop();
    let s;
    try { s = await call('sample'); } catch (e) { return; }
    M.cpu.set(s.cpu, `${s.cpu}%  (${s.cores} threads)`);
    M.ram.set(pct(s.ram.total - s.ram.free, s.ram.total), `${gb(s.ram.total - s.ram.free)} of ${gb(s.ram.total)}`);
    const g = s.gpus && s.gpus[0];
    if (g) {
      M.gpu.set(g.util === null ? 0 : g.util, g.util === null ? 'n/a' : g.util + '%' + (g.temp !== null ? `  ${g.temp} C` : ''));
      M.vram.set(pct(g.used, g.total), `${gb(g.used)} of ${gb(g.total)}`);
      M.gpu.row.firstChild.textContent = 'GPU';
      gpuNote.textContent = g.name;
    } else {
      M.gpu.hide('not measured'); M.vram.hide('not measured');
      gpuNote.textContent = s.gpuNote || 'No GPU information.';
    }
    live.title = s.cpuModel;
    loadedBox.innerHTML = '';
    if (!s.ollama.up) loadedBox.appendChild(el('div', 'rsNote', 'Ollama is not reachable.'));
    else if (!s.ollama.models.length) loadedBox.appendChild(el('div', 'rsNote', 'No model is loaded in memory right now.'));
    for (const m of s.ollama.models) {
      const onGpu = pct(m.sizeVram, m.size);
      const r = el('div', 'rsLoaded');
      r.append(el('b', '', m.name), el('span', 'rsNote', `${gb(m.size)} in memory, ${onGpu}% on GPU, ${100 - onGpu}% on CPU/RAM` + (m.ctx ? `, context ${m.ctx.toLocaleString()}` : '')));
      const un = el('button', 'ghost', 'Unload');
      un.onclick = async () => { try { await F.call('feat:models:setLoaded', m.name, false); F.toast('Unloaded ' + m.name); } catch (e) { F.error(clean(e)); } tick(); };
      r.appendChild(un);
      loadedBox.appendChild(r);
    }
  }
  function start() { active = true; tick(); if (!timer) timer = setInterval(tick, 2000); }
  function stop() { active = false; if (timer) { clearInterval(timer); timer = null; } }

  /* ---------- fit advisor ---------- */
  function stackBar(e, ramFree) {
    const total = e.total || 1;
    const bar = el('div', 'rsStack');
    const seg = (cls, n, tip) => { if (n <= 0) return; const s = el('div', 'rsSeg ' + cls); s.style.flexGrow = String(n); s.title = tip; bar.appendChild(s); };
    const overflow = Math.min(e.ramBytes, Math.max(0, e.spill));
    seg('gpu', e.gpuBytes, 'On the GPU: ' + gb(e.gpuBytes));
    seg('ram', e.ramBytes - overflow, 'In system RAM: ' + gb(e.ramBytes - overflow));
    seg('over', overflow, 'Does not fit in RAM: ' + gb(overflow));
    void total; void ramFree;
    return bar;
  }

  function advisor(root) {
    const sel = el('select', 'rsSel');
    const ctxSel = el('select', 'rsSel');
    const kvSel = el('select', 'rsSel');
    for (const [v, t] of [['f16', 'KV cache: f16 (default)'], ['q8_0', 'KV cache: q8_0 (half the memory)']]) kvSel.appendChild(Object.assign(el('option', '', t), { value: v }));
    const top = el('div', 'rsRowWrap');
    top.append(sel, ctxSel, kvSel);
    const out = el('div', 'rsOut');
    root.append(top, out);
    let cur = null, gpuLayers, seq = 0, tmr = null;

    async function loadModels() {
      let r;
      try { r = await F.call('feat:models:list'); } catch { r = null; }
      const names = r && r.ok ? r.models.map((m) => m.name) : [];
      const keep = sel.value;
      sel.innerHTML = '';
      if (!names.length) sel.appendChild(Object.assign(el('option', '', 'No installed models'), { value: '' }));
      for (const n of names) sel.appendChild(Object.assign(el('option', '', n), { value: n }));
      sel.value = names.includes(keep) ? keep : (names.includes(F.settings().model) ? F.settings().model : names[0] || '');
      if (sel.value) run(true);
    }

    async function run(fresh) {
      const name = sel.value;
      if (!name) { out.textContent = ''; return; }
      const mine = ++seq;
      let a;
      try { a = await call('advise', name, { ctx: Number(ctxSel.value) || undefined, kvType: kvSel.value, gpuLayers }); }
      catch (e) { if (mine === seq) { out.innerHTML = ''; out.appendChild(el('div', 'rsBad', clean(e))); } return; }
      if (mine !== seq) return;
      cur = a;
      if (fresh || !ctxSel.options.length) {
        const want = (a.runtime && a.runtime.num_ctx) || a.recommended.num_ctx;
        ctxSel.innerHTML = '';
        for (const c of a.ctxSteps) ctxSel.appendChild(Object.assign(el('option', '', 'Context ' + c.toLocaleString()), { value: String(c) }));
        const near = a.ctxSteps.reduce((b, c) => (Math.abs(c - want) < Math.abs(b - want) ? c : b), a.ctxSteps[0]);
        ctxSel.value = String(near);
        if (fresh) { gpuLayers = (a.runtime && Number.isInteger(a.runtime.num_gpu)) ? a.runtime.num_gpu : undefined; if (Number(ctxSel.value) !== a.estimate.ctx) return run(false); }
      }
      draw(a);
    }

    function draw(a) {
      const e = a.estimate;
      out.innerHTML = '';
      const head = el('div', 'rsHead', `${a.model}  ${[a.params, a.quant].filter(Boolean).join('  ')}`);
      const lines = el('div', 'rsNote', `Weights ${gb(a.weights)}  +  context memory ${gb(e.kv)}  +  overhead ${gb(e.overhead)}  =  about ${gb(e.total)} (estimate)` + (a.approx ? '  (this model does not report its layout, so the context memory is a rough guess)' : ''));
      const verdict = el('div', 'rsVerdict ' + e.level, e.text);
      const legend = el('div', 'rsLegend');
      legend.append(el('span', 'rsDot gpu'), document.createTextNode(`GPU ${gb(e.gpuBytes)}   `), el('span', 'rsDot ram'), document.createTextNode(`RAM ${gb(Math.max(0, e.ramBytes - Math.max(0, e.spill)))}   `));
      if (e.spill > 0) legend.append(el('span', 'rsDot over'), document.createTextNode(`does not fit ${gb(e.spill)}`));
      out.append(head, lines, stackBar(e), legend, verdict);
      if (e.needsConfirm) out.appendChild(el('div', 'rsBad', e.guardText));
      out.appendChild(el('div', 'rsNote', `This PC: ${a.gpu ? `${a.gpu.name}, ${gb(a.gpu.total)} video memory (${gb(a.gpu.free)} free)` : 'no measurable NVIDIA GPU'}, ${gb(a.ram.total)} RAM (${gb(a.ram.free)} free). Estimates can be off by a gigabyte or more.`));

      // controls
      const ctl = el('div', 'rsCtl');
      const rt = a.runtime || {};
      const gl = Number.isInteger(gpuLayers) ? gpuLayers : e.gpuLayers;
      const layerRow = el('label', 'rsField');
      const lbl = el('span', '', `GPU layers: ${gl} of ${a.layers}`);
      const range = el('input'); range.type = 'range'; range.min = 0; range.max = a.layers; range.value = gl;
      range.oninput = () => { gpuLayers = Number(range.value); lbl.textContent = `GPU layers: ${gpuLayers} of ${a.layers}`; clearTimeout(tmr); tmr = setTimeout(() => run(false), 160); };
      layerRow.append(lbl, range);
      const thr = el('input'); thr.type = 'number'; thr.min = 1; thr.max = a.cores * 2; thr.placeholder = `auto (${a.cores} threads here)`; thr.value = rt.num_thread || '';
      const mm = el('input'); mm.type = 'checkbox'; mm.checked = rt.use_mmap !== false;
      const ka = el('input'); ka.type = 'text'; ka.placeholder = 'default (5m)'; ka.value = rt.keep_alive === undefined ? '' : String(rt.keep_alive);
      const field = (label, input) => { const l = el('label', 'rsField'); l.append(el('span', '', label), input); return l; };
      const mmRow = el('label', 'rsCheck'); mmRow.append(mm, el('span', '', 'Memory-map the model file (lets Windows share it with the cache)'));
      const btns = el('div', 'rsRowWrap');
      const rec = el('button', '', 'Use recommended');
      rec.title = 'All layers that fit on the GPU and the largest context that is safe for your RAM';
      rec.onclick = () => { gpuLayers = a.recommended.num_gpu; const near = a.ctxSteps.filter((c) => c <= (a.recommended.maxCtx || 2048)).pop() || a.ctxSteps[0]; ctxSel.value = String(near); run(false); };
      const save = el('button', 'primary', 'Save for this model');
      const reset = el('button', '', 'Reset to defaults');
      const msg = el('div', 'rsNote');
      const doSave = async (force) => {
        const patch = { num_gpu: gpuLayers === undefined ? e.gpuLayers : gpuLayers, num_ctx: Number(ctxSel.value), num_thread: thr.value === '' ? null : Number(thr.value), use_mmap: mm.checked, keep_alive: ka.value.trim() === '' ? null : ka.value.trim() };
        try {
          const r = await call('setRuntime', a.model, patch, !!force);
          if (r.needsConfirm) {
            F.modal({
              title: 'This may freeze your PC', body: (b) => { b.appendChild(el('p', '', r.warning)); b.appendChild(el('p', 'rsNote', 'Windows would swap memory to disk, which is extremely slow. Save anyway?')); },
              buttons: [{ label: 'Cancel' }, { label: 'Save anyway', primary: true, onClick: () => doSave(true) }],
            });
            return;
          }
          msg.textContent = 'Saved. It applies the next time the model is loaded (use Unload in the loaded list to reload it now).';
          F.toast('Saved settings for ' + a.model);
        } catch (er) { msg.textContent = clean(er); msg.className = 'rsBad'; }
      };
      save.onclick = () => doSave(false);
      reset.onclick = async () => { try { await call('clearRuntime', a.model); gpuLayers = undefined; F.toast('Back to defaults for ' + a.model); run(true); } catch (er) { F.error(clean(er)); } };
      btns.append(rec, save, reset);
      ctl.append(layerRow, field('CPU threads', thr), field('Keep loaded after use', ka), mmRow, btns, msg);
      if (Object.keys(rt).length) ctl.appendChild(el('div', 'rsNote', 'Saved for this model: ' + Object.entries(rt).map(([k, v]) => `${k}=${v}`).join(', ')));
      out.appendChild(ctl);
    }

    advisor.sel = sel;
    sel.onchange = () => { gpuLayers = undefined; ctxSel.innerHTML = ''; run(true); if (advisor.onPick) advisor.onPick(); };
    ctxSel.onchange = () => run(false);
    kvSel.onchange = () => run(false);
    advisor.reload = loadModels;
    loadModels();
  }

  /* ---------- what-if ---------- */
  function whatif(root) {
    const row = el('div', 'rsRowWrap');
    const b = el('input'); b.type = 'number'; b.min = 0.1; b.step = 'any'; b.value = 80; b.className = 'rsNum';
    const bits = el('select', 'rsSel');
    for (const [v, t] of [[4.5, '4-bit (Q4_K_M)'], [8.5, '8-bit (Q8_0)'], [16, '16-bit (full)'], [3.0, '3-bit (Q3)']]) bits.appendChild(Object.assign(el('option', '', t), { value: String(v) }));
    const go = el('button', '', 'Check');
    const out = el('div', 'rsOut');
    row.append(el('span', 'rsName', 'Model size (billions of parameters)'), b, bits, go);
    go.onclick = async () => {
      out.innerHTML = '';
      try {
        const r = await call('whatif', { billions: Number(b.value), bits: Number(bits.value), ctx: 8192 });
        out.append(el('div', 'rsNote', `About ${gb(r.weights)} of weights at ${bits.options[bits.selectedIndex].text}, 8k context (estimate).`), stackBar(r.estimate), el('div', 'rsVerdict ' + r.estimate.level, r.estimate.text));
      } catch (e) { out.appendChild(el('div', 'rsBad', clean(e))); }
    };
    root.append(row, out);
  }

  /* ---------- run it fast on the CPU ---------- */
  function copyText(text, label) {
    try { navigator.clipboard.writeText(text).then(() => F.toast(label + ' copied'), () => F.toast('Copy failed: select the text and press Ctrl+C')); } catch { F.toast('Copy failed: select the text and press Ctrl+C'); }
  }
  function cpuCard(root) {
    const bar = el('div', 'rsRowWrap');
    const show = el('button', 'primary', 'Show CPU profile');
    const bench = el('button', '', 'Benchmark');
    bench.title = 'Runs the model once to measure real speed (loads it into memory if needed)';
    const tuneB = el('button', '', 'Auto-tune threads');
    tuneB.title = 'Runs the model several times with different thread counts and keeps the fastest';
    bar.append(show, bench, tuneB);
    const out = el('div', 'rsOut');
    const res = el('div', 'rsOut');
    root.append(bar, out, res);
    const model = () => (advisor.sel ? advisor.sel.value : '');
    let cur = null;
    const busy = (b) => { show.disabled = bench.disabled = tuneB.disabled = b; };

    async function load() {
      const name = model();
      if (!name) { out.textContent = 'Pick an installed model in the advisor above first.'; return; }
      out.innerHTML = '';
      out.appendChild(el('div', 'rsNote', 'Looking at this PC...'));
      let r;
      try { r = await call('cpuProfile', name, {}); } catch (e) { out.innerHTML = ''; out.appendChild(el('div', 'rsBad', clean(e))); return; }
      cur = r;
      const p = r.profile;
      out.innerHTML = '';
      out.appendChild(el('div', 'rsNote', `CPU: ${p.cpu.model || 'unknown'}. ${p.cpu.physical} physical cores, ${p.cpu.logical} threads${p.cpu.smt ? ' (hyper-threading)' : ''}${p.cpu.features && p.cpu.features.length ? '; instruction sets: ' + p.cpu.features.join(', ') : ''}. ${p.cpu.source === 'guess' ? 'Core count is a guess: the benchmark below checks it.' : 'Detected from the system.'}`));
      out.appendChild(el('div', 'rsHead', `${r.model}  ${[r.params, r.quant].filter(Boolean).join('  ')}`));
      if (p.speed) out.appendChild(el('div', 'rsNote', `Expected on a typical CPU: about ${p.speed.low} to ${p.speed.high} tokens/s when writing (rough estimate from the model size; Benchmark shows the real number).`));
      out.appendChild(el('div', 'rsVerdict ' + (p.quant.level === 'slow' ? 'warn' : p.quant.level === 'best' ? 'ok' : ''), p.quant.text));
      for (const w of p.warnings) out.appendChild(el('div', 'rsBad', w));
      out.appendChild(el('b', '', 'Recommended settings for this model'));
      for (const [k, v] of Object.entries(p.options)) {
        const row = el('div', 'rsCpuRow');
        row.append(el('span', 'rsCpuKey', `${k} = ${v}`), el('span', 'rsNote', p.why[k] || ''));
        out.appendChild(row);
      }
      const act = el('div', 'rsRowWrap');
      const apply = el('button', 'primary', 'Apply these settings');
      apply.onclick = () => applyProfile(r.model, p.options, false);
      act.appendChild(apply);
      out.appendChild(act);
      out.appendChild(el('b', '', 'Ollama environment (set once, outside Faber)'));
      for (const [k, v] of Object.entries(p.env)) { const row = el('div', 'rsCpuRow'); row.append(el('span', 'rsCpuKey', `${k}=${v}`), el('span', 'rsNote', p.envWhy[k] || '')); out.appendChild(row); }
      const pre = el('pre', 'rsPre', r.envScript);
      const cp = el('button', '', 'Copy PowerShell commands');
      cp.onclick = () => copyText(r.envScript, 'Commands');
      out.append(pre, cp);
      for (const n of p.notes) out.appendChild(el('div', 'rsNote', n));
    }
    async function applyProfile(name, options, force) {
      try {
        const r = await call('setRuntime', name, options, !!force);
        if (r.needsConfirm) {
          F.modal({ title: 'This may freeze your PC', body: (b) => { b.appendChild(el('p', '', r.warning)); b.appendChild(el('p', 'rsNote', 'Save anyway?')); }, buttons: [{ label: 'Cancel' }, { label: 'Save anyway', primary: true, onClick: () => applyProfile(name, options, true) }] });
          return;
        }
        F.toast('Saved settings for ' + name + '. They apply the next time the model loads.');
      } catch (e) { F.error(clean(e)); }
    }
    const line = (r) => `${r.tokPerSec ? r.tokPerSec + ' tokens/s writing' : 'no speed'}${r.promptTokPerSec ? ', ' + r.promptTokPerSec + ' tokens/s reading the prompt' : ''}${r.loadMs ? ', load ' + (r.loadMs / 1000).toFixed(1) + 's' : ''}`;
    show.onclick = load;
    bench.onclick = async () => {
      const name = model();
      if (!name) return;
      busy(true); res.innerHTML = ''; res.appendChild(el('div', 'rsNote', 'Measuring... this loads the model and writes a short text.'));
      try { const r = await call('benchmark', name, {}); res.innerHTML = ''; res.appendChild(r.ok ? el('div', 'rsVerdict ok', `${name}: ${line(r)}`) : el('div', 'rsBad', r.error)); } catch (e) { res.innerHTML = ''; res.appendChild(el('div', 'rsBad', clean(e))); }
      busy(false);
    };
    F.on('feat:resources:tune', (e) => {
      if (!res.isConnected || !res.querySelector('.rsTune')) return;
      const t = res.querySelector('.rsTune');
      const row = el('div', 'rsCpuRow');
      row.append(el('span', 'rsCpuKey', `${e.threads} threads`), el('span', e.result.ok ? 'rsNote' : 'rsBad', e.result.ok ? line(e.result) : e.result.error));
      t.appendChild(row);
      res.querySelector('.rsTuneHead').textContent = `Measuring ${e.done} of ${e.total}...`;
    });
    tuneB.onclick = async () => {
      const name = model();
      if (!name) return;
      busy(true); res.innerHTML = '';
      res.append(el('div', 'rsNote rsTuneHead', 'Starting... (several runs, a minute or two on a CPU)'), el('div', 'rsTune'));
      try {
        const r = await call('autoTune', name);
        res.querySelector('.rsTuneHead').textContent = '';
        if (!r.ok) res.appendChild(el('div', 'rsBad', r.error));
        else {
          res.appendChild(el('div', 'rsVerdict ok', `Fastest: ${r.best.threads} threads at ${r.best.tokPerSec} tokens/s (${r.gainVsWorst}% faster than the slowest setting tried).`));
          const use = el('button', 'primary', `Use ${r.best.threads} threads for this model`);
          use.onclick = () => applyProfile(name, { num_thread: r.best.threads }, false);
          res.appendChild(use);
        }
      } catch (e) { res.querySelector('.rsTuneHead').textContent = ''; res.appendChild(el('div', 'rsBad', clean(e))); }
      busy(false);
    };
    advisor.onPick = () => { out.innerHTML = ''; res.innerHTML = ''; cur = null; };
    void cur;
  }

  /* ---------- view ---------- */
  function render(el0) {
    box = el0;
    const sec = (title, note) => { const s = el('div', 'rsSec'); s.appendChild(el('div', 'rsTitle', title)); if (note) s.appendChild(el('div', 'rsNote', note)); box.appendChild(s); return s; };
    const l = sec('This PC, right now');
    live = el('div', 'rsLive');
    M.cpu = meter('CPU'); M.ram = meter('RAM'); M.gpu = meter('GPU'); M.vram = meter('VRAM');
    live.append(M.cpu.row, M.ram.row, M.gpu.row, M.vram.row);
    gpuNote = el('div', 'rsNote');
    l.append(live, gpuNote);
    const lo = sec('Loaded in Ollama');
    loadedBox = el('div', 'rsLoadedBox');
    lo.appendChild(loadedBox);
    advisor(sec('Can this model run here?', 'Pick an installed model and a context size. Models that do not fit on the GPU can spill into system RAM (slower). Anything that does not fit in RAM either makes Windows swap to disk, which can freeze the PC.'));
    cpuCard(sec('Run it fast on the CPU', 'Most of the speed on a CPU comes from three things: a Q4 quantization, one thread per physical core, and a small context. This shows what to set for the model chosen above and can measure the real speed on this PC.'));
    whatif(sec('What if I wanted a bigger model?', 'Check a model you do not have. Honest answer for this kind of PC: small models run well, 14B-30B models run slowly with part on the CPU, and 70B+ models (for example 80B) will not run on a laptop with 8 GB video memory and 15 GB RAM.'));
  }
  function onShow() { start(); if (advisor.reload) advisor.reload(); }

  F.modelsViews = [...(F.modelsViews || []), { id: 'resources', title: 'Resources', render, onShow, onHide: stop }];
  F.onEvent('settings', () => {});
  F.addCommand('resources', '', 'Show CPU, RAM and GPU use and the model fit advisor', () => { F.showSideTab('models'); setTimeout(() => F.showModelsView && F.showModelsView('resources'), 50); });
});
