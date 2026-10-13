/* Layout glue: saves and restores the dock layout, named layouts, and the menu / commands for editor groups.
   The engine is renderer/dock.js; the editor groups are in renderer/editor.js. Loaded after menubar.js. */
(() => {
  const F = Faber;
  const KEY = 'dock';
  const cfg = () => F.featureSettings(KEY) || {};
  let ready = false, timer = null;

  // the current layout is saved a moment after every change, together with how many editor groups it needs
  Dock.onSave((tree) => {
    if (!ready) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { F.saveFeatureSettings(KEY, { layout: tree, groups: Editors.count() }); } catch { /* ignore */ } }, 400);
  });

  function apply(layout, groups) {
    Editors.ensure(Math.max(1, Math.min(8, Number(groups) || 1)));
    Dock.restore(layout);
  }

  F.onReady(() => {
    const c = cfg();
    if (c.layout) { try { apply(c.layout, c.groups); } catch (e) { console.error('layout restore failed', e); Dock.reset(); } }
    // a terminal panel that comes back from the saved layout needs a shell in it
    if (Dock.visible('terminal') && typeof terms !== 'undefined' && !Object.keys(terms).length) newTerminal();
    ready = true;
  });

  /* ---------- named layouts ---------- */
  const named = () => ({ ...(cfg().named || {}) });
  function saveNamed(name) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return;
    const all = named();
    all[name] = { layout: Dock.serialize(), groups: Editors.count() };
    F.saveFeatureSettings(KEY, { named: all });
    F.toast(`Saved layout "${name}"`);
  }
  function askName() {
    const input = document.createElement('input');
    input.placeholder = 'Layout name';
    input.style.width = '100%';
    const go = (m) => { saveNamed(input.value); m.close(); };
    const m = F.modal({
      title: 'Save layout', body: (b) => { b.append(input); setTimeout(() => input.focus(), 0); },
      buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, close: false, onClick: () => go(m) }],
    });
    input.onkeydown = (e) => { if (e.key === 'Enter') go(m); };
  }
  function loadNamed(name) {
    const l = named()[name];
    if (!l) return F.error(`No saved layout called "${name}".`);
    apply(l.layout, l.groups);
    F.toast(`Layout "${name}"`);
  }
  function deleteNamed(name) {
    const all = named();
    delete all[name];
    // feature settings merge one level deep, so write the whole map back
    F.saveFeatureSettings(KEY, { named: all });
  }

  /* ---------- menu, commands ---------- */
  const M = 'View';
  F.addMenuItem(M, { id: 'view.splitEditor', label: 'Split Editor', shortcut: 'Ctrl+\\', keys: 'Ctrl+\\', separatorBefore: true, enabled: () => Editors.count() < 8, action: () => Editors.split() });
  F.addMenuItem(M, { id: 'view.layoutReset', label: 'Reset Layout', action: () => Dock.reset() });
  F.addMenuItem(M, { id: 'view.layoutSave', label: 'Save Layout As...', action: askName });
  F.addMenuItem(M, { id: 'view.layoutLoad', label: 'Saved Layouts', submenu: () => { const n = Object.keys(named()); return n.length ? n.map((k) => ({ label: k, action: () => loadNamed(k) })) : [{ label: '(none saved)', enabled: () => false, action() {} }]; } });
  F.addMenuItem(M, { id: 'view.layoutDelete', label: 'Delete Saved Layout', submenu: () => Object.keys(named()).map((k) => ({ label: k, action: () => deleteNamed(k) })) });

  F.addCommand('layout', 'reset|save <name>|load <name>|list', 'Dock layout: reset, save, load', (a) => {
    const [sub, ...rest] = String(a || '').trim().split(/\s+/);
    const name = rest.join(' ');
    if (sub === 'reset') return Dock.reset();
    if (sub === 'save') return name ? saveNamed(name) : askName();
    if (sub === 'load') return loadNamed(name);
    if (sub === 'list') return F.sys(Object.keys(named()).join('\n') || 'No saved layouts.');
    F.sys('Usage: /layout reset | save <name> | load <name> | list. Drag a panel\'s title onto the edge of another panel to dock it.');
  });
  F.addCommand('editors', '', 'Open another editor beside the current one', () => Editors.split());

  F.layout = { saveNamed, loadNamed, named, apply };
})();
