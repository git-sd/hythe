/* feature: panes (renderer). Split chat: every agent gets its own pane next to the others, with a header (name, model,
   effort, permissions), a live activity strip, its own input, and approvals shown inside the pane that asked.
   Layouts: columns, rows, grid, focus. Splitters are draggable. "Broadcast" sends the bottom input to every pane.
   The chat DOM and event rendering stay in app.js; this file only decides where each agent's view lives. */
Faber.register('panes', (F) => {
  const { el } = F;
  const chat = F.chat;
  const MODES = [['single', 'Single'], ['columns', 'Columns'], ['rows', 'Rows'], ['grid', 'Grid'], ['focus', 'Focus']];
  const MAX = 8, MIN_FR = 0.12;
  const L = { mode: 'single', panes: [], sizes: {}, broadcast: false };
  const cells = new Map();                      // sid -> { root, head parts, body, input... }
  const act = {};                               // sid -> { steps, text, bad }
  const fail = (e) => F.error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

  /* ---------- DOM skeleton ---------- */
  const bar = el('div'); bar.id = 'paneBar'; bar.hidden = true;
  const host = el('div'); host.id = 'panes'; host.hidden = true;
  const chatEl = document.getElementById('chat');
  chatEl.parentNode.insertBefore(bar, chatEl);
  chatEl.parentNode.insertBefore(host, chatEl);
  const inputWrap = document.querySelector('.inputWrap');

  /* ---------- persistence ---------- */
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { F.saveFeatureSettings('panes', { mode: L.mode, panes: L.panes, sizes: L.sizes, broadcast: L.broadcast }); } catch { /* ignore */ } }, 300);
  };

  /* ---------- layout tree ---------- */
  const frs = (key, n) => {
    const a = L.sizes[key];
    if (Array.isArray(a) && a.length === n && a.every((x) => x > 0)) return a;
    return Array(n).fill(1 / n);
  };

  function splitter(dir, key, cellsArr) {
    const s = el('div', 'pSplit ' + dir);
    s.title = 'Drag to resize';
    s.onpointerdown = (e) => {
      e.preventDefault();
      const a = s.prevCell, b = s.nextCell;
      const fa = parseFloat(a.style.flexGrow), fb = parseFloat(b.style.flexGrow);
      const total = fa + fb;
      const g = s.parentNode;
      const size = dir === 'v' ? g.clientWidth : g.clientHeight;
      const start = dir === 'v' ? e.clientX : e.clientY;
      const sumAll = cellsArr.reduce((n, c) => n + parseFloat(c.style.flexGrow), 0);
      s.setPointerCapture(e.pointerId);
      s.classList.add('on');
      const move = (ev) => {
        const d = ((dir === 'v' ? ev.clientX : ev.clientY) - start) / Math.max(1, size) * sumAll;
        const na = Math.max(MIN_FR, Math.min(total - MIN_FR, fa + d));
        a.style.flexGrow = String(na);
        b.style.flexGrow = String(total - na);
      };
      const up = () => {
        s.classList.remove('on');
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
        s.removeEventListener('pointercancel', up);
        L.sizes[key] = cellsArr.map((c) => parseFloat(c.style.flexGrow));
        save();
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
      s.addEventListener('pointercancel', up);
    };
    return s;
  }

  // dir 'h' = children side by side (vertical splitters), 'v' = stacked (horizontal splitters)
  function group(dir, kids, key) {
    const g = el('div', 'pGroup ' + (dir === 'h' ? 'row' : 'col'));
    const f = frs(key, kids.length);
    const cs = kids.map((k, i) => {
      const c = el('div', 'pCell');
      c.style.flexGrow = String(f[i]);
      c.appendChild(k);
      return c;
    });
    cs.forEach((c, i) => {
      g.appendChild(c);
      if (i < cs.length - 1) {
        const sp = splitter(dir === 'h' ? 'v' : 'h', key, cs);
        sp.prevCell = c; sp.nextCell = cs[i + 1];
        g.appendChild(sp);
      }
    });
    return g;
  }

  function layoutTree(sids) {
    const P = (sid) => paneFor(sid);
    if (sids.length === 1) return P(sids[0]);
    if (L.mode === 'rows') return group('v', sids.map(P), 'root');
    if (L.mode === 'grid') {
      const cols = Math.ceil(Math.sqrt(sids.length));
      const rows = [];
      for (let i = 0; i < sids.length; i += cols) rows.push(sids.slice(i, i + cols));
      return group('v', rows.map((r, i) => (r.length === 1 ? P(r[0]) : group('h', r.map(P), 'g' + i))), 'root');
    }
    if (L.mode === 'focus') {
      const main = chat.active() && sids.includes(chat.active()) ? chat.active() : sids[0];
      const rest = sids.filter((s) => s !== main);
      const side = rest.length === 1 ? P(rest[0]) : group('v', rest.map(P), 'side');
      const g = group('h', [P(main), side], 'root');
      if (!L.sizes.root) { g.children[0].style.flexGrow = '0.68'; g.children[2].style.flexGrow = '0.32'; }
      return g;
    }
    return group('h', sids.map(P), 'root');
  }

  /* ---------- one pane ---------- */
  function chip(text, title, onClick) {
    const b = el('button', 'pChip', text);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(e.currentTarget); };
    return b;
  }
  function paneFor(sid) {
    const v = chat.view(sid);
    const root = el('div', 'pane');
    root.dataset.sid = sid;
    const head = el('div', 'pHead');
    const dot = el('i', 'adot');
    const name = el('span', 'pName');
    name.ondblclick = () => rename(sid, name);
    const model = chip('', 'Model', (a) => chat.pickModel(sid, a));
    const effort = chip('', 'Reasoning effort', (a) => { const i = chat.view(sid).info; chat.openMenu(a, chat.efforts, i.effort, (x) => chat.update(sid, { effort: x })); });
    const mode = chip('', 'Permissions', (a) => { const i = chat.view(sid).info; chat.openMenu(a, chat.modes, i.mode, (x) => chat.update(sid, { mode: x })); });
    const sp = el('span', 'spacer');
    const focusB = el('button', 'ghost pBtn', 'Focus');
    focusB.title = 'Show this agent large with the others beside it';
    focusB.onclick = (e) => { e.stopPropagation(); chat.switchTo(sid); setMode('focus'); };
    const closeB = el('button', 'ghost pBtn', 'Hide');
    closeB.title = 'Remove this pane (the agent keeps running)';
    closeB.onclick = (e) => { e.stopPropagation(); removePane(sid); };
    head.append(dot, name, model, effort, mode, sp, focusB, closeB);
    const strip = el('div', 'pStrip');
    const body = el('div', 'pBody');
    const inWrap = el('div', 'pInput');
    const ta = el('textarea');
    ta.rows = 1; ta.placeholder = 'Message this agent...'; ta.spellcheck = false;
    const send = el('button', 'primary pSend', 'Send');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    ta.oninput = grow;
    const submit = () => {
      const t = ta.value.trim();
      const vw = chat.view(sid);
      if (vw && vw.busy) return chat.stop(sid);
      if (!t) return;
      ta.value = ''; grow();
      if (t.startsWith('/')) { chat.switchTo(sid); return chat.runCommand(t); }
      chat.sendTo(sid, t);
    };
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { const vw = chat.view(sid); if (vw && vw.busy) chat.stop(sid); }
    };
    send.onclick = submit;
    inWrap.append(ta, send);
    root.append(head, strip, body, inWrap);
    root.addEventListener('mousedown', () => { if (chat.active() !== sid) chat.switchTo(sid); }, true);
    body.addEventListener('scroll', () => { const vw = chat.view(sid); if (vw) { vw.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40; vw.scrollTop = body.scrollTop; } });
    const c = { root, dot, name, model, effort, mode, strip, body, ta, send };
    cells.set(sid, c);
    if (v) {
      const keepStick = v.stick;
      v.scroller = body;
      v.el.hidden = false;
      body.appendChild(v.el);
      requestAnimationFrame(() => { body.scrollTop = keepStick ? body.scrollHeight : v.scrollTop; });
    }
    paintHead(sid);
    return root;
  }

  function rename(sid, nameEl) {
    const v = chat.view(sid);
    const input = el('input', 'renameBox');
    input.value = v.info.name;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const fin = (ok) => {
      if (done) return; done = true;
      const t = input.value.trim();
      if (ok && t && t !== v.info.name) Promise.resolve(chat.rename(sid, t)).catch(fail);
      input.replaceWith(nameEl);
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
    input.onblur = () => fin(true);
  }

  const STATUS = { idle: 'idle', working: 'working', approval: 'waiting for approval', queued: 'queued', error: 'error' };
  function paintHead(sid) {
    const c = cells.get(sid), v = chat.view(sid);
    if (!c || !v) return;
    const i = v.info;
    c.dot.className = 'adot ' + i.status;
    c.name.textContent = i.name;
    c.model.textContent = F.modelLabel ? F.modelLabel(i.model) : i.model;
    c.effort.textContent = i.effort;
    c.mode.textContent = (chat.modes.find((m) => m[0] === i.mode) || [0, i.mode])[1];
    c.root.classList.toggle('focus', chat.active() === sid);
    c.send.textContent = v.busy ? 'Stop' : 'Send';
    paintStrip(sid);
  }
  function paintStrip(sid) {
    const c = cells.get(sid), v = chat.view(sid);
    if (!c || !v) return;
    const a = act[sid] || {};
    const st = v.info.status;
    let text;
    if (st === 'idle' && !a.bad) text = a.steps ? `idle, last run used ${a.steps} tool call${a.steps === 1 ? '' : 's'}` : 'idle';
    else text = (st === 'error' || a.bad) ? (a.text || 'error') : `${STATUS[st] || st}${a.text ? ': ' + a.text : ''}${a.steps ? `  (step ${a.steps})` : ''}`;
    c.strip.textContent = text;
    c.strip.className = 'pStrip ' + (st === 'error' || a.bad ? 'bad' : st === 'idle' ? '' : 'live');
  }

  let dirtyHeads = new Set(), headRaf = 0;
  function schedule(sid) {
    dirtyHeads.add(sid);
    if (headRaf) return;
    headRaf = requestAnimationFrame(() => { headRaf = 0; const l = [...dirtyHeads]; dirtyHeads = new Set(); for (const s of l) paintHead(s); });
  }
  const allHeads = () => { for (const s of L.panes) schedule(s); };

  F.onEvent('agent-event', ({ view, ev }) => {
    if (L.mode === 'single' || !cells.has(view.id) || ev.sub) return;
    const a = (act[view.id] ||= { steps: 0, text: '' });
    switch (ev.type) {
      case 'user': a.steps = 0; a.text = ''; a.bad = false; break;
      case 'thinking': a.text = 'thinking'; break;
      case 'token': a.text = 'writing the reply'; break;
      case 'tool_start': a.steps++; a.text = `${ev.name} ${typeof ev.args === 'object' && ev.args ? (ev.args.path || ev.args.command || ev.args.pattern || ev.args.task || '') : ''}`.trim().slice(0, 80); break;
      case 'tool_result': a.text = `${ev.ok ? 'finished' : 'failed'} a tool call`; break;
      case 'approval': a.text = ev.title; break;
      case 'error': a.text = ev.message; a.bad = true; break;
      case 'done': a.text = ''; break;
      default: return;
    }
    schedule(view.id);
  });
  F.onEvent('agents', (what) => {
    if (what === 'list') { prune(); }
    if (what === 'active' && L.mode !== 'single') {
      const sid = chat.active();
      if (sid && !L.panes.includes(sid)) addPane(sid);
    }
    if (L.mode !== 'single') allHeads();
  });

  /* ---------- build / teardown ---------- */
  function release() {
    for (const sid of cells.keys()) {
      const v = chat.view(sid);
      if (v) { v.scrollTop = v.scroller ? v.scroller.scrollTop : v.scrollTop; v.scroller = null; }
    }
    // move views out before the pane DOM is destroyed so their content survives a rebuild
    for (const v of chat.views()) { if (v.el.parentNode !== chatEl) { v.el.hidden = true; chatEl.appendChild(v.el); } }
    host.innerHTML = '';
    cells.clear();
  }

  function build() {
    release();
    const single = L.mode === 'single' || !L.panes.length;
    bar.hidden = single;
    host.hidden = single;
    chatEl.hidden = !single;
    document.body.classList.toggle('splitOn', !single);
    if (single) {
      const act0 = chat.active();
      for (const v of chat.views()) v.el.hidden = v.id !== act0;
      inputWrap.hidden = false;
      resetInput();
      requestAnimationFrame(() => { const v = chat.view(act0); if (v) chatEl.scrollTop = v.stick ? chatEl.scrollHeight : v.scrollTop; });
      paintBar();
      return;
    }
    host.appendChild(layoutTree(L.panes));
    inputWrap.hidden = !L.broadcast;
    resetInput();
    paintBar();
    allHeads();
  }
  function resetInput() {
    const i = document.getElementById('input');
    if (!i) return;
    i.placeholder = L.mode !== 'single' && L.broadcast ? `Send to all ${L.panes.length} panes...   / for commands` : 'Message Faber...   / for commands · Shift+Enter for new line';
  }

  /* ---------- changing the layout ---------- */
  async function setMode(mode) {
    if (!MODES.some((m) => m[0] === mode)) return;
    if (mode !== 'single') {
      if (!L.panes.length) {
        let list = chat.sessions().map((s) => s.id);
        if (list.length < 2) { try { await chat.create(); list = chat.sessions().map((s) => s.id); } catch (e) { return fail(e); } }
        const act0 = chat.active();
        // creation order, but never drop the agent the user is looking at
        L.panes = list.slice(0, MAX);
        if (act0 && !L.panes.includes(act0)) L.panes[L.panes.length - 1] = act0;
      }
    }
    if (L.mode !== mode) L.sizes = {};
    L.mode = mode;
    build(); save();
  }
  function addPane(sid) {
    if (L.panes.includes(sid)) return;
    if (L.panes.length >= MAX) return F.toast(`At most ${MAX} panes at once.`);
    L.panes.push(sid);
    L.sizes = {};
    build(); save();
  }
  function removePane(sid) {
    L.panes = L.panes.filter((s) => s !== sid);
    L.sizes = {};
    if (L.panes.length < 2 && L.mode !== 'single' && !L.panes.length) L.mode = 'single';
    build(); save();
  }
  function prune() {
    const ids = new Set(chat.sessions().map((s) => s.id));
    const keep = L.panes.filter((s) => ids.has(s));
    if (keep.length !== L.panes.length) { L.panes = keep; L.sizes = {}; if (!keep.length) L.mode = 'single'; build(); save(); }
  }

  /* ---------- toolbar above the panes ---------- */
  function paintBar() {
    bar.innerHTML = '';
    if (L.mode === 'single') return;
    const seg = el('div', 'pSeg');
    for (const [id, t] of MODES) {
      const b = el('button', 'pSegBtn' + (L.mode === id ? ' on' : ''), t);
      b.onclick = () => setMode(id);
      seg.appendChild(b);
    }
    const add = el('button', '', 'Add pane');
    add.title = 'Show another agent here, or start a new one';
    add.onclick = () => {
      const hidden = chat.sessions().filter((s) => !L.panes.includes(s.id));
      chat.openMenu(add, [['__new', 'New agent', 'Starts a fresh chat in its own pane'], ...hidden.map((s) => [s.id, s.name, s.model])], null, async (id) => {
        if (id === '__new') { try { const i = await chat.create(); addPane(i.id); } catch (e) { fail(e); } } else addPane(id);
      });
    };
    const lab = el('label', 'pBroadcast');
    const chk = el('input'); chk.type = 'checkbox'; chk.checked = L.broadcast;
    chk.onchange = () => { L.broadcast = chk.checked; inputWrap.hidden = !L.broadcast; resetInput(); save(); if (L.broadcast) document.getElementById('input').focus(); };
    lab.append(chk, el('span', '', 'Broadcast: one message to every pane'));
    const stopAll = el('button', '', 'Stop all');
    stopAll.onclick = () => chat.stopAll();
    const count = el('span', 'pCount', `${L.panes.length} pane${L.panes.length === 1 ? '' : 's'}`);
    bar.append(seg, add, lab, el('span', 'spacer'), count, stopAll);
  }

  chat.setBroadcast((text) => {
    if (L.mode === 'single' || !L.broadcast) return false;
    for (const sid of L.panes) { const v = chat.view(sid); if (v && !v.busy) chat.sendTo(sid, text); }
    return true;
  });

  /* ---------- entry points: header button, menu, command ---------- */
  const layoutItems = () => MODES.map(([id, t]) => [id, t, id === 'single' ? 'One chat at a time' : id === 'columns' ? 'Agents side by side' : id === 'rows' ? 'Agents stacked' : id === 'grid' ? 'Agents in a grid' : 'One big pane, the rest beside it']);
  const btn = F.addHeaderButton({ id: 'splitBtn', label: 'Split', title: 'Show several agents side by side', onClick: () => chat.openMenu(btn, layoutItems(), L.mode, setMode) });
  F.addMenuItem('Agents', {
    id: 'agents.split', label: 'Split Layout', separatorBefore: true,
    submenu: () => MODES.map(([id, t]) => ({ label: t, checked: () => L.mode === id, action: () => setMode(id) })),
  });
  F.addCommand('split', 'single|columns|rows|grid|focus', 'Show agents side by side', (a) => {
    a = (a || '').trim().toLowerCase();
    if (!a) return setMode(L.mode === 'single' ? 'columns' : 'single');
    if (!MODES.some((m) => m[0] === a)) return F.sys('Usage: /split single|columns|rows|grid|focus');
    return setMode(a);
  });

  F.onReady(() => {
    const s = F.featureSettings('panes');
    if (s && MODES.some((m) => m[0] === s.mode) && s.mode !== 'single') {
      const ids = new Set(chat.sessions().map((x) => x.id));
      L.panes = (s.panes || []).filter((x) => ids.has(x));
      if (L.panes.length) { L.mode = s.mode; L.sizes = s.sizes || {}; L.broadcast = !!s.broadcast; build(); }
    }
  });

  // for tests and other features
  // show exactly these agents (used by team mode)
  function show(sids, mode) {
    const ids = new Set(chat.sessions().map((x) => x.id));
    L.panes = sids.filter((x) => ids.has(x)).slice(0, MAX);
    if (!L.panes.length) return;
    L.mode = MODES.some((m) => m[0] === mode) && mode !== 'single' ? mode : (L.panes.length > 3 ? 'grid' : 'columns');
    L.sizes = {};
    build(); save();
  }
  F.panes = { state: () => ({ mode: L.mode, panes: [...L.panes], broadcast: L.broadcast }), setMode, addPane, removePane, show };
});
