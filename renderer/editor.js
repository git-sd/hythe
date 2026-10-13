/* Editor pane: tabs, line numbers, light syntax colouring, save. Loaded after app.js (shares its globals). */

const KW = 'function|const|let|var|return|if|else|for|while|do|class|import|export|from|new|async|await|try|catch|finally|throw|switch|case|break|continue|default|typeof|instanceof|this|null|undefined|true|false|def|elif|in|not|and|or|is|lambda|with|as|pass|yield|None|True|False|self|public|private|protected|static|void|int|float|double|string|bool|boolean|char|long|fn|mut|use|struct|impl|enum|interface|type|extends|implements|package|func|go|defer|namespace|using|foreach|param|echo|fi|then|done|esac';
const SLASH = new Set('js mjs cjs ts tsx jsx json jsonc css scss java c cc cpp h hpp cs go rs php swift kt dart'.split(' '));
const HASH = new Set('py sh bash zsh ps1 psm1 yml yaml toml rb pl r ini cfg conf env gitignore dockerfile'.split(' '));
const hlCache = {};

function hlRegex(ext) {
  const kind = SLASH.has(ext) ? 'slash' : HASH.has(ext) ? 'hash' : null;
  if (!kind) return null;
  const comment = kind === 'slash' ? String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*` : String.raw`#[^\n]*`;
  const str = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`';
  return (hlCache[kind] ||= new RegExp(`(${comment})|(${str})|(\\b\\d[\\d._]*\\b)|(\\b(?:${KW})\\b)`, 'g'));
}

function highlight(text, ext) {
  const re = text.length < 200000 ? hlRegex(ext) : null;
  if (!re) return esc(text) + '\n';
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + esc(text.slice(last)) + '\n';
}

const extOf = (p) => { const b = basename(p).toLowerCase(); return b.includes('.') ? b.split('.').pop() : b; };
const isDirty = (t) => t.text !== t.orig;

// The editor box always uses LF internally (browsers normalise it). Each document remembers the file's real
// line endings so an untouched CRLF file is not "unsaved", and saving puts CRLF back.
const toLF = (s) => s.replace(/\r\n/g, '\n');
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
function makeTab(f) {
  const text = toLF(f.text);
  return { path: f.path, name: basename(f.path), text, orig: text, eol: eolOf(f.text), conflict: null };
}

/* ---------- editor groups ----------
   A group is one editor pane (tab strip + text area) and one dock panel. Documents are shared: the same file open in
   two groups is the same object, so typing in one group shows up in the other. The ACTIVE group owns the legacy
   element ids (#editor, #edText, #tabs, ...) and the globals `tabs` / `activeTab` mirror it, so older code
   (menu bar, settings, plugins) keeps working on "the editor you are using". */
const groups = [];
let cur = null;
let tabs = [];          // === cur.tabs
let activeTab = -1;     // mirrors cur.activeTab
const ED_IDS = { root: 'editor', tabs: 'tabs', edPath: 'edPath', edSave: 'edSave', edConflict: 'edConflict', edBody: 'edBody', edGutter: 'edGutter', edWrap: 'edWrap', edFlash: 'edFlash', edHl: 'edHl', edText: 'edText', edEmpty: 'edEmpty', edMention: 'edMention', edHide: 'edHide', edReload: 'edReload', edKeep: 'edKeep' };
const CLOSE_SVG = '<svg viewBox="0 0 16 16"><path d="M4.1 3L8 6.9 11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z"/></svg>';

function buildGroupEl() {
  const s = document.createElement('section');
  s.className = 'edGroup';
  s.hidden = true;
  s.innerHTML = `
    <div class="edTabs"></div>
    <div class="edBar">
      <span class="edPath muted small"></span>
      <span class="spacer"></span>
      <button class="ghost edSplit" title="Open this file in a new editor beside this one">Split</button>
      <button class="ghost edMention" title="Add this file to your message">Add to chat</button>
      <button class="ghost edSave" title="Save (Ctrl+S)">Save</button>
      <button class="ghost icon edHide" title="Close this editor">${CLOSE_SVG}</button>
    </div>
    <div class="edConflict" hidden>
      <span>This file changed on disk, but you have unsaved edits here.</span>
      <span class="spacer"></span>
      <button class="edReload">Load disk version</button>
      <button class="edKeep">Keep mine</button>
    </div>
    <div class="edBody" hidden>
      <pre class="edGutter"></pre>
      <div class="edWrap"><div class="edFlash"></div><pre class="edHl"></pre><textarea class="edText" spellcheck="false" wrap="off" autocomplete="off"></textarea></div>
    </div>
    <div class="edEmpty">Click a file in the sidebar to open it here.</div>`;
  return s;
}

function newGroup() {
  const n = groups.reduce((m, g) => Math.max(m, g.n), 0) + 1;
  const root = buildGroupEl();
  const q = (c) => root.querySelector('.' + c);
  const g = {
    n, id: 'editor' + n, root, tabs: [], activeTab: -1, flash: null, flashTimer: null,
    els: { root, tabs: q('edTabs'), edPath: q('edPath'), edSave: q('edSave'), edConflict: q('edConflict'), edBody: q('edBody'), edGutter: q('edGutter'), edWrap: q('edWrap'), edFlash: q('edFlash'), edHl: q('edHl'), edText: q('edText'), edEmpty: q('edEmpty'), edMention: q('edMention'), edHide: q('edHide'), edReload: q('edReload'), edKeep: q('edKeep') },
    split: q('edSplit'),
  };
  groups.push(g);
  Dock.register({ id: g.id, title: n === 1 ? 'Editor' : 'Editor ' + n, el: root, onClose: () => (n === 1 ? Dock.hide(g.id) : closeGroup(g)) });
  wireGroup(g);
  if (!cur) activate(g);
  return g;
}

// the active group gets the legacy ids
function activate(g) {
  if (cur === g) return;
  for (const [name, id] of Object.entries(ED_IDS)) {
    const old = document.getElementById(id);
    if (old && old !== g.els[name]) old.removeAttribute('id');
    g.els[name].id = id;
  }
  cur = g;
  tabs = g.tabs;
  activeTab = g.activeTab;
  for (const x of groups) x.root.classList.toggle('edActive', x === g);
  Faber.emit('editor-group', g);
  readEdMetrics();
}

const titleOf = (g) => (g.n === 1 ? 'Editor' : 'Editor ' + g.n) + (g.tabs[g.activeTab] ? ': ' + g.tabs[g.activeTab].name : '');
const curDoc = () => (cur ? cur.tabs[cur.activeTab] || null : null);
const allDocs = () => { const s = new Set(); for (const g of groups) for (const t of g.tabs) s.add(t); return [...s]; };
const findDoc = (p) => allDocs().find((t) => t.path.toLowerCase() === p.toLowerCase());
const groupsWith = (t) => groups.filter((g) => g.tabs.includes(t));
const groupShowing = (t) => groups.filter((g) => g.tabs[g.activeTab] === t);

function showGroup(g) {
  if (!Dock.visible(g.id)) {
    const near = groups.filter((x) => x !== g && Dock.visible(x.id)).pop();
    Dock.show(g.id, near ? { near: near.id, zone: 'right', ratio: 0.5 } : undefined);
  } else Dock.setActive(g.id);
  paintEditorBtn();
}
function paintEditorBtn() { const b = document.getElementById('editorBtn'); if (b) b.style.color = groups.some((g) => Dock.visible(g.id)) ? 'var(--accent)' : ''; }

function toggleEditor(force) {
  const any = groups.some((g) => Dock.visible(g.id));
  const show = force ?? !any;
  if (show) showGroup(cur || groups[0]);
  else for (const g of groups) Dock.hide(g.id);
  paintEditorBtn();
}

/* ---------- painting one group ---------- */
function gPaint(g) {
  const E = g.els;
  g.flash = null;
  E.edFlash.classList.remove('on');
  const t = g.tabs[g.activeTab];
  E.edBody.hidden = !t;
  E.edEmpty.hidden = !!t;
  E.edPath.textContent = t ? '\u200e' + t.path : '';   // LRM: the label is right-to-left so long paths cut on the left; this keeps a leading / in place
  E.edPath.title = t ? t.path : '';
  E.edSave.disabled = !t || !isDirty(t);
  E.edConflict.hidden = !(t && t.conflict !== null);
  if (t) {
    if (E.edText.value !== t.text) E.edText.value = t.text;
    gSync(g, true);
  }
  gPaintTabs(g);
  Dock.title(g.id, titleOf(g));
  if (g === cur) activeTab = g.activeTab;
}

function gSync(g, fromPaint) {
  const E = g.els;
  const t = g.tabs[g.activeTab];
  if (!t) return;
  const text = E.edText.value;
  t.text = text;
  E.edHl.innerHTML = highlight(text, extOf(t.path));
  const n = text.split('\n').length;
  if (E.edGutter.dataset.n !== String(n)) {
    E.edGutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    E.edGutter.dataset.n = n;
  }
  if (g === cur) Faber.emit('editor-sync', t);
  gScroll(g);
  E.edSave.disabled = !isDirty(t);
  // the dirty dot, in every group that has this document open
  for (const o of groupsWith(t)) { const el = o.els.tabs.children[o.tabs.indexOf(t)]; if (el) el.classList.toggle('dirty', isDirty(t)); if (o.tabs[o.activeTab] === t) o.els.edSave.disabled = !isDirty(t); }
  // other groups showing the same document follow what was typed here
  if (!fromPaint) for (const o of groupShowing(t)) if (o !== g && o.els.edText.value !== text) { o.els.edText.value = text; gSync(o, true); }
}

function gScroll(g) {
  const E = g.els;
  E.edHl.scrollTop = E.edText.scrollTop;
  E.edHl.scrollLeft = E.edText.scrollLeft;
  E.edGutter.scrollTop = E.edText.scrollTop;
  gPositionFlash(g);
}

function gPaintTabs(g) {
  const el = g.els.tabs;
  el.innerHTML = '';
  g.tabs.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === g.activeTab ? ' on' : '') + (isDirty(t) ? ' dirty' : '');
    d.title = t.path;
    d.innerHTML = `<span class="nm"></span><span class="x"><i class="dot"></i>${CLOSE_SVG}</span>`;
    d.querySelector('.nm').textContent = t.name;
    d.onclick = () => { g.activeTab = i; activate(g); gPaint(g); };
    d.onauxclick = (e) => { if (e.button === 1) gCloseTab(g, i); };
    d.querySelector('.x').onclick = (e) => { e.stopPropagation(); gCloseTab(g, i); };
    el.appendChild(d);
  });
  el.children[g.activeTab]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// compat wrappers: "the editor" means the active group
function paintEditor() { if (!cur) return; cur.activeTab = activeTab; gPaint(cur); }
function syncEditor() { if (cur) gSync(cur); }
function syncScroll() { if (cur) gScroll(cur); }
function paintTabs() { if (cur) gPaintTabs(cur); }

// repaint every group that shows (or lists) a document
function repaintDoc(t) {
  for (const g of groupsWith(t)) { if (g.tabs[g.activeTab] === t) gPaint(g); else gPaintTabs(g); }
}
// make the group holding `t` visible and give it that tab
function focusDoc(t) {
  const g = cur && cur.tabs.includes(t) ? cur : groupsWith(t)[0] || cur;
  g.activeTab = g.tabs.indexOf(t);
  showGroup(g);
  activate(g);
  return g;
}

async function openFile(p) {
  let t = findDoc(p);
  if (!t) {
    try { t = makeTab(await api.readFile(p)); } catch (e) { add('error', clean(e)); return; }
    cur.tabs.push(t);
  }
  const g = cur.tabs.includes(t) ? cur : groupsWith(t)[0] || cur;
  if (!g.tabs.includes(t)) g.tabs.push(t);
  g.activeTab = g.tabs.indexOf(t);
  showGroup(g);
  activate(g);
  gPaint(g);
}

// Open a file and put the cursor on a line (used by search results).
async function openFileAt(p, line, col = 0, len = 0) {
  await openFile(p);
  const t = curDoc();
  if (!t) return;
  const lines = t.text.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  const ta = $('edText');
  ta.focus();
  ta.setSelectionRange(pos + col, pos + col + (len || (lines[line - 1] || '').length));
  showFlash({ first: line - 1, count: 1 });
}

function gCloseTab(g, i) {
  const t = g.tabs[i];
  if (!t) return;
  const elsewhere = groups.some((x) => x !== g && x.tabs.includes(t));
  if (isDirty(t) && !elsewhere && !confirm(`Discard unsaved changes to ${t.name}?`)) return;
  g.tabs.splice(i, 1);
  if (i < g.activeTab) g.activeTab--;
  g.activeTab = Math.min(g.activeTab, g.tabs.length - 1);
  if (g.activeTab < 0 && g.tabs.length) g.activeTab = 0;
  gPaint(g);
}
function closeTab(i) { if (cur) gCloseTab(cur, i); }

// A second editor beside the first, showing the same file.
function splitGroup(g) {
  const t = g.tabs[g.activeTab];
  const n = newGroup();
  if (t) { n.tabs.push(t); n.activeTab = 0; }
  Dock.show(n.id, { near: g.id, zone: 'right', ratio: 0.5 });
  activate(n);
  gPaint(n);
  paintEditorBtn();
  return n;
}
function closeGroup(g) {
  if (g.n === 1) return Dock.hide(g.id);
  const lost = g.tabs.filter((t) => isDirty(t) && !groups.some((x) => x !== g && x.tabs.includes(t)));
  if (lost.length && !confirm(`Discard unsaved changes to ${lost.map((t) => t.name).join(', ')}?`)) return;
  const i = groups.indexOf(g);
  groups.splice(i, 1);
  Dock.unregister(g.id);
  if (cur === g) { cur = null; activate(groups[Math.max(0, i - 1)]); }
  paintEditorBtn();
}

async function saveTab() {
  const t = curDoc();
  if (!t || !isDirty(t)) return;
  const out = t.eol === '\r\n' ? t.text.replace(/\n/g, '\r\n') : t.text;
  try { await api.writeFile(t.path, out); t.orig = t.text; t.conflict = null; repaintDoc(t); } catch (e) { add('error', 'Save failed: ' + clean(e)); }
}

/* ---- live updates: follow changes made on disk ---- */
let LINE_H = 20, PAD_TOP = 8;      // read from the computed style: font size / line height are configurable (ui-settings)
const edCfg = { tab: 2 };           // spaces the Tab key inserts
const edLayout = { starts: null };  // word wrap: visual line where each logical line starts (null = no wrapping)
function readEdMetrics() {
  const ta = document.getElementById('edText');
  if (!ta) return;
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  LINE_H = lh > 0 ? lh : 20;
  PAD_TOP = parseFloat(cs.paddingTop) || 8;
}
function visualRange(first, count) {  // logical line range -> visual line range
  const s = edLayout.starts;
  if (!s) return { first, count };
  const a = s[Math.min(first, s.length - 1)], b = s[Math.min(first + count, s.length - 1)];
  return { first: a, count: Math.max(1, b - a) };
}

// First and last line that differ between two versions (common prefix/suffix trimmed).
function changedRange(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const last = Math.max(p, b.length - s - 1);
  return { first: p, count: last - p + 1 };
}

function gPositionFlash(g) {
  const el = g.els.edFlash;
  if (!g.flash) { el.classList.remove('on'); return; }
  readEdMetrics();
  const v = visualRange(g.flash.first, g.flash.count);
  el.style.top = (PAD_TOP + v.first * LINE_H - g.els.edText.scrollTop) + 'px';
  el.style.height = (v.count * LINE_H) + 'px';
}
function positionFlash() { if (cur) gPositionFlash(cur); }

function gShowFlash(g, range) {
  g.flash = range;
  const ta = g.els.edText;
  readEdMetrics();
  const top = PAD_TOP + visualRange(range.first, range.count).first * LINE_H;
  if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 80) ta.scrollTop = Math.max(0, top - 60);
  gScroll(g);
  gPositionFlash(g);
  g.els.edFlash.classList.add('on');
  clearTimeout(g.flashTimer);
  g.flashTimer = setTimeout(() => { g.els.edFlash.classList.remove('on'); g.flash = null; }, 2500);
}
function showFlash(range) { if (cur) gShowFlash(cur, range); }
const flashDoc = (t, range) => { const g = cur && cur.tabs[cur.activeTab] === t ? cur : groupShowing(t)[0]; if (g) gShowFlash(g, range); };

// Bring the editor in line with the file on disk.
//   follow: true  = the AI just edited this file, so open/focus it and highlight the change
//   follow: false = something else changed it; only refresh if it is already open
async function syncFromDisk(p, follow) {
  let f;
  try { f = await api.readFile(p); } catch { return; }   // deleted, binary, or too large
  const disk = toLF(f.text);
  let t = findDoc(f.path);
  if (!t) {
    if (!follow) return;
    t = makeTab(f);
    cur.tabs.push(t);
    gPaint(focusDoc(t));
    flashDoc(t, { first: 0, count: Math.min(disk.split('\n').length, 40) });
    return;
  }
  if (disk === t.orig) return;                            // nothing new on disk
  if (isDirty(t)) {
    // You have real unsaved typing. Never overwrite it silently: show a bar and let you choose.
    t.conflict = disk;
    t.diskEol = eolOf(f.text);
    if (follow) focusDoc(t);
    repaintDoc(t);
    return;
  }
  const range = changedRange(t.text, disk);
  t.text = t.orig = disk;
  t.eol = eolOf(f.text);
  t.conflict = null;
  if (follow) focusDoc(t);
  repaintDoc(t);
  flashDoc(t, range);
}

// Manual reload (button, F5, Ctrl+R): re-read every open file and rebuild the file tree from disk.
let reloadLabelTimer = null;
async function reloadAll() {
  const b = $('reloadBtn');
  b.disabled = true;
  try {
    await refreshTree();
    for (const t of allDocs()) await syncFromDisk(t.path, false);
    b.textContent = 'Reloaded';
  } catch { b.textContent = 'Reload failed'; }
  b.disabled = false;
  clearTimeout(reloadLabelTimer);
  reloadLabelTimer = setTimeout(() => { b.textContent = 'Reload'; }, 1200);
}
api.onReloadKey(() => reloadAll());

// The AI's own file tools reported a change.
function onFileChanged(p) { syncFromDisk(p, true); }

// The folder watcher saw a change (AI commands, terminal programs like claude, other editors).
let treeTimer = null;
api.onFsChanged(({ path: p, exists }) => {
  syncFromDisk(p, false);
  const row = document.querySelector(`#tree [data-path="${CSS.escape(p)}"]`);
  if (exists !== !!row) {                                  // created or deleted
    clearTimeout(treeTimer);
    treeTimer = setTimeout(refreshTree, 500);
  }
});

/* ---------- events of one group ---------- */
function wireGroup(g) {
  const E = g.els;
  const mine = () => { activate(g); return g; };
  g.root.addEventListener('mousedown', mine, true);
  g.root.addEventListener('focusin', mine);
  E.edText.addEventListener('input', () => { mine(); gSync(g); });
  E.edText.addEventListener('scroll', () => gScroll(g));
  E.edText.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, ' '.repeat(edCfg.tab)); }
  });
  E.edSave.onclick = () => { mine(); saveTab(); };
  E.edHide.onclick = () => (g.n === 1 ? Dock.hide(g.id) : closeGroup(g));
  E.edMention.onclick = () => { const t = g.tabs[g.activeTab]; if (t) mention(t.path); };
  g.split.onclick = () => splitGroup(g);
  E.edReload.onclick = () => {
    const t = g.tabs[g.activeTab];
    if (!t || t.conflict === null) return;
    const range = changedRange(t.text, t.conflict);
    t.text = t.orig = t.conflict;
    t.eol = t.diskEol || t.eol;
    t.conflict = null;
    repaintDoc(t);
    flashDoc(t, range);
  };
  E.edKeep.onclick = () => {
    const t = g.tabs[g.activeTab];
    if (!t || t.conflict === null) return;
    t.orig = t.conflict;                                    // disk is now the baseline; saving overwrites it with yours
    t.conflict = null;
    repaintDoc(t);
  };
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && curDoc()) { e.preventDefault(); saveTab(); }
});
window.addEventListener('beforeunload', (e) => { if (allDocs().some(isDirty)) { e.preventDefault(); e.returnValue = ''; } });

// for the layout glue and tests
window.Editors = {
  list: () => groups.map((g) => ({ id: g.id, n: g.n, tabs: g.tabs.map((t) => t.path), active: g.activeTab })),
  count: () => groups.length,
  ensure: (n) => { while (groups.length < n) newGroup(); },
  create: () => newGroup(),
  split: () => splitGroup(cur || groups[0]),
  close: (id) => { const g = groups.find((x) => x.id === id); if (g) closeGroup(g); },
  current: () => (cur ? cur.id : null),
};

newGroup();            // group 1: always exists; it is shown the first time a file opens
Dock.onChange(paintEditorBtn);
