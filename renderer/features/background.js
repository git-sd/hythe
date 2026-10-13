/* feature: background. Silent periodic refresh of the file tree, the open editor tabs and the Ollama
   connection. One IPC call per round (feat:background:ping) returns Ollama state plus change signatures,
   and the core refreshTree() / syncFromDisk() / loadModels() only run when something actually changed. */
Faber.register('background', (F) => {
  const DEF = { enabled: true, interval: 5, whenUnfocused: false };
  let cfg = { ...DEF };
  let timer = null, running = false, started = false;
  let visible = document.visibilityState !== 'hidden';
  let focused = document.hasFocus();
  let ollama = null;                 // null = unknown, true = up, false = down
  let modelSig = null, models = [], host = '';
  let lastRun = 0, pings = 0, lastError = '';
  const fileSigs = new Map();        // tab path -> signature last synced
  let dirSigs = new Map();           // folder -> signature of its listing

  const sanitize = (r) => ({
    enabled: !r || r.enabled !== false,
    interval: Math.round(Math.min(60, Math.max(2, Number(r && r.interval) || DEF.interval))),
    whenUnfocused: !!(r && r.whenUnfocused),
  });
  const save = () => { try { Promise.resolve(F.saveFeatureSettings('background', cfg)).catch(() => {}); } catch { /* not ready */ } };

  /* ---- status chip in the bottom bar ---- */
  const chip = document.createElement('button');
  chip.className = 'chip bgStatus'; chip.id = 'bgStatus';
  chip.innerHTML = '<i class="dot"></i><span class="lbl"></span>';
  chip.onclick = () => F.openSettings('background');
  const bar = document.getElementById('bar');
  if (bar) bar.appendChild(chip);

  const clock = (t) => (t ? new Date(t).toLocaleTimeString() : 'not yet');
  function paint() {
    const state = !cfg.enabled ? 'off' : ollama === false ? 'down' : ollama === true ? 'ok' : 'unknown';
    chip.classList.toggle('ok', state === 'ok');
    chip.classList.toggle('down', state === 'down');
    chip.querySelector('.lbl').textContent = { off: 'Auto-refresh off', down: 'Ollama not running', ok: 'Ollama connected', unknown: 'Ollama...' }[state];
    chip.title = [
      state === 'ok' ? `Ollama is connected (${models.length} model${models.length === 1 ? '' : 's'}) at ${host}` : state === 'down' ? `Ollama is not reachable at ${host || 'its address'}. Retrying quietly.` : state === 'off' ? 'Background refresh is off.' : 'Checking Ollama',
      'Last refresh: ' + clock(lastRun),
      cfg.enabled ? `Refreshing every ${cfg.interval} s while the window is active. Click to change.` : 'Click to change.',
    ].join('\n');
  }

  /* ---- scheduling ---- */
  const active = () => cfg.enabled && visible && (focused || cfg.whenUnfocused);
  function schedule(ms) {
    clearTimeout(timer); timer = null;
    if (started && active()) timer = setTimeout(tick, ms === undefined ? cfg.interval * 1000 : ms);
  }
  async function tick() {
    timer = null;
    if (running || !active()) return;      // paused: resume() runs a refresh when the window is active again
    running = true;
    try { await refresh(); lastError = ''; } catch (e) { lastError = e.message || String(e); }
    running = false;
    paint();
    schedule();
  }
  function resume() { if (started && active()) { clearTimeout(timer); timer = null; tick(); } paint(); }

  /* ---- one refresh round ---- */
  async function refresh() {
    const ws = F.folder();
    const dirs = ws ? [ws, ...(typeof openDirs !== 'undefined' ? [...openDirs] : [])] : [];
    const paths = (typeof tabs !== 'undefined' ? tabs : []).map((t) => t.path);
    const r = await F.call('feat:background:ping', { paths, dirs });
    pings++;
    lastRun = Date.now();
    host = r.host || host;
    onOllama(r);

    // open editor tabs: re-read only files whose size/mtime changed (or that we have not checked yet)
    const open = new Set(paths);
    for (const p of [...fileSigs.keys()]) if (!open.has(p)) fileSigs.delete(p);
    for (const p of paths) {
      const sig = r.files && r.files[p];
      if (sig === undefined || sig === null) continue;                 // deleted: leave the tab as it is
      if (fileSigs.get(p) === sig) continue;
      fileSigs.set(p, sig);
      await syncFromDisk(p, false);                                    // never overwrites unsaved edits
    }

    // file tree: rebuild only when a folder we show has a different listing
    if (ws && r.dirs) {
      let changed = false;
      for (const [d, sig] of Object.entries(r.dirs)) if (dirSigs.has(d) && dirSigs.get(d) !== sig) changed = true;
      dirSigs = new Map(Object.entries(r.dirs));
      if (changed) await refreshTree();
    } else dirSigs = new Map();
  }

  function onOllama(r) {
    const was = ollama;
    ollama = !!r.up;
    if (r.up) {
      models = r.models || [];
      const sig = models.slice().sort().join('|');
      if (sig !== modelSig || was !== true) { modelSig = sig; Promise.resolve(loadModels()).catch(() => {}); }
      if (was === false) F.toast('Ollama is back. Connected.');
    } else if (was !== false) { modelSig = null; models = []; }
  }

  /* ---- window visibility / focus ---- */
  document.addEventListener('visibilitychange', () => { visible = document.visibilityState !== 'hidden'; if (visible) resume(); else { clearTimeout(timer); timer = null; paint(); } });
  window.addEventListener('focus', () => { focused = true; resume(); });
  window.addEventListener('blur', () => { focused = false; if (!active()) { clearTimeout(timer); timer = null; } });
  F.onEvent('folder', () => { dirSigs = new Map(); });

  /* ---- settings section ---- */
  function setCfg(patch) {
    cfg = sanitize({ ...cfg, ...patch });
    save();
    if (cfg.enabled) { if (!running) schedule(); } else { clearTimeout(timer); timer = null; }
    paint();
  }
  F.addSettingsSection({
    id: 'background', title: 'Background refresh',
    render(el) {
      const h = F.el('h2', '', 'Background refresh');
      h.style.margin = '0 0 6px';
      el.append(h);
      const row = (label, desc, ctl) => {
        const r = F.el('div', 'bgRow'), t = F.el('div', 't'), c = F.el('div', 'ctl');
        t.append(F.el('label', '', label)); if (desc) t.append(F.el('div', 'd', desc));
        c.append(ctl); r.append(t, c); el.append(r);
      };
      const sw = (label, value, on) => {
        const b = F.el('button', 'bgSw'); b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-label', label); b.setAttribute('aria-checked', !!value);
        b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', v); on(v); };
        return b;
      };
      row('Refresh automatically', 'Keeps the file tree, open editor tabs and the Ollama connection up to date without clicking Reload. Unsaved edits are never overwritten.', sw('Refresh automatically', cfg.enabled, (v) => setCfg({ enabled: v })));
      const w = F.el('div', 'ctl');
      const rg = F.el('input'); rg.type = 'range'; rg.min = 2; rg.max = 60; rg.value = cfg.interval; rg.setAttribute('aria-label', 'Refresh interval in seconds');
      const nb = F.el('input'); nb.type = 'number'; nb.min = 2; nb.max = 60; nb.value = cfg.interval; nb.setAttribute('aria-label', 'Refresh interval (number)');
      rg.oninput = () => { nb.value = rg.value; setCfg({ interval: Number(rg.value) }); };
      nb.onchange = () => { setCfg({ interval: Number(nb.value) }); nb.value = rg.value = cfg.interval; };
      w.append(rg, nb, F.el('span', 'muted', 's'));
      row('Interval', 'Between 2 and 60 seconds. Refreshing is cheap: nothing is redrawn unless something changed.', w);
      row('Keep refreshing when not focused', 'By default refreshing pauses while the window is hidden, minimised or in the background.', sw('Keep refreshing when not focused', cfg.whenUnfocused, (v) => setCfg({ whenUnfocused: v })));
      const now = F.el('button', '', 'Refresh now'); now.onclick = async () => { await refreshNow(); info(); };
      row('Refresh now', null, now);
      const inf = F.el('p', 'bgInfo'); inf.setAttribute('aria-live', 'polite');
      const info = () => { inf.textContent = chip.title; };
      el.append(inf); info();
    },
  });

  async function refreshNow() {
    if (running) return;
    running = true;
    try { await refresh(); lastError = ''; } catch (e) { lastError = e.message || String(e); }
    running = false;
    paint();
  }

  F.background = {
    refresh: refreshNow,
    configure: (patch) => setCfg(patch),
    state: () => ({ ollama, models: models.slice(), pings, lastRun, active: active(), running, lastError, cfg: { ...cfg } }),
  };
  if (F.addAction) F.addAction({ id: 'background-refresh', title: 'Refresh now', hint: 'Files, tabs and the Ollama connection', run: refreshNow });
  F.onEvent('ui-reset', () => { cfg = { ...DEF }; paint(); schedule(); });
  F.onEvent('ui-import', () => { cfg = sanitize(F.featureSettings('background')); paint(); schedule(); });

  paint();
  F.onReady(() => {
    cfg = sanitize(F.featureSettings('background'));
    started = true;
    paint();
    schedule(1500);
  });
});
