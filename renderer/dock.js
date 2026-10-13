/* Dock: the layout engine for the main area. Panels (chat, editor groups, terminal) are real DOM elements that live in
   #dockPark while hidden and are moved into a layout tree when shown. The tree is made of
     split nodes  { t:'split', d:'h'|'v', c:[nodes], s:[fractions] }   h = side by side, v = stacked
     leaf nodes   { t:'leaf', p:[panel ids], a:activeIndex }           several panels in one leaf = tabs (a stack)
   Drag a panel's tab onto the left/right/top/bottom edge of any panel to dock it there, onto the middle to stack it.
   Loaded after app.js and before editor.js / terminal.js, which register their panels. */
window.Dock = (() => {
  const MIN_FR = 0.1;
  const panels = new Map();          // id -> { id, title, el, closable, onClose }
  let root = null;                   // layout tree (null until start())
  let host = null, park = null;
  let seq = 0;
  const listeners = [];
  let saveFn = null;

  const dom = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- tree helpers ---------- */
  const leaf = (ids, a = 0) => ({ t: 'leaf', id: 'L' + (++seq), p: ids.slice(), a });
  const split = (d, c, s) => ({ t: 'split', d, c, s: s || c.map(() => 1 / c.length) });
  function walk(n, fn, parent = null, idx = 0) {
    fn(n, parent, idx);
    if (n.t === 'split') n.c.forEach((k, i) => walk(k, fn, n, i));
  }
  function findLeaf(id) { let out = null; if (root) walk(root, (n, p, i) => { if (n.t === 'leaf' && n.p.includes(id)) out = { n, p, i }; }); return out; }
  function findLeafById(lid) { let out = null; if (root) walk(root, (n, p, i) => { if (n.t === 'leaf' && n.id === lid) out = { n, p, i }; }); return out; }
  const visibleIds = () => { const o = []; if (root) walk(root, (n) => { if (n.t === 'leaf') o.push(...n.p); }); return o; };
  const isVisible = (id) => !!findLeaf(id);

  // remove empty leaves and splits with one child; keeps fractions sane
  function normalize(n) {
    if (!n) return null;
    if (n.t === 'leaf') {
      n.p = n.p.filter((id) => panels.has(id));
      if (!n.p.length) return null;
      n.a = Math.max(0, Math.min(n.a, n.p.length - 1));
      return n;
    }
    const kids = [], fr = [];
    n.c.forEach((k, i) => { const r = normalize(k); if (r) { kids.push(r); fr.push(n.s[i] > 0 ? n.s[i] : 1 / n.c.length); } });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    const sum = fr.reduce((a, b) => a + b, 0);
    n.c = kids; n.s = fr.map((x) => x / sum);
    // flatten a child split with the same direction into this one
    for (let i = 0; i < n.c.length; i++) {
      const k = n.c[i];
      if (k.t === 'split' && k.d === n.d) {
        n.c.splice(i, 1, ...k.c);
        n.s.splice(i, 1, ...k.s.map((x) => x * n.s[i]));
        i += k.c.length - 1;
      }
    }
    return n;
  }
  function removeFromTree(id) {
    walk(root, (n) => { if (n.t === 'leaf') { const i = n.p.indexOf(id); if (i >= 0) { n.p.splice(i, 1); if (n.a >= i) n.a = Math.max(0, n.a - 1); } } });
  }
  // put panel `id` next to the leaf `target` (a leaf node). zone: left|right|top|bottom|center
  function insertAt(id, target, zone, ratio = 0.5) {
    if (zone === 'center') { target.p.push(id); target.a = target.p.length - 1; return; }
    const d = zone === 'left' || zone === 'right' ? 'h' : 'v';
    const first = zone === 'left' || zone === 'top';
    const nl = leaf([id]);
    const f = findLeafById(target.id);
    const pair = first ? [nl, target] : [target, nl];
    const share = first ? [ratio, 1 - ratio] : [1 - ratio, ratio];
    if (f.p && f.p.d === d) {
      const sz = f.p.s[f.i];
      f.p.c.splice(f.i, 1, ...pair);
      f.p.s.splice(f.i, 1, sz * share[0], sz * share[1]);
    } else {
      const s = split(d, pair, share);
      if (f.p) f.p.c[f.i] = s; else root = s;
    }
  }
  // wrap the whole layout (drop on the outer edge of the dock)
  function insertAtRoot(id, zone, ratio = 0.3) {
    const d = zone === 'left' || zone === 'right' ? 'h' : 'v';
    const nl = leaf([id]);
    const first = zone === 'left' || zone === 'top';
    root = split(d, first ? [nl, root] : [root, nl], first ? [ratio, 1 - ratio] : [1 - ratio, ratio]);
  }

  /* ---------- rendering ---------- */
  function snapshotScroll() {
    const out = [];
    for (const p of panels.values()) {
      if (!p.el.isConnected) continue;
      for (const e of [p.el, ...p.el.querySelectorAll('*')]) if (e.scrollTop || e.scrollLeft) out.push([e, e.scrollTop, e.scrollLeft]);
    }
    return out;
  }
  function restoreScroll(list) { for (const [e, t, l] of list) { if (e.isConnected) { e.scrollTop = t; e.scrollLeft = l; } } }

  function render() {
    if (!host) return;
    root = normalize(root);
    const sc = snapshotScroll();
    // park everything first so no panel is lost when the old tree DOM is thrown away
    for (const p of panels.values()) { p.el.hidden = true; park.appendChild(p.el); }
    host.innerHTML = '';
    if (root) host.appendChild(build(root, 'root'));
    for (const p of panels.values()) p.el.classList.add('dPanel');
    restoreScroll(sc);
    // scroll positions inside re-attached elements are restored after layout
    requestAnimationFrame(() => { restoreScroll(sc); fire(); });
    host.classList.toggle('dEmpty', !root);
  }

  function build(n, key) {
    if (n.t === 'leaf') return buildLeaf(n);
    const g = dom('div', 'dNode dSplit ' + n.d);
    const cells = n.c.map((k, i) => {
      const c = dom('div', 'dCell');
      c.style.flexGrow = String(n.s[i]);
      c.appendChild(build(k, key + '.' + i));
      return c;
    });
    cells.forEach((c, i) => {
      g.appendChild(c);
      if (i < cells.length - 1) {
        const sp = dom('div', 'dSp ' + (n.d === 'h' ? 'dv' : 'dh'));
        sp.title = 'Drag to resize';
        sp.onpointerdown = (e) => dragSplitter(e, sp, n, i, cells, g);
        g.appendChild(sp);
      }
    });
    return g;
  }

  function buildLeaf(n) {
    const l = dom('div', 'dNode dLeaf');
    l.dataset.leaf = n.id;
    const head = dom('div', 'dHead');
    n.p.forEach((id, i) => {
      const p = panels.get(id);
      const t = dom('div', 'dTab' + (i === n.a ? ' on' : ''));
      t.dataset.panel = id;
      const nm = dom('span', 'dTitle', typeof p.title === 'function' ? p.title() : p.title);
      t.appendChild(nm);
      if (p.closable) {
        const x = dom('button', 'dClose', '×');
        x.title = 'Close';
        x.onpointerdown = (e) => e.stopPropagation();
        x.onclick = (e) => { e.stopPropagation(); if (p.onClose) p.onClose(); else hide(id); };
        t.appendChild(x);
      }
      t.onpointerdown = (e) => tabDown(e, id, t);
      t.onclick = () => { if (n.a !== i) { n.a = i; render(); save(); } };
      head.appendChild(t);
    });
    const body = dom('div', 'dBody');
    const active = panels.get(n.p[n.a]);
    if (active) { active.el.hidden = false; body.appendChild(active.el); }
    l.append(head, body);
    return l;
  }

  /* ---------- splitters ---------- */
  function dragSplitter(e, sp, n, i, cells, g) {
    e.preventDefault();
    const horiz = n.d === 'h';
    const a = cells[i], b = cells[i + 1];
    const fa = n.s[i], fb = n.s[i + 1], total = fa + fb;
    const size = horiz ? g.clientWidth : g.clientHeight;
    const sumAll = n.s.reduce((x, y) => x + y, 0);
    const start = horiz ? e.clientX : e.clientY;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('on');
    const move = (ev) => {
      const d = ((horiz ? ev.clientX : ev.clientY) - start) / Math.max(1, size) * sumAll;
      const na = Math.max(MIN_FR * total, Math.min(total - MIN_FR * total, fa + d));
      a.style.flexGrow = String(na); b.style.flexGrow = String(total - na);
      n.s[i] = na; n.s[i + 1] = total - na;
    };
    const up = () => {
      sp.classList.remove('on');
      sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
      fire(); save();
    };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  }

  /* ---------- dragging panels ---------- */
  let drag = null;
  function zoneAt(x, y) {
    const hostR = host.getBoundingClientRect();
    const EDGE = 14;
    if (x < hostR.left || x > hostR.right || y < hostR.top || y > hostR.bottom) return null;
    // outer edges of the whole dock: wrap everything
    const root0 = { x: x - hostR.left, y: y - hostR.top };
    if (root0.x < EDGE) return { root: true, zone: 'left', rect: { left: hostR.left, top: hostR.top, width: hostR.width * 0.3, height: hostR.height } };
    if (root0.x > hostR.width - EDGE) return { root: true, zone: 'right', rect: { left: hostR.right - hostR.width * 0.3, top: hostR.top, width: hostR.width * 0.3, height: hostR.height } };
    if (root0.y < EDGE) return { root: true, zone: 'top', rect: { left: hostR.left, top: hostR.top, width: hostR.width, height: hostR.height * 0.3 } };
    if (root0.y > hostR.height - EDGE) return { root: true, zone: 'bottom', rect: { left: hostR.left, top: hostR.bottom - hostR.height * 0.3, width: hostR.width, height: hostR.height * 0.3 } };
    const el = document.elementFromPoint(x, y);
    const lf = el && el.closest && el.closest('.dLeaf');
    if (!lf) return null;
    const r = lf.getBoundingClientRect();
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    const T = 0.28;
    let zone = 'center';
    const dl = fx, dr = 1 - fx, dt = fy, db = 1 - fy;
    const m = Math.min(dl, dr, dt, db);
    if (m < T) zone = m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom';
    const rect = zone === 'left' ? { left: r.left, top: r.top, width: r.width / 2, height: r.height }
      : zone === 'right' ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
        : zone === 'top' ? { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
          : zone === 'bottom' ? { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 } : { left: r.left, top: r.top, width: r.width, height: r.height };
    return { leaf: lf.dataset.leaf, zone, rect };
  }

  function tabDown(e, id, tabEl) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    const onMove = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        started = true;
        drag = { id, ghost: dom('div', 'dGhost', tabEl.textContent.replace(/×$/, '')), drop: dom('div', 'dDrop'), target: null };
        document.body.append(drag.ghost, drag.drop);
        document.body.classList.add('dDragging');
      }
      drag.ghost.style.left = ev.clientX + 12 + 'px';
      drag.ghost.style.top = ev.clientY + 12 + 'px';
      const z = zoneAt(ev.clientX, ev.clientY);
      drag.target = z;
      if (!z) { drag.drop.style.display = 'none'; return; }
      const same = !z.root && findLeaf(id) && findLeaf(id).n.id === z.leaf && findLeaf(id).n.p.length === 1;
      if (same) { drag.target = null; drag.drop.style.display = 'none'; return; }
      Object.assign(drag.drop.style, { display: 'block', left: z.rect.left + 'px', top: z.rect.top + 'px', width: z.rect.width + 'px', height: z.rect.height + 'px' });
    };
    const finish = (apply) => {
      document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('keydown', onKey, true);
      if (!started) return;
      const t = drag && drag.target;
      drag.ghost.remove(); drag.drop.remove();
      document.body.classList.remove('dDragging');
      const d = drag; drag = null;
      if (apply && t) place(d.id, t);
    };
    const onUp = () => finish(true);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey, true);
  }

  function place(id, t) {
    if (t.root) {
      removeFromTree(id);
      root = normalize(root);
      if (!root) root = leaf([id]); else insertAtRoot(id, t.zone);
    } else {
      const target = findLeafById(t.leaf);
      if (!target) return;
      removeFromTree(id);
      // the target leaf may have just emptied (dragging a leaf's only panel onto itself is filtered earlier)
      insertAt(id, target.n, t.zone);
    }
    render(); save();
  }

  /* ---------- public API ---------- */
  function fire() { for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } }
  function save() { if (saveFn) saveFn(serialize()); }
  const serialize = () => (root ? clone(root) : null);

  function register(p) {
    panels.set(p.id, { closable: true, ...p });
    p.el.classList.add('dPanel');
    p.el.hidden = true;
    (park || document.getElementById('dockPark') || document.body).appendChild(p.el);
    return p;
  }
  function unregister(id) {
    if (isVisible(id)) { removeFromTree(id); render(); }
    const p = panels.get(id);
    if (p && p.el.parentNode) p.el.remove();
    panels.delete(id);
    save();
  }

  // Where a panel goes when it is shown and nothing says otherwise.
  const DEFAULT_PLACE = { terminal: { near: 'chat', zone: 'bottom', ratio: 0.3 }, editor: { near: 'chat', zone: 'right', ratio: 0.5 } };
  function show(id, hint) {
    if (!panels.has(id)) return false;
    const f = findLeaf(id);
    if (f) { f.n.a = f.n.p.indexOf(id); render(); return true; }
    let rule = hint || DEFAULT_PLACE[id.replace(/\d+$/, '')] || { near: 'chat', zone: 'right', ratio: 0.5 };
    if (!hint && id === 'terminal' && host) {
      // the Settings > Layout "terminal height" is the terminal's starting share of the area
      const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--termh')) || 280;
      rule = { ...rule, ratio: Math.max(0.15, Math.min(0.7, px / Math.max(300, host.clientHeight))) };
    }
    if (!root) root = leaf([id]);
    else {
      const near = findLeaf(rule.near) || findLeaf('chat') || findLeaf(visibleIds()[0]);
      if (near) insertAt(id, near.n, rule.zone, rule.ratio); else insertAtRoot(id, rule.zone);
    }
    render(); save();
    return true;
  }
  function hide(id) {
    if (!isVisible(id)) return false;
    removeFromTree(id);
    render(); save();
    return true;
  }
  function move(id, nearId, zone) {
    const near = findLeaf(nearId);
    if (!near || !panels.has(id) || id === nearId) return false;
    removeFromTree(id);
    const t = findLeaf(nearId);
    insertAt(id, t.n, zone);
    render(); save();
    return true;
  }
  function defaultLayout() { return leaf(['chat']); }
  function reset() {
    const keep = visibleIds().filter((id) => id !== 'chat');
    root = defaultLayout();
    for (const id of keep) { const rule = DEFAULT_PLACE[id.replace(/\d+$/, '')]; if (id === 'terminal' || /^editor/.test(id)) { const near = findLeaf(rule.near); insertAt(id, near.n, rule.zone, rule.ratio); } }
    render(); save();
  }
  function restore(tree) {
    if (!tree || typeof tree !== 'object') return false;
    const t = clone(tree);
    walk(t, (n) => { if (n.t === 'leaf') n.id = 'L' + (++seq); });
    // unknown panels are dropped; chat must always be there
    root = normalize(t);
    if (!root) root = defaultLayout();
    if (!isVisible('chat')) { const first = findLeaf(visibleIds()[0]); insertAt('chat', first.n, 'left', 0.5); }
    render();
    return true;
  }
  function start() {
    host = document.getElementById('dock');
    park = document.getElementById('dockPark');
    for (const p of panels.values()) park.appendChild(p.el);
    root = defaultLayout();
    render();
  }
  const refresh = () => { if (host) render(); };

  return {
    register, unregister, show, hide, move, reset, restore, serialize, start, refresh,
    toggle(id) { return isVisible(id) ? hide(id) : show(id); },
    visible: isVisible, panelIds: () => [...panels.keys()], visibleIds,
    onChange: (f) => listeners.push(f),
    onSave: (f) => { saveFn = f; },
    title: (id, t) => { const p = panels.get(id); if (p) { p.title = t; if (isVisible(id)) { const e = host.querySelector(`.dTab[data-panel="${id}"] .dTitle`); if (e) e.textContent = typeof t === 'function' ? t() : t; } } },
    setActive: (id) => { const f = findLeaf(id); if (f && f.n.p[f.n.a] !== id) { f.n.a = f.n.p.indexOf(id); render(); } },
    leafOf: (id) => { const f = findLeaf(id); return f ? f.n.id : null; },
  };
})();

// the chat is always part of the layout
Dock.register({ id: 'chat', title: 'Chat', el: document.getElementById('chatPanel'), closable: false });
Dock.start();   // the dock exists from now on; panels registered later by editor.js / terminal.js just park until shown
