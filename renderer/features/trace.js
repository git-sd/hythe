/* feature: trace (renderer). A dock panel that shows the communication line live: every message between agents, every tool
   call, every approval, token usage. Nothing is summarised: long messages are collapsed but expand to the full text.
   Main side: src/features/trace.js and src/comms.js. Open it from View > Trace or /trace. */
Faber.register('trace', (F) => {
  const { el } = F;
  const NS = 'feat:trace:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a);
  const MAX_MEM = 3000, MAX_DOM = 500;
  let E = [];                           // newest last
  let count = 0;
  const toggles = { messages: true, tools: true, thoughts: true, board: true, usage: true, system: true };
  const GROUP = { task: 'messages', result: 'messages', final: 'messages', plan: 'messages', question: 'messages', answer: 'messages', error: 'messages', tool: 'tools', 'tool-result': 'tools', thought: 'thoughts', board: 'board', usage: 'usage', system: 'system' };
  let agentFilter = '';
  let follow = true;

  /* ---------- skeleton ---------- */
  const root = el('section', 'trPanel');
  root.id = 'tracePanel';
  const bar = el('div', 'trBar');
  const agentSel = el('select', 'trSel');
  agentSel.title = 'Show only messages to or from one agent';
  const chips = el('div', 'trChips');
  for (const [k, label] of [['messages', 'Messages'], ['tools', 'Tools'], ['thoughts', 'Reasoning'], ['board', 'Board'], ['usage', 'Tokens'], ['system', 'System']]) {
    const b = el('button', 'trChip on', label);
    b.title = 'Show or hide ' + label.toLowerCase();
    b.onclick = () => { toggles[k] = !toggles[k]; b.classList.toggle('on', toggles[k]); redraw(); };
    chips.appendChild(b);
  }
  const followLab = el('label', 'trFollow');
  const followChk = el('input'); followChk.type = 'checkbox'; followChk.checked = true;
  followChk.onchange = () => { follow = followChk.checked; if (follow) toEnd(); };
  followLab.append(followChk, el('span', '', 'Follow'));
  const verifyB = el('button', '', 'Verify chain');
  verifyB.title = 'Checks that no message was removed, changed or reordered since it was logged';
  const exportJ = el('button', '', 'Export JSONL');
  const exportT = el('button', '', 'Export text');
  const folderB = el('button', '', 'Open folder');
  const clearB = el('button', '', 'Clear');
  clearB.title = 'Starts a new trace file. The old file stays on disk.';
  bar.append(agentSel, chips, followLab, verifyB, exportJ, exportT, folderB, clearB);
  const status = el('div', 'trStatus');
  const list = el('div', 'trList');
  const empty = el('div', 'trEmpty', 'Nothing yet. When agents talk to each other (Orchestra tab, Team tab) every message appears here, word for word.');
  root.append(bar, status, list);

  Dock.register({ id: 'trace', title: 'Trace', el: root, onClose: () => Dock.hide('trace') });

  /* ---------- entries ---------- */
  const fmtT = (ms) => '+' + (ms / 1000).toFixed(1) + 's';
  const visible = (e) => toggles[GROUP[e.kind] || 'system'] && (!agentFilter || e.from === agentFilter || e.to === agentFilter);
  function node(e) {
    const d = el('div', 'trEntry k-' + e.kind);
    d.dataset.seq = e.seq;
    const h = el('div', 'trHead');
    h.append(el('span', 'trSeq', '#' + e.seq), el('span', 'trTime', fmtT(e.t)), el('span', 'trKind', e.kind.toUpperCase()), el('span', 'trWho', `${e.from} → ${e.to}`));
    if (e.model) h.appendChild(el('span', 'trModel', e.model));
    if (e.meta && e.meta.ms !== undefined) h.appendChild(el('span', 'trMs', (e.meta.ms / 1000).toFixed(1) + 's'));
    d.appendChild(h);
    if (e.text) {
      const lines = e.text.split('\n');
      const long = lines.length > 8 || e.text.length > 700;
      const body = el('pre', 'trBody', long ? lines.slice(0, 8).join('\n').slice(0, 700) : e.text);
      d.appendChild(body);
      if (long) {
        const more = el('button', 'ghost trMore', `Show all (${e.text.length.toLocaleString()} characters)`);
        let open = false;
        more.onclick = () => { open = !open; body.textContent = open ? e.text : lines.slice(0, 8).join('\n').slice(0, 700); more.textContent = open ? 'Show less' : `Show all (${e.text.length.toLocaleString()} characters)`; };
        d.appendChild(more);
      }
    }
    return d;
  }
  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function toEnd() { list.scrollTop = list.scrollHeight; }
  function updateAgents() {
    const names = new Set();
    for (const e of E) { names.add(e.from); names.add(e.to); }
    const want = ['', ...[...names].filter((n) => !['all', 'owner', 'tools', 'board'].includes(n)).sort()].join('|');
    if (agentSel.dataset.k === want) return;
    agentSel.dataset.k = want;
    const cur = agentSel.value;
    agentSel.innerHTML = '';
    agentSel.appendChild(Object.assign(el('option', '', 'All agents'), { value: '' }));
    for (const n of want.split('|').slice(1)) agentSel.appendChild(Object.assign(el('option', '', n), { value: n }));
    agentSel.value = [...agentSel.options].some((o) => o.value === cur) ? cur : '';
  }
  agentSel.onchange = () => { agentFilter = agentSel.value; redraw(); };

  function redraw() {
    list.innerHTML = '';
    const shown = E.filter(visible).slice(-MAX_DOM);
    if (!shown.length) list.appendChild(empty);
    for (const e of shown) list.appendChild(node(e));
    if (follow) toEnd();
    paintStatus();
  }
  let raf = 0, queue = [];
  function add(entries) {
    for (const e of entries) {
      if (E.length && e.seq <= E[E.length - 1].seq) continue;
      E.push(e);
      if (e.seq > count) count = e.seq;
      queue.push(e);
    }
    if (E.length > MAX_MEM) E = E.slice(-MAX_MEM);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const q = queue; queue = [];
      const stick = follow && atEnd();
      if (empty.parentNode) empty.remove();
      for (const e of q) if (visible(e)) list.appendChild(node(e));
      while (list.children.length > MAX_DOM) list.firstChild.remove();
      if (follow && (stick || true)) toEnd();
      updateAgents();
      paintStatus();
      Dock.title('trace', 'Trace (' + count + ')');
    });
  }
  let verified = '';
  function paintStatus() { status.textContent = `${count} message${count === 1 ? '' : 's'} in this trace${verified ? '  ·  ' + verified : ''}`; status.className = 'trStatus' + (/BROKEN|could not/.test(verified) ? ' bad' : verified ? ' ok' : ''); }

  F.on(NS + 'entries', (batch) => add(batch));
  async function load() {
    try { const r = await call('list', 0, 500); E = []; list.innerHTML = ''; count = 0; add(r.entries); count = r.count; paintStatus(); } catch { /* feature missing */ }
  }
  F.onReady(load);

  /* ---------- buttons ---------- */
  verifyB.onclick = async () => {
    try {
      const r = await call('verify');
      const f = r.file;
      const ok = r.memory.ok && (!f || f.ok);
      verified = ok ? `chain VERIFIED (${r.memory.count} entries${f ? ', file matches' : ''})` : `chain BROKEN: ${(!r.memory.ok ? r.memory : f).reason}`;
      paintStatus();
      F.toast(ok ? 'Trace verified: no message was removed or changed.' : 'The trace chain is broken!');
    } catch (e) { F.error(clean(e)); }
  };
  exportJ.onclick = async () => { try { const p = await call('export', 'jsonl'); if (p) F.toast('Saved ' + p); } catch (e) { F.error(clean(e)); } };
  exportT.onclick = async () => { try { const p = await call('export', 'text'); if (p) F.toast('Saved ' + p); } catch (e) { F.error(clean(e)); } };
  folderB.onclick = () => call('openFolder').catch(() => {});
  clearB.onclick = async () => { try { await call('clear'); E = []; count = 0; verified = ''; list.innerHTML = ''; list.appendChild(empty); agentSel.dataset.k = ''; updateAgents(); paintStatus(); Dock.title('trace', 'Trace'); } catch (e) { F.error(clean(e)); } };

  /* ---------- entry points ---------- */
  F.openTrace = () => { Dock.show('trace', { near: 'chat', zone: 'bottom', ratio: 0.42 }); redraw(); };
  F.addMenuItem('View', { id: 'view.trace', label: 'Agent Trace', checked: () => Dock.visible('trace'), action: () => (Dock.visible('trace') ? Dock.hide('trace') : F.openTrace()) });
  F.addCommand('trace', 'verify|clear', 'Show the agent communication trace', (a) => {
    a = (a || '').trim();
    if (a === 'verify') { F.openTrace(); return verifyB.click(); }
    if (a === 'clear') return clearB.click();
    F.openTrace();
  });
  F.trace = { entries: () => E.slice(), count: () => count, reload: load };
});
