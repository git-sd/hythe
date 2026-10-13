// Plain-node unit/integration tests for the remote feature libraries (no Electron needed).
// Run: node tests/remote-unit.js    Writes PASS/FAIL lines to stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const lib = (n) => require(path.join(root, 'src', 'remote', n));
const { startFake } = require('./remote-fake-ollama');
const S = lib('sshcmd');
const { normalizeUrl, classify, testServer } = lib('net');
const { createProxy } = lib('proxy');
const { buildNotebook } = lib('notebook');
const { scanFolder, createTarStream, TarReader } = lib('tar');
const R = lib('sshrun');

let fails = 0;
const check = (name, ok, extra) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_SH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\sh.exe' : '/bin/sh';
const GIT_TAR = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\tar.exe' : '/nonexistent-gnu-tar';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-remote-unit-'));

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { headers }, (res) => {
      const chunks = []; const t0 = Date.now();
      res.on('data', (c) => chunks.push({ t: Date.now() - t0, s: c.toString() }));
      res.on('end', () => resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join('') }));
      res.on('error', (e) => resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join(''), err: e.message }));
      res.on('close', () => { if (!res.complete) resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join(''), err: 'aborted' }); });
    });
    r.on('error', reject); r.end();
  });
}
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = []; const t0 = Date.now();
      res.on('data', (c) => chunks.push({ t: Date.now() - t0, s: c.toString() }));
      res.on('end', () => resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join('') }));
      res.on('error', (e) => resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join(''), err: e.message }));
      res.on('close', () => { if (!res.complete) resolve({ status: res.statusCode, chunks, body: chunks.map((c) => c.s).join(''), err: 'aborted' }); });
    });
    r.on('error', reject); r.end(body);
  });
}

async function main() {
  /* ---------- URL handling ---------- */
  check('normalizeUrl strips /api and slashes', normalizeUrl(' https://a-b.trycloudflare.com/api/tags/ ') === 'https://a-b.trycloudflare.com');
  check('normalizeUrl finds URL in pasted blob', normalizeUrl('FABER_URL=https://x.ngrok.app\nFABER_TOKEN=abc') === 'https://x.ngrok.app');
  check('normalizeUrl bare LAN host gets http', normalizeUrl('192.168.1.5:11434') === 'http://192.168.1.5:11434');
  check('normalizeUrl bare public host gets https', normalizeUrl('gpu.example.com') === 'https://gpu.example.com');
  let e1 = ''; try { normalizeUrl('https://user:pw@host.com'); } catch (e) { e1 = e.message; }
  check('credentials in URL refused', /user name or password/.test(e1));
  let e2 = ''; try { normalizeUrl('ftp://host.com'); } catch (e) { e2 = e.message; }
  check('non-http scheme refused', /http/.test(e2));
  check('classify scopes', classify('http://127.0.0.1:1').scope === 'loopback' && classify('http://192.168.0.2').scope === 'private' && classify('http://100.100.1.1').scope === 'private' && classify('https://a.trycloudflare.com').scope === 'public' && classify('http://8.8.8.8').scope === 'public');

  /* ---------- quoting: round trip through a real POSIX shell ---------- */
  const nasty = [
    "plain", "with space", "it's", `a"b`, 'a;b&c|d', '$HOME `id` $(id)', 'ünï✓ 日本語', "'; rm -rf / #", 'back\\slash', '*?[x]', 'tab\there', '--option', '', "multi\nline",
  ];
  if (fs.existsSync(GIT_SH)) {
    let ok = true, bad = '';
    for (const s of nasty) {
      const r = spawnSync(GIT_SH, ['-c', 'printf %s ' + S.quote(s)], { encoding: 'utf8' });
      if (r.stdout !== s) { ok = false; bad += JSON.stringify(s) + '=>' + JSON.stringify(r.stdout) + ' '; }
    }
    check('quote() round-trips nasty strings through sh', ok, bad);
    // the whole remote command: what login shell -c receives must be exactly the user command
    let ok2 = true, bad2 = '';
    const home = path.join(tmp, 'rhome'); fs.mkdirSync(path.join(home, 'my dir', "it's"), { recursive: true });
    for (const cmd of ["echo \"a;b\" | grep 'x' & echo $HOME `id` 'q' ; ls", 'python train.py --name "O\'Brien" && echo $?', 'ünï ✓ ; & | $ ` " \' end']) {
      for (const dir of ['~/my dir/it\'s', '/tmp', '~']) {
        const full = S.runCommand(dir === '/tmp' ? home.replace(/\\/g, '/') : dir, cmd);
        const echoBin = 'C:/Program Files/Git/usr/bin/echo.exe';
        const r = spawnSync(GIT_SH, ['-c', full], { encoding: 'utf8', cwd: home, env: { ...process.env, HOME: home, SHELL: echoBin } });
        if (r.stdout !== '-c ' + cmd + '\n') { ok2 = false; bad2 += JSON.stringify(cmd) + ' in ' + dir + ' => ' + JSON.stringify(r.stdout + r.stderr) + ' | '; }
      }
    }
    check('runCommand(): login shell receives the exact user command, cwd handled incl. ~ and quotes', ok2, bad2);
  } else check('Git sh available for quoting round-trip', false, 'skipped: ' + GIT_SH + ' missing');
  check('psQuote safe + quoted', S.psQuote('a-b.c') === 'a-b.c' && S.psQuote("C:\\k m\\it's") === "'C:\\k m\\it''s'");

  /* ---------- ssh argument construction ---------- */
  const prof = S.validateProfile({ name: 'x', user: 'bob', host: 'h.example.com', port: 2222, keyFile: "C:\\Users\\O'Brien\\my key", remoteDir: '~/p' });
  const a = S.sshArgs(prof, { tty: 'force' });
  check('sshArgs: BatchMode, no StrictHostKeyChecking by default', a.includes('BatchMode=yes') && !a.some((x) => /StrictHostKeyChecking/.test(x)));
  check('sshArgs: key, port, -tt, -- before destination', a.includes('-i') && a[a.indexOf('-i') + 1] === prof.keyFile && a.includes('-p') && a.includes('2222') && a.includes('-tt') && a[a.length - 2] === '--' && a[a.length - 1] === 'bob@h.example.com');
  check('sshArgs: accept-new only when ticked, never "no"', S.sshArgs({ ...prof, acceptNew: true }).includes('StrictHostKeyChecking=accept-new') && !S.sshArgs({ ...prof, acceptNew: true }).some((x) => /=no$/.test(x) && /Strict/.test(x)));
  let bad = 0;
  for (const p of [{ user: '-oProxyCommand=x', host: 'h' }, { user: 'u', host: '-h' }, { user: 'u', host: 'a b' }, { user: 'u;x', host: 'h' }, { user: 'u', host: 'h', port: 70000 }, { user: 'u', host: 'h', remoteDir: 'relative/dir' }]) {
    try { S.validateProfile({ name: 'n', ...p }); } catch { bad++; }
  }
  check('validateProfile rejects option injection / junk', bad === 6, 'rejected=' + bad);
  check('terminalLine quoting', /^ssh -t .* -i 'C:\\Users\\O''Brien\\my key' -o IdentitiesOnly=yes -p 2222 -- bob@h\.example\.com 'cd ~\/''p'' 2>\/dev\/null; exec \$SHELL -l'$/.test(S.terminalLine(prof, '')), S.terminalLine(prof, ''));
  check('forwardArgs binds loopback only', S.forwardArgs(prof, 11436, 11434).includes('127.0.0.1:11436:127.0.0.1:11434') && S.forwardArgs(prof, 1, 2).includes('-N'));
  const cls = (s) => S.classifyError(s, 255).kind;
  check('classifyError kinds', cls('user@h: Permission denied (publickey).') === 'auth' && cls('Host key verification failed.') === 'hostkey' && cls('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!') === 'hostkey-changed' && cls('ssh: connect to host h port 22: Connection refused') === 'refused' && cls('ssh: Could not resolve hostname zz') === 'dns' && cls('Connection timed out') === 'timeout');

  /* ---------- tar writer vs real tar programs ---------- */
  const proj = path.join(tmp, "nasty dir $x ;& 'q' `bt` ünï✓");
  fs.mkdirSync(path.join(proj, 'sub dir', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '__pycache__'), { recursive: true });
  const longName = 'L'.repeat(120) + '.txt';
  const files = { 'a.txt': 'hello', 'sub dir/b it\'s.py': '#!/usr/bin/env python\nprint(1)\n', 'sub dir/deep/日本語 ✓.txt': 'unicode', [longName]: 'long', 'empty.bin': '', '.env': 'SECRET=1', 'key.pem': 'x', 'node_modules/pkg/i.js': 'x', '.git/HEAD': 'x', '__pycache__/m.pyc': 'x', ['sub dir/' + 'd'.repeat(90) + '/' + 'e'.repeat(90) + '.txt']: 'prefix-split' };
  fs.mkdirSync(path.join(proj, 'sub dir', 'd'.repeat(90)), { recursive: true });
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...k.split('/')), v);
  fs.writeFileSync(path.join(proj, 'big.bin'), Buffer.alloc(3 * 1048576));
  fs.writeFileSync(path.join(proj, 'fill.bin'), crypto_bytes(200000));
  const plan = scanFolder(proj, { maxFileMB: 2, maxTotalMB: 50 });
  const rels = plan.files.map((f) => f.rel).sort();
  check('scan excludes .git/node_modules/__pycache__', !rels.some((r) => /^(\.git|node_modules|__pycache__)/.test(r)) && plan.excludedDirs['.git'] === 1 && plan.excludedDirs.node_modules === 1);
  check('scan holds back secrets and large files', plan.skippedSecrets.length === 2 && plan.skippedLarge.length === 1 && plan.skippedLarge[0].rel === 'big.bin');
  check('scan counts files and bytes', plan.count === 7 && plan.bytes === plan.files.reduce((s, f) => s + f.size, 0), 'count=' + plan.count);
  const tarFile = path.join(tmp, 'out.tar');
  await new Promise((res, rej) => { const w = fs.createWriteStream(tarFile); createTarStream(proj, plan.files).pipe(w).on('finish', res).on('error', rej); });
  for (const [label, bin] of [['Windows bsdtar', 'tar'], ['GNU tar', GIT_TAR]]) {
    if (label === 'GNU tar' && !fs.existsSync(bin)) continue;
    const list = spawnSync(bin, ['-tf', 'out.tar'], { encoding: 'utf8', cwd: tmp });
    const names = list.stdout.split(/\r?\n/).filter(Boolean).map((x) => unesc(x.replace(/^\.\//, ''))).sort();
    const want = [...rels];
    check(`tar writer: ${label} lists exactly the planned files (incl. unicode, long, split names)`, JSON.stringify(names) === JSON.stringify(want), list.status ? 'status=' + list.status + ' ' + list.stderr.slice(0, 200) : (names.length + ' vs ' + want.length + ' diff: ' + JSON.stringify(names.filter((n) => !want.includes(n)).concat(want.filter((n) => !names.includes(n))))));
  }
  const ex = path.join(tmp, 'extract'); fs.mkdirSync(ex);
  const xr = spawnSync('tar', ['-xf', 'out.tar', '-C', 'extract'], { encoding: 'utf8', cwd: tmp });
  let same = xr.status === 0;
  for (const f of plan.files) { try { if (!fs.readFileSync(path.join(proj, ...f.rel.split('/'))).equals(fs.readFileSync(path.join(ex, ...f.rel.split('/'))))) same = false; } catch { same = false; } }
  check('tar writer: bsdtar extraction reproduces every file byte for byte', same, xr.stderr.slice(0, 200));
  const mode = fs.existsSync(GIT_TAR) ? spawnSync(GIT_TAR, ['-tvf', 'out.tar'], { encoding: 'utf8', cwd: tmp }).stdout : '';
  check('tar writer: #! scripts get exec bit, others do not', !mode || (/-rwxr-xr-x .* sub dir\/b it's\.py/.test(mode) && /-rw-r--r-- .* a\.txt/.test(mode)), '');

  /* ---------- tar reader on archives made by real tars ---------- */
  for (const [label, mk] of [
    ['bsdtar', () => spawnSync('tar', ['-cf', 'b.tar', '-C', path.relative(tmp, proj), 'a.txt', 'sub dir', longName, 'empty.bin'], { cwd: tmp }).status],
    ['GNU tar', () => (fs.existsSync(GIT_TAR) ? spawnSync(GIT_TAR, ['-cf', 'b.tar', '-C', proj.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1'), 'a.txt', 'sub dir', longName, 'empty.bin'], { cwd: tmp }).status : 'skip')],
  ]) {
    const st = mk(); if (st === 'skip') continue;
    const got = {};
    const rd = new TarReader((name, size) => { const parts = []; return { write: (b) => parts.push(Buffer.from(b)), end: () => { got[name.replace(/\/$/, '')] = Buffer.concat(parts); } }; });
    const data = fs.readFileSync(path.join(tmp, 'b.tar'));
    for (let i = 0; i < data.length; i += 777) rd.push(data.subarray(i, i + 777));   // awkward chunking
    const okAll = ['a.txt', 'sub dir/b it\'s.py', 'sub dir/deep/日本語 ✓.txt', longName, 'empty.bin', 'sub dir/' + 'd'.repeat(90) + '/' + 'e'.repeat(90) + '.txt'].every((n) => got[n] && got[n].equals(fs.readFileSync(path.join(proj, ...n.split('/')))));
    check(`tar reader: parses ${label} archive (unicode, long names, odd chunking)`, okAll, Object.keys(got).join('|').slice(0, 200));
    fs.rmSync(path.join(tmp, 'b.tar'), { force: true });
  }
  check('safeRel blocks traversal/odd names', ['../x', 'a/../b', '/abs', 'a\\b', 'C:x', 'con.txt', 'a/', 'dot.', ''].every((r) => !R.safeRel(r)) && R.safeRel('ok/ünï ✓/file.txt'));

  /* ---------- proxy ---------- */
  const fake = await startFake({ token: 'sekret-tok', chunks: 5, delayMs: 200 });
  const px = await createProxy({ target: fake.url, token: 'sekret-tok', label: 'Remote server "fake"' });
  const v = await get(px.url + '/api/version', { host: `127.0.0.1:${px.port}` });
  check('proxy: forwards GET and adds the bearer token', v.status === 200 && /fake/.test(v.body) && fake.state.authHeaders.at(-1) === 'Bearer sekret-tok');
  const sp = await post(px.url + '/api/chat', JSON.stringify({ model: 'x', stream: true }));
  const times = sp.chunks.map((c) => c.t);
  check('proxy: NDJSON arrives incrementally (not buffered)', sp.status === 200 && sp.chunks.length >= 5 && times.at(-1) - times[0] > 600 && times[1] - times[0] < 400, 'chunk times ms=' + times.join(','));
  check('proxy: body passes through intact', sp.body.split('\n').filter(Boolean).length === 6 && /tok1/.test(sp.body));
  const bd = await get(px.url + '/api/version', { host: 'evil.example:80' });
  check('proxy: wrong Host header refused (DNS rebinding)', bd.status === 403);
  const od = await get(px.url + '/api/version', { origin: 'https://evil.example' });
  check('proxy: browser Origin refused', od.status === 403);
  const sf = await get(px.url + '/api/version', { 'sec-fetch-site': 'cross-site' });
  check('proxy: Sec-Fetch-* refused', sf.status === 403);
  const nf = await get(px.url + '/etc/passwd');
  check('proxy: non-API path refused', nf.status === 404);
  const cl = await get(px.url + '/api/version', { authorization: 'Bearer attacker-supplied' });
  check('proxy: client Authorization header is replaced, not forwarded', fake.state.authHeaders.at(-1) === 'Bearer sekret-tok');
  // stopping the client aborts the remote work
  await new Promise((resolve) => { const r = http.request(px.url + '/api/chat', { method: 'POST' }, (res) => { res.once('data', () => { r.destroy(); setTimeout(resolve, 600); }); }); r.on('error', () => {}); r.end('{}'); });
  check('proxy: client disconnect closes the upstream request', fake.state.closedEarly === true);
  await px.close();
  const px2 = await createProxy({ target: fake.url, token: 'WRONG', label: 'Remote server "fake"' });
  const bad401 = await post(px2.url + '/api/chat', '{}');
  check('proxy: wrong token gives a clear 401 message', bad401.status === 401 && /rejected the access token/.test(bad401.body) && !/WRONG/.test(bad401.body), bad401.body);
  const px3 = await createProxy({ target: fake.url, token: '', label: 'Remote server "fake"' });
  const no401 = await get(px3.url + '/api/tags');
  check('proxy: missing token gives a clear message', no401.status === 401 && /requires an access token/.test(no401.body));
  const tst = await testServer(fake.url, 'WRONG');
  const tst2 = await testServer(fake.url, 'sekret-tok');
  check('testServer: wrong token -> authRequired + clear text', !tst.ok && tst.authRequired && /rejected the access token/.test(tst.error));
  check('testServer: ok -> version, models, latency', tst2.ok && tst2.version === '0.0.0-fake' && tst2.models.length === 2 && tst2.latencyMs >= 0);
  await px2.close(); await px3.close();
  // mid-stream drop and killed server
  const px4 = await createProxy({ target: fake.url, token: 'sekret-tok', label: 'Remote server "fake"' });
  const events = [];
  px4.close = ((c) => c)(px4.close);
  const dropper = await createProxy({ target: fake.url, token: 'sekret-tok', label: 'Remote server "fake"', onEvent: (e) => events.push(e) });
  const pr = post(dropper.url + '/api/chat', '{}').catch((e) => ({ err: e.message }));
  await sleep(450);
  await fake.close();
  const dropped = await pr;
  check('proxy: server dying mid-stream surfaces an error (connection torn down)', dropped.err || (dropped.chunks && dropped.chunks.length < 6), JSON.stringify(dropped.err || dropped.chunks.length));
  const down = await get(dropper.url + '/api/version');
  check('proxy: killed server -> clear "connection refused" message', down.status === 502 && /Remote server "fake" is unreachable: connection refused/.test(JSON.parse(down.body).error), down.body);
  const tdown = await testServer(fake.url, '');
  check('testServer: killed server -> clear error', !tdown.ok && /connection refused/.test(tdown.error), tdown.error);
  await dropper.close(); await px4.close();

  /* ---------- notebook ---------- */
  const nb = buildNotebook({ model: 'qwen2.5-coder:7b', tunnel: 'cloudflared', requireToken: true });
  const json = JSON.stringify(nb);
  const parsed = JSON.parse(json);
  const ids = parsed.cells.map((c) => c.id);
  const wellFormed = parsed.nbformat === 4 && parsed.nbformat_minor === 5 && typeof parsed.metadata === 'object' && Array.isArray(parsed.cells) && parsed.cells.every((c) =>
    (c.cell_type === 'code' ? c.execution_count === null && Array.isArray(c.outputs) : c.cell_type === 'markdown') && c.metadata && typeof c.metadata === 'object' &&
    Array.isArray(c.source) && c.source.every((l) => typeof l === 'string') && /^[A-Za-z0-9_-]{1,64}$/.test(c.id)) && new Set(ids).size === ids.length;
  check('notebook: nbformat 4.5 structure, unique cell ids, cells well-formed', wellFormed);
  check('notebook: no secret baked in (token generated at run time, API_TOKEN empty, no ngrok token)', json.includes('API_TOKEN = \\"\\"') && /secrets\.token_urlsafe/.test(json) && !/authtoken\s*=\s*["'][^"']+/.test(json) && !/FABER_TOKEN=[A-Za-z0-9_-]{8,}/.test(json));
  check('notebook: has install, pull, serve, tunnel, URL print, keep-alive cells', ['install.sh', 'Popen([\\"ollama\\", \\"serve\\"]', 'ollama pull', 'trycloudflare', 'FABER_URL=', 'time.sleep(30)'].every((k) => json.includes(k)));
  check('notebook: ngrok variant asks for the token at run time', /getpass/.test(JSON.stringify(buildNotebook({ model: 'a:b', tunnel: 'ngrok' }))));
  let em = ''; try { buildNotebook({ model: 'x"; import os #' }); } catch (e) { em = e.message; }
  check('notebook: hostile model name refused', /model name/.test(em));
  fs.writeFileSync(path.join(tmp, 'nb.ipynb'), json);
  const py2 = spawnSync('python', ['-I', '-c', 'import sys,ast,json\nnb=json.load(open(sys.argv[1]))\nfor i,c in enumerate(nb["cells"]):\n  if c["cell_type"]=="code": ast.parse("".join(c["source"]))\nprint("PYOK")', path.join(tmp, 'nb.ipynb')], { encoding: 'utf8' });
  check('notebook: every code cell is valid Python (ast.parse)', /PYOK/.test(py2.stdout), py2.stderr.slice(0, 300));
  // run the notebook's own token gate against a fake Ollama
  const fake2 = await startFake({ chunks: 5, delayMs: 200 });
  const gatePort = 20000 + Math.floor(Math.random() * 20000);
  const harness = path.join(tmp, 'gate.py');
  fs.writeFileSync(harness, [
    'import json,sys,time',
    'nb=json.load(open(sys.argv[1]))',
    'code=[c for c in nb["cells"] if c["cell_type"]=="code"]',
    'g={}',
    'exec("".join(code[0]["source"]),g)',
    `g["OLLAMA_PORT"]=${fake2.port}; g["PROXY_PORT"]=${gatePort}; g["API_TOKEN"]="gate-test-token"`,
    'gate=[c for c in code if "class Gate" in "".join(c["source"])][0]',
    'exec("".join(gate["source"]),g)',
    'print("GATE UP",flush=True)',
    'time.sleep(25)',
  ].join('\n'));
  const gp = spawn('python', ['-I', harness, path.join(tmp, 'nb.ipynb')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let gout = ''; gp.stdout.on('data', (d) => { gout += d; }); gp.stderr.on('data', (d) => { gout += d; });
  for (let i = 0; i < 40 && !/GATE UP/.test(gout); i++) await sleep(250);
  const gu = `http://127.0.0.1:${gatePort}`;
  const g1 = await get(gu + '/api/version');
  const g2 = await get(gu + '/api/version', { authorization: 'Bearer wrong' });
  const g3 = await get(gu + '/api/version', { authorization: 'Bearer gate-test-token' });
  check('notebook gate (real Python): rejects missing/wrong token, accepts right one', g1.status === 401 && g2.status === 401 && g3.status === 200 && /fake/.test(g3.body), `${g1.status}/${g2.status}/${g3.status} ${gout.slice(0, 200)}`);
  const g4 = await post(gu + '/api/chat', '{"model":"x"}', { authorization: 'Bearer gate-test-token' });
  const t4 = g4.chunks.map((c) => c.t);
  check('notebook gate (real Python): streams NDJSON incrementally', g4.status === 200 && g4.chunks.length >= 5 && t4.at(-1) - t4[0] > 600 && /tok1/.test(g4.body), 'times=' + t4.join(','));
  check('notebook gate: token never forwarded to Ollama', !fake2.state.authHeaders.some((h) => /gate-test-token/.test(h)));
  // full chain: our proxy -> python gate (token) -> fake ollama
  const chain = await createProxy({ target: gu, token: 'gate-test-token', label: 'Remote server "gate"' });
  const c1 = await get(chain.url + '/api/tags');
  check('chain: Faber relay -> notebook gate -> Ollama works with the token', c1.status === 200 && /fake-model/.test(c1.body));
  await chain.close();
  try { gp.kill(); } catch { /* gone */ }
  await fake2.close();

  /* ---------- SSH flows against the fake ssh ---------- */
  const shim = path.join(__dirname, 'remote-fake-ssh.js');
  process.env.FABER_REMOTE_SSH = shim;
  const rhome = path.join(tmp, 'remote-home'); fs.mkdirSync(rhome);
  process.env.FAKE_REMOTE_HOME = rhome;
  process.env.FAKE_SSH_LOG = path.join(tmp, 'ssh.log');
  const logLines = () => (fs.existsSync(process.env.FAKE_SSH_LOG) ? fs.readFileSync(process.env.FAKE_SSH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const P = (host, extra = {}) => S.validateProfile({ name: host, user: 'bob', host, remoteDir: "~/proj dir/it's", keyFile: '', ...extra });
  const t1 = await R.testConnection(P('ok.test'));
  check('ssh test: success path', t1.ok === true, JSON.stringify(t1));
  const lastArgs = logLines().at(-1);
  check('ssh test: BatchMode + ConnectTimeout=8 + -- dest, command is one arg', lastArgs.opts.some(([, v]) => v === 'BatchMode=yes') && lastArgs.opts.some(([, v]) => v === 'ConnectTimeout=8') && lastArgs.dest === 'bob@ok.test' && /^echo faber-ok/.test(lastArgs.command));
  const tu = await R.testConnection(P('unreachable.test')); const td = await R.testConnection(P('denied.test')); const th = await R.testConnection(P('hostkey.test')); const tc = await R.testConnection(P('hostchanged.test'));
  check('ssh test: unreachable -> timeout message', !tu.ok && tu.kind === 'timeout', tu.error);
  check('ssh test: auth failure -> key/agent explanation, no password offer', !td.ok && td.kind === 'auth' && /ssh-add/.test(td.error));
  check('ssh test: host key unknown -> explained, mentions terminal / accept-new', !th.ok && th.kind === 'hostkey' && /Open SSH terminal/.test(th.error));
  check('ssh test: host key CHANGED -> refuses with warning', !tc.ok && tc.kind === 'hostkey-changed');
  process.env.FABER_REMOTE_SSH = path.join(tmp, 'nope.exe');
  const tm = await R.testConnection(P('ok.test'));
  check('ssh test: ssh missing -> install hint', !tm.ok && tm.kind === 'missing' && /OpenSSH/.test(tm.error), tm.error);
  process.env.FABER_REMOTE_SSH = shim;

  if (fs.existsSync(GIT_SH)) {
    const prof2 = P('ok.test');
    const up = await R.upload(prof2, "~/proj dir/it's", plan, {});
    const remoteProj = path.join(rhome, 'proj dir', "it's");
    const allThere = plan.files.every((f) => { try { return fs.readFileSync(path.join(remoteProj, ...f.rel.split('/'))).equals(fs.readFileSync(path.join(proj, ...f.rel.split('/')))); } catch { return false; } });
    check('upload: tar over ssh creates the remote dir (spaces + quote in name) and unpacks files', up.ok && allThere && fs.existsSync(path.join(remoteProj, S.STAMP)), up.error || '');
    check('upload: secrets / .git / node_modules never reached the remote', !fs.existsSync(path.join(remoteProj, '.env')) && !fs.existsSync(path.join(remoteProj, '.git')) && !fs.existsSync(path.join(remoteProj, 'node_modules')));
    const upBad = await R.upload(P('denied.test'), '~/x', plan, {});
    check('upload: auth failure reported, nothing hangs', !upBad.ok && upBad.kind === 'auth');
    // streaming run
    const chunksSeen = [];
    const t0 = Date.now();
    const rn = R.run(prof2, "~/proj dir/it's", 'for i in 1 2 3; do echo line$i; sleep 1; done; echo "a;b" \'q\' $HOME | wc -c; exit 7', { onOutput: (t) => chunksSeen.push([Date.now() - t0, t]) });
    const rr = await rn.done;
    const outText = chunksSeen.map((c) => c[1]).join('');
    check('run: output streamed live (first line arrives well before the end)', chunksSeen.length >= 3 && chunksSeen[0][0] < chunksSeen.at(-1)[0] - 1500 && /line1/.test(outText) && /line3/.test(outText), chunksSeen.map((c) => c[0]).join(','));
    check('run: remote exit code propagates, command ran in the project dir', rr.code === 7 && !rr.stopped);
    const rcwd = await new Promise((resolve) => { let s = ''; R.run(prof2, "~/proj dir/it's", 'pwd; ls a.txt', { onOutput: (t) => { s += t; } }).done.then(() => resolve(s)); });
    check('run: working directory is the synced folder (pwd + a.txt present)', /proj dir\/it's/.test(rcwd) && /a\.txt/.test(rcwd), JSON.stringify(rcwd));
    const lastRun = logLines().at(-1);
    check('run: uses -tt (live output, Ctrl-C works), key auth only', lastRun.flags.includes('-tt') && lastRun.opts.some(([, v]) => v === 'BatchMode=yes'));
    // Stop
    process.env.FAKE_SSH_PIDFILE = path.join(tmp, 'ssh.pid');
    let got = '';
    const slow = R.run(prof2, "~/proj dir/it's", 'echo started; sleep 20; echo NOT_REACHED', { onOutput: (t) => { got += t; } });
    for (let i = 0; i < 40 && !/started/.test(got); i++) await sleep(150);
    const pid = Number(fs.readFileSync(process.env.FAKE_SSH_PIDFILE, 'utf8'));
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    check('stop: run is active before Stop', alive(pid) && /started/.test(got));
    const ts = Date.now();
    slow.stop();
    const sr = await slow.done;
    check('stop: Ctrl-C ends the remote command quickly, marked stopped, process gone', sr.stopped === true && Date.now() - ts < 4000 && !alive(pid) && !/NOT_REACHED/.test(got), `code=${sr.code} ms=${Date.now() - ts}`);
    process.env.FAKE_IGNORE_CTRLC = '1';
    let got2 = '';
    const stubborn = R.run(prof2, "~/proj dir/it's", 'echo started; sleep 20', { onOutput: (t) => { got2 += t; } });
    for (let i = 0; i < 40 && !/started/.test(got2); i++) await sleep(150);
    const pid2 = Number(fs.readFileSync(process.env.FAKE_SSH_PIDFILE, 'utf8'));
    const ts2 = Date.now();
    stubborn.stop();
    await sleep(300);
    stubborn.stop();   // second click = force
    const sr2 = await stubborn.done;
    check('stop: when the remote ignores Ctrl-C, the second Stop closes the connection', sr2.stopped === true && !alive(pid2) && Date.now() - ts2 < 4000, `ms=${Date.now() - ts2}`);
    delete process.env.FAKE_IGNORE_CTRLC;

    // fetch: what changed remotely
    fs.writeFileSync(path.join(remoteProj, 'a.txt'), 'CHANGED REMOTELY');
    fs.writeFileSync(path.join(remoteProj, 'result 1.csv'), 'x,y\n1,2\n');
    fs.mkdirSync(path.join(remoteProj, 'out', 'ünï'), { recursive: true });
    fs.writeFileSync(path.join(remoteProj, 'out', 'ünï', 'r ✓.txt'), 'unicode result');
    fs.mkdirSync(path.join(remoteProj, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(remoteProj, 'node_modules', 'ignored.js'), 'x');
    await sleep(50);
    const lc = await R.listChanged(prof2, "~/proj dir/it's");
    const lrels = (lc.files || []).map((f) => f.rel).sort();
    check('fetch list: only files changed remotely since upload (not unchanged, not node_modules)', lc.ok && JSON.stringify(lrels) === JSON.stringify(['a.txt', 'out/ünï/r ✓.txt', 'result 1.csv']), JSON.stringify(lc));
    const lcNo = await R.listChanged(prof2, '~/never-synced');
    check('fetch list: no sync marker -> helpful message', !lcNo.ok && /run once with upload first/.test(lcNo.error), lcNo.error);
    const stage = path.join(tmp, 'stage'); fs.mkdirSync(stage);
    const dl = await R.download(prof2, "~/proj dir/it's", ['a.txt', 'out/ünï/r ✓.txt', 'result 1.csv', '../../evil.txt', '/etc/passwd'], stage);
    check('fetch download: files arrive intact (incl. unicode name)', dl.ok && fs.readFileSync(path.join(stage, 'a.txt'), 'utf8') === 'CHANGED REMOTELY' && fs.readFileSync(path.join(stage, 'out', 'ünï', 'r ✓.txt'), 'utf8') === 'unicode result' && dl.got.length === 3, JSON.stringify(dl));
    check('fetch download: path traversal names never written', !fs.existsSync(path.join(tmp, 'evil.txt')) && !fs.existsSync(path.join(stage, '..', 'evil.txt')));
    // port forward
    const fk = await startFake({});
    process.env.FAKE_OLLAMA_PORT = String(fk.port);
    const lport = 21000 + Math.floor(Math.random() * 9000);
    const fw = await R.startForward(prof2, lport, 11434, {});
    check('forward: starts and the local port answers (ssh -N -L 127.0.0.1:L:127.0.0.1:R)', fw.ok, fw.error);
    const lastF = logLines().at(-1);
    check('forward: arguments bind to loopback and use ExitOnForwardFailure', lastF.flags.includes('-N') && lastF.argv.includes(`127.0.0.1:${lport}:127.0.0.1:11434`) && lastF.opts.some(([, v]) => v === 'ExitOnForwardFailure=yes'));
    const viaFwd = await testServer(`http://127.0.0.1:${lport}`, '');
    check('forward: test through the forwarded port works', viaFwd.ok && viaFwd.version === '0.0.0-fake');
    if (fw.handle) { fw.handle.stop(); await sleep(300); }
    const after = await testServer(`http://127.0.0.1:${lport}`, '');
    check('forward: stop closes the port', !after.ok);
    const fwBad = await R.startForward(P('denied.test'), lport + 1, 11434, {});
    check('forward: auth failure reported cleanly', !fwBad.ok && /rejected the key/.test(fwBad.error), fwBad.error);
    await fk.close();
  } else check('Git sh available for ssh flow tests', false, 'skipped');

  /* ---------- Kaggle notebook ---------- */
  const kb = buildNotebook({ model: 'qwen2.5-coder:7b', platform: 'kaggle' });
  const kj = JSON.stringify(kb);
  check('kaggle notebook: valid nbformat 4, Internet + GPU + 12 h notes, kaggle metadata, no secrets', JSON.parse(kj).nbformat === 4 && /Internet/.test(kj) && /12 hours/.test(kj) && !!kb.metadata.kaggle && !kb.metadata.colab && kj.includes('API_TOKEN = \\"\\"') && !/authtoken\s*=\s*\\"[^\\"]+/.test(kj));
  check('colab notebook has colab metadata and no Kaggle section', !!nb.metadata.colab && !/Kaggle specifics/.test(json));
  fs.writeFileSync(path.join(tmp, 'kb.ipynb'), kj);
  const py3 = spawnSync('python', ['-I', '-c', 'import sys,ast,json\nnb=json.load(open(sys.argv[1]))\nfor c in nb["cells"]:\n  if c["cell_type"]=="code": ast.parse("".join(c["source"]))\nprint("PYOK")', path.join(tmp, 'kb.ipynb')], { encoding: 'utf8' });
  check('kaggle notebook: every code cell is valid Python', /PYOK/.test(py3.stdout) || !!py3.error, py3.stderr && py3.stderr.slice(0, 200));

  /* ---------- LAN scan (fake servers on localhost) ---------- */
  const { scanLan, lanPrefixes, probeOllama } = lib('net');
  const F1 = await startFake({}); const F2 = await startFake({});
  const nonOllama = http.createServer((q, r) => { r.writeHead(200); r.end('hello'); });
  await new Promise((r) => nonOllama.listen(0, '127.0.0.1', r));
  const p1 = await probeOllama('127.0.0.1', F1.port, 800);
  check('probeOllama: finds a fake Ollama and reads its version', p1 && p1.version === '0.0.0-fake' && p1.port === F1.port);
  check('probeOllama: non-Ollama web server and closed port are ignored', !(await probeOllama('127.0.0.1', nonOllama.address().port, 800)) && !(await probeOllama('127.0.0.1', 1, 300)));
  const found = await scanLan(['127.0.0'], { port: F2.port, timeoutMs: 300, concurrency: 32 });
  check('scanLan: /24 sweep finds the server on 127.0.0.1 only', found.length === 1 && found[0].host === '127.0.0.1' && found[0].port === F2.port, JSON.stringify(found));
  check('scanLan: ignores malformed prefixes (no scan of arbitrary hosts)', (await scanLan(['evil.com', '1.2.3.4', '999', '10.0.0.0/8'], { timeoutMs: 100 })).length === 0);
  let probes = 0;
  const stopped = await scanLan(['127.0.0'], { port: F2.port, timeoutMs: 200, concurrency: 2, shouldStop: () => (++probes > 6) });
  check('scanLan: Stop ends the scan early', probes < 40 && Array.isArray(stopped), 'probes=' + probes);
  check('lanPrefixes: only private, non-internal IPv4', JSON.stringify(lanPrefixes({ a: [{ family: 'IPv4', address: '192.168.7.20', internal: false }, { family: 'IPv4', address: '127.0.0.1', internal: true }, { family: 'IPv4', address: '8.8.4.4', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }], b: [{ family: 4, address: '10.1.2.3', internal: false }] })) === '["192.168.7","10.1.2"]');
  await F1.close(); await F2.close(); nonOllama.close();

  /* ---------- feature entry: exports, vault, profile storage, no plaintext secrets ---------- */
  const feat = require(path.join(root, 'src', 'features', 'remote.js'));
  check('feature module keeps entry function and exports helpers', typeof feat === 'function' && typeof feat.makeVault === 'function' && feat.helpers && typeof feat.helpers.ssh.sshArgs === 'function' && /OLLAMA_HOST/.test(feat.LAN_COMMANDS.ollamaHost) && /-Profile Private/.test(feat.LAN_COMMANDS.firewall) && feat.BIG_MODEL_TIPS.length >= 4 && /no login/i.test(feat.LAN_WARNING));
  const fakeSS = (avail) => ({ isEncryptionAvailable: () => avail, encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).reverse().toString('hex')), decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return Buffer.from(t.slice(4), 'hex').reverse().toString(); } });
  const v1 = feat.makeVault(fakeSS(true), 'win32'), v0 = feat.makeVault(fakeSS(false), 'win32'), vb = feat.makeVault({ ...fakeSS(true), getSelectedStorageBackend: () => 'basic_text' }, 'linux');
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  check('vault: encrypts/decrypts; unavailable or basic_text backend -> refuses', v1.canEncrypt() && v1.decrypt(v1.encrypt('tok-123')) === 'tok-123' && !v0.canEncrypt() && !vb.canEncrypt() && throws(() => v0.encrypt('x')) && !feat.makeVault(null, 'win32').canEncrypt());
  const mkCtx = (ss) => {
    const store = {}; const handlers = {}; const sent = []; let host = 'http://127.0.0.1:11434', remote = false;
    const ctx = {
      safeStorage: ss, handlers, sent, store, hostCalls: [],
      handle: (n, f) => { handlers[n] = f; }, send: (n, p) => sent.push([n, p]),
      getSettings: () => ({ host, hostRemote: remote }), effective: () => ({}), workspace: () => '', dataDir: tmp,
      featureSettings: () => store, setFeatureSettings: (n, p) => Object.assign(store, p),
      setHost: (u, r) => { host = u; remote = !!r; ctx.hostCalls.push([u, !!r]); },
      ollamaUp: async () => true, window: () => null, app: { on: () => {} }, dialog: {}, fs, path, os,
    };
    return ctx;
  };
  const H = (c, n) => c.handlers['feat:remote:' + n];
  const cNo = mkCtx(fakeSS(false)); feat(cNo);
  let errNo = ''; try { await H(cNo, 'serverSave')({ name: 'A', url: 'https://gpu.example.com', token: 'SECRET-TOKEN-1' }); } catch (e) { errNo = e.message; }
  check('safeStorage unavailable: saving a token is refused with a clear message, nothing stored', /will not save a token/.test(errNo) && !JSON.stringify(cNo.store).includes('SECRET-TOKEN-1') && !(cNo.store.servers || []).length, errNo);
  const okNo = await H(cNo, 'serverSave')({ name: 'NoTok', url: '192.168.1.5:11434' });
  check('safeStorage unavailable: a server without token still saves (http allowed on LAN)', okNo.url === 'http://192.168.1.5:11434' && !okNo.hasToken);
  const cOk = mkCtx(fakeSS(true)); feat(cOk);
  const sv = await H(cOk, 'serverSave')({ name: 'Hosted', url: 'https://gpu.example.com/api/tags', token: 'SECRET-TOKEN-2' });
  const stateJson = JSON.stringify(await H(cOk, 'state')());
  check('token stored only encrypted; never in settings JSON, UI state or events', sv.hasToken && !JSON.stringify(cOk.store).includes('SECRET-TOKEN-2') && !stateJson.includes('SECRET-TOKEN-2') && !JSON.stringify(cOk.sent).includes('SECRET-TOKEN-2') && /ENC:/.test(Buffer.from(cOk.store.servers[0].tokenEnc, 'base64').toString()));
  let eHttp = ''; try { await H(cOk, 'serverSave')({ name: 'Bad', url: 'http://8.8.8.8:11434', token: 'tttt' }); } catch (e) { eHttp = e.message; }
  check('token over plain http to a public address is refused', /plain http/.test(eHttp), eHttp);
  const eBad = [];
  for (const i of [{ name: '', url: 'http://h' }, { name: 'x', url: 'ftp://h' }, { name: 'x', url: 'http://u:p@h' }, { name: 'x', url: 'http://h', token: 'has space' }, { name: 'x'.repeat(80), url: 'http://h' }]) {
    try { await H(cOk, 'serverSave')(i); eBad.push('accepted ' + JSON.stringify(i).slice(0, 40)); } catch { /* good */ }
  }
  check('server validation rejects empty name, bad scheme, credentials in URL, spaced token, long name', !eBad.length, eBad.join(';'));
  let eCons = ''; try { await H(cOk, 'use')(sv.id, 'forged-nonce'); } catch (e) { eCons = e.message; }
  check('switching without the consent step is refused and never calls setHost', /Consent is required/.test(eCons) && cOk.hostCalls.length === 0);
  const fk2 = await startFake({ token: 'real-bearer' });
  const sv2 = await H(cOk, 'serverSave')({ name: 'Local fake', url: fk2.url, token: 'real-bearer' });
  const prep = await H(cOk, 'usePrepare')(sv2.id);
  const used = await H(cOk, 'use')(sv2.id, prep.nonce);
  const hc = cOk.hostCalls.at(-1);
  check('consent flow: setHost(relay, true) with the relay on 127.0.0.1, models listed', used.models.length === 2 && hc[1] === true && /^http:\/\/127\.0\.0\.1:\d+$/.test(hc[0]) && !hc[0].includes('real-bearer'), JSON.stringify(hc));
  const viaRelay = await get(hc[0] + '/api/tags');
  check('relay adds the stored bearer; the settings never contain it', viaRelay.status === 200 && fk2.state.authHeaders.at(-1) === 'Bearer real-bearer' && !JSON.stringify(cOk.store).includes('real-bearer'));
  let replay = ''; try { await H(cOk, 'use')(sv2.id, prep.nonce); } catch (e) { replay = e.message; }
  check('consent nonce is single-use', /Consent is required/.test(replay));
  await H(cOk, 'local')();
  const lc2 = cOk.hostCalls.at(-1);
  const afterLocal = await get(hc[0] + '/api/tags').catch(() => null);
  check('Back to local: setHost(local, false) and the relay is closed', lc2[0] === 'http://127.0.0.1:11434' && lc2[1] === false && afterLocal === null);
  const st2 = await H(cOk, 'state')();
  check('after Back to local: a reconnect is offered (needs a click) but nothing is connected', !st2.active && st2.offer && st2.offer.id === sv2.id);
  await H(cOk, 'forgetTokens')();
  check('forgetTokens removes every saved token', cOk.store.servers.every((s) => !s.tokenEnc));
  await fk2.close();
  const fk3 = await startFake({ token: 'nb-token' });
  const pa = await H(cOk, 'pasteAdd')({ text: 'FABER_URL=' + fk3.url + '\nFABER_TOKEN=nb-token\n' });
  check('paste box: parses URL + token, creates a profile and tests it', pa.test.ok && pa.server.hasToken && !JSON.stringify(cOk.store).includes('nb-token'), JSON.stringify(pa.test));
  await fk3.close();
  const ssP = await H(cOk, 'sshSave')({ name: 'box', user: 'bob', host: 'h.example.com' });
  let sshBad = 0;
  for (const i of [{ name: 'b', user: '-oProxyCommand=x', host: 'h' }, { name: 'b', user: 'u', host: 'h', password: 'pw', port: 99999 }]) { try { await H(cOk, 'sshSave')(i); } catch { sshBad++; } }
  check('ssh profile saved without any password field; bad ones rejected', ssP.id && !('password' in ssP) && sshBad === 2 && !JSON.stringify(cOk.store).toLowerCase().includes('password'));

  console.log(fails ? `FAILED: ${fails}` : 'ALL PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
function unesc(x) {
  const t = x.replace(/^"|"$/g, '');
  if (!/\\[0-7]{3}/.test(t)) return t;
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const m = t.slice(i).match(/^\\([0-7]{3})/);
    if (m) { out.push(parseInt(m[1], 8)); i += 3; } else out.push(...Buffer.from(t[i]));
  }
  return Buffer.from(out).toString('utf8');
}
function crypto_bytes(n) { return require('crypto').randomBytes(n); }
main().catch((e) => { console.log('FAIL unexpected error', e.stack); process.exit(1); });
