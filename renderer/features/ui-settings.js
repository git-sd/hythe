/* feature: ui-settings. Settings window, themes, layout, editor/terminal options, rebindable shortcuts,
   command palette. Settings are applied live and persisted with F.saveFeatureSettings('ui-settings', ...).
   A copy lives in localStorage so the right theme is applied before the first paint. */
Faber.register('ui-settings', (F) => {
  const $ = (id) => document.getElementById(id);
  const el = F.el;
  const root = document.documentElement;
  const CACHE = 'faber.ui-settings.v1';

  /* ================= themes ================= */
  const DARK_X = { treeText: '#cfcfd6', gutter: '#55555f', edSel: '#4c3a86', tkc: '#6b6b78', tks: '#a5d6a7', tkn: '#f0a97b', tkk: '#b69cff' };
  const THEMES = [
    { id: 'violet', name: 'Violet', dark: true, x: DARK_X,
      c: { bg: '#0e0e10', panel: '#151518', panel2: '#1c1c20', hover: '#24202e', sel: '#2d2640', border: '#2c2c32', text: '#e6e6ea', muted: '#8a8a94', accent: '#8b5cf6', ok: '#4ade80', bad: '#f87171' } },
    { id: 'midnight', name: 'Midnight', dark: true, x: { ...DARK_X, edSel: '#27427a' },
      c: { bg: '#0b1020', panel: '#101729', panel2: '#162036', hover: '#1d2a47', sel: '#223559', border: '#243252', text: '#dbe4f5', muted: '#8294b4', accent: '#3b82f6', ok: '#4ade80', bad: '#f87171' } },
    { id: 'graphite', name: 'Graphite', dark: true, x: { ...DARK_X, edSel: '#2f5a55' },
      c: { bg: '#121212', panel: '#1a1a1a', panel2: '#222222', hover: '#2a2a2a', sel: '#30403f', border: '#333333', text: '#e8e8e8', muted: '#9a9a9a', accent: '#2dd4bf', ok: '#4ade80', bad: '#f87171' } },
    { id: 'ember', name: 'Ember', dark: true, x: { ...DARK_X, edSel: '#6b4220' },
      c: { bg: '#130f0d', panel: '#1b1512', panel2: '#231b17', hover: '#2e2119', sel: '#3a2a1d', border: '#36291f', text: '#efe6df', muted: '#a8978a', accent: '#f59e0b', ok: '#4ade80', bad: '#f87171' } },
    { id: 'daylight', name: 'Daylight', dark: false,
      x: { treeText: '#3a3a44', gutter: '#8a8a96', edSel: '#cbbdf5', tkc: '#6b6b78', tks: '#1a7f37', tkn: '#a8480a', tkk: '#6d28d9' },
      c: { bg: '#ffffff', panel: '#f4f4f6', panel2: '#eaeaee', hover: '#e4e0f0', sel: '#dcd5f3', border: '#d2d2da', text: '#1d1d22', muted: '#62626e', accent: '#7c3aed', ok: '#15803d', bad: '#dc2626' } },
  ];
  const ACCENTS = [['Violet', '#8b5cf6'], ['Blue', '#3b82f6'], ['Teal', '#14b8a6'], ['Green', '#22c55e'], ['Amber', '#f59e0b'], ['Orange', '#f97316'], ['Pink', '#ec4899'], ['Red', '#ef4444']];
  const ANSI_LIGHT = { black: '#1d1d22', red: '#c62828', green: '#15803d', yellow: '#a16207', blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0e7490', white: '#6a6a76',
    brightBlack: '#4b4b57', brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#9333ea', brightCyan: '#0891b2', brightWhite: '#1d1d22' };

  /* colour helpers */
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (a) => '#' + a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
  const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

  /* ================= settings model ================= */
  const KEYS = [
    { id: 'toggleTerminal', label: 'Toggle terminal', def: 'Ctrl+`', how: 'core', menu: ['view.terminal', 'term.toggle'] },
    { id: 'toggleEditor', label: 'Toggle editor', def: 'Ctrl+Alt+E', how: 'menu', menu: ['view.editor'] },
    { id: 'reload', label: 'Reload files from disk', def: 'F5', how: 'main', menu: ['view.reload'] },
    { id: 'openSettings', label: 'Open settings', def: 'Ctrl+,', how: 'own', menu: ['file.settings'] },
    { id: 'focusChat', label: 'Focus chat input', def: 'Ctrl+1', how: 'menu', menu: ['go.chat'] },
    { id: 'palette', label: 'Command palette', def: 'Ctrl+Shift+P', how: 'own', menu: ['view.palette'] },
  ];
  const DEFAULTS = {
    theme: 'violet', accent: null, uiFont: 14, density: 'comfortable', radius: 'small',
    ed: { fontSize: 13, lineHeight: 1.55, tab: 2, wrap: false, lineNumbers: true },
    term: { fontSize: 13, cursor: 'block', scrollback: 5000 },
    layout: { side: 'left', rail: 'left', hiddenRail: [], sideW: 250, chatW: 860, termH: 280, hiddenChips: [] },
    keys: Object.fromEntries(KEYS.map((k) => [k.id, k.def])),
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, min, max, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def; };
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const edLh = (c) => Math.round(c.ed.fontSize * c.ed.lineHeight);

  /* shortcuts: "Ctrl+Alt+Shift+Key" */
  const CODES = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Space: 'Space' };
  const MODS = ['Control', 'Shift', 'Alt', 'Meta'];
  function comboList(e) {
    if (MODS.includes(e.key)) return [];
    const mods = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '');
    const out = [];
    const c = e.code || '';
    let k = null;
    if (/^Key[A-Z]$/.test(c)) k = c.slice(3);
    else if (/^Digit\d$/.test(c)) k = c.slice(5);
    else if (CODES[c]) k = CODES[c];
    else if (/^(F\d+|Arrow\w+|Page\w+|Home|End|Insert|Delete|Enter|Escape|Tab|Backspace)$/.test(c)) k = c;
    if (k) out.push(mods + k);
    const kk = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!out.includes(mods + kk)) out.push(mods + kk);
    return out;
  }
  const validCombo = (s) => typeof s === 'string' && s.length < 40 && /^((Ctrl|Alt|Shift)\+){0,3}[^+\s]+$|^((Ctrl|Alt|Shift)\+){0,3}\+$/.test(s);

  function sanitize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = clone(DEFAULTS);
    const out = {
      theme: oneOf(r.theme, THEMES.map((t) => t.id), d.theme),
      accent: isHex(r.accent) ? r.accent.toLowerCase() : null,
      uiFont: Math.round(num(r.uiFont, 11, 20, d.uiFont)),
      density: oneOf(r.density, ['comfortable', 'compact'], d.density),
      radius: oneOf(r.radius, ['small', 'none'], d.radius),
      ed: {
        fontSize: Math.round(num(r.ed?.fontSize, 9, 28, d.ed.fontSize)),
        lineHeight: Math.round(num(r.ed?.lineHeight, 1.1, 2.4, d.ed.lineHeight) * 100) / 100,
        tab: Math.round(num(r.ed?.tab, 1, 8, d.ed.tab)),
        wrap: r.ed?.wrap === true,
        lineNumbers: r.ed?.lineNumbers !== false,
      },
      term: {
        fontSize: Math.round(num(r.term?.fontSize, 8, 28, d.term.fontSize)),
        cursor: oneOf(r.term?.cursor, ['block', 'underline', 'bar'], d.term.cursor),
        scrollback: Math.round(num(r.term?.scrollback, 500, 100000, d.term.scrollback)),
      },
      layout: {
        side: oneOf(r.layout?.side, ['left', 'right'], d.layout.side),
        rail: oneOf(r.layout?.rail, ['left', 'right'], d.layout.rail),
        hiddenRail: Array.isArray(r.layout?.hiddenRail) ? r.layout.hiddenRail.filter((x) => typeof x === 'string' && x.length < 60 && x !== 'Settings').slice(0, 40) : [],
        sideW: Math.round(num(r.layout?.sideW, 160, 600, d.layout.sideW)),
        chatW: Math.round(num(r.layout?.chatW, 520, 1600, d.layout.chatW)),
        termH: Math.round(num(r.layout?.termH, 120, 700, d.layout.termH)),
        hiddenChips: Array.isArray(r.layout?.hiddenChips) ? r.layout.hiddenChips.filter((x) => typeof x === 'string' && /^[\w-]+$/.test(x)).slice(0, 40) : [],
      },
      keys: {},
    };
    const used = new Set();
    for (const k of KEYS) {
      let v = r.keys && Object.prototype.hasOwnProperty.call(r.keys, k.id) ? r.keys[k.id] : k.def;
      if (v !== '' && !validCombo(v)) v = k.def;
      if (v && used.has(v)) v = used.has(k.def) ? '' : k.def;     // duplicates fall back to the default
      if (v) used.add(v);
      out.keys[k.id] = v;
    }
    return out;
  }

  let cfg = sanitize(null);
  try { cfg = sanitize(JSON.parse(localStorage.getItem(CACHE))); } catch { /* no cache yet */ }

  /* ================= apply ================= */
  const styleEl = document.head.appendChild(Object.assign(document.createElement('style'), { id: 'uisVars' }));
  const themeOf = (c) => THEMES.find((t) => t.id === c.theme) || THEMES[0];
  const accentOf = (c) => c.accent || themeOf(c).c.accent;
  let lastTermH = null;

  function termTheme(c) {
    const th = themeOf(c), a = accentOf(c), custom = a !== th.c.accent;
    const sel = custom ? mix(th.c.bg, a, th.dark ? 0.4 : 0.3) : th.x.edSel;
    const base = typeof TERM_THEME !== 'undefined' ? TERM_THEME : {};
    return { ...base, ...(th.dark ? {} : ANSI_LIGHT), background: th.c.bg, foreground: th.c.text, cursor: a, cursorAccent: th.c.bg, selectionBackground: sel };
  }

  function applyCss(c) {
    const th = themeOf(c), t = th.c, a = accentOf(c), custom = a !== t.accent;
    const v = {
      bg: t.bg, panel: t.panel, panel2: t.panel2, border: t.border, text: t.text, muted: t.muted, ok: t.ok, bad: t.bad,
      hover: custom ? mix(t.panel2, a, 0.1) : t.hover, sel: custom ? mix(t.panel2, a, 0.22) : t.sel,
      'on-accent': lum(a) > 0.4 ? '#111111' : '#ffffff',
      'tree-text': th.x.treeText, gutter: th.x.gutter, 'ed-sel': custom ? mix(t.bg, a, th.dark ? 0.4 : 0.3) : th.x.edSel,
      'tk-c': th.x.tkc, 'tk-s': th.x.tks, 'tk-n': th.x.tkn, 'tk-k': th.x.tkk,
      'ui-fs': c.uiFont + 'px', 'ed-font-size': c.ed.fontSize + 'px', 'ed-lh': edLh(c) + 'px', 'ed-tab': c.ed.tab,
      'side-w': c.layout.sideW + 'px', 'chat-w': c.layout.chatW + 'px', termh: c.layout.termH + 'px', 'term-prev-fs': c.term.fontSize + 'px',
    };
    let css = ':root{color-scheme:' + (th.dark ? 'dark' : 'light') + ';' + Object.entries(v).map(([k, x]) => `--${k}:${x}`).join(';') + ';--accent:' + a + ' !important}';
    for (const id of c.layout.hiddenChips) css += `#bar #${id}{display:none !important}`;
    for (const t of c.layout.hiddenRail) css += `#rail .rbtn[title="${t.replace(/["\\]/g, '\\$&')}"]{display:none !important}`;
    styleEl.textContent = css;
    root.dataset.density = c.density;
    root.dataset.radius = c.radius;
    root.dataset.side = c.layout.side;
    root.dataset.rail = c.layout.rail;
    root.classList.toggle('uis-no-ln', !c.ed.lineNumbers);
    if (lastTermH !== c.layout.termH) { lastTermH = c.layout.termH; $('term')?.style.removeProperty('--termh'); }
  }

  let wrapNotified = false;
  function applyRuntime(c) {
    if (typeof edCfg !== 'undefined') edCfg.tab = c.ed.tab;
    if (typeof applyTermConfig === 'function') applyTermConfig({ fontSize: c.term.fontSize, cursorStyle: c.term.cursor, scrollback: c.term.scrollback, theme: termTheme(c) });
    if (typeof readEdMetrics === 'function') readEdMetrics();
    relayout();
    syncMenus();
  }
  function applyAll() { applyCss(cfg); applyRuntime(cfg); }

  /* ---- word wrap: keep the line numbers and the change highlight aligned with wrapped lines ---- */
  let measure = null;
  function relayout() {
    const wrap = cfg.ed.wrap;
    const ta = $('edText'), gut = $('edGutter');
    if (!ta || !gut) return;
    const t = typeof tabs !== 'undefined' ? tabs[activeTab] : null;
    const lines = t ? t.text.split('\n') : [];
    const tooBig = lines.length > 4000;
    const on = wrap && !tooBig;
    if (wrap && tooBig && !wrapNotified) { wrapNotified = true; F.toast('Word wrap is off for very large files (over 4000 lines).'); }
    root.classList.toggle('uis-wrap', on);
    ta.setAttribute('wrap', on ? 'soft' : 'off');
    if (!on) {
      if (edLayout.starts) { edLayout.starts = null; delete gut.dataset.n; if (t) syncEditor(); }
      return;
    }
    if (!t || !ta.clientWidth) return;
    if (!measure) measure = $('edWrap').appendChild(Object.assign(document.createElement('div'), { id: 'edMeasure' }));
    measure.style.width = ta.clientWidth + 'px';
    const frag = document.createDocumentFragment();
    for (const ln of lines) frag.appendChild(Object.assign(document.createElement('div'), { textContent: ln || '\u200b' }));
    measure.replaceChildren(frag);
    readEdMetrics();
    const starts = [0], nums = [];
    [...measure.children].forEach((k, i) => {
      const n = Math.max(1, Math.round(k.offsetHeight / LINE_H));
      starts.push(starts[i] + n);
      nums.push((i + 1) + '\n'.repeat(n - 1));
    });
    edLayout.starts = starts;
    gut.textContent = nums.join('\n');
    gut.scrollTop = ta.scrollTop;
    positionFlash();
  }
  F.onEvent('editor-sync', () => { if (cfg.ed.wrap) relayout(); });
  if (window.ResizeObserver && $('edWrap')) {
    let raf = 0;
    new ResizeObserver(() => { if (cfg.ed.wrap && !raf) raf = requestAnimationFrame(() => { raf = 0; relayout(); }); }).observe($('edWrap'));
  }

  /* ================= persistence ================= */
  let saveTimer = null;
  const snapshot = () => ({ ...clone(cfg), bg: themeOf(cfg).c.bg });
  function cacheWrite() { try { localStorage.setItem(CACHE, JSON.stringify(cfg)); } catch { /* storage unavailable */ } }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    cacheWrite();
    try { Promise.resolve(F.saveFeatureSettings('ui-settings', snapshot())).catch(() => {}); } catch { /* not ready */ }
    syncCoreAccent();
  }
  function persist(now) {
    cacheWrite();
    clearTimeout(saveTimer);
    if (now) flush(); else saveTimer = setTimeout(flush, 300);
  }
  window.addEventListener('beforeunload', () => { cacheWrite(); });

  /* The core /accent command keeps working: the core setting mirrors our effective accent, and an accent
     changed from outside (the command) is adopted as our custom accent. */
  let coreAccentSeen = null;
  function syncCoreAccent() {
    const a = accentOf(cfg);
    try { if ((F.settings().accent || '').toLowerCase() !== a) { coreAccentSeen = a; F.saveSettings({ accent: a }); } } catch { /* not ready */ }
  }
  F.onEvent('settings', (s) => {
    const ca = String(s.accent || '').toLowerCase();
    if (coreAccentSeen === null) { coreAccentSeen = ca; return; }
    if (ca === coreAccentSeen) return;
    coreAccentSeen = ca;
    if (isHex(ca) && ca !== accentOf(cfg)) { cfg.accent = ca === themeOf(cfg).c.accent ? null : ca; applyAll(); persist(); refreshWin(); }
  });

  /** One change entry point: mutate cfg inside fn, then apply + persist. */
  function change(fn, opts = {}) {
    fn(cfg);
    cfg = sanitize(cfg);
    applyAll();
    persist(opts.now);
    if (opts.redraw) refreshWin();
  }
  function setTheme(id) { change((c) => { c.theme = id; }, { redraw: true }); }

  /* ================= sidebar drag handle ================= */
  const handle = $('side').appendChild(Object.assign(document.createElement('div'), { id: 'sideResize' }));
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize sidebar');
  handle.tabIndex = 0;
  const setSideW = (w, now) => change((c) => { c.layout.sideW = w; }, { now });
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('drag');
    const r = $('side').getBoundingClientRect();
    const move = (ev) => {
      const w = cfg.layout.side === 'right' ? r.right - ev.clientX : ev.clientX - r.left;
      cfg.layout.sideW = Math.round(Math.min(600, Math.max(160, w)));
      applyCss(cfg);
    };
    const up = () => { handle.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); persist(); refreshWin(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  handle.addEventListener('dblclick', () => setSideW(DEFAULTS.layout.sideW));
  handle.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    setSideW(cfg.layout.sideW + 10 * dir * (cfg.layout.side === 'right' ? -1 : 1));
  });

  /* ================= actions + keyboard ================= */
  const actions = [];
  F.addAction = ({ id, title, hint, run }) => {
    const a = { id, title, hint: hint || '', run };
    const i = actions.findIndex((x) => x.id === id);
    if (i >= 0) actions[i] = a; else actions.push(a);
    return a;
  };
  F.actions = () => actions;

  const keyRun = {
    toggleTerminal: () => showTerm(),
    toggleEditor: () => toggleEditor(),
    reload: () => reloadAll(),
    openSettings: () => openSettings(),
    focusChat: () => $('input').focus(),
    palette: () => openPalette(),
  };
  const menuItemsById = (id) => { const out = []; for (const items of (F.menus ? F.menus().values() : [])) for (const it of items) if (it.id === id) out.push(it); return out; };
  function syncMenus() {
    for (const k of KEYS) {
      const combo = cfg.keys[k.id];
      for (const mid of k.menu) {
        if (k.how === 'menu' && F.setMenuShortcut) F.setMenuShortcut(mid, combo);    // the menu bar binds these keys itself
        else for (const it of menuItemsById(mid)) it.shortcut = combo;                // label only; we handle the key
      }
    }
  }

  let recording = false;
  const reservedBy = (combo, exceptId) => {
    if (['F5', 'Ctrl+R'].includes(combo)) return exceptId === 'reload' && combo === 'F5' ? null : 'Reload files (F5 and Ctrl+R are handled by the app)';
    if (['Ctrl+S', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y'].includes(combo)) return 'a standard editing shortcut';
    const mine = new Set(KEYS.flatMap((k) => k.menu));
    for (const items of (F.menus ? F.menus().values() : [])) for (const it of items) {
      if (!it.keys || mine.has(it.id)) continue;
      if (String(it.keys).replace(/\s+/g, '').toLowerCase() === combo.toLowerCase()) return 'the menu item "' + it.label + '"';
    }
    return null;
  };
  /** null when the combo can be used for action id, otherwise a sentence explaining why not. */
  function conflict(id, combo) {
    if (!combo) return null;
    if (!/(^|\+)[^+]+$/.test(combo) || !(/^(.*\+)?(Ctrl|Alt)\+/.test(combo) || /^F\d+$/.test(combo.split('+').pop()))) return 'Use Ctrl or Alt together with a key (or an F key).';
    const other = KEYS.find((k) => k.id !== id && cfg.keys[k.id] === combo);
    if (other) return combo + ' is already used by "' + other.label + '".';
    const r = reservedBy(combo, id);
    if (r) return combo + ' is reserved by ' + r + '.';
    return null;
  }

  window.addEventListener('keydown', (e) => {
    if (recording || e.isComposing || $('app').hidden) return;
    const combos = comboList(e);
    if (!combos.length) return;
    const k = KEYS.find((x) => cfg.keys[x.id] && combos.includes(cfg.keys[x.id]));
    if (k) {
      if (k.how === 'menu') return;                                          // the menu bar handles it
      if (k.how === 'core' && cfg.keys[k.id] === k.def) return;              // app.js handles Ctrl+`
      if (k.how === 'main' && cfg.keys[k.id] === k.def) return;              // main.js handles F5
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) keyRun[k.id]();
      return;
    }
    if (combos.includes('Ctrl+`') && cfg.keys.toggleTerminal !== 'Ctrl+`') { e.preventDefault(); e.stopPropagation(); }   // old binding is released
  }, true);

  /* ================= command palette ================= */
  let pal = null;
  function paletteItems() {
    const items = [];
    const keyOf = { 'toggle-terminal': 'toggleTerminal', 'toggle-editor': 'toggleEditor', reload: 'reload', 'focus-chat': 'focusChat', 'open-settings': 'openSettings' };
    for (const a of actions) items.push({ kind: 'Action', title: a.title, detail: a.hint, key: cfg.keys[keyOf[a.id]] || '', run: a.run });
    for (const s of settingsList()) items.push({ kind: 'Settings', title: 'Settings: ' + s.title, detail: 'Open the ' + s.title + ' section', run: () => openSettings(s.id) });
    document.querySelectorAll('#sideTabs .stab').forEach((b) => items.push({ kind: 'Sidebar', title: 'Show tab: ' + b.textContent, detail: '', run: () => b.click() }));
    document.querySelectorAll('#headerExtra button').forEach((b) => { if (b.id !== 'settingsBtn') items.push({ kind: 'Button', title: b.textContent || b.title, detail: b.title || '', run: () => b.click() }); });
    for (const [name, [args, desc]] of Object.entries(commands)) {
      items.push({ kind: 'Command', title: '/' + name, detail: (args ? args + ' - ' : '') + desc, args, name, key: '' });
    }
    return items;
  }
  function runCmdItem(it) {
    // commands that need an argument are put in the chat input instead of running with nothing
    if (/[<|]/.test(it.args || '')) { const i = $('input'); i.value = '/' + it.name + ' '; i.focus(); i.dispatchEvent(new Event('input')); return; }
    runCommand('/' + it.name);
  }
  function score(it, toks) {
    const t = it.title.toLowerCase().replace(/^\//, ''), hay = (it.kind + ' ' + it.title + ' ' + it.detail).toLowerCase();
    let s = 0;
    for (const w of toks) {
      if (!hay.includes(w)) return -1;
      s += t.startsWith(w) ? 3 : t.includes(w) ? 2 : 1;
    }
    return s;
  }
  function openPalette() {
    if (pal) { pal.input.focus(); return; }
    const back = el('div'); back.id = 'uisPalette';
    const box = el('div', 'box');
    const input = el('input'); input.placeholder = 'Type a command or action'; input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'uisPalList'); input.setAttribute('aria-label', 'Command palette'); input.spellcheck = false; input.autocomplete = 'off';
    const list = el('div', 'list'); list.id = 'uisPalList'; list.setAttribute('role', 'listbox');
    box.append(input, list); back.append(box); document.body.append(back);
    const all = paletteItems();
    let shown = [], sel = 0;
    const paint = () => {
      const toks = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = all.map((it, i) => [it, score(it, toks), i]).filter((x) => x[1] >= 0).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map((x) => x[0]);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren();
      if (!shown.length) list.append(el('div', 'none', 'No matching commands'));
      shown.slice(0, 80).forEach((it, i) => {
        const r = el('div', 'it' + (i === sel ? ' sel' : '')); r.id = 'uisPal' + i; r.setAttribute('role', 'option'); r.setAttribute('aria-selected', i === sel);
        r.append(el('span', 'kind', it.kind), el('b', '', it.title), el('span', 'd', it.detail));
        if (it.key) r.append(el('span', 'k', it.key));
        r.onmousedown = (e) => { e.preventDefault(); run(it); };
        list.append(r);
      });
      input.setAttribute('aria-activedescendant', shown.length ? 'uisPal' + sel : '');
      list.children[sel]?.scrollIntoView?.({ block: 'nearest' });
    };
    const close = () => { back.remove(); pal = null; document.removeEventListener('keydown', onKey, true); };
    const run = (it) => { close(); setTimeout(() => { try { if (it.kind === 'Command') runCmdItem(it); else it.run(); } catch (e) { F.error(e.message); } }, 0); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + Math.min(shown.length, 80)) % Math.min(shown.length, 80); paint(); } }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (shown[sel]) run(shown[sel]); }
    };
    document.addEventListener('keydown', onKey, true);
    input.addEventListener('input', () => { sel = 0; paint(); });
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    pal = { input, close };
    paint();
    input.focus();
  }
  F.openPalette = openPalette;

  /* ================= settings window ================= */
  let win = null;      // {m, nav, pane, cur}
  const BUILTIN_HEAD = ['appearance', 'editor', 'terminal', 'layout', 'keyboard'];
  function builtins() {
    return {
      appearance: { id: 'appearance', title: 'Appearance', render: secAppearance },
      editor: { id: 'editor', title: 'Editor', render: secEditor },
      terminal: { id: 'terminal', title: 'Terminal', render: secTerminal },
      layout: { id: 'layout', title: 'Layout', render: secLayout },
      keyboard: { id: 'keyboard', title: 'Keyboard', render: secKeyboard },
      data: { id: 'data', title: 'Data', render: secData },
    };
  }
  function settingsList() {
    const b = builtins();
    const ids = new Set([...BUILTIN_HEAD, 'data']);
    const extra = F.settingsSections().filter((s) => s && s.id && !ids.has(s.id));
    return [...BUILTIN_HEAD.map((i) => b[i]), ...extra, b.data];
  }

  function openSettings(sectionId) {
    if (win && win.m.el.isConnected) { select(sectionId || win.cur); win.nav.querySelector('[aria-selected="true"]')?.focus(); return; }
    let nav, pane;
    const m = F.modal({
      title: 'Settings', wide: true,
      body: (body) => {
        nav = el('div', 'uisNav'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-orientation', 'vertical'); nav.setAttribute('aria-label', 'Settings sections');
        pane = el('div', 'uisPane'); pane.setAttribute('role', 'tabpanel'); pane.id = 'uisPane';
        body.append(nav, pane);
      },
    });
    m.el.closest('.modalCard').classList.add('uisWin');
    win = { m, nav, pane, cur: null };
    keyMsg = { t: '', bad: false };
    nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const ids = settingsList().map((s) => s.id), i = ids.indexOf(win.cur);
      select(ids[(i + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length]);
      nav.querySelector('[aria-selected="true"]').focus();
    });
    select(sectionId || 'appearance');
    nav.querySelector('[aria-selected="true"]')?.focus();
  }
  F.openSettings = openSettings;

  function select(id) {
    if (!win) return;
    const list = settingsList();
    const s = list.find((x) => x.id === id) || list[0];
    win.cur = s.id;
    win.nav.replaceChildren();
    for (const x of list) {
      const b = el('button', '', x.title);
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', x.id === s.id); b.setAttribute('aria-controls', 'uisPane'); b.tabIndex = x.id === s.id ? 0 : -1; b.dataset.sec = x.id;
      b.onclick = () => select(x.id);
      win.nav.append(b);
    }
    drawSection(s);
  }
  function drawSection(s) {
    const keep = document.activeElement?.dataset?.k;
    win.pane.replaceChildren();
    try { s.render(win.pane); } catch (e) { console.error(e); win.pane.append(el('p', 'err', 'This section failed to load: ' + e.message)); }
    win.pane.scrollTop = 0;
    if (keep) win.pane.querySelector('[data-k="' + keep + '"]')?.focus();
  }
  function refreshWin() {
    if (!win || !win.m.el.isConnected) return;
    const top = win.pane.scrollTop;
    const s = settingsList().find((x) => x.id === win.cur);
    if (s) { drawSection(s); win.pane.scrollTop = top; }
  }

  /* ---- control builders ---- */
  let uid = 0;
  function head(p, title, onReset) {
    const h = el('div', 'uisHead');
    h.append(el('h2', '', title));
    if (onReset) { const b = el('button', '', 'Reset section'); b.title = 'Restore the defaults for this section'; b.onclick = onReset; h.append(b); }
    p.append(h);
  }
  function row(p, label, desc, ctl, forId) {
    const r = el('div', 'uisRow'), t = el('div', 'uisRowText'), l = el('label', 'uisLabel', label);
    if (forId) l.htmlFor = forId;
    t.append(l);
    if (desc) t.append(el('div', 'uisDesc', desc));
    const c = el('div', 'uisCtl'); c.append(ctl);
    r.append(t, c); p.append(r);
    return r;
  }
  function seg(label, options, value, onPick) {
    const g = el('div', 'uisSeg'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const b = el('button', '', text); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', v === value); b.dataset.k = label + ':' + v;
      b.onclick = () => onPick(v);
      g.append(b);
    }
    return g;
  }
  function toggle(label, value, onChange) {
    const b = el('button', 'uisSw'); b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', !!value); b.setAttribute('aria-label', label); b.dataset.k = 'sw:' + label;
    b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', v); onChange(v); };
    return b;
  }
  function slider(label, { min, max, step = 1, value, unit = '', onInput, fmt }) {
    const id = 'uis' + ++uid;
    const w = el('div', 'uisCtl');
    const r = el('input', 'uisRange'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value; r.id = id; r.setAttribute('aria-label', label); r.dataset.k = 'rg:' + label;
    const n = el('input', 'uisNum'); n.type = 'number'; n.min = min; n.max = max; n.step = step; n.value = value; n.setAttribute('aria-label', label + ' (number)');
    const u = el('span', 'uisUnit', unit);
    const push = (v) => { v = Math.min(max, Math.max(min, Number(v))); if (!Number.isFinite(v)) return; r.value = v; if (fmt) u.textContent = fmt(v); onInput(v); };
    r.oninput = () => { n.value = r.value; push(r.value); };
    n.onchange = () => { push(n.value); n.value = r.value; };
    if (fmt) u.textContent = fmt(value);
    w.append(r, n, u);
    w.rangeId = id;
    return w;
  }

  /* ---- Appearance ---- */
  function secAppearance(p) {
    head(p, 'Appearance', () => change((c) => { Object.assign(c, { theme: DEFAULTS.theme, accent: null, uiFont: 14, density: 'comfortable', radius: 'small' }); }, { redraw: true, now: true }));
    const grid = el('div', 'uisThemes'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', 'Theme');
    for (const th of THEMES) {
      const b = el('button', 'uisTheme'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', th.id === cfg.theme); b.dataset.k = 'theme:' + th.id; b.dataset.theme = th.id;
      const prev = el('span', 'uisThemePrev');
      for (const col of [th.c.bg, th.c.panel, th.c.panel2, th.c.accent, th.c.text]) { const i = el('i'); i.style.background = col; prev.append(i); }
      b.append(prev, el('span', '', th.name + (th.dark ? '' : ' (light)')));
      b.onclick = () => setTheme(th.id);
      grid.append(b);
    }
    p.append(grid);

    const acc = el('div', 'uisCtl');
    const sw = el('div', 'uisSwatches'); sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', 'Accent presets');
    const cur = accentOf(cfg);
    for (const [name, h] of ACCENTS) {
      const b = el('button', 'uisSwatch'); b.title = name; b.style.background = h; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', name); b.setAttribute('aria-checked', h === cur); b.dataset.k = 'acc:' + h; b.dataset.accent = h;
      b.onclick = () => change((c) => { c.accent = h; }, { redraw: true });
      sw.append(b);
    }
    const col = el('input', 'uisColor'); col.type = 'color'; col.value = cur; col.setAttribute('aria-label', 'Custom accent colour'); col.dataset.k = 'acc:color';
    const hx = el('input', 'uisHex'); hx.value = cur; hx.maxLength = 7; hx.setAttribute('aria-label', 'Accent colour hex'); hx.spellcheck = false; hx.dataset.k = 'acc:hex';
    col.oninput = () => { hx.value = col.value; change((c) => { c.accent = col.value; }); };
    col.onchange = () => refreshWin();
    hx.onchange = () => { if (isHex(hx.value)) change((c) => { c.accent = hx.value; }, { redraw: true }); else hx.value = accentOf(cfg); };
    const def = el('button', '', 'Theme default'); def.onclick = () => change((c) => { c.accent = null; }, { redraw: true });
    acc.append(sw, col, hx, def);
    row(p, 'Accent colour', 'Used for selection, buttons and links. Each theme has its own default.', acc);

    row(p, 'UI font size', 'Base text size of the whole interface.', slider('UI font size', { min: 11, max: 20, value: cfg.uiFont, unit: 'px', onInput: (v) => change((c) => { c.uiFont = v; }) }));
    row(p, 'Density', 'Compact uses less space around rows, tabs and buttons.', seg('Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], cfg.density, (v) => change((c) => { c.density = v; }, { redraw: true })));
    row(p, 'Corner radius', null, seg('Corner radius', [['small', 'Small'], ['none', 'None']], cfg.radius, (v) => change((c) => { c.radius = v; }, { redraw: true })));

    const pv = el('div', 'uisPreview');
    const s = el('div', 'uisSample');
    s.append(el('div', 'msg user', 'Preview: this is how a message looks.'), Object.assign(el('button', 'primary', 'Primary'), { tabIndex: -1 }), Object.assign(el('button', '', 'Button'), { tabIndex: -1 }));
    pv.append(s);
    p.append(pv);
  }

  /* ---- Editor ---- */
  function secEditor(p) {
    head(p, 'Editor', () => change((c) => { c.ed = clone(DEFAULTS.ed); }, { redraw: true, now: true }));
    row(p, 'Font size', 'Applies to the code editor and its line numbers.', slider('Editor font size', { min: 9, max: 28, value: cfg.ed.fontSize, unit: 'px', onInput: (v) => change((c) => { c.ed.fontSize = v; }) }));
    row(p, 'Line height', 'Relative to the font size.', slider('Line height', { min: 1.1, max: 2.4, step: 0.05, value: cfg.ed.lineHeight, fmt: () => '= ' + edLh(cfg) + ' px', onInput: (v) => change((c) => { c.ed.lineHeight = v; }) }));
    row(p, 'Tab size', 'Width of a tab character, and how many spaces the Tab key inserts.', seg('Tab size', [[2, '2'], [4, '4'], [8, '8']], cfg.ed.tab, (v) => change((c) => { c.ed.tab = v; }, { redraw: true })));
    row(p, 'Word wrap', 'Wrap long lines instead of scrolling sideways.', toggle('Word wrap', cfg.ed.wrap, (v) => change((c) => { c.ed.wrap = v; })));
    row(p, 'Line numbers', null, toggle('Line numbers', cfg.ed.lineNumbers, (v) => change((c) => { c.ed.lineNumbers = v; })));
    const pv = el('div', 'uisPreview'), pre = el('pre');
    pre.textContent = 'function greet(name) {\n  // say hello\n  return "Hello, " + name;\n}\n\nconst total = 42;';
    pv.append(pre); p.append(pv);
  }

  /* ---- Terminal ---- */
  function secTerminal(p) {
    head(p, 'Terminal', () => change((c) => { c.term = clone(DEFAULTS.term); }, { redraw: true, now: true }));
    row(p, 'Font size', 'Applies to open and new terminals.', slider('Terminal font size', { min: 8, max: 28, value: cfg.term.fontSize, unit: 'px', onInput: (v) => change((c) => { c.term.fontSize = v; }) }));
    row(p, 'Cursor style', null, seg('Cursor style', [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']], cfg.term.cursor, (v) => change((c) => { c.term.cursor = v; }, { redraw: true })));
    row(p, 'Scrollback', 'Lines kept in each terminal (500 to 100000).', slider('Scrollback', { min: 500, max: 100000, step: 500, value: cfg.term.scrollback, unit: 'lines', onInput: (v) => change((c) => { c.term.scrollback = v; }) }));
    const pv = el('div', 'uisPreview term'), pre = el('pre');
    pre.textContent = 'PS C:\\project> npm test\n  12 passing\nPS C:\\project> ';
    pv.append(pre); p.append(pv);
  }

  /* ---- Layout ---- */
  function chipList() {
    const names = { chipModel: 'Model', chipEffort: 'Reasoning effort', chipMode: 'Permissions', scopeNote: 'Folder note', bgStatus: 'Ollama status' };
    return [...document.querySelectorAll('#bar > [id]')].map((n) => [n.id, names[n.id] || n.title || n.id]);
  }
  function secLayout(p) {
    head(p, 'Layout', () => { change((c) => { c.layout = clone(DEFAULTS.layout); }, { redraw: true, now: true }); });
    row(p, 'Sidebar position', null, seg('Sidebar position', [['left', 'Left'], ['right', 'Right']], cfg.layout.side, (v) => change((c) => { c.layout.side = v; }, { redraw: true })));
    row(p, 'Sidebar width', 'You can also drag the edge of the sidebar. Double-click the edge to reset.', slider('Sidebar width', { min: 160, max: 600, step: 5, value: cfg.layout.sideW, unit: 'px', onInput: (v) => change((c) => { c.layout.sideW = v; }) }));
    row(p, 'Chat width', 'Maximum width of the conversation column.', slider('Chat width', { min: 520, max: 1600, step: 10, value: cfg.layout.chatW, unit: 'px', onInput: (v) => change((c) => { c.layout.chatW = v; }) }));
    row(p, 'Terminal height', 'Default height of the terminal panel (you can still drag its top edge).', slider('Terminal height', { min: 120, max: 700, step: 10, value: cfg.layout.termH, unit: 'px', onInput: (v) => change((c) => { c.layout.termH = v; }) }));
    row(p, 'Activity bar position', 'The icon strip next to the sidebar.', seg('Activity bar position', [['left', 'Left'], ['right', 'Right']], cfg.layout.rail, (v) => change((c) => { c.layout.rail = v; }, { redraw: true })));
    p.append(el('h3', '', 'Activity bar icons'));
    const railTitles = [...document.querySelectorAll('#railTop .rbtn')].map((b) => b.title).filter(Boolean);
    for (const t of new Set([...railTitles, ...cfg.layout.hiddenRail])) {
      row(p, t, null, toggle('Show ' + t + ' icon', !cfg.layout.hiddenRail.includes(t), (on) => change((c) => { c.layout.hiddenRail = c.layout.hiddenRail.filter((x) => x !== t); if (!on) c.layout.hiddenRail.push(t); })));
    }
    p.append(el('h3', '', 'Bottom bar items'));
    for (const [id, name] of chipList()) {
      row(p, name, null, toggle('Show ' + name, !cfg.layout.hiddenChips.includes(id), (on) => change((c) => { c.layout.hiddenChips = c.layout.hiddenChips.filter((x) => x !== id); if (!on) c.layout.hiddenChips.push(id); })));
    }
  }

  /* ---- Keyboard ---- */
  let keyMsg = { t: '', bad: false };
  function secKeyboard(p) {
    const msg = el('p', 'uisMsg' + (keyMsg.bad ? ' bad' : ''), keyMsg.t); msg.setAttribute('aria-live', 'polite');
    const say = (t, bad) => { keyMsg = { t, bad: !!bad }; msg.className = 'uisMsg' + (bad ? ' bad' : ''); msg.textContent = t; };
    head(p, 'Keyboard', () => { change((c) => { c.keys = clone(DEFAULTS.keys); }, { redraw: true, now: true }); });
    const note = { toggleTerminal: 'Changing this releases Ctrl+`.', reload: 'F5 and Ctrl+R always reload; a different key adds another way.', toggleEditor: '', openSettings: '', focusChat: '', palette: '' };
    for (const k of KEYS) {
      const b = el('button', 'uisKey', cfg.keys[k.id] || 'Not set'); b.dataset.k = 'key:' + k.id; b.dataset.action = k.id;
      b.setAttribute('aria-label', k.label + ': ' + (cfg.keys[k.id] || 'not set') + '. Press Enter to change.');
      b.onclick = () => record(b, k, say);
      const rs = el('button', '', 'Reset'); rs.title = 'Restore ' + k.def; rs.dataset.k = 'keyreset:' + k.id;
      rs.onclick = () => {
        const why = conflict(k.id, k.def);
        if (why) return say(why, true);
        keyMsg = { t: '', bad: false };
        change((c) => { c.keys[k.id] = k.def; }, { redraw: true, now: true });
      };
      const c = el('div', 'uisCtl'); c.append(b, rs);
      row(p, k.label, note[k.id] || null, c);
    }
    p.append(msg);
    p.append(el('p', 'uisNote', 'Click a shortcut, then press the new keys. Escape cancels, Backspace clears. Plain Ctrl+letter shortcuts also take that key away from the terminal while it has focus.'));
  }
  function record(btn, k, say) {
    if (recording) return;
    recording = true;
    btn.textContent = 'Press keys...'; btn.classList.add('rec');
    const done = () => { window.removeEventListener('keydown', h, true); recording = false; btn.removeEventListener('blur', done); if (btn.isConnected) refreshWin(); };
    const h = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (MODS.includes(e.key)) return;
      if (e.key === 'Escape') return done();
      if (e.key === 'Backspace' || e.key === 'Delete') { change((c) => { c.keys[k.id] = ''; }, { now: true }); say(k.label + ' is now unassigned.'); return done(); }
      const combo = comboList(e)[0];
      const why = conflict(k.id, combo);
      if (why) { say(why, true); return done(); }
      change((c) => { c.keys[k.id] = combo; }, { now: true });
      say(k.label + ' is now ' + combo + '.');
      done();
    };
    window.addEventListener('keydown', h, true);
    btn.addEventListener('blur', done);
  }

  /* ---- Data ---- */
  const SECRET = /token|secret|passw|cipher|api[_-]?key|credential/i;
  const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !SECRET.test(k)).map(([k, v]) => [k, strip(v)])) : o);
  const SKIP_FEATURES = new Set(['ui-settings', 'remote']);
  function exportObject() {
    const s = F.settings();
    const features = {};
    for (const [name, v] of Object.entries(s.features || {})) if (!SKIP_FEATURES.has(name) && v && typeof v === 'object') features[name] = strip(v);
    return { app: 'Faber', format: 1, exportedAt: new Date().toISOString(),
      ui: clone(cfg), core: { model: s.model, effort: s.effort, mode: s.mode, showHidden: !!s.showHidden, numCtx: s.numCtx, extraSystem: s.extraSystem || '' }, features };
  }
  async function importObject(o) {
    if (!o || typeof o !== 'object' || o.app !== 'Faber') throw new Error('This is not a Faber settings file.');
    if (o.ui) { cfg = sanitize(o.ui); applyAll(); persist(true); }
    const c = o.core || {}, patch = {};
    if (typeof c.model === 'string' && c.model && c.model.length < 200) patch.model = c.model;
    if (['low', 'medium', 'high'].includes(c.effort)) patch.effort = c.effort;
    if (['ask', 'edits', 'auto'].includes(c.mode)) patch.mode = c.mode;
    if (typeof c.showHidden === 'boolean') patch.showHidden = c.showHidden;
    if (Number.isFinite(c.numCtx) && c.numCtx >= 2048 && c.numCtx <= 1048576) patch.numCtx = Math.round(c.numCtx);
    if (typeof c.extraSystem === 'string' && c.extraSystem.length < 20000) patch.extraSystem = c.extraSystem;
    if (Object.keys(patch).length) await F.saveSettings(patch);
    for (const [name, v] of Object.entries(o.features || {})) {
      if (SKIP_FEATURES.has(name) || !/^[\w-]+$/.test(name) || !v || typeof v !== 'object') continue;
      await F.saveFeatureSettings(name, strip(v));
    }
    F.emit('ui-import', o);
  }
  const errText = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function secData(p) {
    const msg = el('p', 'uisMsg'); msg.setAttribute('aria-live', 'polite');
    const say = (t, bad) => { msg.textContent = t; msg.className = 'uisMsg' + (bad ? ' bad' : ''); };
    head(p, 'Data');
    p.append(el('p', 'uisNote', 'Settings are saved automatically. Export writes your interface settings, model choices and the settings of other features (never passwords or tokens, and never remote-connection settings) to a JSON file.'));
    const bt = el('div', 'uisBtns');
    const ex = el('button', 'primary', 'Export settings...'); ex.dataset.k = 'data:export';
    ex.onclick = async () => {
      try { const r = await F.call('feat:ui-settings:export', JSON.stringify(exportObject(), null, 2)); say(r.canceled ? 'Export cancelled.' : 'Saved to ' + r.path); } catch (e) { say(errText(e), true); }
    };
    const im = el('button', '', 'Import settings...'); im.dataset.k = 'data:import';
    im.onclick = async () => {
      try {
        const r = await F.call('feat:ui-settings:import');
        if (r.canceled) return say('Import cancelled.');
        await importObject(r.data);
        refreshWin();
        say('Imported settings from ' + r.path);
      } catch (e) { say(errText(e), true); }
    };
    const rs = el('button', 'uisDanger', 'Reset everything...'); rs.dataset.k = 'data:reset';
    let armTimer = null;
    rs.onclick = () => {
      if (!rs.classList.contains('arm')) {
        rs.classList.add('arm'); rs.textContent = 'Click again to confirm';
        armTimer = setTimeout(() => { rs.classList.remove('arm'); rs.textContent = 'Reset everything...'; }, 4000);
        return;
      }
      clearTimeout(armTimer);
      resetAll();
      refreshWin();
      say('All interface settings were reset to their defaults.');
    };
    bt.append(ex, im, rs);
    p.append(bt, msg);
    p.append(el('p', 'uisNote', 'Reset everything restores appearance, editor, terminal, layout, shortcuts and background refresh. Models, folders and other features are not touched.'));
    const where = el('p', 'uisNote', '');
    p.append(where);
    F.call('feat:ui-settings:info').then((i) => { where.textContent = 'Settings file: ' + i.settingsFile; }).catch(() => {});
  }
  function resetAll() {
    cfg = sanitize(null);
    applyAll();
    persist(true);
    F.saveFeatureSettings('background', { enabled: true, interval: 5, whenUnfocused: false });
    F.emit('ui-reset');
  }

  /* ================= wiring: commands, menu, actions ================= */
  F.addCommand('settings', '[section]', 'Open the settings window', (a) => openSettings(a || undefined));
  F.addCommand('theme', '[name]', 'Show or switch the colour theme', (a) => {
    const t = THEMES.find((x) => x.id === a.toLowerCase() || x.name.toLowerCase() === a.toLowerCase());
    if (!a) return F.sys('Theme: ' + themeOf(cfg).name + '\nAvailable: ' + THEMES.map((x) => x.name).join(', '));
    if (!t) return F.sys('Unknown theme. Available: ' + THEMES.map((x) => x.name).join(', '));
    setTheme(t.id);
    F.sys('Theme: ' + t.name);
  });

  const act = (id, title, hint, run) => F.addAction({ id, title, hint, run });
  act('toggle-terminal', 'Toggle terminal', 'Show or hide the terminal panel', () => showTerm());
  act('new-terminal', 'New terminal', 'Open another terminal tab', () => newTerminal());
  act('toggle-editor', 'Toggle editor', 'Show or hide the editor pane', () => toggleEditor());
  act('toggle-sidebar', 'Toggle sidebar', 'Show or hide the sidebar', () => { $('side').hidden = !$('side').hidden; });
  act('reload', 'Reload files', 'Re-read open files and the file tree from disk', () => reloadAll());
  act('open-folder', 'Open folder...', 'Choose a project folder', () => pickFolder());
  act('close-folder', 'Close folder', 'Close the project folder', () => closeFolder());
  act('focus-chat', 'Focus chat input', 'Move the cursor to the message box', () => $('input').focus());
  act('open-settings', 'Open settings', 'The settings window', () => openSettings());
  act('sidebar-side', 'Move sidebar to the other side', 'Left or right', () => change((c) => { c.layout.side = c.layout.side === 'left' ? 'right' : 'left'; }, { redraw: true }));
  act('toggle-wrap', 'Toggle word wrap in the editor', '', () => change((c) => { c.ed.wrap = !c.ed.wrap; }, { redraw: true }));
  act('reset-layout', 'Reset layout sizes', 'Sidebar width, chat width, terminal height', () => change((c) => { Object.assign(c.layout, { sideW: 250, chatW: 860, termH: 280 }); }, { redraw: true, now: true }));
  for (const th of THEMES) act('theme-' + th.id, 'Theme: ' + th.name, 'Switch the colour theme', () => setTheme(th.id));

  if (F.addMenuItem) {
    F.addMenuItem('View', { id: 'view.appearance', label: 'Appearance', separatorBefore: true,
      submenu: () => THEMES.map((t) => ({ label: t.name, checked: () => cfg.theme === t.id, action: () => setTheme(t.id) })) });
  }

  F.ui = { get: () => clone(cfg), flush, themes: () => THEMES.map((t) => t.id), defaults: () => clone(DEFAULTS), openPalette, resetAll, exportObject, importObject };

  /* ================= start ================= */
  F.ui.early = cfg.theme;               // theme applied from the localStorage cache at load time
  applyAll();                           // from the localStorage cache, before anything is shown
  F.onReady(() => {
    const real = F.featureSettings('ui-settings');
    if (real && Object.keys(real).length) cfg = sanitize(real);
    else { const ca = String(F.settings().accent || '').toLowerCase(); if (isHex(ca) && ca !== themeOf(cfg).c.accent) cfg.accent = ca; }
    coreAccentSeen = String(F.settings().accent || '').toLowerCase();
    applyAll();
    cacheWrite();
    syncCoreAccent();
  });
});
