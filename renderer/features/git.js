/* feature: git. Sidebar "Git" tab: local Git (offline) + optional GitHub (online, opt-in).
   Main-process half: src/features/git.js. Test/diagnostic hooks: window.FaberGit. */
Faber.register('git', (F) => {
  const el = F.el;
  const ICON = {
    refresh: '<svg viewBox="0 0 16 16"><path d="M8 2.5a5.5 5.5 0 1 0 5.3 7h-1.6A4 4 0 1 1 8 4c1.1 0 2.1.45 2.8 1.2L9 7h5V2l-1.9 1.9A5.48 5.48 0 0 0 8 2.5z"/></svg>',
    undo: '<svg viewBox="0 0 16 16"><path d="M6 3 2 7l4 4V8c3 0 5 .8 6 4 .2-4-2-6.5-6-6.5z"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><path d="M5 1.5h8v10H5zM6.5 3v7h5V3zM3 4.5v10h7V13H4.5V4.5z"/></svg>',
  };
  const S = {
    pane: null, st: null, sig: '', headSig: '', commits: [], hasMore: false, historyLoaded: false,
    branches: null, stashes: null, ghStatus: null, ghRepo: null, ghData: {}, ghErr: '', ghRate: null,
    busy: false, again: false, againAll: false, stale: false, staleAll: false, secOpen: {},
  };
  const ui = {};                 // persistent DOM pieces
  const timers = {};
  let ghTimer = null, ghPollMs = 60000;
  const ghViews = new Set();     // connect forms (tab + settings window)

  const call = async (m, arg) => {
    try { return await F.call('feat:git:' + m, arg); } catch (e) { return { ok: false, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }; }
  };
  const later = (key, ms, fn) => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); };
  const lsGet = (k, d) => { try { const v = localStorage.getItem('faber.git.' + k); return v === null ? d : v === '1'; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem('faber.git.' + k, v ? '1' : '0'); } catch { /* storage unavailable */ } };
  const visible = () => !!S.pane && !S.pane.hidden && !document.getElementById('side').hidden;
  const base = (p) => p.split('/').pop();
  const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const ok = () => !!S.st && S.st.state === 'ok';

  function ago(sec) {
    const d = Date.now() / 1000 - sec;
    if (d < 45) return 'just now';
    const units = [['min', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000]];
    let u = units[0];
    for (const x of units) if (d >= x[1]) u = x;
    const v = Math.max(1, Math.round(d / u[1]));
    return v + ' ' + u[0] + (v > 1 ? 's' : '') + ' ago';
  }
  const fullDate = (sec) => new Date(sec * 1000).toLocaleString();

  /* ---------- small widgets ---------- */
  function btn(label, act, onClick, cls, title) {
    const b = el('button', 'gbtn' + (cls ? ' ' + cls : ''), label);
    if (act) b.dataset.act = act;
    if (title) b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(b, e); };
    return b;
  }
  function iconBtn(svg, act, title, onClick) {
    const b = el('button', 'gbtn gicon');
    b.innerHTML = svg; b.dataset.act = act; b.title = title; b.setAttribute('aria-label', title);
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    return b;
  }
  function confirmBox(title, text, okLabel) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const m = F.modal({
        title, body: (b) => { b.append(el('div', 'gConfirm', text)); },
        buttons: [{ label: 'Cancel', onClick: () => fin(false) }, { label: okLabel, primary: true, onClick: () => fin(true) }],
      });
      new MutationObserver((_r, o) => { if (!document.body.contains(m.el)) { fin(false); o.disconnect(); } }).observe(document.body, { childList: true });
    });
  }
  function section(id, title, openByDefault, onOpen) {
    const root = el('div', 'gSec'); root.dataset.sec = id;
    const head = el('div', 'gSecHead');
    const arrow = el('span', 'gArrow', '');
    const t = el('span', 'gSecTitle', title);
    const count = el('span', 'gCount', '');
    const extra = el('span', 'gSecExtra');
    head.append(arrow, t, count, extra);
    const body = el('div', 'gSecBody');
    root.append(head, body);
    const s = { root, head, body, count, extra, open: lsGet('open.' + id, openByDefault) };
    const paint = () => { body.hidden = !s.open; arrow.className = 'gArrow' + (s.open ? ' open' : ''); };
    s.set = (v) => { s.open = v; lsSet('open.' + id, v); paint(); if (v && onOpen) onOpen(); };
    head.onclick = () => s.set(!s.open);
    paint();
    return s;
  }
  function setOut(title, text, bad) {
    ui.out.hidden = false;
    ui.out.classList.toggle('bad', !!bad);
    ui.outTitle.textContent = title;
    ui.outText.textContent = text || '';
    ui.outText.hidden = !text;
  }
  const clearOut = () => { ui.out.hidden = true; };
  async function copyText(t) { await call('copy', t); F.toast('Copied ' + t.slice(0, 12)); }

  /* ---------- diff rendering ---------- */
  function renderDiff(box, d) {
    box.textContent = '';
    if (!d || !d.ok) { box.append(el('div', 'gdNote bad', (d && d.error) || 'Could not load the diff.')); return; }
    const meta = el('div', 'gdMeta');
    box.append(meta);
    const chip = (t, c) => meta.append(el('span', 'gChip' + (c ? ' ' + c : ''), t));
    if (d.binary) box.append(el('div', 'gdNote', 'Binary file: no text preview.'));
    else if (d.empty) box.append(el('div', 'gdNote', d.note || 'No differences.'));
    const lines = (d.text || '').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const CAP = 4000;
    const frag = document.createDocumentFragment();
    let o = 0, n = 0, crlf = false, inHunk = false;
    for (const raw of lines.slice(0, CAP)) {
      let t = raw;
      if (t.endsWith('\r')) { crlf = true; t = t.slice(0, -1); }
      let cls = 'ctx', a = '', b = '';
      if (t.startsWith('diff --git')) { inHunk = false; cls = 'meta'; }
      else if (t.startsWith('@@')) {
        const m = t.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (m) { o = +m[1]; n = +m[2]; }
        inHunk = true; cls = 'hunk';
      } else if (!inHunk) cls = 'meta';
      else if (t[0] === '+') { cls = 'add'; b = n++; }
      else if (t[0] === '-') { cls = 'del'; a = o++; }
      else if (t[0] === '\\') cls = 'meta';
      else { a = o++; b = n++; }
      const row = el('div', 'gdl ' + cls);
      row.append(el('span', 'gdn', String(a)), el('span', 'gdn', String(b)), el('span', 'gdt', t));
      frag.append(row);
    }
    const body = el('div', 'gdBody');
    body.append(frag);
    box.append(body);
    if (crlf) chip('CRLF line endings');
    if (d.binary) chip('binary');
    if (d.truncated || lines.length > CAP) {
      chip('truncated', 'bad');
      box.append(el('div', 'gdNote', 'This diff is very large, so only the first part is shown.'));
    }
  }
  // variants: [{label, load()}], openPath: absolute path for the "Open file" button
  function showDiff(title, variants, openPath) {
    const m = F.modal({
      title, wide: true,
      body: (b) => {
        b.classList.add('gdModal');
        const bar = el('div', 'gdBar');
        const box = el('div', 'gdBox');
        b.append(bar, box);
        const pick = async (i) => {
          [...bar.children].forEach((c, j) => c.classList.toggle('on', j === i));
          box.textContent = 'Loading...';
          renderDiff(box, await variants[i].load());
        };
        if (variants.length > 1) variants.forEach((v, i) => { const x = el('button', 'gbtn', v.label); x.onclick = () => pick(i); bar.append(x); });
        else bar.hidden = true;
        pick(0);
      },
      buttons: openPath ? [{ label: 'Open file', onClick: () => F.openFile(openPath) }] : [],
    });
    return m;
  }
  const rootJoin = (rel) => (S.st && S.st.root ? S.st.root.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\') : rel);
  function showFileDiff(f, kind) {
    const label = { staged: 'staged', unstaged: 'unstaged', untracked: 'new file', conflict: 'conflict' }[kind] || kind;
    return showDiff(`${f.path} (${label})`, [{ label, load: () => call('diff', { path: f.path, kind: kind === 'conflict' ? 'unstaged' : kind }) }], f.y === 'D' && kind !== 'staged' ? '' : rootJoin(f.path));
  }
  async function diffForPath(rel) {
    await refresh();
    const f = ok() && S.st.files.find((x) => x.path === rel);
    const v = [];
    if (f && f.x === '?') v.push({ label: 'New file', load: () => call('diff', { path: rel, kind: 'untracked' }) });
    else { v.push({ label: 'Unstaged', load: () => call('diff', { path: rel, kind: 'unstaged' }) }, { label: 'Staged', load: () => call('diff', { path: rel, kind: 'staged' }) }); }
    return showDiff(rel, v, rootJoin(rel));
  }

  async function showCommit(hash) {
    const info = await call('commitInfo', hash);
    if (!info.ok) return setOut('Commit', info.error, true);
    F.modal({
      title: `${info.short}  ${info.message.split('\n')[0]}`, wide: true,
      body: (b) => {
        b.classList.add('gdModal');
        const head = el('div', 'gcHead');
        head.append(el('div', 'gcMsg', info.message), el('div', 'gcBy', `${info.author} <${info.email}>  ${fullDate(info.at)}  ${info.hash}`));
        const cp = btn('Copy hash', 'copy-hash', () => copyText(info.hash));
        head.append(cp);
        const wrap = el('div', 'gcWrap');
        const list = el('div', 'gcFiles');
        const box = el('div', 'gdBox');
        wrap.append(list, box);
        b.append(head, wrap);
        const pick = async (f, row) => {
          [...list.children].forEach((c) => c.classList.toggle('on', c === row));
          box.textContent = 'Loading...';
          renderDiff(box, await call('commitDiff', { hash: info.hash, path: f && f.path, orig: f && f.orig }));
        };
        const all = el('div', 'gcFile on', 'All changes');
        all.onclick = () => pick(null, all);
        list.append(all);
        for (const f of info.files) {
          const r = el('div', 'gcFile');
          r.dataset.path = f.path;
          r.append(el('span', 'gs s-' + f.status, f.status), el('span', 'gn', f.path));
          r.onclick = () => pick(f, r);
          list.append(r);
        }
        if (!info.files.length) list.append(el('div', 'gNone', 'No file changes (empty or merge commit).'));
        pick(null, all);
      },
    });
  }

  /* ---------- refresh engine ---------- */
  async function refresh(opt = {}) {
    if (!visible()) { S.stale = true; if (opt.all) S.staleAll = true; return; }
    if (S.busy) { S.again = true; if (opt.all) S.againAll = true; return; }
    S.busy = true;
    try {
      let all = !!opt.all || S.staleAll;
      S.stale = S.staleAll = false;
      do {
        S.again = false;
        await loadStatus(all);
        all = S.againAll; S.againAll = false;
      } while (S.again);
    } finally { S.busy = false; }
  }
  async function loadStatus(all) {
    const st = await call('status');
    if (st.ok === false) { S.st = { state: 'error', message: st.error }; } else S.st = st;
    const sig = JSON.stringify(S.st);
    const changed = sig !== S.sig;
    S.sig = sig;
    if (changed) { paintAll(); }
    const hs = ok() ? S.st.oid + '|' + S.st.branch : '';
    const moved = hs !== S.headSig;
    S.headSig = hs;
    if (ok() && (all || moved)) await reloadSecondary();
  }
  async function reloadSecondary() {
    const jobs = [];
    if (secs.history.open) jobs.push(loadHistory(true));
    jobs.push(loadBranches());
    if (secs.stash.open) jobs.push(loadStash());
    await Promise.all(jobs);
  }

  /* ---------- painting ---------- */
  const badge = (st) => { if (F.setBadge) F.setBadge('git', st && st.state === 'ok' ? st.files.length + (st.moreFiles || 0) : 0); };
  // While the panel is hidden only the activity-bar badge is kept fresh (one cheap status call).
  async function badgeOnly() {
    if (visible()) return;
    const st = await call('status');
    badge(st.ok === false ? null : st);
  }
  function paintAll() {
    badge(S.st);
    paintHead(); paintNotice(); paintChanges(); updateCommit();
    ui.sections.hidden = !ok();
    ui.remote.hidden = !ok();
  }
  function paintHead() {
    const st = S.st;
    ui.branch.textContent = ''; ui.sync.textContent = ''; ui.dirty.textContent = '';
    if (!ok()) { ui.branch.textContent = 'Git'; return; }
    ui.branch.textContent = st.detached ? `(detached ${String(st.oid).slice(0, 7)})` : st.branch;
    ui.branch.title = st.upstream ? 'Tracking ' + st.upstream : 'No upstream branch';
    ui.sync.textContent = st.upstream ? `\u2191${st.ahead} \u2193${st.behind}` : 'no upstream';
    ui.sync.title = st.upstream ? `${st.ahead} commit(s) to push, ${st.behind} to pull` : 'This branch is not tracking a remote branch yet';
    const n = st.files.length + (st.moreFiles || 0);
    ui.dirty.textContent = n ? `${n} change${n > 1 ? 's' : ''}` : 'clean';
    ui.dirty.className = 'gDirty ' + (n ? 'dirty' : 'clean');
  }
  function paintNotice() {
    const st = S.st, n = ui.notice;
    n.textContent = '';
    n.hidden = ok();
    if (ok() || !st) return;
    if (st.state === 'nofolder') {
      n.append(el('p', '', 'No folder is open. Open a folder to use Git.'));
      n.append(btn('Open folder', 'open-folder', () => document.getElementById('openBtn').click(), 'primary'));
    } else if (st.state === 'norepo') {
      n.append(el('p', '', 'This folder is not a Git repository yet.'));
      n.append(btn('Initialize repository', 'init', async () => {
        const r = await call('init');
        if (!r.ok) setOut('git init', r.error, true); else F.toast('Repository created');
        await refresh({ all: true });
      }, 'primary'));
    } else {
      n.append(el('p', 'bad', st.message || 'Git is not available.'));
      n.append(btn('Retry', 'retry', () => refresh({ all: true })));
    }
  }

  const stagedList = () => (ok() ? S.st.files.filter((f) => !f.conflict && f.x !== '.' && f.x !== '?') : []);
  const unstagedList = () => (ok() ? S.st.files.filter((f) => !f.conflict && f.y !== '.' && f.y !== '?') : []);
  const untrackedList = () => (ok() ? S.st.files.filter((f) => f.x === '?') : []);
  const conflictList = () => (ok() ? S.st.files.filter((f) => f.conflict) : []);

  async function act(promise, errTitle) {
    const r = await promise;
    if (!r.ok) setOut(errTitle || 'Git', r.error, true);
    await refresh({ all: true });
    return r;
  }
  const withOrig = (list) => list.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path]));

  function group(title, list, kind, bulk) {
    const g = el('div', 'gGrp'); g.dataset.group = kind;
    const h = el('div', 'gGrpHead');
    h.append(el('span', 'gGrpTitle', title), el('span', 'gCount', String(list.length)), el('span', 'spacer'));
    for (const b of bulk) h.append(b);
    g.append(h);
    for (const f of list.slice(0, 500)) {
      const r = el('div', 'gFile'); r.dataset.path = f.path; r.title = f.path;
      const letter = kind === 'staged' ? f.x : kind === 'untracked' ? '?' : kind === 'conflict' ? '!' : f.y;
      r.append(el('span', 'gs s-' + letter, letter), el('span', 'gn', base(f.path)), el('span', 'gd', dir(f.path)));
      const acts = el('span', 'gAct');
      if (kind === 'staged') acts.append(iconBtn('<span>\u2212</span>', 'unstage', 'Unstage', () => act(call('unstage', { paths: withOrig([f]) }))));
      else {
        if (kind !== 'conflict') acts.append(iconBtn(ICON.undo, 'discard', kind === 'untracked' ? 'Delete this untracked file' : 'Discard changes', () => discardFiles(kind === 'untracked' ? [] : [f], kind === 'untracked' ? [f] : [])));
        acts.append(iconBtn('<span>+</span>', 'stage', kind === 'conflict' ? 'Mark resolved (stage)' : 'Stage', () => act(call('stage', { paths: [f.path] }))));
      }
      r.append(acts);
      r.onclick = () => (kind === 'conflict' ? F.openFile(rootJoin(f.path)) : showFileDiff(f, kind));
      g.append(r);
    }
    if (list.length > 500) g.append(el('div', 'gNone', `+${list.length - 500} more not shown`));
    return g;
  }
  async function discardFiles(tracked, untracked) {
    const names = [...tracked, ...untracked].map((f) => f.path);
    const text = names.length === 1
      ? `${untracked.length ? 'Delete the untracked file' : 'Discard all changes to'} ${names[0]}?\nThis cannot be undone.`
      : `Discard changes to ${tracked.length} file(s) and delete ${untracked.length} untracked file(s)?\nThis cannot be undone.`;
    if (!(await confirmBox('Discard changes', text, 'Discard'))) return;
    await act(call('discard', { tracked: tracked.map((f) => f.path), untracked: untracked.map((f) => f.path) }));
  }
  function paintChanges() {
    const box = ui.changes;
    box.textContent = '';
    if (!ok()) { secs.changes.count.textContent = ''; return; }
    const st = unstagedList(), un = untrackedList(), sg = stagedList(), cf = conflictList();
    secs.changes.count.textContent = String(S.st.files.length || '');
    if (cf.length) box.append(group('Merge conflicts', cf, 'conflict', []));
    box.append(group('Staged', sg, 'staged', sg.length ? [btn('Unstage all', 'unstage-all', () => act(call('unstage', {})))] : []));
    box.append(group('Changes', st, 'unstaged', st.length ? [
      btn('Stage all', 'stage-all', () => act(call('stage', { paths: st.map((f) => f.path) }))),
      btn('Discard all', 'discard-all', () => discardFiles(st, [])),
    ] : []));
    if (un.length) box.append(group('Untracked', un, 'untracked', [
      btn('Stage all', 'stage-untracked', () => act(call('stage', { paths: un.map((f) => f.path) }))),
      btn('Discard all', 'discard-untracked', () => discardFiles([], un)),
    ]));
    if (!S.st.files.length) box.append(el('div', 'gNone', 'No changes. Working tree clean.'));
  }

  /* ---------- commit box ---------- */
  function updateCommit() {
    const staged = stagedList().length, any = ok() ? S.st.files.length : 0;
    const has = ui.msg.value.trim().length > 0;
    const can = ok() && has && (ui.amend.checked || (ui.stageAll.checked ? any > 0 : staged > 0));
    ui.commit.disabled = !can;
    ui.suggest.disabled = !ok() || !staged;
    ui.commit.textContent = ui.amend.checked ? 'Amend commit' : ui.stageAll.checked ? 'Stage all and commit' : 'Commit staged';
    ui.commit.title = !ok() ? '' : !has ? 'Write a commit message first' : (!staged && !ui.stageAll.checked && !ui.amend.checked) ? 'Nothing is staged' : '';
  }
  async function doCommit(msg) {
    const r = await call('commit', { message: msg, amend: ui.amend.checked, stageAll: ui.stageAll.checked });
    if (!r.ok) { setOut('Commit failed', r.error, true); return r; }
    ui.msg.value = ''; ui.amend.checked = false; ui.hint.textContent = '';
    F.toast(`Committed ${r.hash}`);
    clearOut();
    await refresh({ all: true });
    return r;
  }
  async function suggestMessage() {
    ui.suggest.disabled = true; ui.hint.textContent = 'Asking your local model...';
    const r = await call('suggest');
    if (!r.ok) { ui.hint.textContent = ''; setOut('Suggestion', r.error, true); updateCommit(); return; }
    ui.hint.textContent = 'Suggestion from your local model. Edit it before you commit.';
    if (!ui.msg.value.trim()) ui.msg.value = r.message;
    else if (ui.msg.value !== r.message) ui.hint.textContent += ' Suggested: ' + r.message;
    updateCommit();
  }

  /* ---------- history ---------- */
  async function loadHistory(reset) {
    if (!ok()) return;
    const keep = Math.min(Math.max(S.commits.length, 30), 300);
    const r = await call('log', reset ? { skip: 0, limit: keep } : { skip: S.commits.length, limit: 30 });
    if (!r.ok) { ui.history.textContent = ''; ui.history.append(el('div', 'gNone bad', r.error)); return; }
    S.commits = reset ? r.commits : S.commits.concat(r.commits);
    S.hasMore = r.hasMore; S.historyLoaded = true;
    paintHistory(r.empty);
  }
  function paintHistory(empty) {
    const box = ui.history;
    box.textContent = '';
    secs.history.count.textContent = S.commits.length ? String(S.commits.length) + (S.hasMore ? '+' : '') : '';
    if (!S.commits.length) box.append(el('div', 'gNone', empty ? 'No commits yet.' : 'No history.'));
    for (const c of S.commits) {
      const r = el('div', 'gCommit'); r.dataset.hash = c.hash;
      const main = el('div', 'gcMain');
      main.append(el('div', 'gcSubj', c.subject));
      const meta = el('div', 'gcMeta');
      meta.append(el('span', 'gcHash', c.short), el('span', '', c.author), el('span', '', ago(c.at)));
      meta.lastChild.title = fullDate(c.at);
      main.append(meta);
      r.append(main, iconBtn(ICON.copy, 'copy-hash', 'Copy hash', () => copyText(c.hash)));
      r.onclick = () => showCommit(c.hash);
      box.append(r);
    }
    if (S.hasMore) box.append(btn('Load more', 'load-more', () => loadHistory(false), 'gWide'));
  }

  /* ---------- branches + stash ---------- */
  async function loadBranches() {
    if (!ok()) return;
    const r = await call('branches');
    S.branches = r.ok ? r : null;
    const box = ui.branchList;
    box.textContent = '';
    if (!r.ok) { box.append(el('div', 'gNone bad', r.error)); return; }
    secs.branches.count.textContent = String(r.local.length);
    for (const b of r.local) {
      const row = el('div', 'gBranch' + (b.current ? ' cur' : '')); row.dataset.branch = b.name;
      row.append(el('span', 'gn', b.name), el('span', 'gd', b.upstream || ''));
      if (!b.current) row.append(btn('Switch', 'switch', () => switchBranch(b.name, false)));
      else row.append(el('span', 'gChip', 'current'));
      box.append(row);
    }
    if (r.remote.length) box.append(el('div', 'gSub', 'Remote'));
    for (const b of r.remote) {
      const row = el('div', 'gBranch remote'); row.dataset.branch = b.name;
      row.append(el('span', 'gn', b.name), btn('Checkout', 'switch-remote', () => switchBranch(b.name, true)));
      box.append(row);
    }
  }
  async function switchBranch(name, remote) {
    const r = await call('checkout', { name, remote });
    if (!r.ok) setOut('Cannot switch branch', r.error, true); else { clearOut(); F.toast('Switched to ' + name); }
    await refresh({ all: true });
    return r;
  }
  async function createBranch(name, sw) {
    const r = await call('createBranch', { name, checkout: sw });
    if (!r.ok) setOut('Cannot create branch', r.error, true); else { clearOut(); F.toast('Created ' + r.name); }
    await refresh({ all: true });
    return r;
  }
  async function loadStash() {
    if (!ok()) return;
    const r = await call('stashList');
    S.stashes = r.ok ? r.items : null;
    const box = ui.stashList;
    box.textContent = '';
    if (!r.ok) { box.append(el('div', 'gNone bad', r.error)); return; }
    secs.stash.count.textContent = r.items.length ? String(r.items.length) : '';
    if (!r.items.length) box.append(el('div', 'gNone', 'No stashes.'));
    for (const s of r.items) {
      const row = el('div', 'gStash'); row.dataset.index = s.index;
      row.append(el('span', 'gn', s.message), el('span', 'gd', ago(s.at)));
      row.append(btn('Pop', 'stash-pop', async () => {
        const x = await call('stashPop', { index: s.index });
        if (!x.ok) setOut('Stash pop', x.error, true); else clearOut();
        await refresh({ all: true });
      }), btn('Drop', 'stash-drop', async () => {
        if (!(await confirmBox('Drop stash', `Delete this stash?\n${s.message}`, 'Drop'))) return;
        await act(call('stashDrop', { index: s.index }), 'Stash drop');
      }));
      box.append(row);
    }
  }

  /* ---------- remote (online) ---------- */
  async function remote(kind) {
    const st = S.st;
    if (!ok()) return;
    let arg;
    if (kind === 'push') {
      const target = st.upstream ? st.upstream : 'origin (and set it as the upstream)';
      if (!(await confirmBox('Push (online)', `Push branch "${st.branch}" to ${target}?\nThis sends your commits to a remote server over the network, using your Git credentials.`, 'Push'))) return;
      arg = { confirmed: true, setUpstream: !st.upstream };
    }
    for (const b of ui.remote.querySelectorAll('button')) b.disabled = true;
    setOut(`git ${kind} (online)`, 'Working...', false);
    const r = await call(kind, arg);
    for (const b of ui.remote.querySelectorAll('button')) b.disabled = false;
    setOut(`git ${kind}${r.ok ? ': done' : ': failed'}`, r.ok ? r.output : (r.error + (r.output ? '\n\n' + r.output : '')), !r.ok);
    await refresh({ all: true });
    return r;
  }

  /* ---------- GitHub (online, opt-in) ---------- */
  async function ghLoadStatus() {
    const s = await call('ghStatus');
    S.ghStatus = s.ok === false ? null : s;
    for (const v of ghViews) v.paint();
    ui.ghWrap.hidden = !(S.ghStatus && S.ghStatus.connected);
    secs.github.count.textContent = S.ghStatus && S.ghStatus.connected ? '@' + S.ghStatus.login : '';
    return S.ghStatus;
  }
  function connectView(box) {
    const v = { box };
    let msg = '';
    v.paint = () => {
      const s = S.ghStatus;
      const keep = box.querySelector('input[type=password]') ? box.querySelector('input[type=password]').value : '';
      box.textContent = '';
      box.classList.add('ghConnect');
      if (!s) { box.append(el('div', 'gNone', 'Loading...')); return; }
      box.append(el('div', 'ghHint', 'Optional and ONLINE. Nothing talks to GitHub until you connect. Your token is stored encrypted by your operating system and is only used by Faber\u2019s background process.'));
      if (!s.secure) { box.append(el('div', 'gNone bad', s.secureReason)); return; }
      if (s.connected) {
        box.append(el('div', 'ghWho', `Connected as @${s.login} (${s.baseUrl})`));
        const live = el('label', 'ghLive');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.live; cb.dataset.act = 'gh-live';
        cb.onchange = async () => { await call('ghSetLive', cb.checked); await ghLoadStatus(); if (cb.checked) ghPoll(); };
        live.append(cb, document.createTextNode(' Live updates (check GitHub every minute while this tab is open)'));
        box.append(live);
        box.append(btn('Disconnect (forget token)', 'gh-disconnect', async () => {
          await call('ghDisconnect');
          S.ghData = {}; S.ghErr = ''; S.ghRate = null; msg = '';
          await ghLoadStatus(); paintGhData();
        }));
        if (s.authError) box.append(el('div', 'gNone bad', 'GitHub rejected the token. Disconnect and connect again with a valid token.'));
        return;
      }
      const tok = el('input'); tok.type = 'password'; tok.placeholder = 'Personal access token'; tok.autocomplete = 'off'; tok.spellcheck = false; tok.dataset.field = 'gh-token'; tok.value = keep;
      const url = el('input'); url.type = 'text'; url.value = s.baseUrl; url.spellcheck = false; url.dataset.field = 'gh-url'; url.title = 'GitHub API address (change it for GitHub Enterprise)';
      const go = btn('Connect GitHub', 'gh-connect', async () => {
        go.disabled = true; msg = 'Checking the token...'; line.textContent = msg; line.className = 'gNone';
        const r = await call('ghConnect', { token: tok.value, baseUrl: url.value });
        tok.value = '';
        if (!r.ok) { msg = r.error; go.disabled = false; line.textContent = msg; line.className = 'gNone bad'; return; }
        msg = '';
        secs.github.set(true);
        await ghLoadStatus();
        await ghSection(true);
      }, 'primary');
      const line = el('div', 'gNone', msg);
      box.append(tok, url, go, line);
    };
    ghViews.add(v);
    v.paint();
    return v;
  }
  async function ghSection(force) {
    if (!ok()) return;
    const s = await ghLoadStatus();
    if (!s || !s.connected) { paintGhData(); return; }
    const repo = await call('ghRepo');
    if (JSON.stringify(repo) !== JSON.stringify(S.ghRepo)) { S.ghRepo = repo; paintGhData(); }
    await ghRefresh({ kinds: ['info', 'commits', 'pulls', 'runs'], force });
  }
  async function ghRefresh({ kinds, poll, force }) {
    if (!S.ghStatus || !S.ghStatus.connected) return;
    const r = await call('ghLoad', { kinds, poll: !!poll, force: !!force || kinds.some((k) => !S.ghData[k]) });
    let dirty = false;
    const err = r.ok === false ? r.error : Object.values(r.errors || {})[0] || '';
    if (err !== S.ghErr) { S.ghErr = err; dirty = true; }
    for (const [k, v] of Object.entries(r.results || {})) if (v.changed && v.data !== undefined) { S.ghData[k] = v.data; dirty = true; }
    if (r.rate) { S.ghRate = r.rate; paintRate(); }
    if (r.authError) await ghLoadStatus();
    if (dirty) paintGhData();
  }
  async function ghPoll() {
    const s = S.ghStatus;
    if (!s || !s.connected || !s.live || s.authError || !ok() || !visible() || document.hidden || !secs.github.open) return;
    await ghRefresh({ kinds: ['commits', 'pulls', 'runs'], poll: true });
  }
  function startGhTimer() { clearInterval(ghTimer); ghTimer = setInterval(ghPoll, ghPollMs); }
  function paintRate() {
    const r = S.ghRate;
    ui.ghRate.textContent = r ? `API rate limit: ${r.remaining}/${r.limit} left` : '';
  }
  const open = (url) => call('openUrl', url).then((r) => { if (!r.ok) F.toast(r.error); });
  function ghItem(cls, url, parts) {
    const r = el('div', 'ghItem ' + cls);
    r.dataset.url = url || '';
    for (const p of parts) r.append(p);
    if (url) { r.title = url; r.onclick = () => open(url); r.classList.add('link'); }
    return r;
  }
  function paintGhData() {
    const box = ui.ghData, d = S.ghData;
    box.textContent = '';
    ui.ghData.dataset.renders = String((+ui.ghData.dataset.renders || 0) + 1);
    if (!S.ghStatus || !S.ghStatus.connected) return;
    const repo = S.ghRepo;
    if (repo && repo.found) {
      box.append(el('div', 'ghRepo', `${repo.owner}/${repo.repo}`));
      if (repo.warn) box.append(el('div', 'gNone bad', repo.warn));
    } else if (repo) box.append(el('div', 'gNone', 'No GitHub-style "origin" remote found for this folder.'));
    if (S.ghErr) box.append(el('div', 'gNone bad ghError', S.ghErr));
    if (d.info) {
      const i = d.info;
      box.append(el('div', 'ghDesc', i.description || '(no description)'));
      box.append(el('div', 'ghStats', `${i.stars} stars   default: ${i.branch}   ${i.issues} open issues/PRs`));
      box.append(btn('Open on GitHub', 'gh-open-repo', () => open(i.url)));
    }
    const sub = (t) => box.append(el('div', 'gSub', t));
    if (d.commits) {
      sub('Recent commits');
      if (!d.commits.length) box.append(el('div', 'gNone', 'None.'));
      for (const c of d.commits) box.append(ghItem('ghCommit', c.url, [el('span', 'gcHash', c.sha), el('span', 'gn', c.message), el('span', 'gd', c.author + (c.date ? '  ' + ago(Date.parse(c.date) / 1000) : ''))]));
    }
    if (d.pulls) {
      sub('Open pull requests');
      if (!d.pulls.length) box.append(el('div', 'gNone', 'None.'));
      for (const p of d.pulls) box.append(ghItem('ghPull', p.url, [el('span', 'gcHash', '#' + p.number), el('span', 'gn', p.title), el('span', 'gChip chk-' + p.checks, 'checks: ' + p.checks)]));
    }
    if (d.runs) {
      sub('GitHub Actions');
      if (!d.runs.length) box.append(el('div', 'gNone', 'None.'));
      for (const r of d.runs) box.append(ghItem('ghRun', r.url, [el('span', 'gChip run-' + r.state, r.state), el('span', 'gn', r.name), el('span', 'gd', r.branch || '')]));
    }
  }

  /* ---------- build the tab ---------- */
  const secs = {};
  function build(root) {
    S.pane = root;
    root.classList.add('gitPane');
    const head = el('div', 'gHead');
    ui.branch = el('span', 'gBranchName', 'Git'); ui.sync = el('span', 'gSync'); ui.dirty = el('span', 'gDirty');
    const rf = iconBtn(ICON.refresh, 'refresh', 'Refresh', () => refresh({ all: true }));
    head.append(ui.branch, ui.sync, ui.dirty, el('span', 'spacer'), rf);

    ui.remote = el('div', 'gRemote');
    ui.remote.append(el('span', 'gOnline', 'online'), btn('Fetch', 'fetch', () => remote('fetch')), btn('Pull', 'pull', () => remote('pull')), btn('Push', 'push', () => remote('push')));

    ui.out = el('div', 'gOut'); ui.out.hidden = true;
    const oh = el('div', 'gOutHead'); ui.outTitle = el('span', 'gOutTitle');
    oh.append(ui.outTitle, el('span', 'spacer'), btn('Close', 'out-close', clearOut, 'ghost'));
    ui.outText = el('pre', 'gOutText');
    ui.out.append(oh, ui.outText);

    ui.notice = el('div', 'gNotice'); ui.notice.hidden = true;
    ui.sections = el('div', 'gSections');
    const scroll = el('div', 'gScroll');

    secs.changes = section('changes', 'Changes', true);
    secs.history = section('history', 'History', true, () => loadHistory(true));
    secs.branches = section('branches', 'Branches', false, loadBranches);
    secs.stash = section('stash', 'Stash', false, loadStash);
    secs.github = section('github', 'GitHub (online)', false, () => ghSection());

    // commit box
    ui.msg = el('textarea', 'gMsg'); ui.msg.rows = 3; ui.msg.placeholder = 'Commit message'; ui.msg.spellcheck = false;
    ui.msg.oninput = updateCommit;
    ui.msg.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !ui.commit.disabled) ui.commit.click(); };
    const opts = el('div', 'gOpts');
    const mk = (label, key) => { const l = el('label', 'gOpt'); const c = el('input'); c.type = 'checkbox'; c.dataset.opt = key; c.onchange = updateCommit; l.append(c, document.createTextNode(' ' + label)); opts.append(l); return c; };
    ui.stageAll = mk('Stage all first', 'stage-all');
    ui.amend = mk('Amend last commit', 'amend');
    ui.amend.addEventListener('change', async () => {
      if (ui.amend.checked && !ui.msg.value.trim()) { const r = await call('lastMessage'); if (r.ok) { ui.msg.value = r.message; updateCommit(); } }
    });
    ui.commit = btn('Commit staged', 'commit', () => doCommit(ui.msg.value), 'primary');
    ui.suggest = btn('Suggest message', 'suggest', suggestMessage, '', 'Ask your local model for a commit message (a suggestion only)');
    const row = el('div', 'gCommitRow'); row.append(ui.commit, ui.suggest);
    ui.hint = el('div', 'gHint');
    ui.changes = el('div', 'gChanges');
    secs.changes.body.append(ui.msg, opts, row, ui.hint, ui.changes);

    ui.history = el('div', 'gHistory');
    secs.history.body.append(ui.history);

    ui.branchList = el('div', 'gBranches');
    const nb = el('div', 'gNewBranch');
    const nbIn = el('input'); nbIn.placeholder = 'New branch name'; nbIn.dataset.field = 'new-branch'; nbIn.spellcheck = false;
    const nbGo = btn('Create', 'branch-create', async () => { const n = nbIn.value.trim(); if (!n) return; const r = await createBranch(n, true); if (r.ok) nbIn.value = ''; });
    nbIn.onkeydown = (e) => { if (e.key === 'Enter') nbGo.click(); };
    nb.append(nbIn, nbGo);
    secs.branches.body.append(nb, ui.branchList);

    ui.stashList = el('div', 'gStashes');
    const sh = el('div', 'gNewBranch');
    const shIn = el('input'); shIn.placeholder = 'Stash message (optional)'; shIn.dataset.field = 'stash-msg';
    const shU = el('label', 'gOpt'); const shUc = el('input'); shUc.type = 'checkbox'; shUc.dataset.opt = 'stash-untracked'; shU.append(shUc, document.createTextNode(' + untracked'));
    const shGo = btn('Stash', 'stash-push', async () => {
      const r = await call('stashPush', { message: shIn.value, untracked: shUc.checked });
      if (!r.ok) setOut('Stash', r.error, true); else { shIn.value = ''; clearOut(); }
      await refresh({ all: true });
    });
    sh.append(shIn, shU, shGo);
    secs.stash.body.append(sh, ui.stashList);

    const ghTop = el('div', 'ghTop');
    connectView(ghTop);
    ui.ghWrap = el('div', 'ghWrap'); ui.ghWrap.hidden = true;
    const ghBar = el('div', 'ghBar');
    ui.ghRate = el('span', 'gd');
    ghBar.append(btn('Refresh', 'gh-refresh', () => ghSection(true)), ui.ghRate);
    ui.ghData = el('div', 'ghData');
    ui.ghWrap.append(ghBar, ui.ghData);
    secs.github.body.append(ghTop, ui.ghWrap);

    ui.sections.append(secs.changes.root, secs.history.root, secs.branches.root, secs.stash.root, secs.github.root);
    scroll.append(ui.notice, ui.sections);
    root.append(head, ui.remote, ui.out, scroll);
    ui.remote.hidden = ui.sections.hidden = true;
    ghLoadStatus();
  }

  /* ---------- wiring ---------- */
  F.addSideTab({ id: 'git', title: 'Git', render: build, onShow: () => refresh({ all: true }) });

  F.on('feat:git:changed', () => { later('git', 100, () => refresh({ all: true })); if (!visible()) later('badge', 1500, badgeOnly); });
  if (window.api && window.api.onFsChanged) window.api.onFsChanged(() => { later('fs', 600, () => refresh()); if (!visible()) later('badge', 2500, badgeOnly); });
  F.onEvent('folder', () => {
    later('badge', 300, badgeOnly);
    S.sig = ''; S.headSig = ''; S.commits = []; S.historyLoaded = false; S.ghData = {}; S.ghRepo = null; S.ghErr = '';
    if (S.pane) { paintHistoryReset(); refresh({ all: true }).then(() => { if (secs.github.open) ghSection(); }); }
  });
  function paintHistoryReset() { if (ui.history) ui.history.textContent = ''; }
  window.addEventListener('focus', () => { if (visible()) refresh(); });
  setInterval(() => { if (visible() && document.hasFocus() && !document.hidden) refresh(); }, 5000);   // safety net only
  F.onReady(() => { startGhTimer(); badgeOnly(); });

  window.FaberGit = {
    refresh: (o) => refresh(o), ghPoll, ghRefresh, state: () => S,
    setPollMs(ms) { ghPollMs = Math.max(500, ms | 0); startGhTimer(); },
    confirmBox,
  };

  /* ---------- Settings window section ---------- */
  F.addSettingsSection({
    id: 'git', title: 'Git & GitHub',
    render(box) {
      box.append(el('p', 'muted', 'Local Git works offline with the git program installed on this PC. Faber never sees or stores your Git passwords: push/pull use your own credential manager.'));
      box.append(el('h4', '', 'GitHub (online, optional)'));
      const wrap = el('div', 'ghSettings');
      box.append(wrap);
      connectView(wrap);
      ghLoadStatus();
    },
  });

  /* ---------- slash commands ---------- */
  function openPanel() {
    document.getElementById('side').hidden = false;
    F.showSideTab('git');
  }
  F.addCommand('git', '', 'Open the Git panel', () => openPanel());
  F.addCommand('commit', '<message>', 'Commit the staged changes (asks first)', async (a) => {
    if (!a) return F.sys('Usage: /commit <message>');
    const st = await call('status');
    if (!st.ok || st.state !== 'ok') return F.sys(st.message || (st.state === 'norepo' ? 'This folder is not a Git repository.' : 'No folder is open.'));
    const staged = st.files.filter((f) => !f.conflict && f.x !== '.' && f.x !== '?');
    if (!staged.length) return F.sys('Nothing is staged. Stage files in the Git panel first (/git).');
    const list = staged.slice(0, 12).map((f) => `  ${f.x}  ${f.path}`).join('\n') + (staged.length > 12 ? `\n  ...and ${staged.length - 12} more` : '');
    if (!(await confirmBox('Commit staged changes', `Commit ${staged.length} staged file(s) on ${st.branch}?\n${list}\n\nMessage: ${a}`, 'Commit'))) return F.sys('Commit cancelled.');
    const r = await call('commit', { message: a });
    F.sys(r.ok ? `Committed ${r.hash}: ${a}` : 'Commit failed: ' + r.error);
    refresh({ all: true });
  });
  F.addCommand('diff', '[file]', 'Show the Git diff (all changes, or one file)', async (a) => {
    const st = await call('status');
    if (!st.ok || st.state !== 'ok') return F.sys(st.message || 'No Git repository is open.');
    if (!a) return showDiff('All changes vs HEAD', [{ label: 'All changes', load: () => call('diff', { kind: 'all' }) }]);
    return diffForPath(a.replace(/\\/g, '/'));
  });
  F.addCommand('branch', '[name]', 'List branches, or switch to / create a branch', async (a) => {
    const b = await call('branches');
    if (!b.ok) return F.sys(b.error);
    if (!a) return F.sys('Branches:\n' + (b.local.map((x) => (x.current ? '* ' : '  ') + x.name).join('\n') || '(none yet)'));
    if (b.local.some((x) => x.name === a)) { const r = await switchBranch(a, false); return F.sys(r.ok ? `Switched to ${a}.` : 'Cannot switch: ' + r.error); }
    if (!(await confirmBox('Create branch', `Create and switch to a new branch named "${a}"?`, 'Create'))) return F.sys('Cancelled.');
    const r = await createBranch(a, true);
    F.sys(r.ok ? `Created and switched to ${a}.` : 'Cannot create branch: ' + r.error);
  });

  /* ---------- menu bar ---------- */
  if (typeof F.addMenuItem === 'function') {
    const active = () => (typeof tabs !== 'undefined' && tabs[activeTab]) || null;
    const relOfActive = () => {
      const t = active();
      if (!t || !ok()) return '';
      const a = t.path.replace(/\\/g, '/'), r = S.st.root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      return a.toLowerCase().startsWith(r.toLowerCase()) ? a.slice(r.length) : '';
    };
    const M = (item) => F.addMenuItem('Git', item);
    M({ id: 'git.open', label: 'Open Git Panel', action: openPanel });
    M({ id: 'git.refresh', label: 'Refresh', action: () => { openPanel(); refresh({ all: true }); } });
    M({ id: 'git.commit', label: 'Commit...', action: () => { openPanel(); secs.changes.set(true); setTimeout(() => ui.msg && ui.msg.focus(), 50); } });
    M({ id: 'git.diff', label: 'Diff Current File', enabled: () => !!relOfActive(), action: () => diffForPath(relOfActive()) });
    M({ id: 'git.branches', label: 'Branches', separatorBefore: true, submenu: () => {
      const list = (S.branches && S.branches.local) || [];
      return [...list.map((b) => ({ label: b.name, checked: () => b.current, action: () => !b.current && switchBranch(b.name, false) })),
        { label: 'Open Branches panel...', separatorBefore: !!list.length, action: () => { openPanel(); secs.branches.set(true); } }];
    } });
    M({ id: 'git.fetch', label: 'Fetch (online)', separatorBefore: true, action: async () => { openPanel(); await refresh(); remote('fetch'); } });
    M({ id: 'git.pull', label: 'Pull (online)', action: async () => { openPanel(); await refresh(); remote('pull'); } });
    M({ id: 'git.push', label: 'Push (online)', action: async () => { openPanel(); await refresh(); remote('push'); } });
  }
});
