/* Faber extension API. Loaded first. Features live in renderer/features/<name>.js and call
   Faber.register('<name>', (F) => { ... }). See docs/EXTENDING.md. */
window.Faber = (() => {
  const queue = [];            // [name, init]
  const readyFns = [];
  const bus = {};              // event name -> [cb]
  const sideTabs = [];         // {id, title, pane, render, rendered, onShow}
  const settingsSections = []; // {id, title, render(el)}
  let host = null;             // bindings supplied by app.js
  let started = false;
  let isReady = false;
  let activeSide = 'files';

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function runInit(name, init) {
    try { init(F); } catch (e) {
      console.error('feature ' + name + ' failed to load:', e);
      if (host) host.sys('Feature "' + name + '" failed to load: ' + e.message);
    }
  }

  /* ---- activity bar (icon rail) + sidebar panes ---- */
  const badges = {};           // id -> number | string
  const ICONS = {
    files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
    agents: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M15 14.5c3 0 6 1.5 6 5"/>',
    models: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    remote: '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9z"/>',
    plugins: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><path d="M16.5 13v7M13 16.5h7"/>',
    debug: '<path d="M9 7a3 3 0 0 1 6 0"/><rect x="7" y="7" width="10" height="12" rx="5"/><path d="M12 10v9M3 12h4M17 12h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>',
    team: '<circle cx="12" cy="6" r="2.5"/><circle cx="5" cy="17" r="2.5"/><circle cx="19" cy="17" r="2.5"/><path d="M12 8.5v3.5M12 12l-5.5 3M12 12l5.5 3"/>',
    orchestra: '<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M10.2 10.4L6.6 7.4M13.8 10.4l3.6-3M10.2 13.6l-3.6 3M13.8 13.6l3.6 3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    other: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  };
  const RAIL_ORDER = ['files', 'search', 'git', 'agents', 'team', 'orchestra', 'models', 'remote', 'plugins', 'debug'];
  const svg = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';

  function ensureFiles() {
    if (!sideTabs.some((t) => t.id === 'files')) sideTabs.unshift({ id: 'files', title: 'Files', pane: $('paneFiles'), rendered: true });
  }

  function railButton(id, title, inner, onClick, on) {
    const b = el('button', 'rbtn' + (on ? ' on' : ''));
    b.innerHTML = svg(inner);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = onClick;
    const n = badges[id];
    if (n) { const bd = el('span', 'rbadge', String(n)); b.appendChild(bd); }
    return b;
  }

  function paintSideTabs() {
    ensureFiles();
    const top = $('railTop'), bottom = $('railBottom');
    if (!top) return;
    top.innerHTML = '';
    const sorted = [...sideTabs].sort((a, b) => {
      const ia = RAIL_ORDER.indexOf(a.id), ib = RAIL_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const open = !$('side').hidden;
    for (const t of sorted) {
      top.appendChild(railButton(t.id, t.title, t.icon || ICONS[t.id] || ICONS.other, () => railClick(t.id), open && t.id === activeSide));
    }
    bottom.innerHTML = '';
    bottom.appendChild(railButton('settings', 'Settings', ICONS.settings, () => F.openSettings(), false));
  }

  // Clicking the icon of the open panel hides the sidebar (like VS Code); clicking another icon opens it.
  function railClick(id) {
    if (!$('side').hidden && activeSide === id) { $('side').hidden = true; paintSideTabs(); } else showSideTab(id);
  }

  function showSideTab(id) {
    const t = sideTabs.find((x) => x.id === id);
    if (!t) return;
    $('side').hidden = false;
    activeSide = id;
    for (const s of sideTabs) s.pane.hidden = s.id !== id;
    if (!t.rendered && t.render) { t.rendered = true; try { t.render(t.pane); } catch (e) { console.error(e); t.pane.textContent = 'Failed to render: ' + e.message; } }
    if (t.onShow) { try { t.onShow(t.pane); } catch (e) { console.error(e); } }
    paintSideTabs();
  }

  /* ---- modal + toast ---- */
  function modal({ title, body, buttons, wide } = {}) {
    const back = el('div', 'modalBack');
    const card = el('div', 'modalCard' + (wide ? ' wide' : ''));
    const head = el('div', 'modalHead');
    head.appendChild(el('span', 'modalTitle', title || ''));
    const x = el('button', 'ghost', 'Close');
    head.appendChild(x);
    const content = el('div', 'modalBody');
    card.append(head, content);
    const api = { el: content, close() { back.remove(); document.removeEventListener('keydown', onKey); } };
    const onKey = (e) => { if (e.key === 'Escape') api.close(); };
    x.onclick = api.close;
    back.addEventListener('mousedown', (e) => { if (e.target === back) api.close(); });
    document.addEventListener('keydown', onKey);
    if (typeof body === 'function') body(content, api); else if (body) content.append(body);
    if (buttons && buttons.length) {
      const foot = el('div', 'modalFoot');
      for (const b of buttons) {
        const btn = el('button', b.primary ? 'primary' : '', b.label);
        btn.onclick = () => { if (b.onClick) b.onClick(api); if (b.close !== false) api.close(); };
        foot.appendChild(btn);
      }
      card.appendChild(foot);
    }
    back.appendChild(card);
    document.body.appendChild(back);
    return api;
  }

  function toast(text, ms = 3000) {
    let box = $('toasts');
    if (!box) { box = el('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = el('div', 'toast', text);
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  const F = {
    el, modal, toast,

    /* lifecycle */
    register(name, init) { if (started) runInit(name, init); else queue.push([name, init]); },
    start() { started = true; for (const [n, i] of queue.splice(0)) runInit(n, i); paintSideTabs(); },
    onReady(fn) { if (isReady) fn(); else readyFns.push(fn); },   // after settings are loaded (app is usable)
    bind(h) { host = h; },                                         // app.js only
    ready() { isReady = true; for (const fn of readyFns.splice(0)) { try { fn(); } catch (e) { console.error(e); } } },

    /* app state + actions */
    settings: () => (host ? host.settings() : {}),
    saveSettings: (patch) => host.save(patch),
    featureSettings: (name) => (F.settings().features || {})[name] || {},
    saveFeatureSettings: (name, patch) => host.save({ features: { [name]: patch } }),   // merged per feature in main
    sys: (t) => host.sys(t),
    error: (t) => host.error(t),
    openFile: (p) => host.openFile(p),
    refreshTree: () => host.refreshTree(),
    runInTerminal: (cmd) => host.runInTerminal(cmd),
    folder: () => (host ? host.settings().workspace || '' : ''),

    /* main-process bridge (channels must start with "feat:") */
    call: (channel, ...args) => window.api.call(channel, ...args),
    on: (channel, cb) => window.api.on(channel, cb),

    /* tiny event bus. Core emits: 'folder' (path), 'enter', 'chat-done', 'settings' */
    emit(name, data) { for (const cb of bus[name] || []) { try { cb(data); } catch (e) { console.error(e); } } },
    onEvent(name, cb) { (bus[name] ||= []).push(cb); },

    /* UI registries */
    addCommand(name, argsHint, desc, fn) { host.commands[name] = [argsHint, desc, fn]; },
    addSideTab({ id, title, render, onShow, icon }) {
      const pane = el('div', 'sidePane');
      pane.id = 'pane-' + id;
      pane.hidden = true;
      $('side').appendChild(pane);
      ensureFiles();
      sideTabs.push({ id, title, pane, render, onShow, icon });
      paintSideTabs();
      return pane;
    },
    showSideTab,
    refreshRail: () => paintSideTabs(),
    setBadge(id, n) { badges[id] = n; paintSideTabs(); },
    addHeaderButton({ id, label, title, onClick }) {
      const b = el('button', 'ghost', label);
      b.id = id; if (title) b.title = title;
      b.onclick = onClick;
      $('headerExtra').appendChild(b);
      return b;
    },
    addSettingsSection({ id, title, render }) { settingsSections.push({ id, title, render }); },
    settingsSections: () => settingsSections,
    // The settings window is provided by the ui-settings feature (it overwrites this).
    openSettings(sectionId) { toast('Settings window is not available'); },
  };
  return F;
})();
