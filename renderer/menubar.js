/* VS Code style menu bar. Features add entries with Faber.addMenuItem(menu, item):
     item = { id, label, action(), shortcut?: 'Ctrl+Shift+P', keys?: 'Ctrl+Shift+P' (also binds the key),
              enabled?: () => bool, checked?: () => bool, submenu?: () => [items], separatorBefore?: bool }
   New menu names create a new menu. Empty menus stay hidden. Loaded after terminal.js, before features. */
(() => {
  const ORDER = ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Agents', 'Git', 'Tools', 'Help'];
  const menus = new Map(ORDER.map((n) => [n, []]));
  const bar = $('menubar');
  let openName = null;
  let panel = null;

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const keyOf = (e) => [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
  const norm = (s) => String(s).replace(/\s+/g, '').replace(/Cmd|Command/i, 'Ctrl').toLowerCase();

  function addMenuItem(menu, item) {
    if (!menus.has(menu)) {
      const helpAt = [...menus.keys()].indexOf('Help');
      const entries = [...menus.entries()];
      entries.splice(helpAt < 0 ? entries.length : helpAt, 0, [menu, []]);
      menus.clear();
      for (const [k, v] of entries) menus.set(k, v);
    }
    const list = menus.get(menu);
    const i = list.findIndex((x) => item.id && x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
    paintBar();
    return item;
  }

  function sep() { return { sep: true }; }

  /* ---- rendering ---- */
  function paintBar() {
    bar.innerHTML = '';
    for (const [name, items] of menus) {
      if (!items.length) continue;
      const b = document.createElement('button');
      b.className = 'mbtn' + (name === openName ? ' open' : '');
      b.textContent = name;
      b.onmousedown = (e) => { e.preventDefault(); toggle(name, b); };
      b.onmouseenter = () => { if (openName && openName !== name) show(name, b); };
      bar.appendChild(b);
    }
  }

  function closeMenu() {
    openName = null;
    panel?.remove(); panel = null;
    document.querySelectorAll('.msub').forEach((n) => n.remove());
    bar.querySelectorAll('.mbtn.open').forEach((b) => b.classList.remove('open'));
  }
  function toggle(name, anchor) { if (openName === name) closeMenu(); else show(name, anchor); }

  function build(items, anchorRect, isSub) {
    const p = document.createElement('div');
    p.className = isSub ? 'mpanel msub' : 'mpanel';
    let first = true;
    for (const it of items) {
      if (it.when && !it.when()) continue;
      if (it.separatorBefore && !first) p.appendChild(Object.assign(document.createElement('div'), { className: 'msep' }));
      if (it.sep) { if (!first) p.appendChild(Object.assign(document.createElement('div'), { className: 'msep' })); continue; }
      first = false;
      const enabled = it.enabled ? it.enabled() : true;
      const row = document.createElement('div');
      row.className = 'mitem' + (enabled ? '' : ' off');
      const chk = document.createElement('span');
      chk.className = 'mchk';
      chk.textContent = it.checked && it.checked() ? '✓' : '';
      const lab = document.createElement('span');
      lab.className = 'mlab';
      lab.textContent = it.label;
      const sc = document.createElement('span');
      sc.className = 'msc';
      sc.textContent = it.submenu ? '▸' : (it.shortcut || '');
      row.append(chk, lab, sc);
      if (it.submenu) {
        row.onmouseenter = () => {
          document.querySelectorAll('.msub').forEach((n) => { if (n !== p) n.remove(); });
          const r = row.getBoundingClientRect();
          const sub = build(it.submenu(), r, true);
          document.body.appendChild(sub);
          sub.style.left = Math.min(r.right - 2, innerWidth - sub.offsetWidth - 4) + 'px';
          sub.style.top = r.top - 4 + 'px';
        };
      } else {
        row.onmouseenter = () => document.querySelectorAll('.msub').forEach((n) => { if (n !== p) n.remove(); });
        row.onmousedown = (e) => e.preventDefault();          // keep focus (and selection) where it was
        row.onclick = () => { if (!enabled) return; closeMenu(); setTimeout(() => it.action && it.action(), 0); };
      }
      p.appendChild(row);
    }
    if (!p.children.length) {
      const none = document.createElement('div');
      none.className = 'mitem off';
      none.textContent = 'Nothing here';
      p.appendChild(none);
    }
    return p;
  }

  function show(name, anchor) {
    panel?.remove();
    document.querySelectorAll('.msub').forEach((n) => n.remove());
    openName = name;
    panel = build(menus.get(name), null, false);
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.left = Math.min(r.left, innerWidth - panel.offsetWidth - 4) + 'px';
    panel.style.top = r.bottom + 'px';
    bar.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('open', b === anchor));
  }

  document.addEventListener('mousedown', (e) => {
    if (!openName) return;
    if (e.target.closest('.mpanel') || e.target.closest('#menubar')) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openName) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  /* ---- keyboard accelerators for items declared with `keys` ---- */
  const bound = new Map();   // normalized combo -> item
  function rebuildKeys() {
    bound.clear();
    for (const items of menus.values()) for (const it of items) if (it.keys) bound.set(norm(it.keys), it);
  }
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey) || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    rebuildKeys();
    const it = bound.get(norm(keyOf(e)));
    if (!it || (it.enabled && !it.enabled())) return;
    e.preventDefault();
    it.action();
  });

  /* ---- helpers for default actions ---- */
  const focusedEditable = () => document.activeElement;
  const exec = (cmd) => { const el = focusedEditable(); if (el) el.focus(); document.execCommand(cmd); };
  const hasFolder = () => !!Faber.settings().workspace;
  const activeTabObj = () => (typeof tabs !== 'undefined' ? tabs[activeTab] : null);
  const runnable = { py: 'python', js: 'node', mjs: 'node', ps1: 'powershell -File', bat: '', cmd: '', sh: 'bash', go: 'go run', rb: 'ruby' };
  const q = (p) => '"' + p.replace(/"/g, '`"') + '"';
  let zoom = 1;
  const setZoom = (z) => { zoom = Math.max(0.6, Math.min(1.8, Math.round(z * 10) / 10)); api.setZoom(zoom); };

  const F = window.Faber;
  F.addMenuItem = addMenuItem;
  F.menuSeparator = sep;
  F.menus = () => menus;
  F.setMenuShortcut = (id, keys) => {
    for (const items of menus.values()) for (const it of items) if (it.id === id) { it.keys = keys; it.shortcut = keys; }
  };

  const add = (menu, items) => items.forEach((i) => addMenuItem(menu, i));

  add('File', [
    { id: 'file.open', label: 'Open Folder…', shortcut: 'Ctrl+O', keys: 'Ctrl+O', action: () => pickFolder() },
    { id: 'file.recent', label: 'Open Recent', submenu: () => (Faber.settings().recent || []).slice(0, 8).map((p) => ({ label: p, action: () => openFolder(p) })), enabled: () => (Faber.settings().recent || []).length > 0 },
    { id: 'file.close', label: 'Close Folder', enabled: hasFolder, action: () => closeFolder() },
    sep(),
    { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', enabled: () => !!activeTabObj() && isDirty(activeTabObj()), action: () => saveTab() },
    { id: 'file.closeTab', label: 'Close Editor', shortcut: 'Ctrl+W', keys: 'Ctrl+W', enabled: () => !!activeTabObj(), action: () => closeTab(activeTab) },
    sep(),
    { id: 'file.settings', label: 'Settings', shortcut: 'Ctrl+,', action: () => F.openSettings() },
    { id: 'file.lock', label: 'Lock', when: () => !$('lockBtn').hidden, action: () => lock() },
    { id: 'file.exit', label: 'Exit', action: () => api.quit() },
  ]);

  add('Edit', [
    { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', action: () => exec('undo') },
    { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', action: () => exec('redo') },
    sep(),
    { id: 'edit.cut', label: 'Cut', shortcut: 'Ctrl+X', action: () => exec('cut') },
    { id: 'edit.copy', label: 'Copy', shortcut: 'Ctrl+C', action: () => exec('copy') },
    { id: 'edit.paste', label: 'Paste', shortcut: 'Ctrl+V', action: () => navigator.clipboard.readText().then((t) => { focusedEditable()?.focus(); document.execCommand('insertText', false, t); }).catch(() => F.toast('Use Ctrl+V to paste')) },
  ]);

  add('Selection', [
    { id: 'sel.all', label: 'Select All', shortcut: 'Ctrl+A', action: () => { const el = focusedEditable(); if (el && el.select) el.select(); else document.execCommand('selectAll'); } },
    { id: 'sel.line', label: 'Select Line', enabled: () => !!activeTabObj(), action: () => {
      const ta = $('edText'); const v = ta.value; const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      let e = v.indexOf('\n', ta.selectionEnd); if (e < 0) e = v.length; ta.focus(); ta.setSelectionRange(s, e);
    } },
  ]);

  add('View', [
    { id: 'view.palette', label: 'Command Palette…', shortcut: 'Ctrl+Shift+P', when: () => typeof F.openPalette === 'function', action: () => F.openPalette() },
    { id: 'view.sidebar', label: 'Sidebar', shortcut: 'Ctrl+B', keys: 'Ctrl+B', checked: () => !$('side').hidden, action: () => { $('side').hidden = !$('side').hidden; Faber.refreshRail(); } },
    { id: 'view.editor', label: 'Editor', shortcut: 'Ctrl+Alt+E', keys: 'Ctrl+Alt+E', checked: () => !$('editor').hidden, action: () => toggleEditor() },
    { id: 'view.terminal', label: 'Terminal', shortcut: 'Ctrl+`', checked: () => !$('term').hidden, action: () => showTerm() },
    sep(),
    { id: 'view.hidden', label: 'Show Hidden Files', checked: () => !!Faber.settings().showHidden, action: async () => { await save({ showHidden: !Faber.settings().showHidden }); refreshTree(); } },
    { id: 'view.reload', label: 'Reload Files', shortcut: 'F5', action: () => reloadAll() },
    sep(),
    { id: 'view.zoomIn', label: 'Zoom In', shortcut: 'Ctrl+=', keys: 'Ctrl+=', action: () => setZoom(zoom + 0.1) },
    { id: 'view.zoomOut', label: 'Zoom Out', shortcut: 'Ctrl+-', keys: 'Ctrl+-', action: () => setZoom(zoom - 0.1) },
    { id: 'view.zoomReset', label: 'Reset Zoom', shortcut: 'Ctrl+0', keys: 'Ctrl+0', action: () => setZoom(1) },
  ]);

  add('Go', [
    { id: 'go.chat', label: 'Focus Chat', shortcut: 'Ctrl+1', keys: 'Ctrl+1', action: () => $('input').focus() },
    { id: 'go.editor', label: 'Focus Editor', shortcut: 'Ctrl+2', keys: 'Ctrl+2', enabled: () => !!activeTabObj(), action: () => $('edText').focus() },
    { id: 'go.terminal', label: 'Focus Terminal', shortcut: 'Ctrl+3', keys: 'Ctrl+3', action: () => { showTerm(true); activeTerm?.term.focus(); } },
    sep(),
    { id: 'go.next', label: 'Next Editor Tab', shortcut: 'Ctrl+PageDown', keys: 'Ctrl+PageDown', enabled: () => tabs.length > 1, action: () => { activeTab = (activeTab + 1) % tabs.length; paintEditor(); } },
    { id: 'go.prev', label: 'Previous Editor Tab', shortcut: 'Ctrl+PageUp', keys: 'Ctrl+PageUp', enabled: () => tabs.length > 1, action: () => { activeTab = (activeTab - 1 + tabs.length) % tabs.length; paintEditor(); } },
  ]);

  add('Run', [
    { id: 'run.file', label: 'Run Current File', shortcut: 'Ctrl+F5', keys: 'Ctrl+F5',
      enabled: () => { const t = activeTabObj(); return !!t && extOf(t.path) in runnable; },
      action: () => { const t = activeTabObj(); const r = runnable[extOf(t.path)]; runInTerminal((r ? r + ' ' : '& ') + q(t.path)); } },
    { id: 'run.stop', label: 'Stop Running Command', shortcut: 'Ctrl+C in terminal', enabled: () => !!activeTerm, action: () => api.termInput(activeTerm.id, String.fromCharCode(3)) },
  ]);

  add('Terminal', [
    { id: 'term.new', label: 'New Terminal', shortcut: 'Ctrl+Shift+`', keys: 'Ctrl+Shift+`', action: () => newTerminal() },
    { id: 'term.toggle', label: 'Show / Hide Terminal', shortcut: 'Ctrl+`', action: () => showTerm() },
    { id: 'term.clear', label: 'Clear Terminal', enabled: () => !!activeTerm, action: () => activeTerm.term.clear() },
    { id: 'term.kill', label: 'Close This Terminal', enabled: () => !!activeTerm, action: () => closeTerminal(activeTerm.id) },
  ]);

  const SHORTCUTS = () => {
    const rows = [];
    for (const [name, items] of menus) for (const it of items) if (it.shortcut && !it.sep) rows.push([name + ': ' + it.label, it.shortcut]);
    return rows;
  };
  add('Help', [
    { id: 'help.commands', label: 'Slash Commands', action: () => runCommand('/help') },
    { id: 'help.keys', label: 'Keyboard Shortcuts', action: () => F.modal({ title: 'Keyboard shortcuts', body: (el) => {
      const t = document.createElement('table'); t.className = 'ktable';
      for (const [a, k] of SHORTCUTS()) { const tr = t.insertRow(); tr.insertCell().textContent = a; const c = tr.insertCell(); c.textContent = k; c.className = 'msc'; }
      el.appendChild(t);
    } }) },
    { id: 'help.about', label: 'About Faber', action: () => { const s = Faber.settings(); F.modal({ title: 'About Faber', body: (el) => {
      el.textContent = 'Faber: an offline, local coding assistant.\nModel: ' + s.model + '\nEngine: ' + s.host + (s.hostRemote ? '  (REMOTE)' : '  (this PC)') + '\nFolder: ' + (s.workspace || 'none');
      el.style.whiteSpace = 'pre-wrap';
    } }); } },
  ]);

  paintBar();
})();
