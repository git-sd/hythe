/* Editor pane: tabs, line numbers, light syntax colouring, save. Loaded after app.js (shares its globals). */
const tabs = [];     // {path, name, text, orig}
let activeTab = -1;

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

// The editor box always uses LF internally (browsers normalise it). Each tab remembers the file's real
// line endings so an untouched CRLF file is not "unsaved", and saving puts CRLF back.
const toLF = (s) => s.replace(/\r\n/g, '\n');
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
function makeTab(f) {
  const text = toLF(f.text);
  return { path: f.path, name: basename(f.path), text, orig: text, eol: eolOf(f.text), conflict: null };
}

function toggleEditor(force) {
  const show = force ?? $('editor').hidden;
  $('editor').hidden = $('split').hidden = !show;
  $('editorBtn').style.color = show ? 'var(--accent)' : '';
}

function paintEditor() {
  flash = null;
  $('edFlash').classList.remove("on");
  const t = tabs[activeTab];
  $('edBody').hidden = !t;
  $('edEmpty').hidden = !!t;
  $('edPath').textContent = t ? t.path : '';
  $('edPath').title = t ? t.path : '';
  $('edSave').disabled = !t || !isDirty(t);
  $('edConflict').hidden = !(t && t.conflict !== null);
  if (t) {
    if ($('edText').value !== t.text) $('edText').value = t.text;
    syncEditor();
  }
  paintTabs();
}

function syncEditor() {
  const t = tabs[activeTab];
  if (!t) return;
  const text = $('edText').value;
  t.text = text;
  $('edHl').innerHTML = highlight(text, extOf(t.path));
  const n = text.split('\n').length;
  if ($('edGutter').dataset.n !== String(n)) {
    $('edGutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    $('edGutter').dataset.n = n;
  }
  Faber.emit('editor-sync', t);
  syncScroll();
  $('edSave').disabled = !isDirty(t);
  $('tabs').children[activeTab]?.classList.toggle('dirty', isDirty(t));
}

function syncScroll() {
  const ta = $('edText');
  $('edHl').scrollTop = ta.scrollTop;
  $('edHl').scrollLeft = ta.scrollLeft;
  $('edGutter').scrollTop = ta.scrollTop;
  positionFlash();
}

function paintTabs() {
  const el = $('tabs');
  el.innerHTML = '';
  tabs.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === activeTab ? ' on' : '') + (isDirty(t) ? ' dirty' : '');
    d.title = t.path;
    d.innerHTML = '<span class="nm"></span><span class="x"><i class="dot"></i><svg viewBox="0 0 16 16"><path d="M4.1 3L8 6.9 11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z"/></svg></span>';
    d.querySelector('.nm').textContent = t.name;
    d.onclick = () => { activeTab = i; paintEditor(); };
    d.onauxclick = (e) => { if (e.button === 1) closeTab(i); };
    d.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(i); };
    el.appendChild(d);
  });
  el.children[activeTab]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function openFile(p) {
  const i = tabs.findIndex((t) => t.path.toLowerCase() === p.toLowerCase());
  if (i >= 0) { activeTab = i; toggleEditor(true); return paintEditor(); }
  try {
    const f = await api.readFile(p);
    tabs.push(makeTab(f));
    activeTab = tabs.length - 1;
    toggleEditor(true);
    paintEditor();
  } catch (e) { add('error', clean(e)); }
}

// Open a file and put the cursor on a line (used by search results).
async function openFileAt(p, line, col = 0, len = 0) {
  await openFile(p);
  const t = tabs[activeTab];
  if (!t) return;
  const lines = t.text.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  const ta = $('edText');
  ta.focus();
  ta.setSelectionRange(pos + col, pos + col + (len || (lines[line - 1] || '').length));
  showFlash({ first: line - 1, count: 1 });
}

function closeTab(i) {
  const t = tabs[i];
  if (isDirty(t) && !confirm(`Discard unsaved changes to ${t.name}?`)) return;
  tabs.splice(i, 1);
  if (i < activeTab) activeTab--;
  activeTab = Math.min(activeTab, tabs.length - 1);
  if (activeTab < 0 && tabs.length) activeTab = 0;
  paintEditor();
}

async function saveTab() {
  const t = tabs[activeTab];
  if (!t || !isDirty(t)) return;
  const out = t.eol === '\r\n' ? t.text.replace(/\n/g, '\r\n') : t.text;
  try { await api.writeFile(t.path, out); t.orig = t.text; t.conflict = null; paintEditor(); } catch (e) { add('error', 'Save failed: ' + clean(e)); }
}

/* ---- live updates: follow changes made on disk ---- */
let LINE_H = 20, PAD_TOP = 8;      // read from the computed style: font size / line height are configurable (ui-settings)
const edCfg = { tab: 2 };           // spaces the Tab key inserts
const edLayout = { starts: null };  // word wrap: visual line where each logical line starts (null = no wrapping)
function readEdMetrics() {
  const cs = getComputedStyle($('edText'));
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
let flash = null;        // {first, count} line range currently highlighted
let flashTimer = null;

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

function positionFlash() {
  const el = $('edFlash');
  if (!flash) { el.classList.remove('on'); return; }
  readEdMetrics();
  const v = visualRange(flash.first, flash.count);
  el.style.top = (PAD_TOP + v.first * LINE_H - $('edText').scrollTop) + 'px';
  el.style.height = (v.count * LINE_H) + 'px';
}

function showFlash(range) {
  flash = range;
  const ta = $('edText');
  readEdMetrics();
  const top = PAD_TOP + visualRange(range.first, range.count).first * LINE_H;
  if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 80) ta.scrollTop = Math.max(0, top - 60);
  syncScroll();
  positionFlash();
  $('edFlash').classList.add('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('edFlash').classList.remove('on'); flash = null; }, 2500);
}

// Bring the editor in line with the file on disk.
//   follow: true  = the AI just edited this file, so open/focus it and highlight the change
//   follow: false = something else changed it; only refresh if it is already open
async function syncFromDisk(p, follow) {
  let f;
  try { f = await api.readFile(p); } catch { return; }   // deleted, binary, or too large
  const disk = toLF(f.text);
  let t = tabs.find((x) => x.path.toLowerCase() === f.path.toLowerCase());
  if (!t) {
    if (!follow) return;
    t = makeTab(f);
    tabs.push(t);
    activeTab = tabs.length - 1;
    toggleEditor(true);
    paintEditor();
    showFlash({ first: 0, count: Math.min(disk.split('\n').length, 40) });
    return;
  }
  if (disk === t.orig) return;                            // nothing new on disk
  if (isDirty(t)) {
    // You have real unsaved typing. Never overwrite it silently: show a bar and let you choose.
    t.conflict = disk;
    t.diskEol = eolOf(f.text);
    if (follow) { activeTab = tabs.indexOf(t); toggleEditor(true); }
    if (tabs[activeTab] === t) paintEditor(); else paintTabs();
    return;
  }
  const range = changedRange(t.text, disk);
  t.text = t.orig = disk;
  t.eol = eolOf(f.text);
  t.conflict = null;
  if (follow) { activeTab = tabs.indexOf(t); toggleEditor(true); }
  if (tabs[activeTab] === t) { paintEditor(); showFlash(range); } else paintTabs();
}

// Conflict bar buttons (file changed on disk while you have unsaved edits)
$('edReload').onclick = () => {
  const t = tabs[activeTab];
  if (!t || t.conflict === null) return;
  const range = changedRange(t.text, t.conflict);
  t.text = t.orig = t.conflict;
  t.eol = t.diskEol || t.eol;
  t.conflict = null;
  paintEditor();
  showFlash(range);
};
$('edKeep').onclick = () => {
  const t = tabs[activeTab];
  if (!t || t.conflict === null) return;
  t.orig = t.conflict;                                    // disk is now the baseline; saving overwrites it with yours
  t.conflict = null;
  paintEditor();
};

// Manual reload (button, F5, Ctrl+R): re-read every open file and rebuild the file tree from disk.
let reloadLabelTimer = null;
async function reloadAll() {
  const b = $('reloadBtn');
  b.disabled = true;
  try {
    await refreshTree();
    for (const t of [...tabs]) await syncFromDisk(t.path, false);
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

$('edText').addEventListener('input', syncEditor);
$('edText').addEventListener('scroll', syncScroll);
$('edText').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, ' '.repeat(edCfg.tab)); }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && tabs[activeTab]) { e.preventDefault(); saveTab(); }
});
$('edSave').onclick = saveTab;
$('edHide').onclick = () => toggleEditor(false);
$('edMention').onclick = () => { if (tabs[activeTab]) mention(tabs[activeTab].path); };

// drag the divider to resize
$('split').addEventListener('mousedown', (e) => {
  e.preventDefault();
  $('split').classList.add('drag');
  const right = $('editor').getBoundingClientRect().right;
  const move = (ev) => {
    const w = Math.min(right - 400, Math.max(280, right - ev.clientX));
    $('editor').style.setProperty('--edw', w + 'px');
  };
  const up = () => {
    $('split').classList.remove('drag');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});

window.addEventListener('beforeunload', (e) => { if (tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ''; } });
