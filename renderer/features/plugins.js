/* feature: plugins (renderer). Sidebar tab, results panel, settings, slash commands, menu items, snippets.
   Plugins are declarative (see src/plugins-lib/manifest.js); everything runs in the main process. */
Faber.register('plugins', (F) => {
  const el = F.el;
  const call = (m, ...a) => F.call('feat:plugins:' + m, ...a);
  const NS = (window.FaberPlugins = {});
  let state = { plugins: [], settings: {}, userDir: '', builtinDir: '' };
  let cur = null;                       // {id, cmd, plugin, outputMode} of the running UI command
  let seq = 0;
  const rid = () => 'r' + Date.now().toString(36) + (++seq);
  const sepOf = (p) => (p.includes('\\') ? '\\' : '/');

  /* ---------- editor helpers (editor.js globals) ---------- */
  const activeTabObj = () => (typeof tabs !== 'undefined' && typeof activeTab !== 'undefined' ? tabs[activeTab] : null);
  const activeFile = () => { const t = activeTabObj(); return t ? t.path : ''; };
  const g = (id) => document.getElementById(id);

  /* ---------- clickable file:line references ---------- */
  const EXT = 'js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|c|cc|cpp|cxx|h|hpp|cs|vb|fs|rb|php|swift|dart|lua|vue|svelte|css|scss|less|html|json|md|sh|ps1|yml|yaml|toml|sql|txt';
  const PATHCH = String.raw`[^\s:()'"<>|*?]`;
  const RE_COLON = new RegExp(String.raw`((?:[A-Za-z]:)?${PATHCH}*\.(?:${EXT}))(?=:\d)(?::(\d+))(?::(\d+))?`, 'g');
  const RE_PAREN = new RegExp(String.raw`((?:[A-Za-z]:)?${PATHCH}*\.(?:${EXT}))\((\d+)(?:,\s*(\d+))?\)`, 'g');
  const RE_PYTB = /File "([^"]+)", line (\d+)/g;
  const RE_HEADER = new RegExp(String.raw`^((?:[A-Za-z]:)?[^\s:*?"<>|]+\.(?:${EXT}))\s*$`);
  const RE_ESLINT = /^(\s+)(\d+):(\d+)(?=\s)/;

  // -> [{text} | {text, path, line, col}]; `st.file` carries an eslint-style "file header" line to the lines below it
  function parseRefs(line, st = {}) {
    const hits = [];
    const grab = (re, mapIt) => { re.lastIndex = 0; let m; while ((m = re.exec(line))) hits.push(mapIt(m)); };
    grab(RE_COLON, (m) => ({ i: m.index, len: m[0].length, path: m[1], line: +m[2], col: +(m[3] || 1) }));
    grab(RE_PAREN, (m) => ({ i: m.index, len: m[0].length, path: m[1], line: +m[2], col: +(m[3] || 1) }));
    grab(RE_PYTB, (m) => ({ i: m.index + 6, len: m[1].length, path: m[1], line: +m[2], col: 1 }));
    const h = RE_HEADER.exec(line);
    if (h) { st.file = h[1]; }
    else if (st.file) {
      const e = RE_ESLINT.exec(line);
      if (e) hits.push({ i: e[1].length, len: e[0].length - e[1].length, path: st.file, line: +e[2], col: +e[3] });
      else if (line.trim() === '') st.file = '';
    }
    hits.sort((a, b) => a.i - b.i || b.len - a.len);
    const segs = [];
    let pos = 0;
    for (const hit of hits) {
      if (hit.i < pos) continue;
      if (hit.i > pos) segs.push({ text: line.slice(pos, hit.i) });
      segs.push({ text: line.slice(hit.i, hit.i + hit.len), path: hit.path, line: hit.line, col: hit.col });
      pos = hit.i + hit.len;
    }
    if (pos < line.length) segs.push({ text: line.slice(pos) });
    return segs.length ? segs : [{ text: line }];
  }
  NS.parseRefs = parseRefs;

  function joinPath(base, rel) {
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(rel)) return rel;
    const sep = sepOf(base || rel);
    const out = (base || '').split(/[\\/]/);
    for (const part of rel.split(/[\\/]/)) {
      if (part === '.' || part === '') continue;
      if (part === '..') { if (out.length > 1) out.pop(); } else out.push(part);
    }
    return out.join(sep);
  }

  // Open a file and put the cursor on a line.
  async function openAt(path, line, col) {
    await F.openFile(path);
    const t = activeTabObj();
    const ta = g('edText');
    if (!t || !ta || t.path.toLowerCase() !== path.toLowerCase()) return false;
    const text = ta.value;
    let off = 0;
    for (let i = 1; i < line; i++) { const n = text.indexOf('\n', off); if (n < 0) break; off = n + 1; }
    let end = text.indexOf('\n', off);
    if (end < 0) end = text.length;
    const at = Math.min(off + Math.max(0, (col || 1) - 1), end);
    ta.focus();
    ta.setSelectionRange(at, at);
    ta.scrollTop = Math.max(0, (line - 1) * 20 - ta.clientHeight / 3);
    if (typeof showFlash === 'function') { try { showFlash({ first: Math.max(0, line - 1), count: 1 }); } catch { /* cosmetic */ } }
    return true;
  }
  NS.openAt = openAt;

  /* ---------- results panel (docked above the chat input) ---------- */
  const panel = el('section');
  panel.id = 'plgPanel';
  panel.hidden = true;
  panel.innerHTML = '<div class="plgSplit"></div><div class="plgBar"><span class="plgTitle"></span><span class="plgStatus"></span><span class="spacer"></span>' +
    '<input class="plgFilter" placeholder="Filter (file, text, TODO...)" hidden spellcheck="false"><button class="ghost plgStop" hidden>Stop</button><button class="ghost plgClear">Clear</button><button class="ghost plgHide">Hide</button></div>' +
    '<div class="plgBody"></div><div class="plgFoot" hidden></div>';
  const mainEl = document.querySelector('main');
  mainEl.insertBefore(panel, document.querySelector('.inputWrap'));
  const $p = (s) => panel.querySelector(s);
  const body = $p('.plgBody');
  let pending = '', pendingEl = null, queue = '', flushTimer = null, lineCount = 0, refState = {}, panelCwd = '';
  let mode = 'output';

  function showPanel() { panel.hidden = false; }
  function resetBody() {
    body.textContent = '';
    pending = ''; queue = ''; lineCount = 0; refState = {};
    pendingEl = el('div', 'plgLine plgPending');
    body.appendChild(pendingEl);
  }
  function panelBegin(title, sub, cwd) {
    mode = 'output';
    showPanel();
    panelCwd = cwd || F.folder();
    $p('.plgTitle').textContent = title;
    $p('.plgStatus').textContent = sub || '';
    $p('.plgStatus').className = 'plgStatus';
    $p('.plgFilter').hidden = true;
    $p('.plgFoot').hidden = true;
    $p('.plgFoot').textContent = '';
    resetBody();
  }
  const clean = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  function addLine(text) {
    const d = el('div', 'plgLine');
    for (const seg of parseRefs(text, refState)) {
      if (seg.path) {
        const a = el('a', 'plgRef', seg.text);
        a.dataset.path = seg.path; a.dataset.line = seg.line; a.dataset.col = seg.col;
        a.title = 'Open ' + seg.path + ' at line ' + seg.line;
        d.appendChild(a);
      } else d.appendChild(document.createTextNode(seg.text));
    }
    if (!text) d.appendChild(document.createTextNode(' '));
    body.insertBefore(d, pendingEl);
    if (++lineCount > 4000) { body.firstChild.remove(); lineCount--; }
  }
  function flush() {
    flushTimer = null;
    if (mode !== 'output' || !pendingEl) { queue = ''; return; }
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const parts = (pending + clean(queue)).split(/\r?\n/);
    queue = '';
    pending = parts.pop();
    for (const l of parts) addLine(l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l);
    pendingEl.textContent = pending;
    if (stick) body.scrollTop = body.scrollHeight;
  }
  function panelOut(text) {
    queue += text;
    if (!flushTimer) flushTimer = setTimeout(flush, 30);
  }
  function panelFinish(info) {
    clearTimeout(flushTimer);
    queue += '\n';
    flush();
    pendingEl.textContent = '';
    const bad = info.timedOut || info.killed || (info.code !== 0 && !(info.summary && info.summary.status === 'pass'));
    const st = $p('.plgStatus');
    st.textContent = info.killed ? 'Stopped' : info.timedOut ? 'Timed out' : `Finished, exit code ${info.code}, ${(info.ms / 1000).toFixed(1)}s`;
    st.className = 'plgStatus ' + (bad ? 'bad' : 'ok');
    const foot = $p('.plgFoot');
    const bits = [];
    if (info.summary) bits.push(info.summary.line);
    if (info.changed && info.changed.length) bits.push('Changed: ' + info.changed.slice(0, 6).join(', ') + (info.changed.length > 6 ? ` and ${info.changed.length - 6} more` : ''));
    foot.textContent = bits.join('   |   ');
    foot.className = 'plgFoot' + (info.summary ? (info.summary.status === 'pass' ? ' ok' : ' bad') : '');
    foot.hidden = !bits.length;
  }
  function panelMessage(title, text, bad) {
    panelBegin(title, '');
    const st = $p('.plgStatus');
    st.textContent = bad ? 'Could not run' : '';
    st.className = 'plgStatus' + (bad ? ' bad' : '');
    for (const l of String(text).split('\n')) addLine(l);
  }

  body.addEventListener('click', (e) => {
    const a = e.target.closest('.plgRef, .plgTodo');
    if (!a) return;
    const p = joinPath(panelCwd, a.dataset.path);
    openAt(p, +a.dataset.line || 1, +a.dataset.col || 1).then((ok) => { if (!ok) F.toast('Could not open ' + a.dataset.path); });
  });
  $p('.plgHide').onclick = () => { panel.hidden = true; };
  $p('.plgClear').onclick = () => { if (!cur) { resetBody(); mode = 'output'; $p('.plgStatus').textContent = ''; $p('.plgFoot').hidden = true; $p('.plgFilter').hidden = true; } };
  $p('.plgStop').onclick = () => { if (cur) call('stop', cur.id); };
  $p('.plgSplit').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const bottom = panel.getBoundingClientRect().bottom;
    const move = (ev) => panel.style.setProperty('--plgh', Math.min(innerHeight - 260, Math.max(100, bottom - ev.clientY)) + 'px');
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });

  function setRunning(on) {
    $p('.plgStop').hidden = !on;
    document.querySelectorAll('.plgRun, .plgScriptRun').forEach((b) => { b.disabled = on; });
  }

  F.on('feat:plugins:out', (m) => { if (cur && m.id === cur.id) panelOut(m.text); });
  F.on('feat:plugins:done', (m) => {
    if (!cur || m.id !== cur.id) return;
    const c = cur;
    cur = null;
    setRunning(false);
    panelFinish(m);
    if (c.output === 'toast') F.toast(`${c.title}: ${m.killed ? 'stopped' : m.timedOut ? 'timed out' : m.code === 0 ? 'done' : 'failed (exit ' + m.code + ')'}`);
    if (c.slash) F.sys(`${c.title} (${m.label}): ${m.summary ? m.summary.line : m.killed ? 'stopped' : 'exit code ' + m.code}`);
    NS.lastDone = m;
  });

  /* ---------- running commands ---------- */
  function askText(title, label, pattern) {
    return new Promise((resolve) => {
      let input, done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const m = F.modal({
        title,
        body: (box) => {
          box.append(el('div', 'muted small', label));
          input = el('input', 'plgAsk');
          input.style.width = '100%';
          input.spellcheck = false;
          box.appendChild(input);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value); m.close(); } });
          setTimeout(() => input.focus(), 0);
        },
        buttons: [{ label: 'Cancel', onClick: () => finish(null) }, { label: 'Run', primary: true, onClick: () => finish(input.value) }],
      });
      const x = m.el.parentElement.querySelector('.modalHead button');
      if (x) x.addEventListener('click', () => finish(null));
    });
  }

  async function runCmd(p, c, opts = {}) {
    if (cur) { F.toast('A command is already running. Stop it first.'); return; }
    let file = '';
    if (c.scope === 'file') {
      file = activeFile();
      if (!file) { F.toast('Open a file in the editor first.'); return; }
      const t = activeTabObj();
      if (t && typeof isDirty === 'function' && isDirty(t) && state.settings.autoSave !== false) { try { await saveTab(); } catch { /* shown by the editor */ } }
    }
    let arg = opts.arg;
    if (c.arg && (arg === undefined || arg === '')) {
      if (c.arg.required || opts.ask) { arg = await askText(c.title, c.arg.label); if (arg === null) return; } else arg = '';
    }
    const id = rid();
    cur = { id, title: c.title, output: c.output, slash: !!opts.slash };
    setRunning(true);
    panelBegin(c.title, 'Starting...');
    let r;
    try { r = await call('run', { pluginId: p.id, command: c.name, runId: id, file, arg }); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      cur = null; setRunning(false);
      panelMessage(c.title, r.error, true);
      if (opts.slash) F.sys(c.title + ': ' + r.error.split('\n')[0]);
      return;
    }
    if (r.mode === 'terminal') {
      cur = null; setRunning(false);
      panel.hidden = true;
      F.runInTerminal(r.command);
      return;
    }
    $p('.plgStatus').textContent = 'Running with ' + r.label;
    $p('.plgStatus').title = (r.used || []).join('\n') + '\n' + r.command;
    panelOut(`> ${r.label}\n> ${r.command}\n\n`);
    if (opts.slash) F.sys(`Running ${c.title} with ${r.label}...`);
  }
  NS.runCmd = (pluginId, name, opts) => { const p = state.plugins.find((x) => x.id === pluginId); const c = p && p.commands.find((k) => k.name === name); return p && c ? runCmd(p, c, opts) : Promise.resolve(); };

  /* ---------- TODO scanner ---------- */
  let todoRun = null;
  async function scanTodos(tag) {
    if (todoRun) { F.toast('A scan is already running.'); return; }
    if (!F.folder()) { F.toast('Open a folder first.'); return; }
    const id = rid();
    todoRun = id; cur = { id, title: 'Scan for TODOs', output: 'panel', todo: true };
    setRunning(true);
    panelBegin('TODO scanner', 'Scanning...', F.folder());
    let r;
    try { r = await call('todos', { runId: id, tag }); } catch (e) { r = { ok: false, error: e.message }; }
    todoRun = null; cur = null; setRunning(false);
    if (!r.ok) { panelMessage('TODO scanner', r.error, true); return; }
    showTodos(r);
    return r;
  }
  F.on('feat:plugins:progress', (m) => { if (todoRun && m.id === todoRun) $p('.plgStatus').textContent = `Scanning... ${m.scanned} files`; });

  function showTodos(r) {
    mode = 'todos';
    const filter = $p('.plgFilter');
    filter.hidden = false; filter.value = '';
    $p('.plgTitle').textContent = 'TODO scanner';
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const items = q ? r.items.filter((i) => (i.file + ' ' + i.tag + ' ' + i.text + ' ' + i.owner).toLowerCase().includes(q)) : r.items;
      body.textContent = '';
      let file = null, grp = null;
      for (const i of items) {
        if (i.file !== file) {
          file = i.file;
          grp = el('div', 'plgGroup');
          grp.appendChild(el('div', 'plgFile', i.file));
          body.appendChild(grp);
        }
        const row = el('div', 'plgTodo');
        row.dataset.path = i.abs; row.dataset.line = i.line; row.dataset.col = 1;
        row.title = `Open ${i.file}:${i.line}`;
        row.append(el('span', 'plgLn', String(i.line)), el('span', 'plgTag t' + i.tag, i.tag), el('span', 'plgTxt', (i.owner ? `(${i.owner}) ` : '') + i.text));
        grp.appendChild(row);
      }
      if (!items.length) body.appendChild(el('div', 'plgLine', r.items.length ? 'Nothing matches the filter.' : 'No TODO, FIXME, HACK or XXX found.'));
      const st = $p('.plgStatus');
      st.className = 'plgStatus ok';
      st.textContent = `${items.length}${q ? ' of ' + r.items.length : ''} item(s) in ${new Set(items.map((i) => i.file)).size} file(s), ${r.scanned} files scanned, ${(r.ms / 1000).toFixed(1)}s${r.truncated ? ' (limit reached, partial)' : ''}`;
    };
    let t;
    filter.oninput = () => { clearTimeout(t); t = setTimeout(draw, 80); };
    draw();
    NS.todoDraw = draw;
  }
  NS.scanTodos = scanTodos;

  /* ---------- project scripts ---------- */
  async function fillScripts(box) {
    box.textContent = '';
    box.appendChild(el('div', 'muted small', 'Looking for scripts...'));
    let r;
    try { r = await call('scripts'); } catch (e) { r = { ok: false, error: e.message }; }
    box.textContent = '';
    if (!r.ok) { box.appendChild(el('div', 'plgErr', r.error)); return; }
    if (!r.groups.length) { box.appendChild(el('div', 'muted small', r.noFolder ? 'Open a folder to list its scripts.' : 'No package.json scripts, Makefile targets or pyproject tasks here.')); return; }
    for (const grp of r.groups) {
      box.appendChild(el('div', 'plgGroupHd', grp.label));
      if (grp.missing) box.appendChild(el('div', 'plgErr small', grp.missing + '. Faber will not install it.'));
      for (const s of grp.scripts) {
        const row = el('div', 'plgScript');
        const b = el('button', 'plgScriptRun', 'Run');
        b.dataset.source = grp.source; b.dataset.name = s.name;
        b.onclick = () => runScript(grp.source, s.name);
        const label = el('span', 'plgScriptName', s.name);
        label.title = s.detail || s.name;
        row.append(label, b);
        box.appendChild(row);
      }
    }
  }
  async function runScript(source, name) {
    if (cur) { F.toast('A command is already running. Stop it first.'); return; }
    const id = rid();
    cur = { id, title: `${source} ${name}`, output: 'panel' };
    setRunning(true);
    panelBegin(`${source} run ${name}`, 'Starting...');
    let r;
    try { r = await call('runScript', { runId: id, source, name }); } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) { cur = null; setRunning(false); panelMessage(`${source} ${name}`, r.error, true); return; }
    $p('.plgStatus').textContent = 'Running';
    panelOut(`> ${r.command}\n\n`);
  }
  NS.runScript = runScript;

  /* ---------- list + cards ---------- */
  const list = el('div', 'plgList');
  let headStatus = null;

  async function refresh() {
    let r;
    try { r = await call('list'); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok) state = r;
    paintList();
    syncSlash();
    await syncSnippets();
    return state;
  }
  NS.refresh = refresh;
  NS.state = () => state;

  function permSummary(p) { return p.permissions.map((x) => x.label.split(' (')[0]).join('; '); }

  function paintList() {
    list.textContent = '';
    if (!state.plugins.length) list.appendChild(el('div', 'muted small plgPad', 'No plugins found.'));
    for (const p of state.plugins) list.appendChild(card(p));
    if (headStatus) headStatus.textContent = `${state.plugins.filter((p) => p.enabled).length} of ${state.plugins.length} enabled`;
  }

  function card(p) {
    const c = el('div', 'plgCard' + (p.enabled ? ' on' : '') + (p.error ? ' bad' : ''));
    c.dataset.id = p.id;
    const head = el('div', 'plgHead');
    head.append(el('span', 'plgName', p.name), el('span', 'plgVer', p.version ? 'v' + p.version : ''), el('span', 'plgSrc', p.source === 'builtin' ? 'built-in' : 'yours'));
    const tg = el('button', 'plgToggle' + (p.enabled ? ' on' : ''), p.enabled ? 'On' : 'Off');
    tg.title = p.enabled ? 'Disable this plugin' : 'Enable this plugin';
    tg.disabled = !!p.error;
    tg.onclick = () => toggle(p);
    head.appendChild(tg);
    c.appendChild(head);
    if (p.error) { c.appendChild(el('div', 'plgErr', 'Cannot load: ' + p.error)); return c; }
    c.appendChild(el('div', 'plgDesc', p.description));
    if (p.note) c.appendChild(el('div', 'plgErr small', p.note));
    c.appendChild(el('div', 'plgPerms muted small', p.permissions.length ? 'Needs: ' + permSummary(p) : 'Needs no special access'));
    if (p.enabled) {
      const cmds = el('div', 'plgCmds');
      for (const k of p.commands) {
        if (k.handler === 'scripts') continue;
        const b = el('button', 'plgRun', k.handler === 'ui:devtools' ? 'Open' : k.title);
        b.title = k.title + (k.scope === 'file' ? ' (uses the file open in the editor)' : '');
        b.dataset.cmd = k.name;
        b.onclick = () => runAction(p, k);
        cmds.appendChild(b);
      }
      if (cmds.children.length) c.appendChild(cmds);
      if (p.commands.some((k) => k.handler === 'scripts')) {
        const box = el('div', 'plgScripts');
        c.appendChild(box);
        fillScripts(box);
      }
      if (p.tools.length) c.appendChild(el('div', 'plgPerms muted small', 'AI tools: ' + p.tools.map((t) => t.name).join(', ')));
      if (p.snippets) c.appendChild(el('div', 'plgPerms muted small', p.snippets + ' snippets (type the prefix, press Tab)'));
    }
    return c;
  }

  function runAction(p, k, opts) {
    if (k.handler === 'todo-scan') return scanTodos();
    if (k.handler === 'ui:devtools') return openDevtools();
    if (k.handler === 'scripts') { F.showSideTab('plugins'); return; }
    return runCmd(p, k, opts);
  }

  function confirmEnable(p) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const m = F.modal({
        title: 'Enable "' + p.name + '"?',
        wide: true,
        body: (box) => {
          box.classList.add('plgEnable');
          box.append(el('div', '', p.description));
          box.append(el('div', 'muted small plgGap', (p.source === 'builtin' ? 'Built into Faber.' : 'Installed by you in ' + p.dir + '.') + ' Plugins are plain data: they never run code inside Faber, they only describe commands.'));
          box.append(el('div', 'plgGroupHd', 'This plugin asks for permission to:'));
          const ul = el('ul', 'plgPermList');
          for (const x of p.permissions) ul.appendChild(el('li', '', x.label));
          if (!p.permissions.length) ul.appendChild(el('li', '', 'Nothing special'));
          box.appendChild(ul);
          const items = [];
          for (const k of p.commands) for (const t of k.templates) items.push(`${k.title}  [${t.label}]\n    ${t.run}`);
          for (const t of p.tools) items.push(`AI tool ${t.name}: ${t.description}${t.templates.length ? '\n    ' + t.templates.join('\n    ') : ''}`);
          if (items.length) {
            box.append(el('div', 'plgGroupHd', 'What it can run'));
            const pre = el('pre', 'plgPre', items.join('\n'));
            box.appendChild(pre);
          }
          if (p.tools.length) box.append(el('div', 'muted small', 'AI tools ask your approval before every command, unless you chose Auto-approve.'));
        },
        buttons: [{ label: 'Cancel', onClick: () => fin(false) }, { label: 'Enable plugin', primary: true, onClick: () => fin(true) }],
      });
      const x = m.el.parentElement.querySelector('.modalHead button');
      if (x) x.addEventListener('click', () => fin(false));
    });
  }
  NS.confirmEnable = confirmEnable;

  async function toggle(p) {
    if (!p.enabled && !(await confirmEnable(p))) return false;
    const r = await call('enable', p.id, !p.enabled);
    if (!r.ok) { F.toast(r.error); return false; }
    await refresh();
    return true;
  }
  NS.toggle = (id) => { const p = state.plugins.find((x) => x.id === id); return p ? toggle(p) : Promise.resolve(false); };

  /* ---------- sidebar tab ---------- */
  F.addSideTab({
    id: 'plugins', title: 'Plugins',
    render(pane) {
      pane.classList.add('plgPane');
      const bar = el('div', 'plgTop');
      headStatus = el('span', 'muted small plgCount');
      const reload = el('button', 'ghost plgReload', 'Reload');
      reload.title = 'Re-read all plugin folders';
      reload.onclick = async () => { const r = await call('reload'); if (r.ok) { state = r; paintList(); syncSlash(); syncSnippets(); F.toast('Plugins reloaded'); } };
      const folder = el('button', 'ghost plgFolder', 'Open folder');
      folder.title = 'Open the folder for your own plugins';
      folder.onclick = async () => { const r = await call('openFolder'); if (r.ok) F.toast('Your plugins live in ' + r.dir); };
      const dev = el('button', 'ghost plgDev', 'Dev tools');
      dev.onclick = () => openDevtools();
      bar.append(headStatus, el('span', 'spacer'), reload, folder, dev);
      pane.append(bar, list);
      refresh();
    },
    onShow() { refresh(); },
  });
  F.onEvent('folder', () => { if (!g('pane-plugins').hidden) refresh(); });

  /* ---------- dev tools (separate file, loaded on demand) ---------- */
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function pluginOn(handler) { return state.plugins.some((p) => p.enabled && p.commands.some((c) => c.handler === handler)); }
  async function openDevtools() {
    if (!pluginOn('ui:devtools')) { F.toast('Enable "Developer utilities" in the Plugins tab first.'); F.showSideTab('plugins'); return; }
    try {
      if (!window.FaberDevtools) await loadScript('features/plugins-devtools.js');
      window.FaberDevtools.open(F, { call });
    } catch (e) { F.error(e.message); }
  }
  NS.openDevtools = openDevtools;

  /* ---------- slash commands + menus ---------- */
  const slashOwn = new Map();    // slash name -> true
  function syncSlash() {
    const store = typeof commands !== 'undefined' ? commands : null;
    if (!store) return;
    for (const n of [...slashOwn.keys()]) { delete store[n]; slashOwn.delete(n); }
    for (const p of state.plugins) {
      if (!p.enabled) continue;
      for (const k of p.commands) {
        if (k.handler === 'ui:devtools') continue;
        let name = k.name;
        if (store[name]) name = (p.id + '_' + k.name).replace(/-/g, '_');
        if (store[name]) continue;
        const hint = k.arg ? `<${k.arg.label.toLowerCase()}>` : k.handler === 'todo-scan' ? '[TODO|FIXME|HACK|XXX]' : '';
        F.addCommand(name, hint, k.title + ' (plugin ' + p.name + ')', async (a) => {
          if (k.handler === 'todo-scan') { const tag = a.trim().toUpperCase(); await scanTodos(['TODO', 'FIXME', 'HACK', 'XXX'].includes(tag) ? tag : undefined); return; }
          if (k.handler === 'scripts') { F.showSideTab('plugins'); return F.sys('Project scripts are listed in the Plugins tab. Click Run next to one.'); }
          await runCmd(p, k, { arg: a || undefined, slash: true });
        });
        slashOwn.set(name, true);
      }
    }
  }

  F.addCommand('plugins', '[enable|disable|reload|folder] [id]', 'List and manage plugins', async (a) => {
    const [sub, id] = a.split(/\s+/);
    if (sub === 'reload') { const r = await call('reload'); if (r.ok) { state = r; paintList(); syncSlash(); syncSnippets(); } return F.sys('Plugins reloaded.'); }
    if (sub === 'folder') { const r = await call('openFolder'); return F.sys('Your plugins folder: ' + (r.dir || state.userDir)); }
    if (sub === 'enable' || sub === 'disable') {
      await refresh();
      const p = state.plugins.find((x) => x.id === id);
      if (!p) return F.sys('No plugin with id "' + id + '". Type /plugins to see them.');
      if (p.enabled === (sub === 'enable')) return F.sys(p.name + ' is already ' + (p.enabled ? 'enabled' : 'disabled') + '.');
      return toggle(p);
    }
    await refresh();
    F.showSideTab('plugins');
    F.sys(state.plugins.map((p) => `${p.enabled ? '[on] ' : '[off]'} ${p.id.padEnd(10)} ${p.name}${p.error ? '   ERROR: ' + p.error.split('\n')[0] : ''}`).join('\n') +
      '\nEnable or disable them in the Plugins tab, or with /plugins enable <id>. Your own plugins go in ' + state.userDir);
  });
  F.addCommand('devtools', '', 'Open the developer utilities (regex, JSON, hashes, JWT...)', () => openDevtools());

  async function menuRun(pluginId, name) {
    await refresh();
    const p = state.plugins.find((x) => x.id === pluginId);
    const k = p && p.commands.find((c) => c.name === name);
    if (!p || !k) return F.toast('Plugin not available');
    if (!p.enabled) { F.showSideTab('plugins'); F.toast('Turn on "' + p.name + '" in the Plugins tab first.'); return; }
    return runAction(p, k);
  }
  if (F.addMenuItem) {
    F.addMenuItem('Tools', { id: 'plg.open', label: 'Plugins...', action: () => { F.showSideTab('plugins'); } });
    F.addMenuItem('Tools', { id: 'plg.format', label: 'Format Document', shortcut: 'Alt+Shift+F', keys: 'Alt+Shift+F', separatorBefore: true, action: () => menuRun('format', 'format') });
    F.addMenuItem('Tools', { id: 'plg.lint', label: 'Lint', action: () => menuRun('lint', 'lint') });
    F.addMenuItem('Tools', { id: 'plg.test', label: 'Run Tests', action: () => menuRun('tests', 'test') });
    F.addMenuItem('Tools', { id: 'plg.scripts', label: 'Project Scripts', action: () => menuRun('scripts', 'scripts') });
    F.addMenuItem('Tools', { id: 'plg.todos', label: 'Find TODOs', action: () => menuRun('todos', 'todos') });
    F.addMenuItem('Tools', { id: 'plg.devtools', label: 'Developer Utilities', action: () => menuRun('devtools', 'devtools') });
    const enabledCmds = () => state.plugins.filter((p) => p.enabled).flatMap((p) => p.commands.filter((k) => k.handler !== 'scripts').map((k) => ({ label: `${p.name}: ${k.title}`, action: () => runAction(p, k) })));
    F.addMenuItem('Run', { id: 'plg.cmds', label: 'Plugin Commands', separatorBefore: true, submenu: enabledCmds, enabled: () => enabledCmds().length > 0 });
  }

  /* ---------- snippets ---------- */
  let snippets = [];
  async function syncSnippets() {
    try { const r = await call('snippets'); snippets = r.ok ? r.snippets : []; } catch { snippets = []; }
    NS.snippets = snippets;
  }

  // Build text + tab stops from a snippet body. Supports $1 ${1:default} $0 ${file} ${date} and \$ for a literal dollar.
  function buildSnippet(bodyText, indent, vars) {
    let out = '';
    const stops = [];
    const put = (s) => { out += s.replace(/\n/g, '\n' + indent); };
    for (let i = 0; i < bodyText.length; i++) {
      const c = bodyText[i];
      if (c === '\\' && bodyText[i + 1] === '$') { out += '$'; i++; continue; }
      if (c !== '$') { put(c); continue; }
      let m;
      const rest = bodyText.slice(i);
      if ((m = /^\$\{(\d+):([^}]*)\}/.exec(rest))) {
        const at = out.length; put(m[2]); stops.push({ n: +m[1], at, len: out.length - at }); i += m[0].length - 1;
      } else if ((m = /^\$\{(\d+)\}|^\$(\d+)/.exec(rest))) {
        stops.push({ n: +(m[1] || m[2]), at: out.length, len: 0 }); i += m[0].length - 1;
      } else if ((m = /^\$\{(\w+)\}/.exec(rest)) && vars[m[1]] !== undefined) {
        put(vars[m[1]]); i += m[0].length - 1;
      } else put(c);
    }
    const first = stops.filter((s) => s.n >= 1).sort((a, b) => a.n - b.n || a.at - b.at)[0] || stops.find((s) => s.n === 0);
    return { text: out, stops, first: first || { at: out.length, len: 0 } };
  }
  NS.buildSnippet = buildSnippet;

  const pad2 = (n) => String(n).padStart(2, '0');
  function snippetVars() {
    const d = new Date();
    const t = activeTabObj();
    return { file: t ? t.name : '', date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
  }

  function findSnippet(before, ext) {
    let best = null;
    for (const s of snippets) {
      if (!before.endsWith(s.prefix)) continue;
      const pre = before.length - s.prefix.length;
      if (pre > 0 && /[A-Za-z0-9_$.\-]/.test(before[pre - 1])) continue;
      if (!s.languages.includes('*') && !s.languages.includes(ext)) continue;
      if (!best || s.prefix.length > best.prefix.length) best = s;
    }
    return best;
  }
  NS.findSnippet = findSnippet;

  let session = null;   // {start, len0, stops:[{at,...}], i, lenAtJump}
  const ta = g('edText');
  // capture phase on the target runs before editor.js's own Tab handler; we only act when a snippet matches
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (ta.selectionStart !== ta.selectionEnd) { session = null; return; }
    const pos = ta.selectionStart;
    if (session) {
      session.shift += ta.value.length - session.lenAtJump;     // what was typed at the previous stop
      const next = session.stops[session.i];
      if (next && pos >= session.start && pos <= session.start + session.len0 + session.shift) {
        e.preventDefault(); e.stopImmediatePropagation();
        const at = session.start + next.at + session.shift;
        ta.setSelectionRange(at, at + next.len);
        session.i++; session.lenAtJump = ta.value.length;
        if (session.i >= session.stops.length) session = null;
        return;
      }
      session = null;
    }
    if (!snippets.length) return;
    const t = activeTabObj();
    if (!t) return;
    const ext = (t.name.includes('.') ? t.name.split('.').pop() : t.name).toLowerCase();
    const before = ta.value.slice(Math.max(0, pos - 40), pos);
    const s = findSnippet(before, ext);
    if (!s) return;                                   // normal Tab behaviour (editor.js indents)
    e.preventDefault(); e.stopImmediatePropagation();
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, pos))[0];
    const built = buildSnippet(s.body, indent, snippetVars());
    const start = pos - s.prefix.length;
    ta.setSelectionRange(start, pos);
    if (!document.execCommand('insertText', false, built.text)) {
      ta.setRangeText(built.text, start, pos, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ta.setSelectionRange(start + built.first.at, start + built.first.at + built.first.len);
    const rest = built.stops.filter((x) => x !== built.first && x.n !== 0).sort((a, b) => a.at - b.at).filter((x) => x.at > built.first.at);
    const zero = built.stops.find((x) => x.n === 0 && x !== built.first);
    if (zero && zero.at > built.first.at) rest.push(zero);
    session = rest.length ? { start, len0: built.text.length, stops: [built.first, ...rest], i: 1, shift: 0, lenAtJump: ta.value.length } : null;
  }, true);

  /* ---------- settings section ---------- */
  F.addSettingsSection({
    id: 'plugins', title: 'Plugins',
    render(box) {
      box.textContent = '';
      box.appendChild(el('p', 'muted small', 'Plugins are declarative: they describe commands, AI tools and snippets, and never run code inside Faber. Each one is off until you enable it and review its permissions.'));
      const rows = el('div', 'plgSetRows');
      box.appendChild(rows);
      const paint = () => {
        rows.textContent = '';
        for (const p of state.plugins) {
          const row = el('label', 'plgSetRow');
          const cb = el('input');
          cb.type = 'checkbox'; cb.checked = p.enabled; cb.disabled = !!p.error;
          cb.onchange = async () => { cb.checked = p.enabled; await toggle(p); paint(); };
          row.append(cb, el('span', '', ' ' + p.name), el('span', 'muted small', p.error ? '  (cannot load)' : '  ' + p.description.slice(0, 70) + (p.description.length > 70 ? '...' : '')));
          rows.appendChild(row);
        }
      };
      refresh().then(paint);
      const t = el('div', 'plgSetRow');
      const num = el('input'); num.type = 'number'; num.min = 0; num.max = 1800; num.style.width = '80px';
      num.value = (state.settings && state.settings.timeoutSec) || 0;
      num.onchange = async () => { const r = await call('setOption', 'timeoutSec', num.value); if (r.ok) state = r; };
      t.append(el('span', '', 'Command time limit in seconds (0 = each plugin\'s own default)  '), num);
      const a = el('label', 'plgSetRow');
      const ac = el('input'); ac.type = 'checkbox'; ac.checked = !state.settings || state.settings.autoSave !== false;
      ac.onchange = async () => { const r = await call('setOption', 'autoSave', ac.checked); if (r.ok) state = r; };
      a.append(ac, el('span', '', ' Save the open file before running a command on it'));
      const btns = el('div', 'plgSetRow');
      const rl = el('button', '', 'Reload plugins'); rl.onclick = async () => { const r = await call('reload'); if (r.ok) { state = r; paintList(); paint(); syncSlash(); syncSnippets(); } };
      const of = el('button', '', 'Open plugins folder'); of.onclick = () => call('openFolder');
      btns.append(rl, of);
      box.append(t, a, btns, el('p', 'muted small', 'Your plugins folder: ' + (state.userDir || '(shown after plugins load)')));
    },
  });

  F.onReady(() => { refresh(); });
});
