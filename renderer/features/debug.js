/* feature: debug (renderer). Off by default: nothing is listened to, drawn or requested until debug mode is switched on.
   Toggle: /debug on|off, Run > Debug Mode, or the Settings section. The Debug sidebar tab appears when it is first switched on. */
Faber.register('debug', (F) => {
  const KINDS = ['all', 'request', 'response', 'tool', 'approval', 'subagent', 'error'];
  const MAX_ROWS = 2000;
  let on = false;
  let tabAdded = false;
  let paneEl = null, rowsEl = null, meterEl = null, countEl = null, sessSel = null, pauseBtn = null;
  let entries = [];           // summaries only; full payloads are fetched on click
  let kind = 'all', session = 'all', paused = false;
  let listening = false;

  const fail = (e) => F.error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  const sessions = () => (F.chat ? F.chat.sessions() : []);
  const nameOf = (id) => { const s = sessions().find((x) => x.id === id); return s ? s.name : id || '-'; };
  const clock = (t) => { const d = new Date(t); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };

  function visible(e) {
    return (kind === 'all' || e.kind === kind) && (session === 'all' || e.session === session);
  }
  function rowFor(e) {
    const r = F.el('div', 'dbgRow k-' + e.kind);
    r.dataset.seq = e.seq;
    r.append(F.el('span', 'dt', clock(e.ts)), F.el('span', 'dk', e.kind), F.el('span', 'ds', nameOf(e.session) + (e.agent && e.agent !== 'main' ? ' / ' + e.agent : '')), F.el('span', 'dm', e.summary));
    r.title = e.summary;
    r.onclick = () => showEntry(e.seq);
    return r;
  }
  function paintRows() {
    if (!rowsEl) return;
    rowsEl.replaceChildren(...entries.filter(visible).slice(-MAX_ROWS).map(rowFor));
    rowsEl.scrollTop = rowsEl.scrollHeight;
    if (countEl) countEl.textContent = `${entries.length} entries`;
  }
  function addEntry(e) {
    entries.push(e);
    if (entries.length > MAX_ROWS) entries.splice(0, entries.length - MAX_ROWS);
    if (paused || !rowsEl) return;
    if (visible(e)) {
      const stick = rowsEl.scrollHeight - rowsEl.scrollTop - rowsEl.clientHeight < 30;
      rowsEl.appendChild(rowFor(e));
      while (rowsEl.children.length > MAX_ROWS) rowsEl.firstChild.remove();
      if (stick) rowsEl.scrollTop = rowsEl.scrollHeight;
    }
    if (countEl) countEl.textContent = `${entries.length} entries`;
    if (e.kind === 'response' || e.kind === 'request') paintMeter();
  }

  async function showEntry(seq) {
    try {
      const e = await F.call('feat:debug:entry', seq);
      const text = JSON.stringify(e.data, null, 2);
      F.modal({
        title: `${e.kind} #${e.seq}`, wide: true,
        body: (el) => { const pre = F.el('pre', 'dbgJson'); pre.textContent = text; el.appendChild(pre); },
        buttons: [{ label: 'Copy', close: false, onClick: () => copy(text) }, { label: 'Close' }],
      });
    } catch (err) { fail(err); }
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => F.toast('Copied'), () => F.toast('Copy failed'));
    else F.toast('Copy is not available');
  }

  async function paintMeter() {
    if (!meterEl) return;
    const sid = session !== 'all' ? session : F.chat && F.chat.active();
    let c = null;
    try { c = sid ? await F.call('feat:debug:context', sid) : null; } catch { /* ignore */ }
    meterEl.replaceChildren();
    if (!c || !c.numCtx) { meterEl.textContent = 'Context: no data yet'; return; }
    const used = c.used || c.est;
    const pct = Math.min(100, Math.round((used / c.numCtx) * 100));
    const bar = F.el('div', 'dbgBar');
    const fill = F.el('i');
    fill.style.width = pct + '%';
    if (pct > 85) fill.classList.add('hot');
    bar.appendChild(fill);
    meterEl.append(F.el('div', 'dbgMeterText', `Context ${used} / ${c.numCtx} tokens (${pct}%)${c.used ? '' : ' estimated'}  ${c.model}`), bar);
  }

  async function showSystem() {
    const sid = session !== 'all' ? session : F.chat.active();
    try {
      const s = await F.call('feat:debug:system', sid);
      F.modal({ title: 'System prompt', wide: true, body: (el) => { const pre = F.el('pre', 'dbgJson'); pre.textContent = s ? s.system : 'No request captured yet for this agent. Send a message with debug on.'; el.appendChild(pre); } });
    } catch (e) { fail(e); }
  }
  async function showRaw() {
    const sid = session !== 'all' ? session : F.chat.active();
    try {
      const t = JSON.stringify(await F.call('feat:agents:transcript', sid), null, 2);
      F.modal({ title: 'Raw messages: ' + nameOf(sid), wide: true, body: (el) => { const pre = F.el('pre', 'dbgJson'); pre.textContent = t; el.appendChild(pre); }, buttons: [{ label: 'Copy', close: false, onClick: () => copy(t) }, { label: 'Close' }] });
    } catch (e) { fail(e); }
  }

  function renderPane(el) {
    paneEl = el;
    const tools = F.el('div', 'dbgTools');
    const btn = (label, fn, title) => { const b = F.el('button', '', label); if (title) b.title = title; b.onclick = fn; tools.appendChild(b); return b; };
    pauseBtn = btn('Pause', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) refresh();
    }, 'Freeze the view (capturing continues)');
    btn('Clear', async () => { await F.call('feat:debug:clear'); entries = []; paintRows(); });
    btn('Export', async () => { try { const p = await F.call('feat:debug:export'); if (p) F.toast('Saved ' + p); } catch (e) { fail(e); } }, 'Save the log to a file');
    btn('Off', () => setMode(false));

    const filt = F.el('div', 'dbgFilt');
    sessSel = F.el('select');
    sessSel.onchange = () => { session = sessSel.value; paintRows(); paintMeter(); };
    filt.appendChild(sessSel);
    const kinds = F.el('div', 'dbgKinds');
    for (const k of KINDS) {
      const b = F.el('button', 'ghost' + (k === kind ? ' on' : ''), k);
      b.onclick = () => { kind = k; kinds.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); paintRows(); };
      kinds.appendChild(b);
    }
    meterEl = F.el('div', 'dbgMeter');
    const acts = F.el('div', 'dbgTools');
    const sp = F.el('button', '', 'System prompt'); sp.onclick = showSystem;
    const rw = F.el('button', '', 'Raw messages'); rw.onclick = showRaw;
    acts.append(sp, rw);
    countEl = F.el('div', 'dbgCount');
    rowsEl = F.el('div', 'dbgRows');
    el.append(tools, filt, kinds, meterEl, acts, countEl, rowsEl);
    fillSessions();
    refresh();
  }
  function fillSessions() {
    if (!sessSel) return;
    sessSel.replaceChildren(new Option('All agents', 'all'));
    for (const s of sessions()) sessSel.add(new Option(s.name, s.id));
    sessSel.value = sessions().some((s) => s.id === session) ? session : 'all';
    session = sessSel.value;
  }
  async function refresh() {
    try { entries = await F.call('feat:debug:list'); } catch { entries = []; }
    paintRows();
    paintMeter();
  }

  function listen() {
    if (listening) return;
    listening = true;
    F.on('feat:debug:entry', (e) => { if (on) addEntry(e); });
    F.onEvent('agents', () => { if (on) { fillSessions(); paintMeter(); } });
  }

  async function setMode(v) {
    try { await F.call('feat:debug:set', v); } catch (e) { return fail(e); }
    on = v;
    if (on) {
      listen();
      if (!tabAdded) { tabAdded = true; F.addSideTab({ id: 'debug', title: 'Debug', render: renderPane }); }
      F.showSideTab('debug');
      refresh();
    }
    F.emit('debug', on);
    F.toast(on ? 'Debug mode on' : 'Debug mode off');
  }

  F.addCommand('debug', 'on|off', 'Debug mode: log requests, tool calls and timings', async (a) => {
    if (a === 'on') return setMode(true);
    if (a === 'off') return setMode(false);
    F.sys(`Debug mode is ${on ? 'on' : 'off'}. Usage: /debug on|off`);
  });
  F.addMenuItem('Run', { id: 'run.debug', label: 'Debug Mode', separatorBefore: true, checked: () => on, action: () => setMode(!on) });
  F.addSettingsSection({
    id: 'debug', title: 'Debug',
    render(el) {
      const row = F.el('label', 'aset');
      const chk = F.el('input');
      chk.type = 'checkbox'; chk.checked = on;
      chk.onchange = () => setMode(chk.checked);
      row.append(chk, F.el('span', '', 'Debug mode (log model requests, tool calls, timings in the Debug tab)'));
      el.append(row, F.el('div', 'ahint', 'Off by default. Nothing is logged to disk; the log lives in memory (last 2000 entries) until you export it.'));
    },
  });

  F.onReady(async () => {
    try { const st = await F.call('feat:debug:get'); if (st.enabled) setMode(true); } catch { /* feature not loaded */ }
  });
});
