/* feature: models. Offline model picker + manager. All data comes from the local Ollama via the main process.
   Provides Faber.pickModel(current, onPick), the bottom-bar model chip, /model, the Models sidebar tab,
   variant creation, GGUF import, quick test, and a Settings section. */
Faber.register('models', (F) => {
  const NS = 'feat:models:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a).catch((e) => { throw new Error(clean(e)); });
  const el = F.el;
  const $ = (id) => document.getElementById(id);
  const uid = () => 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
  const NAME_HELP = 'Lowercase letters, digits and . _ - (optional :tag), e.g. my-coder or my-coder:v2.';

  /* ---------- formatting ---------- */
  const GB = 1073741824;
  const fmtBytes = (n) => (n >= GB ? (n / GB).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB');
  const fmtCtx = (n) => (!n ? '' : n >= 1048576 ? Math.round(n / 1048576) + 'M' : n >= 1024 ? Math.round(n / 1024) + 'K' : String(n));
  function fmtAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 90) return 'just now';
    if (d < 5400) return Math.round(d / 60) + ' min ago';
    if (d < 129600) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 45) return Math.round(d / 86400) + ' days ago';
    return new Date(t).toISOString().slice(0, 10);
  }
  const hasCap = (m, c) => !!m.caps && m.caps.includes(c);
  const noTools = (m) => !!m.caps && !m.caps.includes('tools');
  const embedOnly = (m) => !!m.caps && m.caps.includes('embedding') && !m.caps.includes('completion');

  /* Estimate whether a model fits: file size x1.2 against free / total RAM. GPU memory is not considered. */
  function fitOf(m, mem) {
    if (m.loaded || !mem || !m.size) return null;
    const need = m.size * 1.2;
    const why = `Estimate only: needs about ${fmtBytes(need)} (file size x1.2); this PC has ${fmtBytes(mem.free)} free of ${fmtBytes(mem.total)} RAM. A graphics card can take part of the load, so this may be wrong.`;
    if (need > mem.total * 0.92) return { level: 'big', text: 'too big (est.)', title: why };
    if (need > mem.free) return { level: 'tight', text: 'tight on RAM (est.)', title: why };
    return null;
  }
  function badge(text, kind, title) {
    const b = el('span', 'mBadge ' + (kind || ''), text);
    if (title) b.title = title;
    return b;
  }
  function badgesFor(m, mem) {
    const out = [];
    if (m.online) { out.push(badge('online', 'online', 'Your prompts and file contents are sent to Anthropic over the internet')); out.push(badge('tools', '')); return out; }
    if (m.loaded) out.push(badge('loaded', 'ok', 'Currently loaded in memory'));
    if (m.caps === null) out.push(badge('capabilities unknown', 'dim'));
    else {
      if (embedOnly(m)) out.push(badge('embedding only', 'bad', 'Cannot chat'));
      else if (noTools(m)) out.push(badge('no tools', 'bad', "Faber's agent needs tool support to read/edit files and run commands"));
      else out.push(badge('tools', ''));
      if (hasCap(m, 'thinking')) out.push(badge('thinking', ''));
      if (hasCap(m, 'vision')) out.push(badge('vision', ''));
    }
    const f = fitOf(m, mem);
    if (f) out.push(badge(f.text, f.level === 'big' ? 'bad' : 'warn', f.title));
    return out;
  }
  function metaLine(m) {
    if (m.online) return `${m.note}  \u00b7  ${m.price} per million tokens (in / out)  \u00b7  needs your API key`;
    return [m.params && m.params + ' params', m.quant, m.family, m.ctx && fmtCtx(m.ctx) + ' ctx', fmtBytes(m.size), m.modified && fmtAgo(m.modified)]
      .filter(Boolean).join('  \u00b7  ');
  }

  /* ---------- feature settings ---------- */
  const fs = () => F.featureSettings('models');
  const favs = () => new Set(fs().favs || []);
  function toggleFav(name) {
    const s = favs();
    if (s.has(name)) s.delete(name); else s.add(name);
    F.saveFeatureSettings('models', { favs: [...s] });
    notify();
  }
  const defaultCtx = () => Number(fs().defaultCtx) || Number(F.settings().numCtx) || 16384;

  /* ---------- shared model list ---------- */
  const S = { data: null, loading: false, seq: 0, subs: new Set() };
  const notify = () => { for (const f of [...S.subs]) { try { f(); } catch (e) { console.error(e); } } };
  async function refresh() {
    const mine = ++S.seq;
    S.loading = true; notify();
    let d;
    try { d = await call('list'); } catch (e) { d = { ok: false, error: clean(e), models: [] }; }
    if (mine !== S.seq) return S.data;
    S.data = d; S.loading = false; notify();
    return d;
  }
  const models = () => (S.data && S.data.models) || [];
  const find = (name) => models().find((m) => m.name === name);

  /* one dispatcher per event channel (the bridge cannot remove listeners) */
  const progressH = new Map(), qtH = new Map();
  F.on(NS + 'progress', (ev) => { const h = progressH.get(ev.job); if (h) h(ev); });
  F.on(NS + 'qt', (ev) => { const h = qtH.get(ev.id); if (h) h(ev); });
  if (window.api && window.api.onPull) window.api.onPull((ev) => { if (pullH) pullH(ev); });
  let pullH = null;

  /* ---------- small dialog helpers ---------- */
  function onClosed(m, fn) {
    const back = m.el.closest('.modalBack');
    const mo = new MutationObserver(() => { if (!document.body.contains(back)) { mo.disconnect(); fn(); } });
    mo.observe(document.body, { childList: true });
  }
  function ask({ title, text, ok = 'OK', danger = false, body }) {
    return new Promise((resolve) => {
      let answered = false;
      const m = F.modal({
        title,
        body: (c) => { if (text) c.appendChild(el('p', 'mText', text)); if (body) body(c); },
        buttons: [{ label: 'Cancel' }, { label: ok, primary: true, onClick: () => { answered = true; resolve(true); } }],
      });
      if (danger) { const b = m.el.parentElement.querySelector('.modalFoot button.primary'); if (b) b.classList.add('danger'); }
      onClosed(m, () => { if (!answered) resolve(false); });
    });
  }
  function askText({ title, label, value = '', ok = 'OK', check }) {
    return new Promise((resolve) => {
      let input, msg, answered = false;
      const m = F.modal({
        title,
        body: (c) => {
          c.appendChild(el('label', 'mLabel', label));
          input = el('input', 'mWide');
          input.value = value; input.spellcheck = false;
          msg = el('div', 'mErr');
          c.append(input, msg);
          setTimeout(() => { input.focus(); input.select(); }, 0);
        },
        buttons: [{ label: 'Cancel' }, {
          label: ok, primary: true, close: false,
          onClick: (api) => {
            const v = input.value.trim();
            const bad = check && check(v);
            if (bad) { msg.textContent = bad; return; }
            answered = true; resolve(v); api.close();
          },
        }],
      });
      onClosed(m, () => { if (!answered) resolve(null); });
      setTimeout(() => input && input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.parentElement.querySelector('.modalFoot button.primary').click(); }), 0);
    });
  }
  const nameCheck = (v) => (!v ? 'Enter a name.' : v.length > 120 ? 'Name is too long.' : !NAME_RE.test(v) ? NAME_HELP : models().some((m) => m.name === v || m.name === v + ':latest') ? `"${v}" already exists.` : '');

  /* ---------- model actions shared by the picker and the manager ---------- */
  async function useModel(name) {
    await F.saveSettings({ model: name });
    F.toast('Model: ' + name);
    notify();
  }
  async function confirmUse(m) {
    if (embedOnly(m)) { F.toast(`${m.name} is an embedding model and cannot chat.`); return false; }
    if (noTools(m)) {
      const ok = await ask({ title: 'No tool support', text: `${m.name} does not report tool support. Faber's agent needs tools to read and edit files or run commands. Plain chat still works. Use it anyway?`, ok: 'Use anyway' });
      if (!ok) return false;
    }
    return true;
  }
  async function doCopy(m) {
    const to = await askText({ title: 'Copy model', label: `New name for a copy of ${m.name}`, value: m.name.replace(/:latest$/, '') + '-copy', ok: 'Copy', check: nameCheck });
    if (!to) return;
    try { const n = await call('copy', m.name, to); F.toast('Copied to ' + n); } catch (e) { F.error('Copy failed: ' + clean(e)); }
    refresh();
  }
  async function doDelete(m) {
    const active = F.settings().model === m.name;
    const ok = await ask({
      title: 'Delete model', danger: true, ok: 'Delete',
      text: `Delete ${m.name} (${fmtBytes(m.size)}) from this PC? This cannot be undone` + (active ? '. It is your active model; chat will fail until you pick another.' : '.') +
        ' Weights shared with other models (variants and copies) are kept until the last one is deleted.',
    });
    if (!ok) return;
    try { await call('delete', m.name); F.toast('Deleted ' + m.name); } catch (e) { F.error('Delete failed: ' + clean(e)); }
    refresh();
  }
  async function doLoad(m, btn) {
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = m.loaded ? 'Unloading...' : 'Loading...'; }
    try { await call('setLoaded', m.name, !m.loaded); F.toast(m.loaded ? 'Unloaded ' + m.name : 'Loaded ' + m.name); } catch (e) { F.error(clean(e)); }
    if (btn) { btn.disabled = false; btn.textContent = orig; }
    refresh();
  }

  /* ================== PICKER ================== */
  let picker = null;
  function pickModel(current, onPick) {
    if (picker) { try { picker.close(); } catch { /* already closed */ } }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (name) => {
        if (finished) return; finished = true;
        S.subs.delete(paint);
        if (name && onPick) { try { onPick(name); } catch (e) { console.error(e); } }
        resolve(name || null);
      };
      let sel = 0, rows = [], search, sortSel, list, msg, foot;
      const sortKey = () => sortSel.value;
      function visible() {
        const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        const fav = favs();
        const mem = S.data && S.data.mem;
        // online entries come from the claude feature, only while the user has turned it on
        const online = typeof F.claudeModels === 'function' ? F.claudeModels() : [];
        let out = models().concat(online).filter((m) => terms.every((t) => {
          if (t === 'tools') return hasCap(m, 'tools');
          if (t === 'loaded') return m.loaded;
          if (t === 'thinking' || t === 'vision') return hasCap(m, t);
          return [m.name, m.family, m.params, m.quant].join(' ').toLowerCase().includes(t);
        }));
        const k = sortKey();
        out.sort((a, b) => (fav.has(b.name) - fav.has(a.name)) ||
          (k === 'size' ? b.size - a.size : k === 'name' ? a.name.localeCompare(b.name) : (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0)));
        void mem;
        return out;
      }
      function paint() {
        if (!list || !list.isConnected) return;
        const d = S.data, mem = d && d.mem;
        rows = visible();
        list.innerHTML = '';
        msg.innerHTML = '';
        if (S.loading && !d) msg.appendChild(el('div', 'mNote', 'Loading models...'));
        if (d && !d.ok) {
          const e = el('div', 'mNote bad', d.error || 'Cannot reach Ollama.');
          const r = el('button', '', 'Retry');
          r.onclick = () => refresh();
          msg.append(e, r);
        } else if (d && !models().length) {
          msg.appendChild(el('div', 'mNote', 'No models are installed yet. Import a GGUF file or create a variant from the Models tab, or download one (needs internet).'));
        } else if (d && !rows.length) {
          msg.appendChild(el('div', 'mNote', 'No models match your search.'));
        }
        sel = Math.max(0, Math.min(sel, rows.length - 1));
        const fav = favs();
        rows.forEach((m, i) => {
          const row = el('div', 'mpRow' + (i === sel ? ' sel' : '') + (m.name === current ? ' cur' : ''));
          row.dataset.name = m.name;
          const star = el('button', 'ghost icon mStar' + (fav.has(m.name) ? ' on' : ''));
          star.title = fav.has(m.name) ? 'Unpin' : 'Pin to the top';
          star.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.3 4.1 13.5 5 9.1 1.7 6.1l4.4-.5z"/></svg>';
          star.onclick = (e) => { e.stopPropagation(); toggleFav(m.name); };
          const main = el('div', 'mpMain');
          const nm = el('div', 'mpName', m.online ? m.label : m.name);
          nm.title = m.name;
          if (m.name === current) nm.appendChild(el('span', 'mTag', 'current'));
          const meta = el('div', 'mpMeta', metaLine(m));
          const bs = el('div', 'mpBadges');
          for (const b of badgesFor(m, mem)) bs.appendChild(b);
          main.append(nm, meta, bs);
          const info = el('button', 'ghost', 'Info');
          info.onclick = (e) => { e.stopPropagation(); openInfo(m.name); };
          row.append(star, main);
          if (!m.online) row.append(info);
          row.onmousemove = () => { if (sel !== i) { sel = i; mark(); } };
          row.onclick = () => choose(m);
          list.appendChild(row);
        });
        const dsk = d && d.ok ? `${models().length} model${models().length === 1 ? '' : 's'}  \u00b7  ${fmtBytes(d.disk)} on disk  \u00b7  RAM free ${fmtBytes(mem.free)} of ${fmtBytes(mem.total)}  \u00b7  "est." labels are rough guesses from file size` : '';
        foot.textContent = dsk;
        mark();
      }
      function mark() {
        [...list.children].forEach((r, i) => { r.classList.toggle('sel', i === sel); if (i === sel) r.scrollIntoView({ block: 'nearest' }); });
      }
      async function choose(m) {
        if (!m) return;
        if (!(await confirmUse(m))) return;
        picker && picker.close();
        finish(m.name);
      }
      const m = F.modal({
        title: 'Choose a model', wide: true,
        body: (c) => {
          const top = el('div', 'mpTop');
          search = el('input', 'mpSearch');
          search.placeholder = 'Search (also: tools, loaded, thinking, vision, 9b, q4)';
          search.spellcheck = false;
          sortSel = el('select', 'mpSort');
          for (const [v, t] of [['recent', 'Sort: recent'], ['name', 'Sort: name'], ['size', 'Sort: size']]) sortSel.appendChild(Object.assign(el('option', '', t), { value: v }));
          const rf = el('button', '', 'Refresh');
          rf.onclick = () => refresh();
          top.append(search, sortSel, rf);
          msg = el('div', 'mpMsg');
          list = el('div', 'mpList');
          list.setAttribute('role', 'listbox');
          foot = el('div', 'mpFoot muted small');
          const act = el('div', 'mpActs');
          const manage = el('button', '', 'Manage models...');
          manage.onclick = () => { picker && picker.close(); openModelsTab(); };
          act.appendChild(manage);
          c.append(top, msg, list, foot, act);
          search.oninput = () => { sel = 0; paint(); };
          sortSel.onchange = paint;
          search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { sel = Math.min(rows.length - 1, sel + 1); mark(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
            else if (e.key === 'PageDown') { sel = Math.min(rows.length - 1, sel + 5); mark(); e.preventDefault(); }
            else if (e.key === 'PageUp') { sel = Math.max(0, sel - 5); mark(); e.preventDefault(); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(rows[sel]); }
          });
          S.subs.add(paint);
          setTimeout(() => search.focus(), 0);
        },
      });
      picker = m;
      m.el.classList.add('mp');
      onClosed(m, () => { if (picker === m) picker = null; finish(null); });
      // start on the current model
      refresh().then(() => { const i = visible().findIndex((x) => x.name === current); if (i >= 0) { sel = i; paint(); } });
      paint();
    });
  }
  F.pickModel = pickModel;

  /* bottom-bar chip: replace app.js's simple menu with the rich picker */
  const chip = $('chipModel');
  function takeChip() {
    if (!chip) return;
    chip.onclick = () => { pickModel(F.settings().model, (name) => { useModelQuiet(name); }); };
    chip.title = 'Choose a model (installed models, sizes, capabilities)';
  }
  async function useModelQuiet(name) { try { await useModel(name); } catch (e) { F.error(clean(e)); } }
  takeChip();
  F.onReady(takeChip);

  function openModelsTab() {
    const side = $('side');
    if (side && side.hidden) side.hidden = false;
    F.showSideTab('models');
  }

  /* ================== INFO ================== */
  function openInfo(name) {
    const m = F.modal({ title: 'Model info', wide: true, body: (c) => { c.classList.add('mi'); c.appendChild(el('div', 'mNote', 'Loading...')); } });
    const c = m.el;
    (async () => {
      let d, row = find(name);
      try {
        if (!S.data) await refresh();
        row = find(name) || row;
        d = await call('show', name);
      } catch (e) { c.innerHTML = ''; c.appendChild(el('div', 'mNote bad', 'Could not read this model: ' + clean(e))); return; }
      c.innerHTML = '';
      const mem = S.data && S.data.mem;
      const head = el('div', 'miHead');
      const t = el('div', 'miName', name);
      head.appendChild(t);
      const bs = el('div', 'mpBadges');
      if (row) for (const b of badgesFor(row, mem)) bs.appendChild(b);
      head.appendChild(bs);
      const use = el('button', 'primary', F.settings().model === name ? 'Current model' : 'Use this model');
      use.disabled = F.settings().model === name;
      use.onclick = async () => { if (row && !(await confirmUse(row))) return; await useModel(name); use.textContent = 'Current model'; use.disabled = true; };
      head.appendChild(use);
      c.appendChild(head);

      const dt = d.details || {};
      const facts = [
        ['Size on disk', row ? fmtBytes(row.size) : ''], ['Parameters', dt.parameter_size || (d.info.paramCount ? (d.info.paramCount / 1e9).toFixed(1) + 'B' : '')],
        ['Quantization', dt.quantization_level], ['Family', dt.family], ['Format', dt.format],
        ['Context length (max)', d.info.ctx ? d.info.ctx.toLocaleString() + ' tokens' : (row && row.ctx ? row.ctx.toLocaleString() + ' tokens' : '')],
        ['Capabilities', d.caps ? d.caps.join(', ') : 'unknown'],
        ['Last modified', d.modified ? new Date(d.modified).toLocaleString() : ''],
        ['Based on', row && row.parent], ['Needs Ollama', d.requires], ['Digest', row && row.digest ? row.digest.slice(0, 12) : ''],
        ['In memory', row ? (row.loaded ? 'yes' + (row.vram ? ', ' + fmtBytes(row.vram) + ' on GPU' : '') : 'no') : ''],
      ].filter((r) => r[1]);
      const grid = el('div', 'miFacts');
      for (const [k, v] of facts) { grid.appendChild(el('span', 'k', k)); grid.appendChild(el('span', 'v', String(v))); }
      c.appendChild(grid);

      /* quick test */
      const qt = el('div', 'miBox');
      qt.appendChild(el('div', 'miH', 'Quick test'));
      qt.appendChild(el('div', 'muted small', 'Sends one short prompt to this model and measures speed. Loads the model if needed. Runs locally.'));
      const qrow = el('div', 'mRow');
      const qin = el('input', 'mWide mqtIn');
      qin.value = 'Reply with one short sentence about the sea.';
      const run = el('button', 'primary mqtRun', 'Run');
      qrow.append(qin, run);
      const out = el('pre', 'mqtOut');
      const stats = el('div', 'mqtStats muted small');
      qt.append(qrow, out, stats);
      c.appendChild(qt);
      let running = null;
      async function go() {
        if (running) { call('quickStop', running).catch(() => {}); return; }
        const id = uid();
        running = id;
        run.textContent = 'Stop';
        out.textContent = ''; stats.textContent = ''; stats.removeAttribute('data-tps');
        const t0 = Date.now();
        let gotFirst = false;
        const tick = setInterval(() => { if (!gotFirst) stats.textContent = `Waiting for the model (loading if needed)... ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
        stats.textContent = 'Waiting for the model (loading if needed)... 0 s';
        qtH.set(id, (ev) => { if (ev.type === 'token') { gotFirst = true; out.textContent += ev.text; } });
        try {
          const r = await call('quickTest', id, name, qin.value);
          if (!out.textContent) out.textContent = r.reply || '(empty reply)';
          stats.dataset.tps = String(r.tps);
          stats.textContent = (r.stopped ? 'Stopped. ' : '') + (r.tps ? `${r.tps} tokens/s` : 'speed n/a') + `  \u00b7  ${r.tokens} tokens  \u00b7  model load ${(r.loadMs / 1000).toFixed(1)} s  \u00b7  first token ${(r.firstMs / 1000).toFixed(1)} s  \u00b7  total ${(r.totalMs / 1000).toFixed(1)} s`;
        } catch (e) { stats.textContent = ''; out.textContent = 'Error: ' + clean(e); }
        clearInterval(tick); qtH.delete(id); running = null; run.textContent = 'Run';
        refresh();
      }
      run.onclick = go;
      qin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

      /* notes */
      const nb = el('div', 'miBox');
      nb.appendChild(el('div', 'miH', 'Your notes'));
      const ta = el('textarea', 'mWide miNotes');
      ta.rows = 2; ta.placeholder = 'Anything you want to remember about this model';
      ta.value = (fs().notes || {})[name] || '';
      ta.onchange = () => F.saveFeatureSettings('models', { notes: { ...(fs().notes || {}), [name]: ta.value } });
      nb.appendChild(ta);
      c.appendChild(nb);

      const block = (title, text, open) => {
        const dd = el('details', 'miBlock');
        if (open) dd.open = true;
        dd.appendChild(el('summary', '', title));
        dd.appendChild(el('pre', '', text));
        c.appendChild(dd);
        return dd;
      };
      block('Parameters', d.parameters.length ? d.parameters.map(([k, v]) => `${k}  ${v}`).join('\n') : '(none set; Ollama defaults apply)', true).classList.add('miParams');
      block('System prompt', d.system || '(none)', true).classList.add('miSystem');
      block('Template', d.template || '(none)', false).classList.add('miTemplate');
      block('Modelfile (license omitted)', d.modelfile || '(unavailable)', false);
      block('License', d.license || '(none included)', false);
    })();
  }

  /* ================== PROGRESS BAR ================== */
  function progressBox() {
    const box = el('div', 'mProg');
    box.hidden = true;
    const txt = el('div', 'mProgTxt');
    const bar = el('div', 'bar'); const fill = el('i'); bar.appendChild(fill);
    box.append(txt, bar);
    return {
      box,
      show() { box.hidden = false; },
      update(ev) {
        box.hidden = false;
        const pct = ev.total ? Math.floor(((ev.completed || 0) / ev.total) * 100) : null;
        fill.style.width = pct === null ? '0%' : pct + '%';
        txt.textContent = (ev.status || '') + (pct !== null ? ` ${pct}%` : '');
      },
      hide() { box.hidden = true; },
    };
  }
  const fieldRow = (label, input, hint) => {
    const r = el('div', 'mField');
    r.appendChild(el('label', 'mLabel', label));
    r.appendChild(input);
    if (hint) r.appendChild(el('div', 'muted small', hint));
    return r;
  };
  const PARAM_FIELDS = [
    ['temperature', 'Temperature', '0 to 2'], ['top_p', 'Top P', '0 to 1'], ['top_k', 'Top K', 'whole number'], ['min_p', 'Min P', '0 to 1'],
    ['num_ctx', 'Context length (num_ctx)', 'tokens'], ['num_predict', 'Max new tokens', '-1 = no limit'],
    ['repeat_penalty', 'Repeat penalty', '1.0 = off'], ['seed', 'Seed', 'whole number'],
  ];

  /* ================== VARIANT / IMPORT forms ================== */
  function modelForm({ kind, base, onDone }) {
    // kind: 'variant' | 'gguf'
    const m = F.modal({ title: kind === 'gguf' ? 'Import a GGUF file' : 'Create a variant', wide: true, body: (c) => build(c) });
    let jobId = null, busy = false, created = null;
    function build(c) {
      c.classList.add('mf');
      const f = {};
      const intro = kind === 'gguf'
        ? 'Imports a model file that is already on this PC. No internet needed. Ollama copies the file into its own store, so you can delete the original afterwards.'
        : 'Makes a new model from an installed one with your own system prompt and settings. The weights are shared, so it takes almost no extra disk.';
      c.appendChild(el('p', 'mText', intro));
      if (kind === 'gguf') {
        f.path = el('input', 'mWide'); f.path.placeholder = 'C:\\Models\\my-model-Q4_K_M.gguf'; f.path.spellcheck = false;
        const br = el('button', '', 'Browse...');
        br.onclick = async () => { try { const p = await call('pickFile'); if (p) { f.path.value = p; checkPath(); } } catch (e) { F.error(clean(e)); } };
        const r = el('div', 'mRow'); r.append(f.path, br);
        const lab = el('div', 'mField'); lab.append(el('label', 'mLabel', 'GGUF file'), r);
        f.pathMsg = el('div', 'mErr');
        lab.appendChild(f.pathMsg);
        c.appendChild(lab);
      } else {
        f.base = el('select', 'mWide');
        for (const x of models()) f.base.appendChild(Object.assign(el('option', '', x.name), { value: x.name }));
        f.base.value = base && find(base) ? base : (find(F.settings().model) ? F.settings().model : (models()[0] || {}).name);
        c.appendChild(fieldRow('Base model', f.base));
      }
      f.name = el('input', 'mWide'); f.name.spellcheck = false;
      f.name.placeholder = 'my-coder';
      c.appendChild(fieldRow('New model name', f.name, NAME_HELP));
      f.nameMsg = el('div', 'mErr'); c.appendChild(f.nameMsg);
      f.system = el('textarea', 'mWide'); f.system.rows = 4;
      f.system.placeholder = kind === 'gguf' ? 'Optional' : 'e.g. You are a careful senior engineer. Answer briefly.';
      c.appendChild(fieldRow('System prompt', f.system));
      const grid = el('div', 'mGrid');
      f.p = {};
      for (const [k, label, hint] of PARAM_FIELDS) {
        const i = el('input'); i.spellcheck = false; i.dataset.k = k;
        i.placeholder = k === 'num_ctx' ? String(defaultCtx()) : 'default';
        if (k === 'num_ctx') i.value = String(defaultCtx());
        f.p[k] = i;
        grid.appendChild(fieldRow(label, i, hint));
      }
      c.appendChild(grid);
      f.stop = el('textarea', 'mWide'); f.stop.rows = 2; f.stop.placeholder = 'One per line (optional)';
      c.appendChild(fieldRow('Stop sequences', f.stop));
      const adv = el('details', 'miBlock');
      adv.appendChild(el('summary', '', 'Advanced: prompt template' + (kind === 'gguf' ? ' (usually needed for imports)' : '')));
      if (kind === 'gguf') {
        f.preset = el('select', 'mWide');
        for (const [k, t] of [['', 'Let Ollama decide (default)'], ...Object.entries(PRESETS).map(([k, v]) => [k, v.label])]) f.preset.appendChild(Object.assign(el('option', '', t), { value: k }));
        adv.appendChild(fieldRow('Preset', f.preset, 'A plain template gives chat only (no tool calls). Pick the format the model was trained on.'));
      }
      f.template = el('textarea', 'mWide mono'); f.template.rows = 5;
      f.template.placeholder = kind === 'gguf' ? 'Optional' : 'Leave empty to keep the base model\'s template (recommended; a custom template can break tool calls).';
      adv.appendChild(f.template);
      c.appendChild(adv);
      const pv = el('details', 'miBlock');
      pv.appendChild(el('summary', '', 'Modelfile preview'));
      f.preview = el('pre', 'mPreview');
      pv.appendChild(f.preview);
      c.appendChild(pv);
      const prog = progressBox();
      f.result = el('div', 'mResult');
      c.append(prog.box, f.result);
      const acts = el('div', 'mpActs');
      f.go = el('button', 'primary', kind === 'gguf' ? 'Import' : 'Create');
      f.cancel = el('button', '', 'Close');
      f.use = el('button', '', 'Use this model'); f.use.hidden = true;
      acts.append(f.go, f.use, f.cancel);
      c.appendChild(acts);

      let pathInfo = null;
      const spec = () => {
        const parameters = { stop: f.stop.value };
        for (const k of Object.keys(f.p)) parameters[k] = f.p[k].value;
        return { name: f.name.value.trim(), from: f.base ? f.base.value : undefined, system: f.system.value, template: f.template.value, parameters, path: f.path ? f.path.value : undefined };
      };
      let tPrev = 0;
      async function preview() {
        const my = ++tPrev;
        const r = await call('modelfile', spec(), kind, f.path && f.path.value.trim()).catch((e) => ({ error: clean(e) }));
        if (my !== tPrev) return;
        f.preview.textContent = r.text || '';
        const nm = f.name.value.trim();
        f.nameMsg.textContent = '';
        if (nm && !NAME_RE.test(nm)) f.nameMsg.textContent = NAME_HELP;
        else if (nm && models().some((x) => x.name === nm || x.name === nm + ':latest')) f.nameMsg.textContent = `"${nm}" already exists. Choose another name.`;
        else if (r.error && !/Enter a model name/.test(r.error)) f.nameMsg.textContent = r.error;
        f.go.disabled = busy || !!created;
      }
      let tp = null;
      const soon = () => { clearTimeout(tp); tp = setTimeout(preview, 150); };
      async function checkPath() {
        const v = f.path.value.trim();
        if (!v) { f.pathMsg.textContent = ''; pathInfo = null; return soon(); }
        const r = await call('checkGguf', v).catch((e) => ({ ok: false, error: clean(e) }));
        pathInfo = r.ok ? r : null;
        f.pathMsg.className = r.ok ? 'mOk' : 'mErr';
        f.pathMsg.textContent = r.ok ? `OK: GGUF v${r.version}, ${fmtBytes(r.size)}` : r.error;
        if (r.ok && !f.name.value.trim()) f.name.value = r.suggest;
        soon();
      }
      for (const x of [f.name, f.system, f.template, f.stop, ...Object.values(f.p), f.base].filter(Boolean)) { x.addEventListener('input', soon); x.addEventListener('change', soon); }
      if (f.path) { f.path.addEventListener('input', () => { clearTimeout(tp); tp = setTimeout(checkPath, 250); }); }
      if (f.preset) f.preset.onchange = () => {
        const p = PRESETS[f.preset.value];
        f.template.value = p ? p.template : '';
        if (p && !f.stop.value.trim()) f.stop.value = p.stop.join('\n');
        if (p) adv.open = true;
        soon();
      };
      if (f.base) f.base.addEventListener('change', () => { if (!f.name.value.trim() || /-custom$/.test(f.name.value)) f.name.value = f.base.value.replace(/:latest$/, '').replace(/:/g, '-') + '-custom'; soon(); });
      if (f.base && !f.name.value) f.name.value = (f.base.value || 'model').replace(/:latest$/, '').replace(/:/g, '-') + '-custom';

      f.cancel.onclick = () => { if (busy) call('cancel').catch(() => {}); else m.close(); };
      f.use.onclick = async () => { await useModelQuiet(created); m.close(); };
      f.go.onclick = async () => {
        if (busy) return;
        f.result.textContent = ''; f.result.className = 'mResult';
        if (kind === 'gguf' && !pathInfo) { await checkPath(); if (!pathInfo) { f.result.className = 'mResult mErr'; f.result.textContent = f.pathMsg.textContent || 'Choose a .gguf file first.'; return; } }
        busy = true; jobId = uid();
        f.go.disabled = true; f.cancel.textContent = 'Cancel';
        prog.update({ status: 'Starting' });
        progressH.set(jobId, (ev) => prog.update(ev));
        try {
          const r = await call(kind === 'gguf' ? 'import' : 'create', jobId, spec());
          created = r.name;
          prog.hide();
          f.result.className = 'mResult mOk';
          f.result.textContent = `Created ${r.name}.`;
          f.use.hidden = false;
          F.toast('Created ' + r.name);
          await refresh();
          if (onDone) onDone(r.name);
        } catch (e) {
          prog.hide();
          f.result.className = 'mResult mErr';
          f.result.textContent = clean(e);
        }
        progressH.delete(jobId); busy = false; f.cancel.textContent = 'Close';
        preview();
      };
      f.go.disabled = true;
      preview();
      setTimeout(() => f.name.focus(), 0);
    }
    return m;
  }
  const PRESETS = {
    chatml: { label: 'ChatML (Qwen, many others)', stop: ['<|im_start|>', '<|im_end|>'], template: '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ if .Prompt }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n{{ end }}<|im_start|>assistant\n{{ .Response }}<|im_end|>\n' },
    llama3: { label: 'Llama 3', stop: ['<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>'], template: '{{ if .System }}<|start_header_id|>system<|end_header_id|>\n\n{{ .System }}<|eot_id|>{{ end }}{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>\n\n{{ .Prompt }}<|eot_id|>{{ end }}<|start_header_id|>assistant<|end_header_id|>\n\n{{ .Response }}<|eot_id|>' },
    gemma: { label: 'Gemma', stop: ['<start_of_turn>', '<end_of_turn>'], template: '<start_of_turn>user\n{{ if .System }}{{ .System }} {{ end }}{{ .Prompt }}<end_of_turn>\n<start_of_turn>model\n{{ .Response }}<end_of_turn>\n' },
    mistral: { label: 'Mistral / Llama 2 [INST]', stop: ['[INST]', '[/INST]'], template: '[INST] {{ if .System }}{{ .System }} {{ end }}{{ .Prompt }} [/INST]{{ .Response }}' },
  };
  const openVariant = (base) => modelForm({ kind: 'variant', base });
  const openImport = () => modelForm({ kind: 'gguf' });

  /* ================== DOWNLOAD (online, user-initiated) ================== */
  function openDownload() {
    let busy = false;
    const m = F.modal({
      title: 'Download a model (needs internet)',
      body: (c) => {
        c.appendChild(el('p', 'mText', 'This is the only online action in Faber. Your local Ollama downloads the model from the internet (often several GB). Nothing is sent from Faber itself, and after the download everything works offline again.'));
        const inp = el('input', 'mWide mdlName'); inp.placeholder = 'e.g. qwen3:8b'; inp.spellcheck = false;
        c.appendChild(fieldRow('Model name', inp));
        const msg = el('div', 'mErr'); c.appendChild(msg);
        const prog = progressBox(); c.appendChild(prog.box);
        const acts = el('div', 'mpActs');
        const go = el('button', 'primary mdlGo', 'Download (needs internet)');
        const cancel = el('button', '', 'Close');
        acts.append(go, cancel); c.appendChild(acts);
        cancel.onclick = () => { if (busy) window.api.pullCancel().catch(() => {}); else m.close(); };
        go.onclick = async () => {
          const v = inp.value.trim();
          msg.textContent = '';
          if (!v || /\s/.test(v)) { msg.textContent = 'Enter a model name without spaces.'; return; }
          if (!(await ask({ title: 'Confirm download', text: `Download "${v}" from the internet now? Your local Ollama will fetch it. You can cancel while it runs.`, ok: 'Download' }))) return;
          busy = true; go.disabled = true; cancel.textContent = 'Cancel';
          pullH = (ev) => prog.update(ev);
          prog.update({ status: 'Starting' });
          try { await window.api.pullModel(v); F.toast(v + ' downloaded'); m.close(); } catch (e) { msg.textContent = clean(e); prog.hide(); go.disabled = false; }
          pullH = null; busy = false; cancel.textContent = 'Close';
          refresh();
        };
        setTimeout(() => inp.focus(), 0);
      },
    });
  }

  /* ================== MANAGER (sidebar tab) ================== */
  let openName = null;
  function buildManager(root) {
    root.classList.add('mg');
    const head = el('div', 'mgHead');
    head.appendChild(el('span', 'mgTitle', 'Installed models'));
    const rf = el('button', 'ghost', 'Refresh'); rf.onclick = () => refresh();
    head.appendChild(rf);
    const disk = el('div', 'mgDisk muted small');
    const btns = el('div', 'mgBtns');
    const bv = el('button', '', 'New variant'); bv.onclick = () => openVariant(F.settings().model);
    const bi = el('button', '', 'Import GGUF'); bi.onclick = openImport;
    const bd = el('button', 'mgDl', 'Download (needs internet)'); bd.onclick = openDownload;
    btns.append(bv, bi, bd);
    const msg = el('div', 'mgMsg');
    const list = el('div', 'mgList');
    // other features (resources) add views next to the model list through F.modelsViews
    const mainBox = el('div', 'mgMain');
    mainBox.append(head, disk, btns, msg, list);
    const extra = F.modelsViews || [];
    if (extra.length) {
      const seg = el('div', 'mgSeg');
      const boxes = { models: mainBox };
      const show = (id) => {
        for (const [k, b] of Object.entries(boxes)) b.hidden = k !== id;
        for (const b of seg.children) b.classList.toggle('on', b.dataset.id === id);
        const v = extra.find((x) => x.id === id);
        if (v && v.onShow) v.onShow(boxes[id]);
        for (const x of extra) if (x.id !== id && x.onHide) x.onHide();
      };
      const mk = (id, title) => { const b = el('button', 'mgSegBtn', title); b.dataset.id = id; b.onclick = () => show(id); seg.appendChild(b); };
      mk('models', 'Models');
      for (const v of extra) { mk(v.id, v.title); boxes[v.id] = el('div', 'mgView'); boxes[v.id].hidden = true; v.render(boxes[v.id]); }
      root.append(seg, mainBox, ...extra.map((v) => boxes[v.id]));
      F.showModelsView = show;
      mainBox.hidden = false;
      seg.firstChild.classList.add('on');
    } else root.append(mainBox);
    function paint() {
      const d = S.data;
      list.innerHTML = ''; msg.innerHTML = '';
      if (!d) { msg.appendChild(el('div', 'mNote', S.loading ? 'Loading...' : 'Open this tab to load models.')); disk.textContent = ''; return; }
      if (!d.ok) {
        disk.textContent = '';
        msg.appendChild(el('div', 'mNote bad', d.error || 'Cannot reach Ollama.'));
        const r = el('button', 'primary', 'Retry'); r.onclick = () => refresh();
        msg.appendChild(r);
        return;
      }
      const mem = d.mem;
      disk.textContent = `${fmtBytes(d.disk)} on disk, ${d.models.length} model${d.models.length === 1 ? '' : 's'}` +
        (d.sum > d.disk ? ' (variants share weights)' : '') + `. RAM free ${fmtBytes(mem.free)} of ${fmtBytes(mem.total)}.` + (S.loading ? ' Updating...' : '');
      if (!d.models.length) { msg.appendChild(el('div', 'mNote', 'No models installed. Import a GGUF file, or download one (needs internet).')); return; }
      const fav = favs();
      const sorted = [...d.models].sort((a, b) => (fav.has(b.name) - fav.has(a.name)) || a.name.localeCompare(b.name));
      for (const m of sorted) {
        const cur = F.settings().model === m.name;
        const row = el('div', 'mgRow' + (cur ? ' cur' : '') + (openName === m.name ? ' open' : ''));
        row.dataset.name = m.name;
        const top = el('div', 'mgTop');
        const nm = el('div', 'mgName', m.name); nm.title = m.name;
        if (fav.has(m.name)) nm.classList.add('fav');
        top.append(nm, el('div', 'mgSub', [m.params, m.quant, fmtBytes(m.size)].filter(Boolean).join('  \u00b7  ')));
        const bs = el('div', 'mpBadges');
        for (const b of badgesFor(m, mem)) bs.appendChild(b);
        top.appendChild(bs);
        top.onclick = () => { openName = openName === m.name ? null : m.name; paint(); };
        row.appendChild(top);
        if (openName === m.name) {
          const act = el('div', 'mgAct');
          const add = (label, fn, cls) => { const b = el('button', cls || '', label); b.onclick = () => fn(b); act.appendChild(b); return b; };
          const use = add(cur ? 'Current' : 'Use', async () => { if (await confirmUse(m)) await useModelQuiet(m.name); }, cur ? '' : 'primary mgUse');
          use.disabled = cur;
          add('Info', () => openInfo(m.name), 'mgInfo');
          add(m.loaded ? 'Unload' : 'Load', (b) => doLoad(m, b), 'mgLoad');
          add('Copy', () => doCopy(m), 'mgCopy');
          add('Variant', () => openVariant(m.name), 'mgVar');
          add(fav.has(m.name) ? 'Unpin' : 'Pin', () => toggleFav(m.name));
          add('Delete', () => doDelete(m), 'mgDel');
          row.appendChild(act);
        }
        list.appendChild(row);
      }
    }
    S.subs.add(paint);
    paint();
  }
  F.addSideTab({ id: 'models', title: 'Models', render: buildManager, onShow: () => { refresh(); } });
  F.onEvent('settings', () => notify());

  /* ================== /model command ================== */
  function resolveName(q) {
    const ms = models();
    const exact = ms.find((m) => m.name === q || m.name === q + ':latest');
    if (exact) return exact.name;
    const part = ms.filter((m) => m.name.includes(q));
    return part.length === 1 ? part[0].name : null;
  }
  async function infoText(name) {
    const d = await call('show', name);
    const m = find(name) || {};
    const dt = d.details || {};
    const L = [name];
    L.push('  ' + [m.size && fmtBytes(m.size), (dt.parameter_size || '') && dt.parameter_size + ' params', dt.quantization_level, dt.family && 'family ' + dt.family].filter(Boolean).join(' \u00b7 '));
    L.push('  context ' + ((d.info.ctx || m.ctx) ? (d.info.ctx || m.ctx).toLocaleString() + ' tokens' : 'unknown') + ' \u00b7 capabilities: ' + (d.caps ? d.caps.join(', ') : 'unknown'));
    L.push('  in memory: ' + (m.loaded ? 'yes' : 'no') + (d.modified ? ' \u00b7 modified ' + d.modified.slice(0, 10) : ''));
    L.push('  parameters: ' + (d.parameters.length ? d.parameters.map(([k, v]) => `${k}=${v}`).join(', ') : 'defaults'));
    L.push('  system prompt: ' + (d.system ? d.system.slice(0, 300) + (d.system.length > 300 ? '...' : '') : '(none)'));
    return L.join('\n');
  }
  F.addCommand('model', '[name | list | info <name>]', 'Pick, switch, list or inspect models', async (a) => {
    const cur = F.settings().model;
    const [sub, ...rest] = a.split(/\s+/);
    const arg = rest.join(' ').trim();
    if (!a) { F.sys('Model: ' + cur); pickModel(cur, (n) => useModelQuiet(n)); return; }
    const data = await refresh();
    if (sub === 'list') {
      if (!data.ok) return F.error(data.error);
      return F.sys(data.models.length ? data.models.map((m) => `${m.name === cur ? '*' : ' '} ${m.name}  ${fmtBytes(m.size)}  ${[m.params, m.quant].filter(Boolean).join(' ')}${m.loaded ? '  [loaded]' : ''}${noTools(m) ? '  [no tools]' : ''}`).join('\n') : 'No models installed.');
    }
    if (sub === 'info') {
      if (!data.ok) return F.error(data.error);
      const n = arg ? resolveName(arg) : cur;
      if (!n) return F.error(`No installed model matches "${arg}".`);
      return F.sys(await infoText(n));
    }
    if (!data.ok) { await F.saveSettings({ model: a }); return F.sys(`Model -> ${a} (could not check it: ${data.error})`); }
    const n = resolveName(a);
    if (!n) return F.error(`"${a}" is not installed. Installed: ${data.models.map((m) => m.name).join(', ') || 'none'}. Use /pull ${a} to download it (needs internet).`);
    const m = find(n);
    if (embedOnly(m)) return F.error(`${n} is an embedding model and cannot chat.`);
    await useModel(n);
    F.sys(`Model -> ${n}` + (noTools(m) ? '\nWarning: this model does not report tool support, so file and command tools may not work.' : ''));
  });
  F.addCommand('models', '', 'Open the Models manager', () => openModelsTab());

  /* ================== menu ================== */
  if (F.addMenuItem) {
    F.addMenuItem('Tools', { id: 'models-open', label: 'Models...', action: openModelsTab });
    F.addMenuItem('Tools', { id: 'models-switch', label: 'Switch Model...', action: () => pickModel(F.settings().model, (n) => useModelQuiet(n)) });
  }

  /* ================== settings ================== */
  F.addSettingsSection({
    id: 'models', title: 'Models',
    render(root) {
      const save = (p) => F.saveFeatureSettings('models', p);
      root.appendChild(el('p', 'muted small', 'Model manager defaults. These only affect this PC; nothing goes online.'));
      const ctxIn = el('input'); ctxIn.type = 'number'; ctxIn.min = '512'; ctxIn.step = '1024'; ctxIn.value = String(defaultCtx());
      ctxIn.onchange = () => { const n = parseInt(ctxIn.value, 10); if (n >= 512) save({ defaultCtx: n }); else ctxIn.value = String(defaultCtx()); };
      root.appendChild(fieldRow('Default context length for new variants (tokens)', ctxIn));
      const ka = el('select');
      for (const [v, t] of [['5m', '5 minutes (Ollama default)'], ['30m', '30 minutes'], ['2h', '2 hours'], ['24h', '24 hours'], ['-1', 'Until Ollama quits'], ['0', 'Unload right away']]) ka.appendChild(Object.assign(el('option', '', t), { value: v }));
      ka.value = String(fs().keepAlive == null ? '5m' : fs().keepAlive);
      ka.onchange = () => save({ keepAlive: ka.value });
      root.appendChild(fieldRow('Keep models in memory (Load button and Quick test)', ka, 'Chat itself uses Ollama\'s own default.'));
      const cli = el('input'); cli.type = 'checkbox'; cli.checked = !!fs().useCli;
      cli.onchange = () => save({ useCli: cli.checked });
      const lab = el('label', 'mCheck'); lab.append(cli, document.createTextNode(' Use the "ollama create" command instead of the API for variants and imports'));
      root.appendChild(lab);
      root.appendChild(el('div', 'muted small', 'Faber does this automatically for very old Ollama versions.'));
      const open = el('button', '', 'Open the Models tab'); open.onclick = openModelsTab;
      root.appendChild(open);
    },
  });
});
