// feature: git. Local Git through the system `git` program (works offline) plus an optional,
// opt-in GitHub panel (online, token kept encrypted with Electron safeStorage).
const { spawn } = require('child_process');
const nodeFs = require('fs');
const nodePath = require('path');
const { safeStorage, shell, clipboard } = require('electron');

const READ_TIMEOUT = 15000, WRITE_TIMEOUT = 60000, NET_TIMEOUT = 120000;
const MAX_DIFF_CHARS = 300000, MAX_TOOL_CHARS = 20000, MAX_FILES = 3000;
const HASH_RE = /^[0-9a-f]{4,40}$/i;

/* ---------- pure helpers (also exported for tests) ---------- */

// Parse `git status --porcelain=v2 --branch -z` output.
function parseStatus(out) {
  const parts = String(out).split('\0');
  const r = { branch: '', oid: '', detached: false, initial: false, upstream: '', ahead: 0, behind: 0, files: [], moreFiles: 0 };
  const push = (f) => { if (r.files.length < MAX_FILES) r.files.push(f); else r.moreFiles++; };
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const f = s.split(' ');
    if (s[0] === '#') {
      if (f[1] === 'branch.oid') { r.oid = f[2]; r.initial = f[2] === '(initial)'; }
      else if (f[1] === 'branch.head') { r.branch = f.slice(2).join(' '); r.detached = f[2] === '(detached)'; }
      else if (f[1] === 'branch.upstream') r.upstream = f.slice(2).join(' ');
      else if (f[1] === 'branch.ab') { r.ahead = Math.abs(parseInt(f[2], 10)) || 0; r.behind = Math.abs(parseInt(f[3], 10)) || 0; }
    } else if (s[0] === '1') push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1] });
    else if (s[0] === '2') push({ path: f.slice(9).join(' '), orig: parts[++i], x: f[1][0], y: f[1][1] });
    else if (s[0] === 'u') push({ path: f.slice(10).join(' '), x: f[1][0], y: f[1][1], conflict: true });
    else if (s[0] === '?') push({ path: s.slice(2), x: '?', y: '?' });
  }
  return r;
}

// owner/repo from an https, ssh or scp-like remote URL. Returns null for anything else (local paths...).
function parseRemote(url) {
  url = String(url || '').trim();
  if (!url || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('.')) return null;
  let host, segs, m;
  if ((m = url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/i))) { host = m[1]; segs = m[2]; }
  else if ((m = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+?)\/?$/))) { host = m[1]; segs = m[2]; }
  else return null;
  segs = segs.replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const [owner, repo] = segs.slice(-2);
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { host: host.toLowerCase(), owner, repo };
}

// Turn git's stderr into something a person can act on.
function friendly(text) {
  const t = String(text || '').trim();
  if (/not a git repository/i.test(t)) return 'This folder is not a Git repository.';
  if (/dubious ownership/i.test(t)) return 'Git refuses to use this folder because it belongs to another user. Run: git config --global --add safe.directory <folder>';
  if (/please tell me who you are|unable to auto-detect email|author identity unknown/i.test(t)) return 'Git does not know who you are yet. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"';
  if (/would be overwritten by (checkout|merge)/i.test(t)) {
    const files = t.split(/\r?\n/).filter((l) => /^\s+\S/.test(l) && !/^\s*(Please|Aborting|error)/i.test(l)).map((l) => l.trim());
    return 'Cannot switch: your uncommitted changes would be overwritten' + (files.length ? ' (' + files.slice(0, 5).join(', ') + ')' : '') + '. Commit, stash or discard them first.';
  }
  if (/index\.lock/i.test(t)) return 'Another git process seems to be running (index.lock exists). If none is, delete .git/index.lock and try again.';
  if (/terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(publickey\)|403|invalid credentials/i.test(t)) return 'The remote asked for credentials. Sign in once with your usual Git credential manager (for example run "git fetch" in a terminal), then try again.';
  if (/could not resolve host|unable to access|network is unreachable|connection (timed out|refused)|failed to connect/i.test(t)) return 'Cannot reach the remote (offline?). ' + t.split(/\r?\n/)[0];
  if (/no configured push destination|does not appear to be a git repository|no remote repository specified/i.test(t)) return 'No remote repository is configured. Add one first, for example: git remote add origin <url>';
  if (/no upstream branch|has no upstream/i.test(t)) return 'This branch has no upstream yet. Use "Push" and choose to set the upstream.';
  if (/nothing to commit|no changes added/i.test(t)) return 'Nothing to commit.';
  return t.split(/\r?\n/).map((l) => l.replace(/^(fatal|error): /i, '')).filter(Boolean).slice(0, 6).join('\n') || 'Git failed.';
}

const clip = (s, n = MAX_TOOL_CHARS) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);

module.exports = function (ctx) {
  const toolsApi = ctx.tools;
  const fs = ctx.fs || nodeFs, path = ctx.path || nodePath;
  let repoCache = null, queue = Promise.resolve(), netBusy = false, statusInflight = null;

  /* ---------- running git ---------- */
  function gitEnv(readOnly) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', LC_ALL: 'C' };
    if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';   // status/diff must not touch .git (no feedback loop with the watcher)
    return env;
  }

  function run(args, { cwd, input, timeout = READ_TIMEOUT, readOnly = false, maxBytes = 16 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
      const out = [], err = [];
      let size = 0, truncated = false, timedOut = false, settled = false, timer = null, child;
      const finish = (r) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated, timedOut, ...r });
      };
      try {
        child = spawn('git', ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
          { cwd, env: gitEnv(readOnly), windowsHide: true });
      } catch (e) { return finish({ code: -1, enoent: e.code === 'ENOENT', stderr: String(e.message) }); }
      timer = setTimeout(() => { timedOut = true; toolsApi.killTree(child); }, timeout);
      child.stdout.on('data', (d) => {
        if (size > maxBytes) return;
        size += d.length; out.push(d);
        if (size > maxBytes) { truncated = true; toolsApi.killTree(child); }
      });
      child.stderr.on('data', (d) => { if (err.length < 400) err.push(d); });
      child.on('error', (e) => finish({ code: -1, enoent: e.code === 'ENOENT', stderr: String(e.message) }));
      child.on('close', (code) => finish({ code }));
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    });
  }

  const failText = (r) => (r.timedOut ? 'Git took too long and was stopped.' : friendly(r.stderr || r.stdout));

  // Serialise anything that writes, so quick clicks cannot collide on index.lock.
  const locked = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  /* ---------- repository discovery + live watching ---------- */
  async function repo(force) {
    const ws = ctx.workspace();
    if (!ws) return { state: 'nofolder' };
    if (!force && repoCache && repoCache.ws === ws && Date.now() - repoCache.at < 4000) return repoCache.info;
    const r = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd: ws, readOnly: true });
    let info;
    if (r.enoent) info = { state: 'nogit', message: 'Git is not installed (or not on PATH). Install Git from git-scm.com, restart Faber, then press Refresh.' };
    else if (r.code !== 0) info = /not a git repository/i.test(r.stderr) ? { state: 'norepo' } : { state: 'error', message: failText(r) };
    else {
      const [top, gdir, common] = r.stdout.split(/\r?\n/).filter(Boolean);
      info = { state: 'ok', root: path.normalize(top), gitDir: path.resolve(ws, gdir), commonDir: path.resolve(ws, common || gdir) };
    }
    repoCache = { ws, at: Date.now(), info };
    return info;
  }

  async function need() {   // repo that must be usable, or throw a friendly error
    const info = await repo();
    if (info.state === 'ok') return info;
    throw new Error({ nofolder: 'No folder is open.', norepo: 'This folder is not a Git repository.' }[info.state] || info.message || 'Git is not available.');
  }

  let watchKey = '', watchers = [], watchTimer = null;
  function stopWatch() { for (const w of watchers) { try { w.close(); } catch { /* closed */ } } watchers = []; watchKey = ''; }
  function ensureWatch(info) {
    const key = info.state === 'ok' ? info.gitDir + '|' + info.commonDir : '';
    if (key === watchKey) return;
    stopWatch();
    watchKey = key;
    if (!key) return;
    const fire = () => { clearTimeout(watchTimer); watchTimer = setTimeout(() => ctx.send('feat:git:changed', { at: Date.now() }), 150); };
    const watch = (dir, recursive, accept) => {
      try {
        const w = fs.watch(dir, { recursive }, (_e, name) => { name = String(name || ''); if (!/\.lock$/.test(name) && accept.test(name)) fire(); });
        w.on('error', () => {});
        watchers.push(w);
      } catch { /* not watchable: the renderer's slow poll still covers it */ }
    };
    watch(info.gitDir, false, /^(HEAD|index|packed-refs|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|FETCH_HEAD|rebase-merge|rebase-apply)$/);
    watch(path.join(info.gitDir, 'logs'), false, /^HEAD$/);
    watch(path.join(info.commonDir, 'refs'), true, /./);
    if (info.commonDir !== info.gitDir) watch(info.commonDir, false, /^packed-refs$/);
  }

  /* ---------- paths ---------- */
  function relPath(root, base, p) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new Error('Invalid path.');
    const rel = path.relative(root, path.resolve(base, p));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the repository.');
    return rel.split(path.sep).join('/');
  }
  const relList = (root, list) => (Array.isArray(list) ? list : []).slice(0, 5000).map((p) => relPath(root, root, p));

  /* ---------- status ---------- */
  function status() {
    if (!statusInflight) statusInflight = doStatus().finally(() => { statusInflight = null; });
    return statusInflight;
  }
  async function doStatus() {
    const info = await repo();
    ensureWatch(info);
    if (info.state !== 'ok') return { ok: true, state: info.state, message: info.message || '' };
    const r = await run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: info.root, readOnly: true, timeout: 20000 });
    if (r.code !== 0) { repoCache = null; return { ok: true, state: 'error', message: failText(r) }; }
    return { ok: true, state: 'ok', root: info.root, ...parseStatus(r.stdout) };
  }

  async function hasHead(root) { return (await run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, readOnly: true })).code === 0; }

  /* ---------- changes ---------- */
  async function stage({ paths } = {}) {
    const { root } = await need();
    const args = paths ? ['add', '-A', '--', ...relList(root, paths)] : ['add', '-A'];
    if (paths && args.length === 3) return { ok: true };
    const r = await locked(() => run(args, { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) };
  }
  async function unstage({ paths } = {}) {
    const { root } = await need();
    const list = paths ? relList(root, paths) : [];
    if (paths && !list.length) return { ok: true };
    const head = await hasHead(root);
    const args = head ? ['reset', '-q', 'HEAD', '--', ...list] : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...(list.length ? list : ['.'])];
    const r = await locked(() => run(args, { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) };
  }
  // tracked: paths whose working-tree changes are thrown away; untracked: files that are deleted.
  async function discard({ tracked, untracked, all } = {}) {
    const { root } = await need();
    return locked(async () => {
      if (all) {
        const a = await run(['checkout', '--', '.'], { cwd: root, timeout: WRITE_TIMEOUT });
        const b = await run(['clean', '-fdq'], { cwd: root, timeout: WRITE_TIMEOUT });
        const bad = [a, b].find((x) => x.code !== 0);
        return bad ? { ok: false, error: failText(bad) } : { ok: true };
      }
      const t = relList(root, tracked), u = relList(root, untracked);
      if (t.length) { const r = await run(['checkout', '--', ...t], { cwd: root, timeout: WRITE_TIMEOUT }); if (r.code !== 0) return { ok: false, error: failText(r) }; }
      if (u.length) { const r = await run(['clean', '-fdq', '--', ...u], { cwd: root, timeout: WRITE_TIMEOUT }); if (r.code !== 0) return { ok: false, error: failText(r) }; }
      return { ok: true };
    });
  }

  async function commit({ message, amend, stageAll } = {}) {
    const { root } = await need();
    message = String(message || '').replace(/\r\n/g, '\n');
    if (!message.trim()) return { ok: false, error: 'Write a commit message first.' };
    return locked(async () => {
      if (stageAll) { const a = await run(['add', '-A'], { cwd: root, timeout: WRITE_TIMEOUT }); if (a.code !== 0) return { ok: false, error: failText(a) }; }
      if (!amend && (await run(['diff', '--cached', '--quiet'], { cwd: root, readOnly: true })).code === 0) return { ok: false, error: 'Nothing is staged. Stage some changes first.' };
      const r = await run(['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { cwd: root, input: message, timeout: WRITE_TIMEOUT });
      if (r.code !== 0) return { ok: false, error: failText({ ...r, stderr: r.stderr || r.stdout }) };
      const h = await run(['rev-parse', '--short', 'HEAD'], { cwd: root, readOnly: true });
      return { ok: true, hash: h.stdout.trim(), output: r.stdout.trim() };
    });
  }
  async function lastMessage() {
    const { root } = await need();
    const r = await run(['log', '-1', '--format=%B'], { cwd: root, readOnly: true });
    return r.code === 0 ? { ok: true, message: r.stdout.replace(/\s+$/, '') } : { ok: false, error: failText(r) };
  }

  /* ---------- diffs ---------- */
  function shapeDiff(r) {
    let text = r.stdout;
    let truncated = r.truncated;
    if (text.length > MAX_DIFF_CHARS) { text = text.slice(0, text.lastIndexOf('\n', MAX_DIFF_CHARS) + 1 || MAX_DIFF_CHARS); truncated = true; }
    const binary = /^Binary files .* differ$/m.test(text) || /^GIT binary patch/m.test(text);
    return { ok: true, text, binary, truncated, empty: !text.trim() };
  }
  // Untracked files are not known to git diff, so build a "new file" patch ourselves.
  function untrackedDiff(root, rel) {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { return { ok: true, text: '', empty: true, note: 'File no longer exists.' }; }
    if (st.isDirectory()) return { ok: true, text: '', empty: true, note: 'Untracked folder (for example a nested repository).' };
    if (st.size > 1024 * 1024) return { ok: true, text: '', binary: false, empty: true, note: `Large untracked file (${Math.round(st.size / 1024)} KB), preview not shown.` };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return { ok: true, text: `Binary files /dev/null and b/${rel} differ\n`, binary: true };
    const body = buf.toString('utf8');
    const lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const text = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n';
    return shapeDiff({ stdout: text, truncated: false });
  }
  const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

  // kind: unstaged | staged | untracked | all (everything vs HEAD)
  async function diff({ path: p, kind } = {}) {
    const { root } = await need();
    const rel = p ? relPath(root, root, p) : null;
    if (kind === 'untracked') return untrackedDiff(root, rel);
    let args;
    if (kind === 'staged') args = ['diff', '--cached', ...DIFF_OPTS];
    else if (kind === 'all') args = (await hasHead(root)) ? ['diff', 'HEAD', ...DIFF_OPTS] : ['diff', '--cached', ...DIFF_OPTS];
    else args = ['diff', ...DIFF_OPTS];
    if (rel) args.push('--', rel);
    const r = await run(args, { cwd: root, readOnly: true, maxBytes: 2 * 1024 * 1024, timeout: 30000 });
    if (r.code !== 0 && !r.truncated) return { ok: false, error: failText(r) };
    return shapeDiff(r);
  }

  /* ---------- history ---------- */
  async function log({ skip = 0, limit = 30 } = {}) {
    const { root } = await need();
    limit = Math.min(300, Math.max(1, parseInt(limit, 10) || 30));
    skip = Math.min(100000, Math.max(0, parseInt(skip, 10) || 0));
    const fmt = ['%H', '%h', '%an', '%at', '%s', '%D', '%P'].join('%x1f') + '%x1e';
    const r = await run(['log', `--max-count=${limit + 1}`, `--skip=${skip}`, `--format=${fmt}`], { cwd: root, readOnly: true });
    if (r.code !== 0) {
      if (/does not have any commits|unknown revision|bad default revision/i.test(r.stderr)) return { ok: true, commits: [], hasMore: false, empty: true };
      return { ok: false, error: failText(r) };
    }
    const all = r.stdout.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((s) => {
      const [hash, short, author, at, subject, refs, parents] = s.split('\x1f');
      return { hash, short, author, at: +at, subject, refs, merge: (parents || '').trim().split(' ').filter(Boolean).length > 1 };
    });
    return { ok: true, commits: all.slice(0, limit), hasMore: all.length > limit };
  }

  function parseNameStatus(out) {
    const t = out.split('\0'), files = [];
    for (let i = 0; i < t.length; i++) {
      const s = t[i];
      if (!s) continue;
      if (/^[RC]/.test(s)) { files.push({ status: s[0], orig: t[i + 1], path: t[i + 2] }); i += 2; }
      else { files.push({ status: s[0], path: t[++i] }); }
    }
    return files;
  }
  async function commitInfo(hash) {
    const { root } = await need();
    if (!HASH_RE.test(String(hash))) return { ok: false, error: 'Invalid commit.' };
    const a = await run(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B', hash], { cwd: root, readOnly: true });
    if (a.code !== 0) return { ok: false, error: failText(a) };
    const [full, short, author, email, at, parents, ...body] = a.stdout.split('\x1f');
    const f = await run(['show', '--format=', '--name-status', '-z', '-M', '-m', '--first-parent', hash], { cwd: root, readOnly: true });
    return { ok: true, hash: full, short, author, email, at: +at, parents: parents.trim().split(' ').filter(Boolean), message: body.join('\x1f').trim(), files: parseNameStatus(f.stdout).slice(0, 2000) };
  }
  async function commitDiff({ hash, path: p, orig } = {}) {
    const { root } = await need();
    if (!HASH_RE.test(String(hash))) return { ok: false, error: 'Invalid commit.' };
    const paths = [orig, p].filter(Boolean).map((x) => relPath(root, root, x));
    const r = await run(['show', '--format=', ...DIFF_OPTS, '-m', '--first-parent', hash, ...(paths.length ? ['--', ...paths] : [])], { cwd: root, readOnly: true, maxBytes: 2 * 1024 * 1024, timeout: 30000 });
    if (r.code !== 0 && !r.truncated) return { ok: false, error: failText(r) };
    return shapeDiff(r);
  }

  /* ---------- branches + stash ---------- */
  async function branches() {
    const { root } = await need();
    const r = await run(['for-each-ref', '--format=%(refname)%1f%(HEAD)%1f%(objectname:short)%1f%(upstream:short)%1f%(subject)', 'refs/heads', 'refs/remotes'], { cwd: root, readOnly: true });
    if (r.code !== 0) return { ok: false, error: failText(r) };
    const local = [], remote = [];
    for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
      const [ref, head, hash, upstream, subject] = line.split('\x1f');
      if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice(11), current: head === '*', hash, upstream, subject });
      else if (ref.startsWith('refs/remotes/') && !/\/HEAD$/.test(ref)) remote.push({ name: ref.slice(13), hash, subject });
    }
    return { ok: true, local, remote };
  }
  async function validBranch(root, name) {
    name = String(name || '').trim();
    if (!name || name.length > 200 || /^-/.test(name)) return null;
    return (await run(['check-ref-format', '--branch', name], { cwd: root, readOnly: true })).code === 0 ? name : null;
  }
  async function checkout({ name, remote } = {}) {
    const { root } = await need();
    const n = await validBranch(root, name);
    if (!n) return { ok: false, error: 'That is not a valid branch name.' };
    let args = ['checkout', n, '--'];
    if (remote) {
      const local = n.replace(/^[^/]+\//, '');
      const exists = (await run(['show-ref', '--verify', '--quiet', 'refs/heads/' + local], { cwd: root, readOnly: true })).code === 0;
      args = exists ? ['checkout', local, '--'] : ['checkout', '--track', n];
    }
    const r = await locked(() => run(args, { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) };
  }
  async function createBranch({ name, checkout: sw = true } = {}) {
    const { root } = await need();
    const n = await validBranch(root, name);
    if (!n) return { ok: false, error: 'That is not a valid branch name (no spaces, ~, ^, :, ?, *, [ or ..).' };
    const r = await locked(() => run(sw ? ['checkout', '-b', n] : ['branch', n], { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true, name: n } : { ok: false, error: failText(r) };
  }

  const stashRef = (i) => { i = parseInt(i, 10); if (!(i >= 0 && i < 1000)) throw new Error('Invalid stash.'); return `stash@{${i}}`; };
  async function stashList() {
    const { root } = await need();
    const r = await run(['stash', 'list', '--format=%gd%x1f%gs%x1f%at'], { cwd: root, readOnly: true });
    if (r.code !== 0) return { ok: false, error: failText(r) };
    return { ok: true, items: r.stdout.split(/\r?\n/).filter(Boolean).map((l, index) => { const [, msg, at] = l.split('\x1f'); return { index, message: msg, at: +at }; }) };
  }
  async function stashPush({ message, untracked } = {}) {
    const { root } = await need();
    const args = ['stash', 'push', ...(untracked ? ['--include-untracked'] : []), ...(String(message || '').trim() ? ['-m', String(message).trim().slice(0, 200)] : [])];
    const r = await locked(() => run(args, { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { ok: false, error: failText(r) };
  }
  async function stashPop({ index } = {}) {
    const { root } = await need();
    const r = await locked(() => run(['stash', 'pop', stashRef(index)], { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { ok: false, error: failText({ ...r, stderr: r.stderr + '\n' + r.stdout }) };
  }
  async function stashDrop({ index } = {}) {
    const { root } = await need();
    const r = await locked(() => run(['stash', 'drop', stashRef(index)], { cwd: root, timeout: WRITE_TIMEOUT }));
    return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) };
  }

  /* ---------- remote (online) ---------- */
  async function remoteOp(name, args, extra = {}) {
    if (netBusy) return { ok: false, error: 'Another remote operation is still running.' };
    const { root } = await need();
    netBusy = true;
    try {
      const r = await run(args, { cwd: root, timeout: NET_TIMEOUT });
      const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
      if (r.code === 0) return { ok: true, output: output || `git ${name}: done.` };
      return { ok: false, error: r.timedOut ? 'Timed out after 2 minutes.' : friendly(r.stderr || r.stdout), output };
    } finally { netBusy = false; ctx.send('feat:git:changed', { at: Date.now(), ...extra }); }
  }
  const fetchRemote = () => remoteOp('fetch', ['fetch', '--prune']);
  const pull = () => remoteOp('pull', ['pull']);
  async function push({ confirmed, setUpstream } = {}) {
    if (confirmed !== true) return { ok: false, error: 'Push was not confirmed.' };
    const { root } = await need();
    const st = parseStatus((await run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { cwd: root, readOnly: true })).stdout);
    if (st.detached) return { ok: false, error: 'You are on a detached HEAD. Create or switch to a branch before pushing.' };
    const remotes = (await run(['remote'], { cwd: root, readOnly: true })).stdout.split(/\s+/).filter(Boolean);
    if (!remotes.length) return { ok: false, error: 'No remote repository is configured. Add one first, for example: git remote add origin <url>' };
    if (setUpstream || !st.upstream) {
      const rem = remotes.includes('origin') ? 'origin' : remotes[0];
      return remoteOp('push', ['push', '-u', rem, st.branch]);
    }
    return remoteOp('push', ['push']);
  }

  /* ---------- AI helper (local Ollama) ---------- */
  async function suggest() {
    const { root } = await need();
    const stat = await run(['diff', '--cached', '--stat', '--no-color'], { cwd: root, readOnly: true });
    const d = await run(['diff', '--cached', '--no-color', '--no-ext-diff', '-U2'], { cwd: root, readOnly: true, maxBytes: 200000 });
    if (!d.stdout.trim()) return { ok: false, error: 'Nothing is staged, so there is nothing to describe.' };
    const s = ctx.getSettings();
    const prompt = `Files:\n${stat.stdout.trim()}\n\nDiff:\n${clip(d.stdout, 8000)}`;
    let res;
    try {
      res = await fetch(`${s.host}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          model: s.model, stream: false, think: false, options: { num_predict: 60, temperature: 0.2 },
          messages: [
            { role: 'system', content: 'You write Git commit messages. Reply with ONE line only: imperative mood, at most 72 characters, no quotes, no prefix, no explanation.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (e) { return { ok: false, error: `Cannot reach Ollama at ${s.host}. Start Ollama and try again.` }; }
    if (!res.ok) return { ok: false, error: `Ollama answered with an error (${res.status}).` };
    let text = '';
    try { text = String((await res.json()).message?.content || ''); } catch { /* handled below */ }
    const line = text.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    const msg = line.replace(/^(commit message:?\s*)/i, '').replace(/^["'`]+|["'`]+$/g, '').slice(0, 100).trim();
    return msg ? { ok: true, message: msg } : { ok: false, error: 'The model did not return a message. Try again.' };
  }

  /* ---------- AI tools (read-only) ---------- */
  async function toolStatus() {
    const ws = ctx.workspace();
    if (!ws) return 'No folder is open.';
    const info = await repo();
    if (info.state === 'norepo') return 'This folder is not a Git repository.';
    if (info.state !== 'ok') return info.message || 'Git is not available.';
    const st = await doStatus();
    if (st.state !== 'ok') return st.message;
    const names = (pred) => st.files.filter(pred).map((f) => `  ${f.x === '.' ? f.y : f.x}  ${f.path}`);
    const staged = names((f) => !f.conflict && f.x !== '.' && f.x !== '?');
    const unstaged = st.files.filter((f) => !f.conflict && f.y !== '.' && f.y !== '?').map((f) => `  ${f.y}  ${f.path}`);
    const untracked = st.files.filter((f) => f.x === '?').map((f) => `  ?  ${f.path}`);
    const conflicts = st.files.filter((f) => f.conflict).map((f) => `  U  ${f.path}`);
    const sec = (t, l) => (l.length ? `${t} (${l.length}):\n${l.join('\n')}\n` : '');
    const lg = await run(['log', '-5', '--format=%h %s'], { cwd: info.root, readOnly: true });
    return clip(`Repository: ${info.root}\nBranch: ${st.detached ? '(detached HEAD)' : st.branch}${st.upstream ? ` tracking ${st.upstream} (ahead ${st.ahead}, behind ${st.behind})` : ' (no upstream)'}\n` +
      (st.files.length ? '' : 'Working tree clean.\n') + sec('Conflicts', conflicts) + sec('Staged', staged) + sec('Unstaged', unstaged) + sec('Untracked', untracked) +
      (lg.stdout.trim() ? `Recent commits:\n${lg.stdout.trim()}` : 'No commits yet.'));
  }
  async function toolDiff(a) {
    const ws = ctx.workspace();
    if (!ws) return 'No folder is open.';
    const info = await repo();
    if (info.state !== 'ok') return info.state === 'norepo' ? 'This folder is not a Git repository.' : (info.message || 'Git is not available.');
    const args = ['diff', ...(a.staged ? ['--cached'] : []), ...DIFF_OPTS];
    if (a.path) args.push('--', relPath(info.root, ws, String(a.path)));
    const r = await run(args, { cwd: info.root, readOnly: true, maxBytes: 1024 * 1024, timeout: 30000 });
    if (r.code !== 0 && !r.truncated) return 'git diff failed: ' + failText(r);
    return r.stdout.trim() ? clip(r.stdout) : 'No differences.';
  }

  /* ---------- GitHub (opt-in, online) ---------- */
  const DEFAULT_API = 'https://api.github.com';
  const gh = { cache: new Map(), sig: {}, rate: null, blockedUntil: 0, authError: false };
  const ghCfg = () => ctx.featureSettings('git') || {};
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function secure() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'Secure storage is not available on this system, so Faber will not store a GitHub token (it is never saved in plain text).' };
      if (typeof safeStorage.getSelectedStorageBackend === 'function' && process.platform === 'linux' && /basic_text|unknown/.test(safeStorage.getSelectedStorageBackend())) {
        return { ok: false, reason: 'No system keyring is available, so Faber will not store a GitHub token.' };
      }
      return { ok: true };
    } catch { return { ok: false, reason: 'Secure storage is not available on this system, so Faber will not store a GitHub token.' }; }
  }
  function getToken() {
    const enc = ghCfg().tokenEnc;
    if (!enc) return null;
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
  }
  function normalizeBase(u) {
    let url;
    try { url = new URL(String(u || DEFAULT_API).trim()); } catch { throw new Error('The API address is not a valid URL.'); }
    const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password) throw new Error('Do not put credentials in the API address.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loop)) throw new Error('The API address must start with https:// (http:// only for localhost).');
    return (url.origin + url.pathname).replace(/\/+$/, '');
  }
  const ghErr = (message, status, fatal) => Object.assign(new Error(message), { status, fatal });

  async function ghHttp({ base, token, urlPath, query, cache }) {
    const url = new URL(base + urlPath);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const key = url.toString();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Faber', Authorization: 'Bearer ' + token };
    const hit = cache ? gh.cache.get(key) : null;
    if (hit) headers['If-None-Match'] = hit.etag;
    let res;
    try { res = await fetch(key, { headers, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw ghErr(e && e.name === 'TimeoutError' ? 'GitHub did not answer in time.' : 'Cannot reach GitHub (offline?). Everything else in Faber keeps working.', 0); }
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem !== null) gh.rate = { limit: +res.headers.get('x-ratelimit-limit'), remaining: +rem, reset: +res.headers.get('x-ratelimit-reset') };
    if (res.status === 304 && hit) return { data: hit.data, notModified: true };
    if (res.status === 200) {
      let data;
      try { data = await res.json(); } catch { throw ghErr('GitHub sent an unreadable answer.', 200); }
      const etag = res.headers.get('etag');
      if (cache && etag) {
        gh.cache.set(key, { etag, data });
        if (gh.cache.size > 80) gh.cache.delete(gh.cache.keys().next().value);
      }
      return { data };
    }
    let msg = '';
    try { msg = String((await res.json()).message || ''); } catch { /* no body */ }
    if (res.status === 401) { if (cache) gh.authError = true; throw ghErr('GitHub rejected the token (401 bad credentials). Reconnect with a valid token, or disconnect.', 401, true); }
    if (res.status === 403 || res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') || '0', 10);
      if (rem === '0' || retry || /rate limit/i.test(msg)) {
        const until = retry ? Date.now() + retry * 1000 : (gh.rate && gh.rate.reset ? gh.rate.reset * 1000 : Date.now() + 600000);
        gh.blockedUntil = Math.max(until, Date.now() + 30000);
        throw ghErr(`GitHub rate limit reached. Faber will pause GitHub requests until ${clock(gh.blockedUntil)}.`, 403, true);
      }
      throw ghErr(`GitHub refused the request (403): ${msg || 'access denied'}. The token may lack permission for this repository.`, 403);
    }
    if (res.status === 404) throw ghErr('GitHub cannot find this repository, or the token cannot see it (404).', 404);
    throw ghErr(`GitHub error ${res.status}${msg ? ': ' + msg : ''}.`, res.status);
  }

  async function ghStatus() {
    const c = ghCfg();
    return { ok: true, secure: secure().ok, secureReason: secure().reason || '', connected: !!c.tokenEnc && !!getToken(), login: c.login || '', baseUrl: c.baseUrl || DEFAULT_API, live: !!c.live, authError: gh.authError, blockedUntil: gh.blockedUntil, rate: gh.rate };
  }
  async function ghConnect({ token, baseUrl } = {}) {
    const s = secure();
    if (!s.ok) return { ok: false, error: s.reason };
    token = String(token || '').trim();
    if (!/^[A-Za-z0-9_\-.]{8,255}$/.test(token)) return { ok: false, error: 'That does not look like a GitHub token (letters, digits, _ - . only).' };
    let base;
    try { base = normalizeBase(baseUrl); } catch (e) { return { ok: false, error: e.message }; }
    let me;
    try { me = (await ghHttp({ base, token, urlPath: '/user' })).data; }
    catch (e) { return { ok: false, error: e.message }; }
    const enc = safeStorage.encryptString(token).toString('base64');
    ctx.setFeatureSettings('git', { baseUrl: base, tokenEnc: enc, login: String(me.login || ''), live: false });
    Object.assign(gh, { sig: {}, rate: gh.rate, blockedUntil: 0, authError: false });
    gh.cache.clear();
    return { ok: true, login: me.login };
  }
  async function ghDisconnect() {
    ctx.setFeatureSettings('git', { tokenEnc: '', login: '', live: false });
    Object.assign(gh, { sig: {}, rate: null, blockedUntil: 0, authError: false });
    gh.cache.clear();
    return { ok: true };
  }
  async function ghSetLive(on) { ctx.setFeatureSettings('git', { live: !!on }); return { ok: true, live: !!on }; }

  async function ghRepoRef() {
    const info = await repo();
    if (info.state !== 'ok') return null;
    const r = await run(['remote', 'get-url', 'origin'], { cwd: info.root, readOnly: true });
    return r.code === 0 ? parseRemote(r.stdout) : null;
  }
  async function ghRepo() {
    const ref = await ghRepoRef();
    if (!ref) return { ok: true, found: false };
    const base = ghCfg().baseUrl || DEFAULT_API;
    const warn = ref.host !== 'github.com' && base === DEFAULT_API ? `The origin remote (${ref.host}) is not github.com. Set the API address to your GitHub Enterprise server.` : '';
    return { ok: true, found: true, ...ref, warn };
  }

  const checksOf = (runs) => {
    if (!runs.length) return 'none';
    if (runs.some((r) => r.status !== 'completed')) return 'pending';
    return runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion)) ? 'failing' : 'passing';
  };
  const loaders = {
    async info(ctxg) {
      const d = (await ghHttp({ ...ctxg, urlPath: ctxg.repoPath, cache: true })).data;
      return { name: d.full_name, description: d.description || '', stars: d.stargazers_count, branch: d.default_branch, issues: d.open_issues_count, url: d.html_url, private: !!d.private };
    },
    async commits(ctxg) {
      const d = (await ghHttp({ ...ctxg, urlPath: ctxg.repoPath + '/commits', query: { per_page: '8' }, cache: true })).data;
      return (Array.isArray(d) ? d : []).map((c) => ({ sha: String(c.sha).slice(0, 7), message: String(c.commit?.message || '').split('\n')[0], author: c.commit?.author?.name || c.author?.login || '', date: c.commit?.author?.date || '', url: c.html_url }));
    },
    async pulls(ctxg) {
      const d = (await ghHttp({ ...ctxg, urlPath: ctxg.repoPath + '/pulls', query: { state: 'open', per_page: '10' }, cache: true })).data;
      const prs = [];
      for (const p of (Array.isArray(d) ? d : []).slice(0, 10)) {
        let checks = 'unknown';
        if (prs.length < 6 && p.head?.sha) {
          try {
            const c = (await ghHttp({ ...ctxg, urlPath: `${ctxg.repoPath}/commits/${encodeURIComponent(p.head.sha)}/check-runs`, query: { per_page: '50' }, cache: true })).data;
            checks = checksOf(c.check_runs || []);
          } catch (e) { if (e.fatal) throw e; }
        }
        prs.push({ number: p.number, title: p.title, author: p.user?.login || '', draft: !!p.draft, url: p.html_url, checks });
      }
      return prs;
    },
    async runs(ctxg) {
      const d = (await ghHttp({ ...ctxg, urlPath: ctxg.repoPath + '/actions/runs', query: { per_page: '6' }, cache: true })).data;
      return (d.workflow_runs || []).map((r) => ({ id: r.id, name: r.display_title || r.name, workflow: r.name, state: r.status === 'completed' ? (r.conclusion || 'done') : r.status, branch: r.head_branch, event: r.event, url: r.html_url, updated: r.updated_at }));
    },
  };
  async function ghLoad({ kinds, force, poll } = {}) {
    const token = getToken(), c = ghCfg();
    if (!token) return { ok: false, notConnected: true, error: 'Not connected to GitHub.' };
    const ref = await ghRepoRef();
    if (!ref) return { ok: false, error: 'This repository has no "origin" remote that looks like GitHub (owner/repo).' };
    if (Date.now() < gh.blockedUntil) return { ok: false, error: `GitHub rate limit reached. Faber is paused until ${clock(gh.blockedUntil)}.`, rate: gh.rate, blockedUntil: gh.blockedUntil };
    if (poll && gh.rate && gh.rate.remaining <= 3) return { ok: true, skipped: 'rate', rate: gh.rate, results: {}, errors: {} };
    if (gh.authError) return { ok: false, error: 'GitHub rejected the token earlier. Reconnect with a valid token.', authError: true };
    const g = { base: normalizeBase(c.baseUrl), token, repoPath: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}` };
    const out = { ok: true, results: {}, errors: {}, authError: false };
    for (const kind of (kinds || []).filter((k) => loaders[k])) {
      try {
        const data = await loaders[kind](g);
        const sig = JSON.stringify(data);
        const changed = !!force || gh.sig[kind] !== sig;
        gh.sig[kind] = sig;
        out.results[kind] = changed ? { changed, data } : { changed };
      } catch (e) {
        out.errors[kind] = e.message;
        if (e.fatal) break;
      }
    }
    out.rate = gh.rate; out.authError = gh.authError; out.blockedUntil = gh.blockedUntil;
    return out;
  }

  async function openUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return { ok: false, error: 'Invalid link.' }; }
    if (u.protocol !== 'https:' || u.username || u.password || String(url).length > 2048) return { ok: false, error: 'Only plain https links can be opened.' };
    await shell.openExternal(u.toString());
    return { ok: true };
  }

  /* ---------- register ---------- */
  const on = (name, fn) => ctx.handle('feat:git:' + name, async (...a) => {
    try { return await fn(...a); } catch (e) { return { ok: false, error: friendly(e && e.message) }; }
  });
  on('status', status);
  on('init', async () => {
    const ws = ctx.workspace();
    if (!ws) return { ok: false, error: 'No folder is open.' };
    const r = await run(['init'], { cwd: ws });
    repoCache = null;
    return r.code === 0 ? { ok: true } : { ok: false, error: failText(r) };
  });
  on('stage', stage); on('unstage', unstage); on('discard', discard);
  on('commit', commit); on('lastMessage', lastMessage);
  on('diff', diff); on('log', log); on('commitInfo', commitInfo); on('commitDiff', commitDiff);
  on('branches', branches); on('checkout', checkout); on('createBranch', createBranch);
  on('stashList', stashList); on('stashPush', stashPush); on('stashPop', stashPop); on('stashDrop', stashDrop);
  on('fetch', fetchRemote); on('pull', pull); on('push', push);
  on('suggest', suggest);
  on('copy', async (t) => { clipboard.writeText(String(t || '').slice(0, 2000)); return { ok: true }; });
  on('ghStatus', ghStatus); on('ghConnect', ghConnect); on('ghDisconnect', ghDisconnect); on('ghSetLive', ghSetLive);
  on('ghRepo', ghRepo); on('ghLoad', ghLoad); on('openUrl', openUrl);

  const { fn, str } = toolsApi.helpers;
  toolsApi.registerTool(fn('git_status', 'Show the Git state of the open folder: branch, staged/unstaged/untracked files and recent commits. Read-only.', {}, []), async () => toolStatus());
  toolsApi.registerTool(fn('git_diff', 'Show the Git diff of the open folder (unstaged by default). Read-only.', {
    path: str('File to diff (optional)'), staged: { type: 'boolean', description: 'Show staged changes instead (optional)' },
  }, []), async (a) => toolDiff(a || {}));
};

module.exports.parseStatus = parseStatus;
module.exports.parseRemote = parseRemote;
module.exports.friendly = friendly;
