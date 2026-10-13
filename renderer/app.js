const $ = (id) => document.getElementById(id);
let settings = {};
// Chat sessions ("agents"): each has its own view (a div inside #chat), so switching keeps DOM and scroll.
// view = { id, el, root, info, cur, tools, subs, cards, busy, scrollTop, stick }  (root === el; sub-agent blocks reuse the shape)
const views = new Map();
let activeSid = null;
const activeView = () => views.get(activeSid) || null;
const chatBox = () => (activeView() ? activeView().el : $('chat'));
const isBusy = () => !!(activeView() && activeView().busy);
const busyOf = (st) => st === 'working' || st === 'approval' || st === 'queued';
const sent = [];          // input history
let sentIdx = 0;

/* ---------- helpers ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function md(src) {
  return src.split('```').map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
    return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }).join('');
}
// c = a view, or a sub-agent context inside one. add()/sys() write to the ACTIVE chat.
function addTo(c, cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  (c ? c.root : $('chat')).appendChild(el);
  scroll(c && c.view);
  return el;
}
const add = (cls, text) => addTo(activeView(), cls, text);
const sys = (t) => add('sys', t);
// follow new output only while the reader is at the bottom
function scroll(v = activeView()) {
  if (!v || v !== activeView() || !v.stick) return;
  const c = $('chat');
  c.scrollTop = c.scrollHeight;
}
function paintSend() { $('sendBtn').textContent = isBusy() ? 'Stop' : 'Send'; }
function setBusy(b, v = activeView()) { if (v) v.busy = b; if (v === activeView()) paintSend(); }
let switching = false;
$('chat').addEventListener('scroll', () => {
  const v = activeView();
  if (!v || switching) return;
  const c = $('chat');
  v.scrollTop = c.scrollTop;
  v.stick = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
});

function applyAccent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  document.documentElement.style.setProperty('--accent', hex);
  return true;
}
async function save(patch) {
  settings = await api.setSettings(patch);
  render();
  Faber.emit('settings', settings);
}
const clean = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

function render() {
  const open = !!settings.workspace;
  $('folderName').textContent = open ? basename(settings.workspace) : 'No folder';
  $('folderName').title = settings.workspace || '';
  $('refreshBtn').hidden = $('closeFolderBtn').hidden = !open;
  $('tree').hidden = !open;
  $('empty').hidden = open;
  $('hiddenChk').checked = !!settings.showHidden;
  renderRecent();
  renderBar();
  applyAccent(settings.accent);
}

const EFFORTS = [
  ['low', 'Low', 'Fast. No thinking, short answers'],
  ['medium', 'Medium', 'Thinks before answering'],
  ['high', 'High', 'Thinks longer, allows long answers'],
];
const MODE_LIST = [
  ['ask', 'Ask first', 'Confirm every file edit and command'],
  ['edits', 'Auto-edit files', 'Edit files freely, confirm commands'],
  ['auto', 'Auto-approve all', 'Never ask. Use with care'],
];
const CHEV = '<svg viewBox="0 0 10 10"><path d="M1 3l4 4 4-4z"/></svg>';
let modelNames = [];

function renderBar() {
  const chip = (id, text) => { $(id).textContent = text; $(id).insertAdjacentHTML('beforeend', CHEV); };
  const cur = activeView() ? activeView().info : settings;   // the chips show the active agent's values
  chip('chipModel', cur.model);
  chip('chipEffort', (EFFORTS.find((e) => e[0] === cur.effort) || EFFORTS[1])[1] + ' effort');
  chip('chipMode', (MODE_LIST.find((m) => m[0] === cur.mode) || MODE_LIST[0])[1]);
  const n = $('scopeNote');
  n.textContent = settings.workspace ? 'AI works in ' + settings.workspace : 'No folder open: chat only, no file access';
  n.title = n.textContent;
}

/* flat popup menu (replaces native dropdowns) */
let popFor = null;
function closePop() { $('pop').hidden = true; popFor?.classList.remove('open'); popFor = null; }
function openMenu(anchor, items, current, onPick) {
  if (popFor === anchor) return closePop();
  closePop();
  const pop = $('pop');
  pop.innerHTML = '';
  if (!items.length) pop.innerHTML = '<div class="none">Nothing to show</div>';
  for (const [value, label, desc] of items) {
    const b = document.createElement('button');
    b.className = 'it' + (value === current ? ' on' : '');
    b.innerHTML = '<b></b>' + (desc ? '<span></span>' : '');
    b.firstChild.textContent = label;
    if (desc) b.lastChild.textContent = desc;
    b.onclick = () => { closePop(); onPick(value); };
    pop.appendChild(b);
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 4) + 'px';
  anchor.classList.add('open');
  popFor = anchor;
}
document.addEventListener('mousedown', (e) => { if (popFor && !$('pop').contains(e.target) && !popFor.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
async function loadModels() {
  const { ok, names } = await api.listModels();
  const installed = [...names];
  for (const m of [settings.model, ...[...views.values()].map((v) => v.info.model)]) if (m && !names.includes(m)) names.unshift(m);
  modelNames = names;
  renderBar();
  return { ok, installed };
}

/* ---------- model download (user-initiated, goes through local Ollama) ---------- */
let pullCard = null;
let pullHandler = null;
api.onPull((ev) => { if (pullHandler) pullHandler(ev); });

function showPullCard(name) {
  if (pullCard) return;
  const el = document.createElement('div');
  el.className = 'approval';
  el.innerHTML = '<div class="hd"></div><div class="pullBody"><p></p><div class="bar" hidden><i></i></div><div class="btns"><button class="primary">Download</button><button hidden>Cancel</button></div></div>';
  el.querySelector('.hd').textContent = 'Model not installed';
  const p = el.querySelector('p'), bar = el.querySelector('.bar'), fill = bar.firstChild;
  const [go, cancel] = el.querySelectorAll('button');
  p.textContent = `${name} is not installed. Downloading needs internet once (several GB) and is done by your local Ollama. After that everything runs offline.`;
  go.onclick = async () => {
    go.hidden = true; cancel.hidden = false; bar.hidden = false;
    pullHandler = (ev) => {
      const pct = ev.total ? Math.floor(((ev.completed || 0) / ev.total) * 100) : null;
      if (pct !== null) fill.style.width = pct + '%';
      p.textContent = ev.status + (pct !== null ? ` ${pct}%` : '');
    };
    try {
      await api.pullModel(name);
      el.remove(); pullCard = null; pullHandler = null;
      sys(`${name} downloaded.`);
      await loadModels();
    } catch (e) {
      pullHandler = null;
      p.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      go.hidden = false; go.textContent = 'Retry'; cancel.hidden = true; bar.hidden = true;
    }
  };
  cancel.onclick = () => api.pullCancel();
  chatBox().appendChild(el);
  pullCard = el;
  scroll();
}
async function checkModel() {
  const { ok, installed } = await loadModels();
  const m = activeView() ? activeView().info.model : settings.model;
  if (!ok) sys('Cannot reach Ollama. Start the Ollama app, then run /model to retry.');
  else if (!installed.includes(m)) showPullCard(m);
}

/* ---------- login ---------- */
let setupMode = false;
async function initLogin() {
  const st = await api.authStatus();
  if (!st.required) { $('lockBtn').hidden = true; return enter(); }
  setupMode = !st.hasUsers;
  $('loginSub').textContent = setupMode ? 'First run — create your admin account' : 'Sign in to continue';
  $('loginBtn').textContent = setupMode ? 'Create account' : 'Log in';
  $('loginPass2').hidden = !setupMode;
  $('loginErr').textContent = '';
  $('loginPass').value = $('loginPass2').value = '';
  $('login').hidden = false;
  $('app').hidden = true;
  $('loginUser').focus();
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = $('loginUser').value, p = $('loginPass').value;
  try {
    if (setupMode) {
      if (p !== $('loginPass2').value) throw new Error('Passwords do not match.');
      await api.authCreate(u, p);
    } else {
      await api.authLogin(u, p);
    }
    await enter();
  } catch (err) {
    $('loginErr').textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('loginPass').value = '';
  }
});
/* ---------- first-run setup ---------- */
const fmtMB = (n) => (n / 1048576 >= 1024 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / 1048576) + ' MB');
api.onSetup((ev) => {
  document.querySelectorAll('#steps li').forEach((li) => {
    const s = +li.dataset.s;
    li.className = s < ev.step ? 'done' : s === ev.step ? 'cur' : '';
  });
  const pct = ev.pct ?? null;
  $('setupFill').style.width = pct === null ? '0%' : Math.floor(pct * 100) + '%';
  $('setupText').textContent = ev.text + (pct !== null ? ` — ${Math.floor(pct * 100)}%` : '') + (ev.total ? ` (${fmtMB(ev.bytes || 0)} / ${fmtMB(ev.total)})` : '');
});
async function ensureSetup() {
  if ((await api.setupStatus()).ready) return;
  $('setup').hidden = false;
  for (;;) {
    $('setupErr').textContent = '';
    $('setupRetry').hidden = true;
    try { await api.setupRun(); break; } catch (e) {
      $('setupErr').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('setupRetry').hidden = false;
      await new Promise((res) => { $('setupRetry').onclick = res; });
    }
  }
  $('setup').hidden = true;
}

async function enter() {
  settings = await api.getSettings();
  $('login').hidden = true;
  $('app').hidden = false;
  $('chat').innerHTML = '';
  views.clear();
  activeSid = null;
  render();
  await ensureSetup();
  const restored = await initSessions();
  if (!restored) {
    sys(settings.workspace
      ? `Welcome to Faber. Folder: ${settings.workspace}\nType /help for commands.`
      : 'Welcome to Faber. Open a folder so the AI can work on your files.\nType /help for commands.');
  }
  checkModel();
  Faber.ready();
  Faber.emit('enter');
  refreshTree();
  $('input').focus();
}
async function lock() {
  await api.authLogout();
  $('loginUser').value = '';
  await initLogin();
}

/* ---------- folder + file tree ---------- */
const SVG = {
  chev: '<svg class="chev" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5z"/></svg>',
  dir: '<svg class="ico dir" viewBox="0 0 16 16"><path d="M1.5 3h4.7l1.5 1.5h6.8V13h-13z"/></svg>',
  file: '<svg class="ico file" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3V14.5h-9z"/></svg>',
  gap: '<span style="width:14px;flex:none"></span>',
};
let selRow = null;
const openDirs = new Set();   // expanded folders survive refreshes

async function refreshTree() {
  const root = $('tree');
  const top = root.scrollTop;
  const selPath = selRow?.dataset.path;
  if (!settings.workspace) openDirs.clear();
  // build off-screen, then swap in, so the tree doesn't flicker or jump while it refreshes
  const next = document.createElement('div');
  selRow = null;
  if (settings.workspace) await fillTree(next, settings.workspace, 0);
  root.replaceChildren(...next.childNodes);
  root.scrollTop = top;
  if (selPath) {
    const again = [...root.querySelectorAll('.row')].find((r) => r.dataset.path === selPath);
    if (again) select(again);
  }
}

async function fillTree(container, dir, depth) {
  const pad = depth * 12 + 8;
  let items;
  try { items = await api.listDir(dir); } catch {
    container.insertAdjacentHTML('beforeend', `<div class="note" style="padding-left:${pad + 18}px">Cannot open this folder</div>`);
    return;
  }
  if (!settings.showHidden) items = items.filter((it) => !it.name.startsWith('.'));
  if (!items.length) {
    container.insertAdjacentHTML('beforeend', `<div class="note" style="padding-left:${pad + 18}px">Empty</div>`);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = pad + 'px';
    row.innerHTML = (it.dir ? SVG.chev + SVG.dir : SVG.gap + SVG.file) + '<span class="nm"></span>';
    row.querySelector('.nm').textContent = it.name;
    row.title = it.path;
    row.dataset.path = it.path;
    container.appendChild(row);
    if (it.dir) {
      const kids = document.createElement('div');
      container.appendChild(kids);
      const expand = async () => { row.classList.add('open'); openDirs.add(it.path); await fillTree(kids, it.path, depth + 1); };
      row.onclick = async () => {
        select(row);
        if (row.classList.contains('open')) { row.classList.remove('open'); openDirs.delete(it.path); kids.innerHTML = ''; }
        else await expand();
      };
      if (openDirs.has(it.path)) await expand();
    } else {
      row.onclick = () => { select(row); openFile(it.path); };
    }
  }
}

function select(row) {
  if (selRow) selRow.classList.remove('sel');
  selRow = row;
  row.classList.add('sel');
}

function mention(p) {
  const rel = settings.workspace && p.startsWith(settings.workspace) ? p.slice(settings.workspace.length + 1) : p;
  const i = $('input');
  i.value += (i.value && !i.value.endsWith(' ') ? ' ' : '') + rel + ' ';
  i.focus();
  autosize();
}

function renderRecent() {
  const r = $('recent');
  r.innerHTML = '';
  const list = settings.recent || [];
  if (!list.length) return;
  r.insertAdjacentHTML('beforeend', '<div class="rhd">Recent</div>');
  for (const p of list.slice(0, 6)) {
    const b = document.createElement('button');
    b.innerHTML = '<b></b><span></span>';
    b.firstChild.textContent = basename(p);
    b.lastChild.textContent = p;
    b.title = p;
    b.onclick = () => openFolder(p);
    r.appendChild(b);
  }
}

async function openFolder(p) {
  try { settings = await api.openFolder(p); } catch (e) { return add('error', clean(e)); }
  render();
  refreshTree();
  sys(`Opened ${settings.workspace}.`);
  Faber.emit('folder', settings.workspace);
}
async function pickFolder() {
  const p = await api.pickFolder();
  if (p) await openFolder(p);
}
async function closeFolder() {
  settings = await api.closeFolder();
  render();
  refreshTree();
  sys('Folder closed. The AI has no file access until you open one.');
  Faber.emit('folder', '');
}

/* ---------- chat sessions + events (main process side: src/features/agents.js) ---------- */
const agentCall = (name, ...a) => api.call('feat:agents:' + name, ...a);

function makeView(info) {
  const el = document.createElement('div');
  el.className = 'chatView';
  el.hidden = true;
  $('chat').appendChild(el);
  const v = { id: info.id, el, root: el, info, cur: null, tools: {}, subs: {}, cards: {}, busy: busyOf(info.status), scrollTop: 0, stick: true };
  v.view = v;
  views.set(info.id, v);
  return v;
}
const order = () => [...views.values()].map((v) => v.info);

async function initSessions() {
  let st = null;
  try { st = await agentCall('state'); } catch { /* feature missing */ }
  if (!st || !st.sessions.length) {
    // chat cannot work without the agents feature; show why in a plain area
    const v = makeView({ id: null, name: 'Chat', model: settings.model, effort: settings.effort, mode: settings.mode, status: 'idle' });
    views.delete(null);
    views.set('none', v);
    activeSid = 'none';
    v.el.hidden = false;
    add('error', 'The agents feature did not load, so chat is unavailable. Restart Faber.');
    return true;
  }
  for (const info of st.sessions) makeView(info);
  activeSid = views.has(st.active) ? st.active : st.sessions[0].id;
  await Promise.all(st.sessions.map(async (info) => {
    try { replay(views.get(info.id), await agentCall('log', info.id)); } catch { /* start blank */ }
  }));
  showView(activeSid, true);
  const v = activeView();
  Faber.emit('agents', 'init');
  return v.el.childNodes.length > 0;
}

function replay(v, events) {
  for (const ev of events) renderEvent(v, ev, true);
  endAssistant(v);
  for (const s of Object.values(v.subs)) endAssistant(s);
  // anything still "running" in a restored transcript was cut off by a restart
  v.el.querySelectorAll('.tool .st').forEach((st) => { if (st.textContent === '…') st.textContent = 'interrupted'; });
  v.el.querySelectorAll('.approval .btns button').forEach((b) => { b.closest('.btns').textContent = 'No answer'; });
}

function showView(sid, force) {
  const next = views.get(sid);
  if (!next) return;
  const prev = activeView();
  if (prev === next && !force) return;
  const c = $('chat');
  switching = true;
  if (prev && prev !== next) {
    prev.scrollTop = c.scrollTop;
    prev.stick = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
    prev.el.hidden = true;
  }
  activeSid = sid;
  next.el.hidden = false;
  c.scrollTop = next.stick ? c.scrollHeight : next.scrollTop;
  requestAnimationFrame(() => { switching = false; });
  if (next.id && !force) agentCall('setActive', next.id).catch(() => {});
  renderBar();
  paintSend();
  if (!force) { Faber.emit('agents', 'active'); $('input').focus(); }
}

function applySessions(list, active) {
  const ids = new Set(list.map((i) => i.id));
  for (const [id, v] of [...views]) if (!ids.has(id) && id !== 'none') { v.el.remove(); views.delete(id); }
  const next = new Map();
  for (const info of list) {
    const v = views.get(info.id);
    if (v) { v.info = info; v.busy = busyOf(info.status); next.set(info.id, v); } else next.set(info.id, makeView(info));
  }
  views.clear();
  for (const [k, v] of next) views.set(k, v);
  if (!views.has(activeSid)) showView(views.has(active) ? active : list[0].id);
  renderBar();
  paintSend();
  Faber.emit('agents', 'list');
}

api.on('feat:agents:event', (ev) => {
  if (ev.type === 'sessions') return applySessions(ev.sessions, ev.active);
  const v = views.get(ev.session);
  if (!v) return;
  if (ev.type === 'status') {
    v.info = { ...v.info, status: ev.status, preview: ev.preview };
    v.busy = busyOf(ev.status);
    if (v === activeView()) paintSend();
    return Faber.emit('agents', 'status');
  }
  renderEvent(v, ev, false);
});
// Older code paths still send file changes on the chat channel (the editor listens for them).
api.onChat((ev) => { if (ev && ev.type === 'file_changed') onFileChanged(ev.path); });

function ensureAssistant(c) {
  if (c.cur) return c.cur;
  const el = document.createElement('div');
  el.className = 'msg cursor';
  c.root.appendChild(el);
  c.cur = { el, text: '', thinking: '', thinkEl: null };
  return c.cur;
}
function endAssistant(c) {
  if (c.cur) { c.cur.el.classList.remove('cursor'); if (!c.cur.text && !c.cur.thinkEl && !c.cur.thinking) c.cur.el.remove(); }
  c.cur = null;
}
function paint(c) {
  const a = c.cur;
  a.el.innerHTML = '';
  if (a.thinking) {
    const d = document.createElement('details');
    d.className = 'think';
    d.innerHTML = '<summary>thinking</summary><div></div>';
    d.lastChild.textContent = a.thinking;
    a.el.appendChild(d);
  }
  const body = document.createElement('span');
  body.innerHTML = md(a.text);
  a.el.appendChild(body);
  scroll(c.view);
}
function summarize(name, args) {
  if (typeof args === 'string') return args;
  if (args.task) return `${args.role || ''}: ${args.task}`;
  return args.command || args.path || args.pattern || '';
}

function toolStart(c, ev) {
  endAssistant(c);
  const el = document.createElement('div');
  el.className = 'tool';
  el.innerHTML = '<div class="hd"><span class="name"></span><span class="arg"></span><span class="st">…</span></div><pre hidden></pre>';
  el.querySelector('.name').textContent = ev.name;
  el.querySelector('.arg').textContent = summarize(ev.name, ev.args || {});
  c.root.appendChild(el);
  c.tools[ev.id] = el;
  if (ev.name === 'delegate_task') {
    // nested, collapsible block for the sub-agent's own activity
    let a = ev.args;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
    const d = document.createElement('details');
    d.className = 'sub';
    d.open = true;
    d.innerHTML = '<summary></summary><div class="subBody"></div>';
    d.querySelector('summary').textContent = `sub-agent: ${(a && a.role) || '?'} (working)`;
    el.insertBefore(d, el.querySelector('pre'));
    c.view.subs[ev.id] = { view: c.view, root: d.lastChild, cur: null, tools: {}, subs: {}, details: d, role: (a && a.role) || '?' };
  }
  scroll(c.view);
}

function renderEvent(v, ev, replaying) {
  const c = ev.sub ? v.subs[ev.sub] : v;
  if (!c) return;
  switch (ev.type) {
    case 'user': addTo(c, 'user', ev.text); break;
    case 'thinking': ensureAssistant(c).thinking += ev.text; paint(c); break;
    case 'token': ensureAssistant(c).text += ev.text; paint(c); break;
    case 'turn_end': endAssistant(c); break;
    case 'tool_start': toolStart(c, ev); break;
    case 'tool_output': {
      const pre = c.tools[ev.id]?.querySelector(':scope > pre');
      if (pre) { pre.hidden = false; pre.textContent += ev.text; pre.scrollTop = pre.scrollHeight; }
      break;
    }
    case 'tool_result': {
      const el = c.tools[ev.id];
      if (!el) break;
      el.classList.toggle('bad', !ev.ok);
      el.querySelector('.st').textContent = ev.ok ? 'ok' : 'failed';
      const pre = el.querySelector(':scope > pre');
      if (!pre.textContent || !ev.ok || el.querySelector('.name').textContent !== 'run_command') {
        pre.hidden = false;
        pre.textContent = ev.output;
      }
      const sub = c.view.subs[ev.id];
      if (sub) {
        sub.details.querySelector('summary').textContent = `sub-agent: ${sub.role} (${ev.ok ? 'done' : 'failed'})`;
        if (ev.ok) sub.details.open = false;
      }
      scroll(c.view);
      break;
    }
    case 'file_changed':
      if (replaying) break;
      // the active chat takes the editor's focus; a background agent only refreshes files that are already open
      if (v === activeView()) onFileChanged(ev.path); else if (typeof syncFromDisk === 'function') syncFromDisk(ev.path, false);
      break;
    case 'approval': showApproval(v, ev); break;
    case 'approval_result': {
      const card = v.cards[ev.id];
      if (card) card.querySelector('.btns').textContent = ev.ok ? 'Allowed' : 'Denied';
      break;
    }
    case 'notice': addTo(c, 'sys', ev.text); break;
    case 'error':
      endAssistant(c);
      addTo(c, 'error', ev.message);
      if (!ev.sub) setBusy(false, v);
      break;
    case 'done':
      endAssistant(c);
      if (!ev.sub) {
        if (ev.stopped) addTo(v, 'sys', 'Stopped.');
        if (!replaying) { setBusy(false, v); if (v === activeView()) $('input').focus(); }
      }
      break;
  }
}

function showApproval(v, ev) {
  endAssistant(v);
  const el = document.createElement('div');
  el.className = 'approval';
  el.innerHTML = '<div class="hd"></div><pre></pre><div class="btns"><button class="primary">Allow</button><button>Deny</button></div>';
  el.querySelector('.hd').textContent = ev.title;
  el.querySelector('pre').textContent = ev.detail;
  if (ev.ok !== undefined) el.querySelector('.btns').textContent = ev.ok ? 'Allowed' : 'Denied';
  else {
    const [yes, no] = el.querySelectorAll('button');
    const done = (ok) => { agentCall('approve', v.id, ev.id, ok).catch(() => {}); el.querySelector('.btns').textContent = ok ? 'Allowed' : 'Denied'; };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  }
  v.root.appendChild(el);
  v.cards[ev.id] = el;
  scroll(v);
}

async function updateSession(sid, patch) {
  const info = await agentCall('update', sid, patch);
  const v = views.get(sid);
  if (v) v.info = info;
  renderBar();
  Faber.emit('agents', 'list');
  return info;
}
const stopSession = (sid) => agentCall('stop', sid).catch(() => {});

// Model picker for an agent: the models feature may provide Faber.pickModel(current, cb).
function pickModelFor(v, anchor) {
  const set = (m) => { const name = m && typeof m === 'object' ? m.name || m.model : m; if (name) updateSession(v.id, { model: name }).catch((e) => add('error', clean(e))); };
  if (typeof Faber.pickModel === 'function') return Faber.pickModel(v.info.model, set);
  loadModels().then(() => openMenu(anchor || $('chipModel'), modelNames.map((n) => [n, n]), v.info.model, set));
}

// What the agents feature (renderer/features/agents.js) builds its UI on.
Faber.chat = {
  sessions: () => order(),
  active: () => activeSid,
  activeInfo: () => (activeView() ? activeView().info : null),
  create: async (name) => {
    const info = await agentCall('create', name ? { name } : {});
    if (!views.has(info.id)) makeView(info);
    showView(info.id);
    return info;
  },
  switchTo: (sid) => showView(sid),
  rename: (sid, name) => agentCall('rename', sid, name),
  close: (sid) => agentCall('close', sid),
  update: (sid, patch) => updateSession(sid, patch),
  stop: (sid) => stopSession(sid),
  stopAll: () => agentCall('stopAll'),
  pickModel: (sid, anchor) => pickModelFor(views.get(sid), anchor),
  deleteHistory: async () => {
    await agentCall('deleteHistory');
    for (const v of views.values()) { v.el.innerHTML = ''; v.cur = null; v.tools = {}; v.subs = {}; v.cards = {}; }
  },
};

/* ---------- slash commands ---------- */
const MODES = { ask: 'ask', edits: 'edits', auto: 'auto' };
const commands = {
  help: ['', 'Show this list', () => sys(Object.entries(commands).map(([n, [a, d]]) => `/${n} ${a}`.padEnd(24) + d).join('\n'))],
  clear: ['', 'Clear the conversation', async () => { const v = activeView(); await agentCall('clear', v.id); v.el.innerHTML = ''; v.cur = null; v.tools = {}; v.subs = {}; v.cards = {}; sys('Conversation cleared.'); }],
  compact: ['', 'Summarize history to free context', async () => { const v = activeView(); addTo(v, 'sys', 'Compacting…'); addTo(v, 'sys', 'Summary:\n' + await agentCall('compact', v.id)); }],
  model: ['[name]', 'Show or switch model', async (a) => { const v = activeView(); if (!a) return sys(`Model: ${v.info.model}\nInstalled: ${(await api.listModels()).names.join(', ') || 'none found'}`); await updateSession(v.id, { model: a }); await loadModels(); sys(`Model → ${a}`); }],
  pull: ['[name]', 'Download a model through local Ollama', async (a) => { const v = activeView(); if (a) await updateSession(v.id, { model: a }); pullCard?.remove(); pullCard = null; showPullCard(v.info.model); }],
  effort: ['low|medium|high', 'Set reasoning effort', async (a) => { if (!['low', 'medium', 'high'].includes(a)) return sys('Usage: /effort low|medium|high'); await updateSession(activeSid, { effort: a }); sys(`Effort → ${a}`); }],
  mode: ['ask|edits|auto', 'Set permission mode', async (a) => { if (!MODES[a]) return sys('Usage: /mode ask|edits|auto'); await updateSession(activeSid, { mode: a }); sys(`Permission mode → ${a}`); }],
  open: ['[path]', 'Open a project folder', (a) => (a ? openFolder(a) : pickFolder())],
  close: ['', 'Close the folder', closeFolder],
  pwd: ['', 'Show the open folder', () => sys(`Folder: ${settings.workspace || '(none)'}`)],
  ls: ['', 'Refresh file tree', () => { refreshTree(); sys('File tree refreshed.'); }],
  run: ['<command>', 'Run a command in the terminal', (a) => { if (!a) return sys('Usage: /run <command>'); runInTerminal(a); }],
  terminal: ['', 'Toggle terminal', () => showTerm()],
  system: ['[text]', 'Set extra system instructions', async (a) => { await save({ extraSystem: a }); sys(a ? 'System instructions updated.' : 'System instructions cleared.'); }],
  ctx: ['<tokens>', 'Set context window (num_ctx)', async (a) => { const n = parseInt(a, 10); if (!(n >= 2048)) return sys(`num_ctx = ${settings.numCtx}. Usage: /ctx 16384`); await save({ numCtx: n }); sys(`Context → ${n}`); }],
  accent: ['<#rrggbb>', 'Change accent colour', async (a) => { if (!applyAccent(a)) return sys('Usage: /accent #8b5cf6'); await save({ accent: a }); }],
  host: ['[url]', 'Show/set Ollama address (localhost only)', async (a) => { if (!a) return sys(settings.host); await save({ host: a }); await loadModels(); sys(`Host → ${a}`); }],
  export: ['', 'Save transcript as markdown', async () => {
    const t = await agentCall('transcript', activeSid);
    const md = t.map((m) => `**${m.role}**: ${m.content || JSON.stringify(m.tool_calls)}`).join('\n\n');
    const p = await api.exportText(md);
    sys(p ? `Saved to ${p}` : 'Cancelled.');
  }],
  useradd: ['<name> <password>', 'Add a user (admin only)', async (a) => { const [u, p] = a.split(/\s+/); await api.addUser(u, p); sys(`User ${u} created.`); }],
  passwd: ['<old> <new>', 'Change your password', async (a) => { const [o, n] = a.split(/\s+/); await api.passwd(o, n); sys('Password changed.'); }],
  lock: ['', 'Lock the app (back to login)', lock],
  logout: ['', 'Log out', lock],
  exit: ['', 'Quit', () => api.quit()],
};

async function runCommand(line) {
  const m = line.match(/^\/(\w+)\s*([\s\S]*)$/);
  const cmd = m && commands[m[1]];
  if (!cmd) return sys(`Unknown command. Type /help.`);
  try { await cmd[2](m[2].trim()); } catch (e) { add('error', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}

/* ---------- input ---------- */
async function submit() {
  const v = activeView();
  if (v && v.busy) { if (v.id) stopSession(v.id); return; }
  const text = $('input').value.trim();
  if (!text) return;
  sent.push(text); sentIdx = sent.length;
  $('input').value = ''; autosize(); hideSlash();
  if (text.startsWith('/')) return runCommand(text);
  if (!v || !v.id) return add('error', 'Chat is unavailable: the agents feature did not load.');
  add('user', text);
  setBusy(true, v);
  try { await agentCall('send', v.id, text); } catch (e) { addTo(v, 'error', clean(e)); setBusy(false, v); }
}
function autosize() { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 200) + 'px'; }

let slashSel = 0, slashItems = [];
function showSlash() {
  const v = $('input').value;
  if (!/^\/\w*$/.test(v)) return hideSlash();
  slashItems = Object.entries(commands).filter(([n]) => n.startsWith(v.slice(1)));
  if (!slashItems.length) return hideSlash();
  slashSel = Math.min(slashSel, slashItems.length - 1);
  const menu = $('slashMenu');
  menu.hidden = false;
  menu.innerHTML = '';
  slashItems.forEach(([n, [a, d]], i) => {
    const row = document.createElement('div');
    row.className = i === slashSel ? 'sel' : '';
    row.innerHTML = `<b>/${n}</b><span></span>`;
    row.lastChild.textContent = (a ? a + ' — ' : '') + d;
    row.onclick = () => { $('input').value = `/${n} `; hideSlash(); $('input').focus(); };
    menu.appendChild(row);
  });
}
const hideSlash = () => { $('slashMenu').hidden = true; slashSel = 0; };

$('input').addEventListener('input', () => { autosize(); showSlash(); });
$('input').addEventListener('keydown', (e) => {
  const open = !$('slashMenu').hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
    return showSlash();
  }
  if (open && e.key === 'Tab') { e.preventDefault(); $('input').value = `/${slashItems[slashSel][0]} `; return hideSlash(); }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return submit(); }
  if (e.key === 'Escape') { hideSlash(); if (isBusy() && activeView().id) stopSession(activeView().id); }
  if (!open && e.key === 'ArrowUp' && !$('input').value && sentIdx > 0) { $('input').value = sent[--sentIdx]; e.preventDefault(); }
});
$('sendBtn').onclick = submit;

/* ---------- toolbar + sidebar ---------- */
$('chipModel').onclick = (e) => { const v = activeView(); if (v && v.id) pickModelFor(v, e.currentTarget); };
$('chipEffort').onclick = (e) => { const v = activeView(); if (v && v.id) openMenu(e.currentTarget, EFFORTS, v.info.effort, (x) => updateSession(v.id, { effort: x })); };
$('chipMode').onclick = (e) => { const v = activeView(); if (v && v.id) openMenu(e.currentTarget, MODE_LIST, v.info.mode, (x) => updateSession(v.id, { mode: x })); };
$('editorBtn').onclick = () => toggleEditor();
$('termBtn').onclick = () => showTerm();
$('termClose').onclick = () => showTerm();
$('lockBtn').onclick = lock;
$('toggleTree').onclick = () => { $('side').hidden = !$('side').hidden; Faber.refreshRail(); };
$('openBtn').onclick = pickFolder;
$('emptyOpen').onclick = pickFolder;
$('refreshBtn').onclick = () => reloadAll();
$('reloadBtn').onclick = () => reloadAll();
$('closeFolderBtn').onclick = closeFolder;
$('hiddenChk').onchange = async () => { await save({ showHidden: $('hiddenChk').checked }); refreshTree(); };
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === '`') { e.preventDefault(); showTerm(); } });

Faber.bind({
  settings: () => settings,
  save: (patch) => save(patch),
  sys: (t) => sys(t),
  error: (t) => add('error', t),
  openFile: (p) => openFile(p),
  refreshTree: () => refreshTree(),
  runInTerminal: (c) => runInTerminal(c),
  commands,
});
initLogin();
