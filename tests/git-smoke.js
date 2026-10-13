// Git feature smoke test: real Electron app, real git CLI, fake Ollama + mock GitHub servers (no internet, no real token).
const { app, BrowserWindow, safeStorage } = require('electron');
const electron = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const cp = require('child_process');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const base = path.join(fs.realpathSync.native(os.tmpdir()), 'faber-git-' + TAG);
const ud = base + '-ud';
fs.rmSync(base, { recursive: true, force: true });
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
fs.mkdirSync(ud, { recursive: true });
app.setPath('userData', ud);
process.env.GIT_CEILING_DIRECTORIES = path.dirname(base);

const LOG = path.join(process.env.TEMP, 'faber-gitsmoke-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'ghp_FAKEtestTOKEN0123456789abcdefXYZ';
const captured = [];   // everything the main process prints (checked for the token)
for (const s of ['stdout', 'stderr']) { const w = process[s].write.bind(process[s]); process[s].write = (c, ...r) => { captured.push(String(c)); return w(c, ...r); }; }

/* ---------- fake Ollama ---------- */
const ollama = { requests: [] };
ollama.server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/version') return res.end('{"version":"0.0.0"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }));
    if (req.url === '/api/chat') { ollama.requests.push(JSON.parse(body)); return res.end(JSON.stringify({ message: { role: 'assistant', content: '"Update a.txt contents."\nMore text that must be dropped' }, done: true })); }
    res.statusCode = 404; res.end('{}');
  });
});

/* ---------- mock GitHub ---------- */
const mock = { requests: [], etag: '"c1"', commits: [{ sha: 'a'.repeat(40), msg: 'First mock commit' }], revoke: false, rate: false, n304: 0 };
mock.server = http.createServer((req, res) => {
  mock.requests.push({ url: req.url, auth: req.headers.authorization || '', inm: req.headers['if-none-match'] || '' });
  const json = (code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), ...extra }); res.end(obj === null ? '' : JSON.stringify(obj)); };
  if (req.headers.authorization !== 'Bearer ' + TOKEN || mock.revoke) return json(401, { message: 'Bad credentials' });
  if (mock.rate) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
  const etagged = (tag, data) => { if (req.headers['if-none-match'] === tag) { mock.n304++; return json(304, null, { etag: tag }); } return json(200, data, { etag: tag }); };
  const u = req.url.split('?')[0];
  if (u === '/user') return json(200, { login: 'octo' });
  if (u === '/repos/acme/widgets') return etagged('"info1"', { full_name: 'acme/widgets', description: 'Mock widgets', stargazers_count: 42, default_branch: 'main', open_issues_count: 3, html_url: 'https://github.com/acme/widgets', private: false });
  if (u === '/repos/acme/widgets/commits') return etagged(mock.etag, mock.commits.map((c) => ({ sha: c.sha, html_url: 'https://github.com/acme/widgets/commit/' + c.sha, commit: { message: c.msg, author: { name: 'Mona', date: new Date().toISOString() } } })));
  if (u === '/repos/acme/widgets/pulls') return etagged('"p1"', [{ number: 7, title: 'Add widget', user: { login: 'mona' }, draft: false, html_url: 'https://github.com/acme/widgets/pull/7', head: { sha: 'b'.repeat(40) } }]);
  if (/\/check-runs$/.test(u)) return etagged('"k1"', { check_runs: [{ status: 'completed', conclusion: 'success' }] });
  if (u === '/repos/acme/widgets/actions/runs') return etagged('"r1"', { workflow_runs: [{ id: 1, name: 'CI', display_title: 'CI build', status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'push', html_url: 'https://github.com/acme/widgets/actions/runs/1', updated_at: new Date().toISOString() }] });
  json(404, { message: 'Not Found' });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const oPort = await listen(ollama.server), gPort = await listen(mock.server);
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ host: `http://127.0.0.1:${oPort}` }));
  const realFetch = global.fetch;
  const fetched = [];
  require(path.join(root, 'main.js'));
  global.fetch = (u, o) => { fetched.push(String(u)); return realFetch(u, o); };
  const opened = [];
  electron.shell.openExternal = async (u) => { opened.push(u); };

  app.whenReady().then(async () => {
    const win = await new Promise((r) => { const t = setInterval(() => { const w = BrowserWindow.getAllWindows()[0]; if (w) { clearInterval(t); r(w); } }, 100); });
    const consoleMsgs = [];
    win.webContents.on('console-message', (_e, level, msg) => { consoleMsgs.push(msg); });
    const js = (code) => win.webContents.executeJavaScript(code);
    const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    const G = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
    const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(150); } return false; };
    const P = '#pane-git';
    const rows = (g) => js(`[...document.querySelectorAll('${P} [data-group="${g}"] .gFile')].map(r => r.dataset.path + ':' + r.querySelector('.gs').textContent).sort().join(',')`);
    const act = (a, scope = P) => js(`(() => { const b = document.querySelector('${scope} [data-act="${a}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const rowAct = (g, p, a) => js(`(() => { const b = document.querySelector('${P} [data-group="${g}"] .gFile[data-path="${p}"] [data-act="${a}"]'); if (!b) return false; b.click(); return true; })()`);
    const clickRow = (g, p) => js(`(() => { const r = document.querySelector('${P} [data-group="${g}"] .gFile[data-path="${p}"]'); if (!r) return false; r.click(); return true; })()`);
    const modalBtn = (label) => js(`(() => { const b = [...document.querySelectorAll('.modalFoot button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const modalText = () => js(`([...document.querySelectorAll('.modalCard')].pop() || {}).innerText || ''`);
    const closeModal = () => js(`(() => { const b = document.querySelector('.modalHead button'); if (b) b.click(); return true; })()`);
    const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
    const setMsg = (v) => js(`(() => { const t = document.querySelector('${P} .gMsg'); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event('input')); return true; })()`);
    const commitDisabled = () => js(`document.querySelector('${P} [data-act="commit"]').disabled`);
    const head = () => text(P + ' .gHead');
    const setSec = (id, open) => js(`(() => { const s = document.querySelector('${P} [data-sec="${id}"]'); const isOpen = !s.querySelector('.gSecBody').hidden; if (isOpen !== ${open}) s.querySelector('.gSecHead').click(); return true; })()`);
    const diffInfo = () => js(`({ add: document.querySelectorAll('.gdModal .gdl.add').length, del: document.querySelectorAll('.gdModal .gdl.del').length, txt: [...document.querySelectorAll('.gdModal .gdt')].map((x) => x.textContent).join('\\n'), note: (document.querySelector('.gdModal .gdBox') || {}).innerText || '', chips: [...document.querySelectorAll('.gdModal .gChip')].map((x) => x.textContent).join('|') })`);
    const openDiff = async (g, p) => { await clickRow(g, p); await waitFor(() => js(`!!document.querySelector('.gdModal .gdBox') && !/Loading/.test(document.querySelector('.gdModal .gdBox').innerText)`)); const d = await diffInfo(); await closeModal(); return d; };
    const branchNow = (cwd) => G(cwd, 'branch', '--show-current');
    const settingsRaw = () => fs.readFileSync(path.join(ud, 'settings.json'), 'utf8');
    const tools = require(path.join(root, 'src', 'tools.js'));

    try {
      check('git is installed on this PC', /git version/.test(G(base, '--version')), G(base, '--version'));
      check('app is usable', await waitFor(() => js("!document.getElementById('app').hidden"), 25000) === true);
      check('Git icon is on the activity bar', await js(`[...document.querySelectorAll('#railTop .rbtn')].some((b) => b.title === 'Git')`));
      await sleep(500);

      /* ---- pure helpers ---- */
      const mod = require(path.join(root, 'src', 'features', 'git.js'));
      const ps = mod.parseStatus('# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0' +
        '1 .M N... 100644 100644 100644 h h a b.txt\0' + '2 R. N... 100644 100644 100644 h h R100 new name.txt\0old name.txt\0' + '? na\u00efve.txt\0u UU N... 1 2 3 4 h h h c.txt\0');
      check('parseStatus: branch, ahead/behind', ps.branch === 'main' && ps.upstream === 'origin/main' && ps.ahead === 2 && ps.behind === 1);
      check('parseStatus: spaces, rename, unicode, conflict', ps.files[0].path === 'a b.txt' && ps.files[1].path === 'new name.txt' && ps.files[1].orig === 'old name.txt' && ps.files[2].path === 'na\u00efve.txt' && ps.files[3].conflict === true);
      const pr = mod.parseRemote;
      const okRemotes = ['https://github.com/acme/widgets.git', 'https://user:x@github.com/acme/widgets', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git', 'https://ghe.example.com/acme/widgets/'];
      check('parseRemote: https / ssh / scp / GHE forms', okRemotes.every((u) => { const r = pr(u); return r && r.owner === 'acme' && r.repo === 'widgets'; }));
      check('parseRemote: local paths are not GitHub', pr('C:\\repos\\x.git') === null && pr('/srv/x.git') === null && pr('') === null);
      check('friendly(): known git errors', /not a Git repository/.test(mod.friendly('fatal: not a git repository')) && /overwritten/.test(mod.friendly('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit')));

      /* ---- no folder / not a repo ---- */
      await js(`Faber.showSideTab('git')`);
      check('no folder: friendly message', await waitFor(async () => /No folder is open/.test(await text(P + ' .gNotice'))));
      check('no folder: tools answer politely', (await tools.execute('git_status', {}, {})) === 'No folder is open.');
      const norepo = path.join(base, 'norepo');
      fs.mkdirSync(norepo);
      await js(`openFolder(${JSON.stringify(norepo)})`);
      check('not a repo: message + Initialize button', await waitFor(async () => /not a Git repository/.test(await text(P + ' .gNotice')) && (await js(`!!document.querySelector('${P} [data-act="init"]')`))));
      check('not a repo: tools answer politely', /not a Git repository/.test(await tools.execute('git_status', {}, {})));
      await act('init');
      check('Initialize repository creates .git and shows the panel', await waitFor(() => fs.existsSync(path.join(norepo, '.git')) && js(`!document.querySelector('${P} .gSections').hidden`)));
      check('fresh repo: history says no commits', await waitFor(async () => /No commits yet/.test(await text(P + ' .gHistory'))));

      /* ---- the main test repo ---- */
      const ws = path.join(base, 'repo');
      fs.mkdirSync(ws);
      G(ws, 'init', '-q', '-b', 'main');
      for (const [k, v] of [['user.name', 'Faber Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.safecrlf', 'false']]) G(ws, 'config', k, v);
      fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nbeta\ngamma\n');
      fs.writeFileSync(path.join(ws, 'b.txt'), 'bee\n');
      fs.writeFileSync(path.join(ws, 'c.txt'), 'see\nsea\n');
      fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([1, 2, 3, 0, 4, 5]));
      fs.writeFileSync(path.join(ws, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
      fs.writeFileSync(path.join(ws, 'big.txt'), 'x\n');
      G(ws, 'add', '-A'); G(ws, 'commit', '-q', '-m', 'initial commit');
      await js(`openFolder(${JSON.stringify(ws)})`);
      check('repo opens: branch shown in header', await waitFor(async () => /main/.test(await head())));
      check('repo opens: history shows initial commit', await waitFor(async () => /initial commit/.test(await text(P + ' .gHistory'))));

      // build a mixed state
      fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nBETA changed\ngamma\ndelta\n');         // unstaged modify
      fs.writeFileSync(path.join(ws, 'b.txt'), 'bee\nbuzz\n'); G(ws, 'add', 'b.txt');          // staged modify
      fs.writeFileSync(path.join(ws, 's.txt'), 'staged new\n'); G(ws, 'add', 's.txt');         // staged add
      fs.rmSync(path.join(ws, 'c.txt'));                                                      // unstaged delete
      fs.writeFileSync(path.join(ws, 'new.txt'), 'untracked\n');                              // untracked
      await act('refresh');
      check('status: staged list', await waitFor(async () => (await rows('staged')) === 'b.txt:M,s.txt:A'), await rows('staged'));
      check('status: unstaged list', (await rows('unstaged')) === 'a.txt:M,c.txt:D', await rows('unstaged'));
      check('status: untracked list', (await rows('untracked')) === 'new.txt:?', await rows('untracked'));
      check('activity bar badge shows the number of changes', await waitFor(async () => (await js(`(document.querySelector('#railTop .rbtn[title="Git"] .rbadge') || {}).textContent`)) === '5'));
      check('header shows dirty count', /5 changes/.test(await head()), await head());

      /* ---- stage / unstage / discard ---- */
      await rowAct('unstaged', 'a.txt', 'stage');
      check('stage moves a.txt to Staged', await waitFor(async () => /a\.txt:M/.test(await rows('staged')) && !/a\.txt/.test(await rows('unstaged'))));
      await rowAct('staged', 'a.txt', 'unstage');
      check('unstage moves it back', await waitFor(async () => /a\.txt:M/.test(await rows('unstaged')) && !/a\.txt/.test(await rows('staged'))));
      const aMod = fs.readFileSync(path.join(ws, 'a.txt'), 'utf8');
      await rowAct('unstaged', 'a.txt', 'discard');
      check('discard asks for confirmation', await waitFor(async () => /cannot be undone/.test(await modalText())));
      await modalBtn('Cancel');
      await sleep(400);
      check('cancelling discard keeps the file', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === aMod && /a\.txt/.test(await rows('unstaged')));
      await rowAct('unstaged', 'a.txt', 'discard');
      await waitFor(async () => /cannot be undone/.test(await modalText()));
      await modalBtn('Discard');
      check('confirmed discard restores the file', await waitFor(() => fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'alpha\nbeta\ngamma\n') && await waitFor(async () => !/a\.txt/.test(await rows('unstaged'))));
      await rowAct('untracked', 'new.txt', 'discard');
      await waitFor(async () => /cannot be undone/.test(await modalText()));
      await modalBtn('Discard');
      check('discarding an untracked file deletes it', await waitFor(() => !fs.existsSync(path.join(ws, 'new.txt'))));
      await act('unstage-all');
      check('unstage all', await waitFor(async () => (await rows('staged')) === ''), await rows('staged'));
      await act('stage-all');
      check('stage all', await waitFor(async () => /b\.txt:M/.test(await rows('staged')) && /c\.txt:D/.test(await rows('staged'))), await rows('staged'));
      await act('unstage-all');
      await waitFor(async () => (await rows('staged')) === '');

      /* ---- commit ---- */
      await setMsg('');
      check('commit disabled: nothing staged, no message', await commitDisabled());
      await rowAct('unstaged', 'b.txt', 'stage');   // may not exist (b.txt is unstaged again after unstage-all)
      await waitFor(async () => /b\.txt/.test(await rows('staged')));
      check('commit disabled: staged but no message', await commitDisabled());
      await act('unstage-all'); await waitFor(async () => (await rows('staged')) === '');
      await setMsg('only a message');
      check('commit disabled: message but nothing staged', await commitDisabled());
      await rowAct('unstaged', 'b.txt', 'stage');
      await waitFor(async () => /b\.txt/.test(await rows('staged')));
      check('commit enabled: staged + message', (await commitDisabled()) === false);
      check('amend is off by default', (await js(`document.querySelector('${P} [data-opt="amend"]').checked`)) === false);
      await setMsg('Change b.txt\n\nwith a body line');
      await act('commit');
      check('commit lands in git with the right message', await waitFor(() => G(ws, 'log', '-1', '--format=%B') === 'Change b.txt\n\nwith a body line'));
      check('history list shows the new commit', await waitFor(async () => /Change b\.txt/.test(await text(P + ' .gHistory .gCommit'))));
      check('message box cleared after commit', (await js(`document.querySelector('${P} .gMsg').value`)) === '');
      // stage all and commit
      await js(`document.querySelector('${P} [data-opt="stage-all"]').click()`);
      check('button label switches to "Stage all and commit"', /Stage all and commit/.test(await text(P + ' [data-act="commit"]')));
      await setMsg('Everything else');
      await waitFor(async () => (await commitDisabled()) === false);
      await act('commit');
      check('stage-all-and-commit commits everything', await waitFor(() => G(ws, 'log', '-1', '--format=%s') === 'Everything else' && G(ws, 'status', '--porcelain') === ''));
      await js(`document.querySelector('${P} [data-opt="stage-all"]').click()`);
      // amend
      await js(`document.querySelector('${P} [data-opt="amend"]').click()`);
      check('amend loads the previous message', await waitFor(async () => (await js(`document.querySelector('${P} .gMsg').value`)) === 'Everything else'));
      await setMsg('Everything else (amended)');
      await act('commit');
      check('amend rewrites the last commit', await waitFor(() => G(ws, 'log', '-1', '--format=%s') === 'Everything else (amended)' && G(ws, 'rev-list', '--count', 'HEAD') === '3'));
      check('c.txt deletion was committed', !fs.existsSync(path.join(ws, 'c.txt')) && G(ws, 'ls-files', 'c.txt') === '');

      /* ---- diff rendering ---- */
      fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nBETA changed\ngamma\n');
      fs.writeFileSync(path.join(ws, 'added.txt'), 'brand\nnew\n');
      fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([9, 8, 7, 0, 0, 1, 2]));
      fs.writeFileSync(path.join(ws, 'crlf.txt'), 'one\r\nTWO\r\nthree\r\n');
      fs.rmSync(path.join(ws, 'b.txt'));
      fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 30000 }, (_, i) => 'line number ' + i + ' of a very large file').join('\n') + '\n');
      await act('refresh');
      await waitFor(async () => /added\.txt/.test(await rows('untracked')));
      let d = await openDiff('unstaged', 'a.txt');
      check('diff: modified file has + and - lines', d.add === 1 && d.del === 1 && /BETA changed/.test(d.txt), JSON.stringify([d.add, d.del]));
      d = await openDiff('untracked', 'added.txt');
      check('diff: added (untracked) file is all additions', d.add === 2 && d.del === 0 && /brand/.test(d.txt));
      d = await openDiff('unstaged', 'b.txt');
      check('diff: deleted file is all removals', d.add === 0 && d.del === 2 && /buzz/.test(d.txt));
      d = await openDiff('unstaged', 'bin.dat');
      check('diff: binary file is flagged, no text lines', /binary/.test(d.chips) && /Binary file/.test(d.note) && d.add === 0, d.chips);
      d = await openDiff('unstaged', 'crlf.txt');
      check('diff: CRLF file shows clean text and a CRLF note', /CRLF/.test(d.chips) && !d.txt.includes('\r') && d.add === 1 && d.del === 1 && /TWO/.test(d.txt), d.chips);
      d = await openDiff('unstaged', 'big.txt');
      check('diff: huge diff is truncated with a note', /truncated/.test(d.chips) && /very large/.test(d.note), d.chips);
      await rowAct('unstaged', 'a.txt', 'stage');
      await waitFor(async () => /a\.txt/.test(await rows('staged')));
      d = await openDiff('staged', 'a.txt');
      check('diff: staged view', d.add === 1 && d.del === 1);
      // commit view
      await js(`document.querySelector('${P} .gHistory .gCommit').click()`);
      check('commit view lists files and a diff', await waitFor(async () => (await js(`document.querySelectorAll('.gcFile').length`)) >= 2 && (await js(`document.querySelectorAll('.gdModal .gdl').length`)) > 0));
      await js(`document.querySelector('.gcFile[data-path]').click()`);
      check('commit view: clicking a file shows its diff', await waitFor(async () => (await js(`document.querySelectorAll('.gdModal .gdl.add, .gdModal .gdl.del').length`)) > 0));
      await closeModal();
      // restore a clean tree
      G(ws, 'reset', '-q', '--hard'); G(ws, 'clean', '-fdq');
      await act('refresh');
      await waitFor(async () => /clean/.test(await head()));

      /* ---- branches ---- */
      await setSec('branches', true);
      check('branches section lists main as current', await waitFor(async () => /main/.test(await text(P + ' .gBranch.cur'))));
      await js(`(() => { const i = document.querySelector('${P} [data-field="new-branch"]'); i.value = 'feature'; })()`);
      await act('branch-create');
      check('create branch switches to it', await waitFor(() => branchNow(ws) === 'feature'));
      check('header shows new branch', await waitFor(async () => /feature/.test(await head())));
      fs.writeFileSync(path.join(ws, 'a.txt'), 'feature version\n'); G(ws, 'commit', '-q', '-am', 'feature work');
      await js(`document.querySelector('${P} .gBranch[data-branch="main"] [data-act="switch"]').click()`);
      check('switch branch from the list', await waitFor(() => branchNow(ws) === 'main'));
      fs.writeFileSync(path.join(ws, 'a.txt'), 'dirty local edit\n');
      await waitFor(async () => /a\.txt/.test(await rows('unstaged')));
      await js(`document.querySelector('${P} .gBranch[data-branch="feature"] [data-act="switch"]').click()`);
      check('dirty tree: switch is refused with a clear message', await waitFor(async () => /overwritten/.test(await text(P + ' .gOut'))), await text(P + ' .gOut'));
      check('dirty tree: still on main and edit intact', branchNow(ws) === 'main' && fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'dirty local edit\n');

      /* ---- stash ---- */
      await setSec('stash', true);
      await js(`document.querySelector('${P} [data-field="stash-msg"]').value = 'wip edit'`);
      await act('stash-push');
      check('stash saves changes and cleans the tree', await waitFor(() => G(ws, 'status', '--porcelain') === '' && /wip edit/.test(G(ws, 'stash', 'list'))));
      check('stash list shows the entry', await waitFor(async () => /wip edit/.test(await text(P + ' .gStashes'))));
      await act('stash-pop');
      check('stash pop restores the edit', await waitFor(() => fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'dirty local edit\n' && G(ws, 'stash', 'list') === ''));
      check('stash list is empty again', await waitFor(async () => /No stashes/.test(await text(P + ' .gStashes'))));
      G(ws, 'checkout', '--', 'a.txt');
      await act('refresh');

      /* ---- LIVE: changes made outside the app ---- */
      await setSec('history', true);
      fs.writeFileSync(path.join(ws, 'live.txt'), 'made outside\n');
      check('live: new untracked file appears without clicking', await waitFor(async () => /live\.txt/.test(await rows('untracked')), 6000));
      G(ws, 'add', 'live.txt');
      check('live: external git add shows as staged', await waitFor(async () => /live\.txt/.test(await rows('staged')), 6000));
      G(ws, 'commit', '-q', '-m', 'outside commit');
      check('live: external commit shows in history without clicking', await waitFor(async () => /outside commit/.test(await text(P + ' .gHistory .gCommit')), 6000));
      check('live: staged list emptied', await waitFor(async () => (await rows('staged')) === ''));
      G(ws, 'checkout', '-q', '-b', 'ext-branch');
      check('live: external branch switch updates the header', await waitFor(async () => /ext-branch/.test(await head()), 6000));
      G(ws, 'checkout', '-q', 'main');
      check('live: and back', await waitFor(async () => /main/.test(await head()) && !/ext-branch/.test(await head()), 6000));

      /* ---- push / fetch / pull ---- */
      await act('push');
      check('push asks for confirmation first', await waitFor(async () => /Push/.test(await modalText()) && /network/.test(await modalText())));
      await modalBtn('Cancel');
      await sleep(500);
      check('cancelled push ran nothing', (await js(`document.querySelector('${P} .gOut').hidden`)) === true);
      await act('push');
      await waitFor(async () => /network/.test(await modalText()));
      await modalBtn('Push');
      check('push without a remote fails gracefully', await waitFor(async () => /No remote repository is configured/.test(await text(P + ' .gOut'))), await text(P + ' .gOut'));
      const bare = path.join(base, 'remote.git');
      G(base, 'init', '-q', '--bare', '-b', 'main', bare);
      G(ws, 'remote', 'add', 'origin', bare);
      await act('refresh');
      await act('push');
      check('push without upstream offers to set it', await waitFor(async () => /upstream/.test(await modalText())));
      await modalBtn('Push');
      check('push to a local bare remote works', await waitFor(() => G(bare, 'rev-parse', 'main') === G(ws, 'rev-parse', 'main')));
      check('after push: upstream tracked, 0 ahead', await waitFor(async () => /\u21910 \u21930/.test(await head()), 6000), await head());
      fs.writeFileSync(path.join(ws, 'more.txt'), 'more\n'); G(ws, 'add', '-A'); G(ws, 'commit', '-q', '-m', 'more work');
      check('ahead count shows 1', await waitFor(async () => /\u21911/.test(await head()), 6000), await head());
      await act('push'); await waitFor(async () => /network/.test(await modalText())); await modalBtn('Push');
      check('second push sends the commit', await waitFor(() => G(bare, 'rev-parse', 'main') === G(ws, 'rev-parse', 'main')));
      await act('fetch');
      check('fetch shows output', await waitFor(async () => /git fetch: done/.test(await text(P + ' .gOutTitle'))));
      await act('pull');
      check('pull runs and reports', await waitFor(async () => /git pull: done/.test(await text(P + ' .gOutTitle'))), await text(P + ' .gOut'));
      const unconfirmed = await js(`window.api.call('feat:git:push', {})`);
      check('main refuses an unconfirmed push', unconfirmed.ok === false && /not confirmed/.test(unconfirmed.error));

      /* ---- slash commands + menu ---- */
      await js(`Faber.showSideTab('files')`);
      await js(`runCommand('/git')`);
      check('/git opens the Git tab', await js(`!document.getElementById('pane-git').hidden`));
      fs.writeFileSync(path.join(ws, 'slash.txt'), 'x\n'); G(ws, 'add', 'slash.txt');
      await waitFor(async () => /slash\.txt/.test(await rows('staged')));
      await js(`runCommand('/commit slash commit')`);
      check('/commit asks first', await waitFor(async () => /slash\.txt/.test(await modalText())), await modalText());
      print('DEBUG commit', JSON.stringify(await js(`({ cards: document.querySelectorAll('.modalCard').length, chat: [...document.querySelectorAll('#chat .msg')].slice(-3).map((m) => m.textContent), staged: document.querySelectorAll('.gFile').length })`)), G(ws, 'status', '--porcelain'));
      await modalBtn('Commit');
      check('/commit commits the staged files', await waitFor(() => G(ws, 'log', '-1', '--format=%s') === 'slash commit'));
      fs.writeFileSync(path.join(ws, 'a.txt'), 'slash diff\n');
      await js(`runCommand('/diff a.txt')`);
      check('/diff <file> opens a diff', await waitFor(async () => (await js(`document.querySelectorAll('.gdModal .gdl.add').length`)) >= 1));
      await closeModal();
      await js(`runCommand('/diff')`);
      check('/diff opens all changes', await waitFor(async () => /slash diff/.test((await diffInfo()).txt)));
      await closeModal();
      G(ws, 'checkout', '--', 'a.txt');
      await js(`runCommand('/branch')`);
      check('/branch lists branches', await waitFor(() => js(`[...document.querySelectorAll('#chat .msg')].some((m) => /\\* main/.test(m.textContent))`)));
      await js(`runCommand('/branch newbr')`);
      await waitFor(async () => /Create branch/.test(await modalText()));
      await modalBtn('Create');
      check('/branch <new> creates and switches (after asking)', await waitFor(() => branchNow(ws) === 'newbr'));
      await js(`runCommand('/branch main')`);
      check('/branch <existing> switches', await waitFor(() => branchNow(ws) === 'main'));
      const gm = await js(`Faber.menus().get('Git').map((i) => i.label)`);
      check('menu bar has a Git menu with the expected items', ['Open Git Panel', 'Refresh', 'Commit...', 'Diff Current File', 'Branches', 'Fetch (online)', 'Pull (online)', 'Push (online)'].every((l) => gm.includes(l)), gm.join('|'));
      await js(`Faber.showSideTab('files'); Faber.menus().get('Git').find((i) => i.id === 'git.open').action()`);
      check('menu: Open Git Panel works', await js(`!document.getElementById('pane-git').hidden`));
      const sub = await js(`Faber.menus().get('Git').find((i) => i.id === 'git.branches').submenu().map((i) => i.label)`);
      check('menu: Branches submenu lists branches', sub.includes('main'), sub.join('|'));
      check('settings window section registered', await js(`Faber.settingsSections().some((s) => s.id === 'git')`));

      /* ---- AI helper (fake Ollama) ---- */
      fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nsuggested change\n'); G(ws, 'add', 'a.txt');
      await waitFor(async () => /a\.txt/.test(await rows('staged')));
      await setMsg('');
      await act('suggest');
      check('suggest fills the message box (cleaned to one line)', await waitFor(async () => (await js(`document.querySelector('${P} .gMsg').value`)) === 'Update a.txt contents.'), await js(`document.querySelector('${P} .gMsg').value`));
      check('suggestion is labelled as a suggestion', /Suggestion/.test(await text(P + ' .gHint')));
      const rq = ollama.requests[ollama.requests.length - 1] || {};
      check('request: no thinking, non-streaming, small num_predict', rq.think === false && rq.stream === false && rq.options && rq.options.num_predict <= 100, JSON.stringify(rq.options));
      check('request contains the staged diff', JSON.stringify(rq.messages).includes('suggested change') && JSON.stringify(rq.messages).includes('a.txt'));
      check('main refuses suggest with nothing staged', await (async () => { G(ws, 'reset', '-q'); const r = await js(`window.api.call('feat:git:suggest')`); return r.ok === false && /Nothing is staged/.test(r.error); })());

      /* ---- AI tools ---- */
      G(ws, 'add', 'a.txt');
      fs.writeFileSync(path.join(ws, 'unst.txt'), 'u\n'); G(ws, 'add', 'unst.txt'); fs.writeFileSync(path.join(ws, 'unst.txt'), 'u2\n');
      const ts = await tools.execute('git_status', {}, {});
      check('git_status tool: branch, staged, unstaged', /Branch: main/.test(ts) && /Staged \(\d+\)/.test(ts) && /a\.txt/.test(ts) && /Unstaged/.test(ts) && /Recent commits/.test(ts), ts.slice(0, 200));
      const td = await tools.execute('git_diff', { path: 'unst.txt' }, {});
      check('git_diff tool: path diff', /\+u2/.test(td), td.slice(0, 100));
      const tds = await tools.execute('git_diff', { staged: true }, {});
      check('git_diff tool: staged diff', /suggested change/.test(tds));
      check('git_diff tool: path outside repo is refused', await tools.execute('git_diff', { path: '..\\..\\x' }, {}).then(() => false, (e) => /outside/.test(e.message)));
      check('no commit/push AI tools exist', !tools.schemas.some((s) => /commit|push/.test(s.function.name) && /^git_/.test(s.function.name)) && tools.schemas.filter((s) => /^git_/.test(s.function.name)).length === 2);
      G(ws, 'reset', '-q', '--hard'); G(ws, 'clean', '-fdq');

      /* ---- git missing ---- */
      const oldPath = process.env.PATH;
      process.env.PATH = '';
      await sleep(4300);
      await act('refresh');
      check('git not installed: friendly message', await waitFor(async () => /not installed/.test(await text(P + ' .gNotice')), 6000), await text(P + ' .gNotice'));
      process.env.PATH = oldPath;
      await sleep(4300);
      await act('retry');
      check('git back: panel recovers', await waitFor(async () => /main/.test(await head()) && (await js(`!document.querySelector('${P} .gSections').hidden`))));

      /* ---- Ollama down ---- */
      G(ws, 'checkout', '-q', '-b', 'tmp-x'); G(ws, 'checkout', '-q', 'main'); G(ws, 'branch', '-q', '-D', 'tmp-x');
      fs.writeFileSync(path.join(ws, 'a.txt'), 'down\n'); G(ws, 'add', 'a.txt');
      await waitFor(async () => /a\.txt/.test(await rows('staged')));
      ollama.server.close(); if (ollama.server.closeAllConnections) ollama.server.closeAllConnections();
      await setMsg('');
      await act('suggest');
      check('Ollama down: friendly error, no crash', await waitFor(async () => /Cannot reach Ollama/.test(await text(P + ' .gOut'))), await text(P + ' .gOut'));
      G(ws, 'reset', '-q', '--hard');

      /* ---- GitHub (mock server) ---- */
      G(ws, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
      await act('refresh');
      const before = mock.requests.length;
      await setSec('github', true);
      check('GitHub off until connected: connect form, zero requests', await waitFor(async () => (await js(`!!document.querySelector('${P} [data-act="gh-connect"]')`)) && mock.requests.length === before && !fetched.some((u) => /github\.com/.test(u))));
      check('GitHub section is labelled online', /online/i.test(await text(P + ' [data-sec="github"] .gSecTitle')));
      const connect = async (tok) => { await js(`(() => { document.querySelector('${P} [data-field="gh-token"]').value = ${JSON.stringify(tok)}; document.querySelector('${P} [data-field="gh-url"]').value = 'http://127.0.0.1:${gPort}'; })()`); await act('gh-connect'); };
      await connect('ghp_WRONGtoken0123456789');
      check('bad token: friendly 401 message, nothing stored', await waitFor(async () => /401/.test(await text(P + ' .ghConnect'))) && !/"tokenEnc": "[^"]/.test(settingsRaw()));
      check('wrong token is not stored either', !settingsRaw().includes('WRONGtoken'));
      // safeStorage unavailable -> refuse
      let skippedSecure = false;
      const origAvail = safeStorage.isEncryptionAvailable;
      try { safeStorage.isEncryptionAvailable = () => false; } catch { skippedSecure = true; }
      if (!skippedSecure && safeStorage.isEncryptionAvailable() === false) {
        const r = await js(`window.api.call('feat:git:ghConnect', { token: ${JSON.stringify(TOKEN)}, baseUrl: 'http://127.0.0.1:${gPort}' })`);
        check('no secure storage: refuses to store the token', r.ok === false && /Secure storage/.test(r.error) && !settingsRaw().includes(TOKEN));
        safeStorage.isEncryptionAvailable = origAvail;
      } else print('SKIP no-secure-storage refusal (could not stub safeStorage)');
      check('safeStorage works on this machine', safeStorage.isEncryptionAvailable() === true);
      await connect(TOKEN);
      check('connect succeeds with the good token', await waitFor(async () => /Connected as @octo/.test(await text(P + ' .ghConnect'))));
      const cfg = JSON.parse(settingsRaw()).features.git;
      check('token stored encrypted (not plain text)', !!cfg.tokenEnc && !settingsRaw().includes(TOKEN) && safeStorage.decryptString(Buffer.from(cfg.tokenEnc, 'base64')) === TOKEN);
      check('requests carry the Authorization header, never the token in a URL', mock.requests.length > 0 && mock.requests.filter((r) => r.auth === 'Bearer ' + TOKEN).length > 5 && mock.requests.every((r) => !r.url.includes('ghp_')));
      check('repo detected from ssh remote and info shown', await waitFor(async () => /acme\/widgets/.test(await text(P + ' .ghRepo')) && /42 stars/.test(await text(P + ' .ghStats')) && /Mock widgets/.test(await text(P + ' .ghDesc'))));
      check('recent commits shown', await waitFor(async () => /First mock commit/.test(await text(P + ' .ghCommit'))));
      check('pull request with check status shown', await waitFor(async () => /Add widget/.test(await text(P + ' .ghPull')) && /checks: passing/.test(await text(P + ' .ghPull'))));
      check('Actions run shown', await waitFor(async () => /CI build/.test(await text(P + ' .ghRun')) && /failure/.test(await text(P + ' .ghRun'))));
      check('rate limit remaining shown', await waitFor(async () => /4990\/5000/.test(await text(P + ' .ghBar'))));
      // live polling
      const renders = () => js(`+document.querySelector('${P} .ghData').dataset.renders`);
      await js(`FaberGit.setPollMs(1500)`);
      await js(`document.querySelector('${P} [data-act="gh-live"]').click()`);
      print('DEBUG live', JSON.stringify(await js(`({ st: FaberGit.state().ghStatus, vis: !document.getElementById('pane-git').hidden, hid: document.hidden, open: !document.querySelector('${P} [data-sec="github"] .gSecBody').hidden })`)));
      const r0 = await renders(), n0 = mock.n304, req0 = mock.requests.length;
      await sleep(5200);
      const polled = mock.requests.slice(req0);
      check('live: polls automatically', polled.length >= 3, 'requests=' + polled.length);
      check('live: polls send If-None-Match and get 304', polled.some((r) => r.inm) && mock.n304 > n0, 'n304=' + (mock.n304 - n0));
      check('live: unchanged (304) polls do not re-render', (await renders()) === r0, r0 + ' -> ' + (await renders()));
      mock.commits = [{ sha: 'c'.repeat(40), msg: 'Second mock commit' }, ...mock.commits]; mock.etag = '"c2"';
      check('live: a new commit on GitHub appears and re-renders', await waitFor(async () => /Second mock commit/.test(await text(P + ' .ghCommit')), 6000) && (await renders()) > r0);
      // opening links
      await js(`document.querySelector('${P} .ghPull').click()`);
      check('clicking a PR opens it in the system browser (https)', await waitFor(() => opened.includes('https://github.com/acme/widgets/pull/7')), opened.join(','));
      const bad = [];
      for (const u of ['http://example.com/x', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'https://user:pw@example.com/']) bad.push((await js(`window.api.call('feat:git:openUrl', ${JSON.stringify(u)})`)).ok);
      check('non-https / credentialed links are refused', bad.every((x) => x === false) && opened.length === 1, JSON.stringify(bad));
      // token revoked
      mock.revoke = true;
      check('401 later: friendly message and polling stops', await waitFor(async () => /rejected the token/.test(await text(P + ' .ghData')) || /rejected the token/.test(await text(P + ' .ghConnect')), 6000));
      const reqRev = mock.requests.length;
      await sleep(3500);
      check('no more requests after the token was rejected', mock.requests.length === reqRev, mock.requests.length + ' vs ' + reqRev);
      await act('gh-disconnect');
      check('disconnect forgets the token', await waitFor(() => { const g = JSON.parse(settingsRaw()).features.git; return !g.tokenEnc; }) && await waitFor(async () => (await js(`!!document.querySelector('${P} [data-act="gh-connect"]')`))));
      mock.revoke = false;
      await connect(TOKEN);
      await waitFor(async () => /Connected as/.test(await text(P + ' .ghConnect')));
      await waitFor(async () => /First mock commit/.test(await text(P + ' .ghCommit')));
      mock.rate = true;
      await act('gh-refresh');
      check('rate limit 403: friendly message, data kept', await waitFor(async () => /rate limit reached/i.test(await text(P + ' .ghData'))) && /mock commit/.test(await text(P + ' .ghCommit')), await text(P + ' .ghData'));
      const reqRate = mock.requests.length;
      await act('gh-refresh'); await sleep(1500);
      check('rate limited: Faber pauses and sends nothing more', mock.requests.length === reqRate);
      mock.rate = false;
      await act('gh-disconnect');
      await waitFor(async () => (await js(`!!document.querySelector('${P} [data-act="gh-connect"]')`)));
      const reqEnd = mock.requests.length;
      await js(`FaberGit.ghPoll()`); await sleep(1800);
      check('after disconnect: nothing is sent, token gone', mock.requests.length === reqEnd && !JSON.parse(settingsRaw()).features.git.tokenEnc);
      const dom = await js(`document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' ')`);
      check('token never in settings.json, logs, console or page', !settingsRaw().includes(TOKEN) && !captured.join('').includes(TOKEN) && !consoleMsgs.join('\n').includes(TOKEN) && !dom.includes(TOKEN));
      check('never called the real api.github.com', !fetched.some((u) => /api\.github\.com/.test(u)));

      /* ---- settings window section + close folder ---- */
      const sect = await js(`(() => { const d = document.createElement('div'); Faber.settingsSections().find((s) => s.id === 'git').render(d); return d.innerText; })()`);
      check('settings section renders GitHub (online) info', /GitHub \(online/.test(sect) && /offline/.test(sect), sect.slice(0, 80));
      await js(`closeFolder()`);
      check('closing the folder shows the no-folder state again', await waitFor(async () => /No folder is open/.test(await text(P + ' .gNotice'))));
      const errs = consoleMsgs.filter((m) => /Uncaught|TypeError|ReferenceError/.test(m));
      check('no renderer errors', errs.length === 0, errs.join(' | ').slice(0, 300));
    } catch (e) { print('SMOKE ERROR', e.stack || e.message); }
    print('DONE');
    try { mock.server.close(); } catch { /* closed */ }
    app.exit(0);
  });
})();
