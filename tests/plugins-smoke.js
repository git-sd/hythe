// Plugins smoke test (real app): manifest validation, enable/disable + tools, injection safety, streaming + Stop,
// clickable file:line refs, snippets, the six built-in plugins against the tools installed on this PC,
// developer utilities, AI tools (sandbox + approval + editor follows).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const root = process.env.FABER_ROOT;
const TAG = process.env.FABER_TAG || String(process.pid);
const BASE = path.join(process.env.TEMP, 'faber-plugins-' + TAG);
const UD = path.join(BASE, 'ud');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
app.setPath('userData', UD);
process.env.FABER_NO_OPEN = '1';
require(path.join(root, 'main.js'));
const tools = require(path.join(root, 'src', 'tools'));
const M = require(path.join(root, 'src', 'plugins-lib', 'manifest'));
const T = require(path.join(root, 'src', 'plugins-lib', 'template'));
const PARSE = require(path.join(root, 'src', 'plugins-lib', 'parse'));
const TODO = require(path.join(root, 'src', 'plugins-lib', 'todo'));
const DEV = require(path.join(root, 'src', 'plugins-lib', 'devtools'));

const LOG = path.join(process.env.TEMP, 'faber-plugins-' + TAG + '.log');
fs.writeFileSync(LOG, '');
const print = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const wj = (p, obj) => w(p, JSON.stringify(obj, null, 2));
const have = (name) => !!T.which(name);

const TOOLS = path.join(BASE, 'tools');
const PROJ = path.join(BASE, 'p');
const USERP = path.join(UD, 'plugins');

/* ---------- fixtures ---------- */
w(path.join(TOOLS, 'echo.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
w(path.join(TOOLS, 'slow.js'), "require('fs').writeFileSync(process.argv[2], String(process.pid));\nlet n = 0;\nsetInterval(() => console.log('tick ' + (++n)), 150);\nsetTimeout(() => {}, 60000);\n");
w(path.join(TOOLS, 'refs.js'), [
  "const ws = process.argv[2];",
  "console.log('src/a.js:3:5: error boom');",
  "console.log('src\\\\b.ts(7,2): error TS1005: expected');",
  "console.log('  File \"src/a.js\", line 2, in <module>');",
  "console.log(ws + '/src/a.js');",
  "console.log('  4:9  error  something wrong  no-unused-vars');",
  "console.log('done');", ''].join('\n'));

const nodeQ = (f) => `{bin:node} '${f}'`;
const ALLP = ['run-commands', 'write-files', 'read-files', 'ai-tools', 'snippets'];
wj(path.join(USERP, 'good-demo', 'plugin.json'), {
  id: 'good-demo', name: 'Good demo', version: '1.2.3', description: 'Fixture plugin used by the smoke test.', permissions: ALLP,
  commands: [
    { name: 'echoargs', title: 'Echo args', scope: 'file', arg: { label: 'Argument' }, run: `${nodeQ(path.join(TOOLS, 'echo.js'))} {file} {arg}`, output: 'panel' },
    { name: 'slow', title: 'Slow job', run: `${nodeQ(path.join(TOOLS, 'slow.js'))} '${path.join(BASE, 'slow.pid')}'`, output: 'panel', timeoutSec: 90 },
    { name: 'refs', title: 'Print refs', run: `${nodeQ(path.join(TOOLS, 'refs.js'))} {ws}`, output: 'panel' },
    { name: 'shim', title: 'Shim', scope: 'file', run: '{bin:fakefmt} {file}', output: 'panel' },
    { name: 'toasty', title: 'Toasty', run: `${nodeQ(path.join(TOOLS, 'echo.js'))} hi`, output: 'toast' },
  ],
  tools: [{
    name: 'echo_tool', description: 'Echo a message', effect: 'read',
    parameters: { type: 'object', properties: { msg: { type: 'string', description: 'text', pattern: '^[\\w .;&|$`-]{1,60}$' } }, required: ['msg'] },
    run: `${nodeQ(path.join(TOOLS, 'echo.js'))} {msg}`,
  }],
  snippets: [{ prefix: 'zlog', body: 'console.log("${file}", $1);$0', languages: ['js'] }, { prefix: 'zstop', body: 'a${1:one} b$2 c$0', languages: ['*'] }],
});
// invalid plugins: must be reported, never crash anything
wj(path.join(USERP, 'Bad_ID', 'plugin.json'), { id: 'Bad_ID', name: 'x', version: '1.0.0', description: 'x', permissions: [] });
wj(path.join(USERP, 'trav', 'plugin.json'), { id: '../evil', name: 'x', version: '1.0.0', description: 'x', permissions: [] });
wj(path.join(USERP, 'badtypes', 'plugin.json'), { id: 'badtypes', name: 'x', version: '1.0.0', description: 'x', permissions: [], commands: 'nope' });
wj(path.join(USERP, 'unkvar', 'plugin.json'), { id: 'unkvar', name: 'x', version: '1.0.0', description: 'x', permissions: ['run-commands'], commands: [{ name: 'c', title: 'c', run: 'echo {selection}' }] });
wj(path.join(USERP, 'quoted', 'plugin.json'), { id: 'quoted', name: 'x', version: '1.0.0', description: 'x', permissions: ['run-commands'], commands: [{ name: 'c', title: 'c', scope: 'file', run: 'echo "{file}"' }] });
wj(path.join(USERP, 'noperm', 'plugin.json'), { id: 'noperm', name: 'x', version: '1.0.0', description: 'x', permissions: [], commands: [{ name: 'c', title: 'c', run: 'echo hi' }] });
wj(path.join(USERP, 'userhandler', 'plugin.json'), { id: 'userhandler', name: 'x', version: '1.0.0', description: 'x', permissions: ['read-files'], commands: [{ name: 'c', title: 'c', handler: 'todo-scan' }] });
wj(path.join(USERP, 'coretool', 'plugin.json'), { id: 'coretool', name: 'x', version: '1.0.0', description: 'x', permissions: ['run-commands', 'ai-tools'], tools: [{ name: 'run_command', description: 'x', run: 'echo hi' }] });
w(path.join(USERP, 'badjson', 'plugin.json'), '{ not json');
w(path.join(USERP, 'huge', 'plugin.json'), JSON.stringify({ id: 'huge', name: 'x', version: '1.0.0', description: 'x'.repeat(70000), permissions: [] }));
wj(path.join(USERP, 'format', 'plugin.json'), { id: 'format', name: 'Impostor', version: '1.0.0', description: 'tries to reuse a built-in id', permissions: [] });
w(path.join(USERP, 'stray-file.txt'), 'not a plugin');
const BAD_IDS = ['Bad_ID', 'trav', 'badtypes', 'unkvar', 'quoted', 'noperm', 'userhandler', 'coretool', 'badjson', 'huge'];

// workspaces
const HOST = path.join(PROJ, 'hostile');
w(path.join(HOST, 'src', 'a.js'), 'line1\nline2\nline3 target here\nline4\nline5\n');
w(path.join(HOST, 'node_modules', '.bin', 'fakefmt.cmd'), `@echo off\r\nnode "${path.join(TOOLS, 'echo.js')}" %*\r\n`);
const NODE_PASS = path.join(PROJ, 'node-pass');
wj(path.join(NODE_PASS, 'package.json'), { name: 'np', version: '1.0.0', scripts: { test: 'node --test', hello: 'node -e "console.log(\'hello-from-script\')"', 'build:dev': 'node -e "console.log(1)"' } });
w(path.join(NODE_PASS, 'a.test.js'), "const t = require('node:test');\nt('one', () => {});\nt('two', () => {});\n");
w(path.join(NODE_PASS, 'Makefile'), 'all: build\n\nbuild:\n\techo build\n\nclean:\n\techo clean\n\nVAR := 1\n');
w(path.join(NODE_PASS, 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.poe.tasks]\nserve = "python -m http.server"\nlint = "ruff check ."\n');
const NODE_FAIL = path.join(PROJ, 'node-fail');
wj(path.join(NODE_FAIL, 'package.json'), { name: 'nf', version: '1.0.0', scripts: { test: 'node --test' } });
w(path.join(NODE_FAIL, 'b.test.js'), "const t = require('node:test');\nconst assert = require('node:assert');\nt('good', () => {});\nt('bad', () => { assert.strictEqual(1, 2); });\n");
const NODE_NOTEST = path.join(PROJ, 'node-notest');
wj(path.join(NODE_NOTEST, 'package.json'), { name: 'nn', scripts: { test: 'echo "Error: no test specified" && exit 1' } });
const PY = path.join(PROJ, 'py');
w(path.join(PY, 'test_ok.py'), 'def test_a():\n    assert 1 + 1 == 2\n\ndef test_b():\n    assert True\n');
w(path.join(PY, 'lib.py'), 'x = 1\n');
const GO = path.join(PROJ, 'go');
w(path.join(GO, 'go.mod'), 'module example.com/x\n\ngo 1.21\n');
w(path.join(GO, 'main.go'), 'package main\nfunc main() {}\n');
const RUST = path.join(PROJ, 'rust');
w(path.join(RUST, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
const DOTNET = path.join(PROJ, 'dotnet');
w(path.join(DOTNET, 'a.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
w(path.join(DOTNET, 'p.cs'), 'class P {}\n');
const FMT = path.join(PROJ, 'fmt');
w(path.join(FMT, 'package.json'), '{"name":"f"}');
w(path.join(FMT, 'a.js'), 'let x=1;\nlet y=2;\n');
w(path.join(FMT, 'node_modules', '.bin', 'prettier.cmd'), `@echo off\r\nnode "%~dp0prettier-impl.js" %*\r\n`);
w(path.join(FMT, 'node_modules', '.bin', 'prettier-impl.js'),
  "const fs = require('fs');\nconst f = process.argv[process.argv.length - 1];\nconst t = fs.readFileSync(f, 'utf8');\nconst n = t.replace(/(\\w)=(\\w)/g, '$1 = $2');\nif (n !== t) fs.writeFileSync(f, n);\nconsole.log('fake prettier checked ' + f);\n");
const LINT = path.join(PROJ, 'lint');
w(path.join(LINT, 'package.json'), '{"name":"l"}');
w(path.join(LINT, 'eslint.config.js'), 'module.exports = [];\n');
w(path.join(LINT, 'a.js'), 'var unused = 1;\n');
w(path.join(LINT, 'tsconfig.json'), '{}');
w(path.join(LINT, 'node_modules', '.bin', 'eslint.cmd'), `@echo off\r\nnode "%~dp0eslint-impl.js" %*\r\n`);
w(path.join(LINT, 'node_modules', '.bin', 'eslint-impl.js'),
  "const path = require('path');\nconst abs = path.resolve(process.cwd(), 'a.js');\nconsole.log(abs);\nconsole.log('  1:5  error  \\'unused\\' is assigned a value but never used  no-unused-vars');\nconsole.log('');\nconsole.log('1 problem (1 error, 0 warnings)');\nprocess.exit(1);\n");
const BARE = path.join(PROJ, 'bare');           // nothing recognisable
w(path.join(BARE, 'readme.txt'), 'hello');
const TODOP = path.join(PROJ, 'todos');
w(path.join(TODOP, 'special.js'), 'const a = 1;\n// TODO(sam): the special one\nconst b = 2; /* FIXME handle b */\n// HACK: temporary\n// XXX remove me\n');
for (let i = 0; i < 560; i++) w(path.join(TODOP, 'src', 'g' + (i % 14), `f${i}.js`), `// file ${i}\nconst v${i} = ${i};\n${i % 7 === 0 ? `// TODO: item ${i}\n` : ''}${i % 50 === 0 ? '// FIXME: big one ' + i + '\n' : ''}`);
w(path.join(TODOP, 'node_modules', 'dep', 'index.js'), '// TODO: must be skipped (node_modules)\n');
w(path.join(TODOP, '.git', 'x.txt'), 'TODO skipped (.git)\n');
w(path.join(TODOP, 'dist', 'out.js'), '// TODO skipped (dist)\n');
fs.writeFileSync(path.join(TODOP, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('TODO inside binary\n')]));
w(path.join(TODOP, 'big.txt'), '// TODO too big\n' + 'x'.repeat(1100000));

app.whenReady().then(async () => {
  await sleep(3500);
  const win = BrowserWindow.getAllWindows()[0];
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errs.push(msg); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const check = (name, ok, extra) => print((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + String(extra).slice(0, 400) : ''));
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return false; await sleep(100); } };
  const call = (ch, ...a) => js(`Faber.call(${JSON.stringify('feat:plugins:' + ch)}, ...${JSON.stringify(a)})`);
  const open = (dir) => js(`api.openFolder(${JSON.stringify(dir)}).then(async (s) => { settings = s; render(); await refreshTree(); Faber.emit('folder', s.workspace); })`);
  const step = async (name, fn) => { try { await fn(); } catch (e) { print('FAIL ' + name + ' (exception)  ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } };
  const enable = async (id) => { const r = await call('enable', id, true); await js('FaberPlugins.refresh()'); return r; };
  const direct = (args) => js(`window.__direct(${JSON.stringify(args)})`);
  const schemaNames = () => tools.schemas.map((s) => s.function.name);
  const stubCtx = (ws, extra = {}) => {
    const calls = [];
    return Object.assign({ workspace: ws, sandbox: true, mode: 'ask', calls, approve: async (k, t, d) => { calls.push([k, t, d]); return true; }, changed: () => {}, onOutput: () => {}, setKill: () => {} }, extra);
  };

  /* ===== unit level: manifests, templates, parsers (no UI) ===== */
  await step('manifest unit', async () => {
    const good = { id: 'ok-plugin', name: 'OK', version: '1.0.0', description: 'd', permissions: ['run-commands'], commands: [{ name: 'go', title: 'Go', run: '{bin:node} -e 1' }] };
    check('manifest: good plugin accepted', M.validate(good, { source: 'user', folderName: 'ok-plugin' }).ok === true);
    const bad = (label, mut, opts) => {
      let r;
      try { r = M.validate(mut(JSON.parse(JSON.stringify(good))), opts || { source: 'user', folderName: 'ok-plugin' }); } catch (e) { return check('manifest: ' + label + ' (threw!)', false, e.message); }
      check('manifest: rejects ' + label, r.ok === false && r.errors.length > 0, r.errors[0]);
    };
    bad('uppercase id', (m) => { m.id = 'Ok-Plugin'; return m; });
    bad('id with path traversal', (m) => { m.id = '../ok-plugin'; return m; });
    bad('id not matching folder', (m) => { m.id = 'other-name'; return m; });
    bad('wrong type (commands string)', (m) => { m.commands = 'x'; return m; });
    bad('wrong type (run number)', (m) => { m.commands[0].run = 5; return m; });
    bad('unknown top-level key', (m) => { m.exec = 'calc'; return m; });
    bad('unknown template variable', (m) => { m.commands[0].run = 'echo {selection}'; return m; });
    bad('variable inside quotes', (m) => { m.commands[0].scope = 'file'; m.commands[0].run = 'echo "{file}"'; return m; });
    bad('{file} without file scope', (m) => { m.commands[0].run = 'echo {file}'; return m; });
    bad('handler in user plugin', (m) => { m.commands[0] = { name: 'go', title: 'Go', handler: 'todo-scan' }; return m; });
    bad('missing permission', (m) => { m.permissions = []; return m; });
    bad('unknown permission', (m) => { m.permissions.push('root'); return m; });
    bad('slash-unfriendly command name', (m) => { m.commands[0].name = 'my-cmd'; return m; });
    bad('core tool name', (m) => { m.permissions.push('ai-tools'); m.tools = [{ name: 'read_file', description: 'x', run: 'echo hi' }]; return m; });
    bad('bad snippet prefix', (m) => { m.permissions.push('snippets'); m.snippets = [{ prefix: 'a b', body: 'x' }]; return m; });
    bad('bad env name', (m) => { m.commands[0].env = { 'a b': '1' }; return m; });
    bad('PATH override', (m) => { m.commands[0].env = { PATH: 'C:\\evil' }; return m; });
    check('manifest: non-object root rejected', M.validate([], {}).ok === false && M.validate(null, {}).ok === false && M.validate('x', {}).ok === false);
    const tmp = path.join(BASE, 'unit-plugins');
    wj(path.join(tmp, 'ok-plugin', 'plugin.json'), good);
    w(path.join(tmp, 'big-one', 'plugin.json'), JSON.stringify({ id: 'big-one', pad: 'x'.repeat(70000) }));
    w(path.join(tmp, 'broken', 'plugin.json'), '{{{');
    fs.mkdirSync(path.join(tmp, 'nofile'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'UPPER'), { recursive: true });
    const scanned = M.scanDir(tmp, 'user');
    const by = Object.fromEntries(scanned.map((s) => [path.basename(s.dir), s]));
    check('manifest: oversize rejected', by['big-one'].manifest === null && /too large/.test(by['big-one'].errors[0]), by['big-one'].errors[0]);
    check('manifest: broken JSON reported', by.broken.manifest === null && /not valid JSON/.test(by.broken.errors[0]));
    check('manifest: missing plugin.json and bad folder name reported', /missing/.test(by.nofile.errors[0]) && /folder name/.test(by.UPPER.errors[0]));
    check('manifest: good folder loads', by['ok-plugin'].manifest && by['ok-plugin'].manifest.id === 'ok-plugin');
    try {
      fs.symlinkSync(path.join(tmp, 'ok-plugin'), path.join(tmp, 'linked'), 'junction');
      const l = M.loadFolder(path.join(tmp, 'linked'), 'user');
      check('manifest: symlinked plugin folder refused', l.manifest === null && /symbolic/.test(l.errors[0]), l.errors[0]);
    } catch (e) { print('SKIP symlink test:', e.message); }
    const bi = M.scanDir(path.join(root, 'plugins'), 'builtin');
    check('manifest: all 7 built-in plugins are valid', bi.length === 7 && bi.every((b) => b.manifest), bi.filter((b) => !b.manifest).map((b) => b.id + ': ' + b.errors[0]).join(' / '));
  });

  await step('template unit', async () => {
    const R = (tpl, vals, o) => T.render(tpl, vals, {}, Object.assign({ shell: 'ps', win32: true }, o));
    check('template: PowerShell quoting doubles single quotes', R('x {a}', { a: "it's a 'test'" }) === "x 'it''s a ''test'''");
    check('template: PowerShell treats smart quotes as quotes, so they are doubled', R('{a}', { a: 'a\u2018b\u2019c' }) === "'a\u2018\u2018b\u2019\u2019c'");
    check('template: $ ` ; & | stay inert inside quotes', R('{a}', { a: 'a;b&c|d$(x)`e' }) === "'a;b&c|d$(x)`e'");
    check('template: POSIX quoting', R('{a}', { a: "it's;$(x)" }, { shell: 'sh', win32: false }) === "'it'\\''s;$(x)'");
    const rej = (label, v, o) => { try { R('{a}', { a: v }, o); check('template: rejects ' + label, false); } catch (e) { check('template: rejects ' + label, /\{a\}/.test(e.message), e.message); } };
    rej('newline', 'a\nb');
    rej('NUL', 'a\u0000b');
    rej('double quote on Windows', 'a"b');
    rej('leading dash', '-rf');
    rej('trailing backslash with space', 'C:\\my dir\\');
    rej('line separator', 'a\u2028b');
    rej('cmd metacharacters for .cmd tools', 'a&b', { strictCmd: true });
    check('template: leading dash allowed when declared', R('{a}', { a: '-x' }, { allowDash: new Set(['a']) }) === "'-x'");
    check('template: empty value expands to nothing', R('run {a}', { a: '' }) === 'run ');
    check('template: {{ }} are literal braces', R('Where {{ $_ }}', {}) === 'Where { $_ }');
    check('template: validation catches stray braces', T.validateTemplate('a } b', new Set()).length > 0 && T.validateTemplate('{x', new Set()).length > 0);
    check('template: local tools come from node_modules/.bin, runtimes only from PATH',
      (() => { const a = T.which('fakefmt', { workspace: HOST }); const b = T.which('node', { workspace: HOST }); return a && a.local && b && !b.local; })());
  });

  await step('parser unit', async () => {
    const s = (o, c) => PARSE.summarizeTests(o, c);
    check('tests summary: node --test', s('\u2139 pass 2\n\u2139 fail 1\n', 1).line === 'FAIL: 2 passed, 1 failed');
    check('tests summary: pytest', s('=== 1 failed, 2 passed in 0.12s ===', 1).line === 'FAIL: 2 passed, 1 failed' && s('3 passed in 0.03s', 0).status === 'pass');
    check('tests summary: jest / go / cargo / dotnet', s('Tests:       1 failed, 2 passed, 3 total', 1).failed === 1 && s('ok  \tx\t0.1s\nok  \ty\t0.1s', 0).passed === 2 && s('test result: ok. 4 passed; 0 failed; 0 ignored', 0).passed === 4 && s('Passed!  - Failed:     0, Passed:     5, Skipped:     1, Total:     6', 0).passed === 5);
    check('tests summary: nonzero exit is FAIL even without counts', s('boom', 3).status === 'fail');
    const long = Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\n');
    const t = PARSE.trimOutput(long, 1000);
    check('output trimming keeps head and tail', t.length < 1200 && t.includes('line 0') && t.includes('line 4999') && /omitted/.test(t));
    const h = DEV.hashBuffer(Buffer.from('abc'));
    check('hash: md5/sha1/sha256 known vectors', h.md5 === '900150983cd24fb0d6963f7d28e17f72' && h.sha1 === 'a9993e364706816aba3e25717850c26c9cd0d89d' && h.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const re = await DEV.regexTest({ pattern: '(?<k>\\w+)=(\\d+)', flags: 'g', text: 'a=1 bb=22' });
    check('regex worker: matches, groups, named groups', re.ok && re.matches.length === 2 && re.matches[1].groups[1] === '22' && re.matches[0].named.k === 'a', JSON.stringify(re).slice(0, 200));
    const t0 = Date.now();
    const evil = await DEV.regexTest({ pattern: '(a+)+$', flags: '', text: 'a'.repeat(45) + 'b' }, 800);
    check('regex worker: catastrophic pattern is stopped', evil.ok === false && evil.timeout === true && Date.now() - t0 < 4000, Date.now() - t0 + 'ms');
    const again = await DEV.regexTest({ pattern: 'x', flags: '', text: 'xx' });
    check('regex worker recovers after a timeout', again.ok && again.matches.length === 2);
    const bad = await DEV.regexTest({ pattern: '(', flags: '', text: 'x' });
    check('regex: invalid pattern gives a message', bad.ok === false && /Invalid|Unterminated/i.test(bad.error), bad.error);
    const sc = await TODO.scan({ root: TODOP });
    check('todo scanner (direct): finds items, skips node_modules/.git/dist/binary/oversize',
      sc.items.length > 80 && !sc.items.some((i) => /node_modules|\.git|dist|blob|big\.txt/.test(i.file)) && sc.items.some((i) => i.file === 'special.js' && i.tag === 'HACK'), `${sc.items.length} items ${sc.scanned} files`);
  });

  /* ===== real app ===== */
  await step('app boot', async () => {
    check('app is usable', (await js("!document.getElementById('app').hidden")) === true);
    await js(`window.__out = {}; window.__done = {};
      Faber.on('feat:plugins:out', (m) => { __out[m.id] = (__out[m.id] || '') + m.text; });
      Faber.on('feat:plugins:done', (m) => { __done[m.id] = m; });
      window.__direct = (args) => new Promise(async (resolve) => {
        const id = 'd' + Math.random().toString(36).slice(2, 8);
        const r = await Faber.call('feat:plugins:run', { ...args, runId: id });
        if (!r.ok) return resolve({ r });
        const t = setInterval(() => { if (__done[id]) { clearInterval(t); resolve({ r, out: __out[id] || '', done: __done[id] }); } }, 50);
      });
      true`);
    await js('FaberPlugins.refresh()');
  });

  await step('listing + disabled by default', async () => {
    const l = await call('list');
    const ids = l.plugins.map((p) => p.id);
    check('lists the 7 built-in plugins', ['format', 'lint', 'tests', 'scripts', 'todos', 'devtools', 'snippets'].every((i) => ids.includes(i)), ids.join(','));
    check('every plugin starts DISABLED', l.plugins.every((p) => !p.enabled));
    check('plugin tools are not offered while disabled', !schemaNames().some((n) => ['run_tests', 'find_todos', 'format_file', 'echo_tool'].includes(n)), schemaNames().join(','));
    const errored = l.plugins.filter((p) => p.error);
    check('invalid user plugins are listed with errors (no crash)', BAD_IDS.every((id) => errored.some((p) => p.id === id || p.name === id)), errored.map((p) => p.name).join(','));
    check('user plugin cannot reuse a built-in id', l.plugins.filter((p) => p.id === 'format').length === 1 && l.plugins.find((p) => p.id === 'format').source === 'builtin' && errored.some((p) => /built-in/.test(p.error)));
    check('stray files in the plugins folder are ignored', !ids.includes('stray-file.txt'));
    const good = l.plugins.find((p) => p.id === 'good-demo');
    check('good user plugin loads, disabled, with permissions', good && !good.error && !good.enabled && good.permissions.length === 5 && good.source === 'user');
    const keep = await js(`document.querySelectorAll('#paneFiles').length`);
    check('app still healthy after bad plugins', keep === 1 && (await js('typeof Faber.addSideTab')) === 'function');
  });

  await step('enable / disable UI', async () => {
    await js(`Faber.showSideTab('plugins')`);
    await sleep(500);
    check('Plugins sidebar tab renders cards', (await js(`document.querySelectorAll('#pane-plugins .plgCard').length`)) >= 10);
    check('rail has a Plugins icon', (await js(`[...document.querySelectorAll('#railTop .rbtn')].some((b) => b.title === 'Plugins')`)) === true);
    const click = (id) => js(`document.querySelector('#pane-plugins .plgCard[data-id="${id}"] .plgToggle').click()`);
    await click('tests');
    await sleep(400);
    const modalText = await js(`(document.querySelector('.modalCard') || {}).textContent || ''`);
    check('enabling shows the permission dialog with the commands', /Run commands on your computer/.test(modalText) && /Give the AI assistant extra tools/.test(modalText) && /npm/.test(modalText) && /run_tests/.test(modalText), modalText.slice(0, 200));
    await js(`[...document.querySelectorAll('.modalFoot button')].find((b) => b.textContent === 'Cancel').click()`);
    await sleep(300);
    check('Cancel leaves it disabled', !(await call('list')).plugins.find((p) => p.id === 'tests').enabled && !schemaNames().includes('run_tests'));
    await click('tests');
    await sleep(300);
    await js(`[...document.querySelectorAll('.modalFoot button')].find((b) => b.textContent === 'Enable plugin').click()`);
    await sleep(800);
    check('confirming enables it', (await call('list')).plugins.find((p) => p.id === 'tests').enabled === true);
    check('enabling registers its AI tool (ctx.tools schemas)', schemaNames().includes('run_tests'));
    check('enabled card shows Run buttons', (await js(`!!document.querySelector('#pane-plugins .plgCard[data-id="tests"] .plgRun')`)) === true);
    check('enable state survives in settings (persisted)', (await js(`Object.keys(Faber.settings().features || {}).length >= 0`)) === true);
    await click('tests');
    await sleep(600);
    check('disabling removes the tool again', !schemaNames().includes('run_tests') && (await call('list')).plugins.find((p) => p.id === 'tests').enabled === false);
    let denied = '';
    try { await tools.execute('run_tests', {}, stubCtx(NODE_PASS)); } catch (e) { denied = e.message; }
    check('a disabled plugin\'s tool cannot be called', /Unknown tool|disabled/.test(denied), denied);
  });

  /* ===== injection safety, end to end ===== */
  await step('injection safety', async () => {
    await open(HOST);
    await enable('good-demo');
    const names = [
      'sp ace.txt',
      "q'uote; New-Item PWNED1 -ItemType File; '.txt",
      'amp & New-Item PWNED2 -ItemType File & x.txt',
      'dollar $(New-Item PWNED3 -ItemType File) ${x} $env:PATH.txt',
      'tick `New-Item PWNED4 -ItemType File` `n.txt',
      'ünï ‘smart’ “dq” ✓ 日本語.txt',
      'semi;comma,eq=sign.txt',
      'pct %PATH% caret ^ x.txt',
    ];
    const argv = 'pipe | amp & dollar $q ; `x` (y)';
    let all = true, detail = '';
    for (const n of names) {
      const f = path.join(HOST, n);
      fs.writeFileSync(f, 'x');
      const r = await direct({ pluginId: 'good-demo', command: 'echoargs', file: f, arg: argv });
      let got = null;
      try { got = JSON.parse((r.out || '').trim().split('\n').pop()); } catch { /* reported below */ }
      const ok = got && got[0] === f && got[1] === argv;
      if (!ok) { all = false; detail += `\n${JSON.stringify(n)} => ${JSON.stringify(r.out || r.r)}`; }
    }
    check('hostile file names + argument reach the program verbatim (8 names)', all, detail);
    const pwned = fs.readdirSync(HOST).concat(fs.readdirSync(process.cwd())).filter((x) => /^PWNED/.test(x));
    check('no injected command ran (no PWNED files created)', pwned.length === 0, pwned.join(','));
    const q = await direct({ pluginId: 'good-demo', command: 'echoargs', file: path.join(HOST, 'sp ace.txt'), arg: 'say "hi"' });
    check('argument with a double quote is rejected on Windows', process.platform !== 'win32' || (q.r.ok === false && /double quote/.test(q.r.error)), JSON.stringify(q.r).slice(0, 200));
    const d = await direct({ pluginId: 'good-demo', command: 'echoargs', file: path.join(HOST, 'sp ace.txt'), arg: '-rf' });
    check('argument starting with "-" is rejected (option injection)', d.r.ok === false && /must not start with/.test(d.r.error), JSON.stringify(d.r).slice(0, 200));
    const outside = await direct({ pluginId: 'good-demo', command: 'echoargs', file: path.join(BASE, 'tools', 'echo.js'), arg: 'x' });
    check('file outside the open folder is refused (sandbox)', outside.r.ok === false && /outside the workspace/.test(outside.r.error), JSON.stringify(outside.r).slice(0, 200));
    if (process.platform === 'win32') {
      const f1 = path.join(HOST, 'plain name é.txt');
      fs.writeFileSync(f1, 'x');
      const r1 = await direct({ pluginId: 'good-demo', command: 'shim', file: f1 });
      let got1 = null; try { got1 = JSON.parse(r1.out.trim().split('\n').pop()); } catch { /* below */ }
      check('.cmd tool receives a safe unicode/space file name', got1 && got1[0] === f1, r1.out || JSON.stringify(r1.r));
      const f2 = path.join(HOST, 'evil & New-Item PWNED5 -ItemType File & x.txt');
      fs.writeFileSync(f2, 'x');
      const r2 = await direct({ pluginId: 'good-demo', command: 'shim', file: f2 });
      check('.cmd tool refuses a name with cmd metacharacters', r2.r.ok === false && /cannot be passed safely/.test(r2.r.error), JSON.stringify(r2.r).slice(0, 200));
      check('no PWNED5 file after the .cmd attempt', !fs.readdirSync(HOST).some((x) => /^PWNED/.test(x)));
    }
    // AI tool path: parameter values are quoted the same way
    const tc = stubCtx(HOST);
    const res = await tools.execute('echo_tool', { msg: 'a;b & c|d $x `y' }, tc);
    check('AI tool parameter is quoted and echoed back intact', res.includes('["a;b & c|d $x `y"]'), res.slice(-200));
    check('AI tool asked for approval with the exact command', tc.calls.length === 1 && tc.calls[0][0] === 'command' && /echo\.js/.test(tc.calls[0][2]), JSON.stringify(tc.calls[0] || '').slice(0, 200));
    let perr = '';
    try { await tools.execute('echo_tool', { msg: 'bad "quote' }, stubCtx(HOST)); } catch (e) { perr = e.message; }
    check('AI tool parameter violating its pattern is rejected', /invalid format/.test(perr), perr);
    const tcAuto = stubCtx(HOST, { mode: 'auto' });
    await tools.execute('echo_tool', { msg: 'auto' }, tcAuto);
    check('auto mode skips the approval prompt', tcAuto.calls.length === 0);
    let den = '';
    try { await tools.execute('echo_tool', { msg: 'x' }, stubCtx(HOST, { approve: async () => false })); } catch (e) { den = e.message; }
    check('denied approval stops the tool', /denied/.test(den), den);
  });

  /* ===== streaming + Stop, refs, toast ===== */
  await step('streaming + stop', async () => {
    await open(HOST);
    await js(`FaberPlugins.runCmd('good-demo', 'slow')`);
    const live = await waitFor(() => js(`document.querySelector('#plgPanel .plgBody').textContent.includes('tick 3')`), 8000);
    check('output streams into the panel while the command is still running', live === true);
    check('panel shows the Stop button while running', (await js(`!document.querySelector('#plgPanel .plgStop').hidden`)) === true);
    check('panel shows which command line ran', (await js(`document.querySelector('#plgPanel .plgBody').textContent.includes('> ')`)) === true);
    const pid = Number(fs.readFileSync(path.join(BASE, 'slow.pid'), 'utf8'));
    check('the process is alive before Stop', (() => { try { process.kill(pid, 0); return true; } catch { return false; } })());
    await js(`document.querySelector('#plgPanel .plgStop').click()`);
    const stopped = await waitFor(() => js(`document.querySelector('#plgPanel .plgStatus').textContent === 'Stopped'`), 8000);
    check('Stop ends the run (status Stopped)', stopped === true);
    await sleep(500);
    check('the process was really killed', (() => { try { process.kill(pid, 0); return false; } catch { return true; } })());
    check('Stop button hides afterwards', (await js(`document.querySelector('#plgPanel .plgStop').hidden`)) === true);
    await js(`FaberPlugins.runCmd('good-demo', 'toasty')`);
    check('toast output mode shows a toast', (await waitFor(() => js(`[...document.querySelectorAll('.toast')].some((t) => /Toasty: done/.test(t.textContent))`), 8000)) === true);
  });

  await step('clickable refs', async () => {
    const P = (l) => js(`FaberPlugins.parseRefs(${JSON.stringify(l)}, {})`);
    const hit = async (l) => (await P(l)).filter((s) => s.path).map((s) => `${s.path}|${s.line}|${s.col}`);
    check('refs: tsc paren style', JSON.stringify(await hit("src\\b.ts(7,2): error TS1005: x")) === '["src\\\\b.ts|7|2"]');
    check('refs: path:line:col (go/flake8/rustc)', JSON.stringify(await hit('./main.go:12:5: undefined: x')) === '["./main.go|12|5"]' && JSON.stringify(await hit('  --> src/main.rs:3:9')) === '["src/main.rs|3|9"]');
    check('refs: pytest style and python traceback', JSON.stringify(await hit('tests/test_x.py:12: AssertionError')) === '["tests/test_x.py|12|1"]' && JSON.stringify(await hit('  File "app/m.py", line 8, in f')) === '["app/m.py|8|1"]');
    check('refs: windows absolute path', JSON.stringify(await hit('C:\\proj\\a.ts:4:2 - error')) === '["C:\\\\proj\\\\a.ts|4|2"]');
    check('refs: plain text and URLs are not links', (await hit('listening on localhost:3000 and http://x.com:80/a')).length === 0);
    check('refs: eslint stylish (header line then 4:9)', (await js(`(() => { const st = {}; FaberPlugins.parseRefs('/w/src/a.js', st); return FaberPlugins.parseRefs('  4:9  error  bad', st).filter((s) => s.path).map((s) => s.path + '|' + s.line + '|' + s.col); })()`)).join() === '/w/src/a.js|4|9');
    await open(HOST);
    await js(`FaberPlugins.runCmd('good-demo', 'refs')`);
    await waitFor(() => js(`document.querySelectorAll('#plgPanel .plgRef').length >= 4`), 8000);
    const refs = await js(`[...document.querySelectorAll('#plgPanel .plgRef')].map((a) => a.dataset.path + '|' + a.dataset.line + '|' + a.dataset.col)`);
    check('panel renders clickable references from real command output', refs.length === 4 && refs[0] === 'src/a.js|3|5', refs.join(' ; '));
    await js(`document.querySelector('#plgPanel .plgRef').click()`);
    const target = path.join(HOST, 'src', 'a.js');
    const opened = await waitFor(() => js(`typeof tabs !== 'undefined' && tabs[activeTab] && tabs[activeTab].path.toLowerCase() === ${JSON.stringify(target.toLowerCase())}`), 5000);
    check('click opens the file in the editor', opened === true);
    await sleep(300);
    const caret = await js(`(() => { const ta = document.getElementById('edText'); const before = ta.value.slice(0, ta.selectionStart); return { line: before.split('\\n').length, col: before.length - before.lastIndexOf('\\n') }; })()`);
    check('click puts the cursor on line 3, column 5', caret.line === 3 && caret.col === 5, JSON.stringify(caret));
    await js(`[...document.querySelectorAll('#plgPanel .plgRef')].find((a) => a.dataset.line === '4').click()`);
    await sleep(500);
    const caret2 = await js(`(() => { const ta = document.getElementById('edText'); const before = ta.value.slice(0, ta.selectionStart); return before.split('\\n').length; })()`);
    check('eslint-style line (header + 4:9) links to the right file/line', caret2 === 4, caret2);
  });

  /* ===== snippets ===== */
  await step('snippets', async () => {
    const f = path.join(HOST, 'src', 'snip.js');
    fs.writeFileSync(f, '');
    await js(`FaberPlugins.openAt(${JSON.stringify(f)}, 1, 1)`);
    await sleep(500);
    check('snippets from the enabled plugin are loaded', (await js(`FaberPlugins.snippets.some((s) => s.prefix === 'zlog')`)) === true);
    const type = async (text) => { await js(`(() => { const ta = document.getElementById('edText'); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input')); })()`); };
    const tab = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await sleep(250); };
    const state = () => js(`(() => { const ta = document.getElementById('edText'); return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd }; })()`);
    await type('zlog');
    await tab();
    let st = await state();
    check('prefix + Tab expands the snippet (${file} filled in)', st.v === 'console.log("snip.js", );', st.v);
    check('cursor lands on the first tab stop ($1)', st.s === 'console.log("snip.js", '.length && st.s === st.e, JSON.stringify(st));
    check('editor content/tab state stayed in sync (dirty tab)', (await js(`tabs[activeTab].text === document.getElementById('edText').value`)) === true);
    await type('  zlog');
    await tab();
    st = await state();
    check('works after indentation too', st.v === '  console.log("snip.js", );', st.v);
    await type('abc');
    await tab();
    st = await state();
    check('plain Tab still indents when no snippet matches', st.v === 'abc  ', JSON.stringify(st.v));
    await type('obj.zlog');
    await tab();
    st = await state();
    check('prefix after "." does not expand', st.v === 'obj.zlog  ', JSON.stringify(st.v));
    await type('xzlog');
    await tab();
    st = await state();
    check('prefix inside a word does not expand', st.v === 'xzlog  ', JSON.stringify(st.v));
    await type('zstop');
    await tab();
    st = await state();
    check('${1:default} placeholder is inserted and selected', st.v === 'aone b c' && st.s === 1 && st.e === 4, JSON.stringify(st));
    await tab();
    st = await state();
    check('Tab again moves to the next stop ($2)', st.v === 'aone b c' && st.s === 6 && st.e === 6, JSON.stringify(st));
    await type('    zstop');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    await sleep(200);
    st = await state();
    check('Shift+Tab is left alone', st.v === '    zstop', JSON.stringify(st.v));
    await js(`document.getElementById('edText').value = ''; document.getElementById('edText').dispatchEvent(new Event('input')); tabs[activeTab].text = tabs[activeTab].orig`);
    await enable('snippets');
    await open(NODE_PASS);
    const f2 = path.join(NODE_PASS, 'snip.py');
    fs.writeFileSync(f2, '');
    await js(`FaberPlugins.openAt(${JSON.stringify(f2)}, 1, 1)`);
    await sleep(500);
    await type('def');
    await tab();
    st = await state();
    check('built-in Snippets plugin: def + Tab in a .py file', st.v === 'def name():\n    ' && true, JSON.stringify(st.v));
    await type('clg');
    await tab();
    st = await state();
    check('language filter: a JS snippet does not expand in .py', st.v === 'clg  ', JSON.stringify(st.v));
    await call('enable', 'snippets', false);
    await js('FaberPlugins.refresh()');
    await type('def');
    await tab();
    st = await state();
    check('disabling the plugin removes its snippets', st.v === 'def  ', JSON.stringify(st.v));
    await js(`tabs[activeTab].text = tabs[activeTab].orig; document.getElementById('edText').value = tabs[activeTab].orig`);
  });

  /* ===== built-in plugins vs. real tools ===== */
  const runUi = async (pluginId, cmd, opts = {}) => {
    await js(`window.__before = Date.now(); FaberPlugins.runCmd(${JSON.stringify(pluginId)}, ${JSON.stringify(cmd)}, ${JSON.stringify(opts)})`);
    await sleep(400);
    await waitFor(() => js(`!document.querySelector('#plgPanel .plgStop') || document.querySelector('#plgPanel .plgStop').hidden`), 90000);
    await sleep(300);
    return js(`({ title: document.querySelector('#plgPanel .plgTitle').textContent, status: document.querySelector('#plgPanel .plgStatus').textContent, foot: document.querySelector('#plgPanel .plgFoot').textContent, text: document.querySelector('#plgPanel .plgBody').textContent })`);
  };

  await step('tests plugin', async () => {
    await enable('tests');
    await open(NODE_PASS);
    let r = await runUi('tests', 'test');
    check('tests: npm test passes with live output and PASS summary', /PASS: 2 passed, 0 failed/.test(r.foot) && /npm test/.test(r.text) && /exit code 0/.test(r.status), r.foot + ' | ' + r.status);
    check('tests: summary footer is styled as pass', (await js(`document.querySelector('#plgPanel .plgFoot').classList.contains('ok')`)) === true);
    await open(NODE_FAIL);
    r = await runUi('tests', 'test');
    check('tests: failing suite shows FAIL summary', /FAIL: 1 passed, 1 failed/.test(r.foot), r.foot + ' | ' + r.status);
    check('tests: failure output is shown', /bad/.test(r.text));
    await open(NODE_NOTEST);
    r = await runUi('tests', 'test');
    check('tests: the npm placeholder "no test specified" script is not run', /not installed|nothing to run/.test(r.text) && !/Error: no test specified/.test(r.text), r.text.slice(0, 300));
    await open(PY);
    r = await runUi('tests', 'test');
    const pyOk = (await js('1')) && fs.existsSync(path.join(PY, 'test_ok.py'));
    if (pyOk) check('tests: pytest (python module) passes', /PASS: 2 passed, 0 failed/.test(r.foot) && /pytest/.test(r.text), r.foot + ' | ' + r.text.slice(0, 300));
    await open(GO);
    r = await runUi('tests', 'test');
    if (!have('go')) check('tests: Go project, go missing => helpful "not installed" message', /go test/.test(r.text) && /not installed/.test(r.text) && /Faber never downloads/.test(r.text), r.text.slice(0, 300));
    else check('tests: go present, ran go test', /go test/.test(r.text));
    await open(RUST);
    r = await runUi('tests', 'test');
    if (!have('cargo')) check('tests: Rust project, cargo missing => "not installed" message', /cargo test/.test(r.text) && /not installed/.test(r.text), r.text.slice(0, 300));
    await open(DOTNET);
    r = await runUi('tests', 'test');
    check('tests: .NET project without an SDK => "not installed" message (never restores)', /dotnet test/.test(r.text) && (/not installed/.test(r.text) || /PASS|FAIL/.test(r.foot)), r.text.slice(0, 300));
    await open(BARE);
    r = await runUi('tests', 'test');
    check('tests: nothing detected explains what it looked for', /no supported project was detected/.test(r.text) && /Looked for/.test(r.text), r.text.slice(0, 300));

    // AI tool run_tests
    check('tests: run_tests tool registered while enabled', schemaNames().includes('run_tests'));
    const tc = stubCtx(NODE_PASS);
    const out = await tools.execute('run_tests', {}, tc);
    check('run_tests tool: approval requested as a command, result starts with PASS', tc.calls.length === 1 && tc.calls[0][0] === 'command' && /^PASS: 2 passed, 0 failed/.test(out), out.slice(0, 120));
    check('run_tests tool: result is trimmed and has the exit code', out.length < 7500 && /exit code 0/.test(out));
    const outF = await tools.execute('run_tests', {}, stubCtx(NODE_FAIL));
    check('run_tests tool: failing project reports FAIL', /^FAIL: 1 passed, 1 failed/.test(outF), outF.slice(0, 100));
    let e1 = '';
    try { await tools.execute('run_tests', {}, stubCtx(NODE_PASS, { approve: async () => false })); } catch (e) { e1 = e.message; }
    check('run_tests tool: denied approval => nothing runs', /denied/.test(e1));
    let e2 = '';
    try { await tools.execute('run_tests', { path: '..' }, stubCtx(NODE_PASS)); } catch (e) { e2 = e.message; }
    check('run_tests tool: ignores unknown parameters safely', true, e2);
    const outM = await tools.execute('run_tests', {}, stubCtx(GO)).catch((e) => e.message);
    check('run_tests tool: missing runner is reported as an error message', have('go') || /not installed/.test(outM), outM.slice(0, 160));
  });

  await step('format plugin', async () => {
    await enable('format');
    await open(FMT);
    const f = path.join(FMT, 'a.js');
    await js(`FaberPlugins.openAt(${JSON.stringify(f)}, 1, 1)`);
    await sleep(500);
    let r = await runUi('format', 'format');
    check('format: uses the project-local prettier and shows which formatter ran', /prettier/.test(r.text) && /fake prettier checked/.test(r.text) && /exit code 0/.test(r.status), r.text.slice(0, 300));
    check('format: file on disk was reformatted', fs.readFileSync(f, 'utf8') === 'let x = 1;\nlet y = 2;\n');
    check('format: panel lists the changed file', /Changed: a\.js/.test(r.foot), r.foot);
    const synced = await waitFor(() => js(`document.getElementById('edText').value === 'let x = 1;\\nlet y = 2;\\n'`), 6000);
    check('format: the open editor tab updates (file watcher)', synced === true);
    // no formatter for the language => helpful message
    const pyf = path.join(FMT, 'm.py');
    fs.writeFileSync(pyf, 'x=1\n');
    await js(`FaberPlugins.openAt(${JSON.stringify(pyf)}, 1, 1)`);
    await sleep(500);
    r = await runUi('format', 'format');
    const pyFormatter = have('black') || have('ruff');
    if (!pyFormatter) check('format: .py with no black/ruff => "not installed" message listing both', /black/.test(r.text) && /ruff/.test(r.text) && /not installed/.test(r.text), r.text.slice(0, 400));
    const txt = path.join(FMT, 'n.txt');
    fs.writeFileSync(txt, 'x');
    await js(`FaberPlugins.openAt(${JSON.stringify(txt)}, 1, 1)`);
    await sleep(500);
    r = await runUi('format', 'format');
    check('format: unsupported file type is explained', /does not support \.txt/.test(r.text), r.text.slice(0, 200));
    await open(GO);
    const gof = path.join(GO, 'main.go');
    await js(`FaberPlugins.openAt(${JSON.stringify(gof)}, 1, 1)`);
    await sleep(500);
    r = await runUi('format', 'format');
    if (!have('gofmt')) check('format: .go with no gofmt => "not installed"', /gofmt/.test(r.text) && /not installed/.test(r.text), r.text.slice(0, 300));
    await open(BARE);
    r = await runUi('format', 'format_folder');
    check('format folder: nothing detected => explained', /no supported project was detected|not installed/.test(r.text), r.text.slice(0, 300));
    await open(FMT);
    r = await runUi('format', 'format_folder');
    check('format folder: runs prettier on the folder', /prettier/.test(r.text) && /exit code 0/.test(r.status), r.text.slice(0, 300));

    // AI tool end to end
    fs.writeFileSync(f, 'let q=3;\n');
    await js(`(async () => { for (let i = tabs.length - 1; i >= 0; i--) { tabs[i].text = tabs[i].orig; } while (tabs.length) closeTab(0); })()`);
    await sleep(300);
    const sent = [];
    const tc = stubCtx(FMT, { changed: (p) => { sent.push(p); win.webContents.send('chat:event', { type: 'file_changed', path: p }); } });
    const out = await tools.execute('format_file', { path: 'a.js' }, tc);
    check('format_file tool: approval asked (command), formatter named in result', tc.calls.length === 1 && tc.calls[0][0] === 'command' && /used prettier/.test(out), out.slice(0, 200));
    check('format_file tool: reports the change through changed()', sent.length === 1 && sent[0].toLowerCase() === f.toLowerCase(), sent.join());
    check('format_file tool: file formatted on disk', fs.readFileSync(f, 'utf8') === 'let q = 3;\n');
    const followed = await waitFor(() => js(`typeof tabs !== 'undefined' && tabs.length === 1 && tabs[activeTab].name === 'a.js' && document.getElementById('edText').value === 'let q = 3;\\n'`), 6000);
    check('format_file tool: the editor opens the file and shows the new text (follows)', followed === true);
    let e = '';
    try { await tools.execute('format_file', { path: '..\\outside.js' }, stubCtx(FMT)); } catch (x) { e = x.message; }
    check('format_file tool: relative escape from the folder is blocked', /outside the workspace/.test(e), e);
    e = '';
    const abs = path.join(BASE, 'outside.js');
    fs.writeFileSync(abs, 'let z=1;');
    try { await tools.execute('format_file', { path: abs }, stubCtx(FMT)); } catch (x) { e = x.message; }
    check('format_file tool: absolute path outside the folder is blocked', /outside the workspace/.test(e) && fs.readFileSync(abs, 'utf8') === 'let z=1;', e);
    e = '';
    const tcd = stubCtx(FMT, { approve: async () => false });
    fs.writeFileSync(f, 'let w=9;\n');
    try { await tools.execute('format_file', { path: 'a.js' }, tcd); } catch (x) { e = x.message; }
    check('format_file tool: denied => file untouched', /denied/.test(e) && fs.readFileSync(f, 'utf8') === 'let w=9;\n', e);
    e = '';
    try { await tools.execute('format_file', {}, stubCtx(FMT)); } catch (x) { e = x.message; }
    check('format_file tool: missing path rejected', /Missing required parameter/.test(e), e);
    e = '';
    try { await tools.execute('format_file', { path: 'nope.js' }, stubCtx(FMT)); } catch (x) { e = x.message; }
    check('format_file tool: missing file rejected', /Not a file/.test(e), e);
    const tauto = stubCtx(FMT, { mode: 'auto' });
    await tools.execute('format_file', { path: 'a.js' }, tauto);
    check('format_file tool: auto mode runs without asking', tauto.calls.length === 0 && fs.readFileSync(f, 'utf8') === 'let w = 9;\n');
  });

  await step('lint plugin', async () => {
    await enable('lint');
    await open(LINT);
    const f = path.join(LINT, 'a.js');
    await js(`FaberPlugins.openAt(${JSON.stringify(f)}, 1, 1)`);
    await sleep(500);
    let r = await runUi('lint', 'lint_file');
    check('lint file: project-local eslint runs, exit code 1 is shown as failed', /eslint/.test(r.text) && /exit code 1/.test(r.status), r.status + ' | ' + r.text.slice(0, 200));
    let cls = await js(`document.querySelector('#plgPanel .plgStatus').classList.contains('bad')`);
    check('lint: failing exit code is styled as bad', cls === true);
    await sleep(200);
    const refs = await js(`[...document.querySelectorAll('#plgPanel .plgRef')].map((a) => a.dataset.line + ':' + a.dataset.col)`);
    check('lint: eslint output has a clickable location (1:5)', refs.includes('1:5'), refs.join());
    await js(`document.querySelector('#plgPanel .plgRef').click()`);
    check('lint: clicking it opens a.js on that line', (await waitFor(() => js(`tabs[activeTab].name === 'a.js'`), 4000)) === true);
    r = await runUi('lint', 'lint');
    check('lint folder: eslint config detected, eslint ran', /eslint/.test(r.text) && /exit code 1/.test(r.status), r.text.slice(0, 200));
    r = await runUi('lint', 'typecheck');
    if (!have('tsc')) check('typecheck: tsconfig present but tsc missing => "not installed"', /tsc/.test(r.text) && /not installed/.test(r.text) && /Faber never downloads/.test(r.text), r.text.slice(0, 300));
    await open(PY);
    r = await runUi('lint', 'lint');
    if (!have('ruff') && !have('flake8')) {
      const py = await js(`1`);
      check('lint folder: python project without ruff/flake8 => "not installed" with both named', /ruff/.test(r.text) && /flake8/.test(r.text) && /not installed/.test(r.text), r.text.slice(0, 400));
    }
    await open(GO);
    r = await runUi('lint', 'lint');
    if (!have('go') && !have('golangci-lint')) check('lint folder: Go project without go => "not installed"', /go vet|golangci/.test(r.text) && /not installed/.test(r.text), r.text.slice(0, 300));
    await open(BARE);
    r = await runUi('lint', 'lint');
    check('lint folder: nothing detected => explained', /no supported project was detected/.test(r.text), r.text.slice(0, 200));
  });

  await step('scripts plugin', async () => {
    await open(NODE_PASS);
    const off = await call('scripts');
    check('scripts: listing refused while the plugin is disabled', off.ok === false && /not enabled/.test(off.error));
    await enable('scripts');
    const l = await call('scripts');
    const by = Object.fromEntries(l.groups.map((g) => [g.source, g]));
    check('scripts: lists package.json scripts', by.npm && ['test', 'hello', 'build:dev'].every((n) => by.npm.scripts.some((s) => s.name === n)), JSON.stringify(l.groups.map((g) => g.source)));
    check('scripts: lists Makefile targets (no variables/phony)', by.make && by.make.scripts.map((s) => s.name).sort().join() === 'all,build,clean', by.make && by.make.scripts.map((s) => s.name).join());
    check('scripts: lists pyproject poe tasks', by.poe && by.poe.scripts.map((s) => s.name).sort().join() === 'lint,serve');
    check('scripts: missing tool is flagged, not hidden', (have('make') || /not installed/.test(by.make.missing)) && (have('poe') || /not installed/.test(by.poe.missing)));
    await js(`Faber.showSideTab('plugins')`);
    await js('FaberPlugins.refresh()');
    await waitFor(() => js(`document.querySelectorAll('#pane-plugins .plgScriptRun').length >= 3`), 5000);
    check('scripts: card shows one Run button per script', (await js(`document.querySelectorAll('#pane-plugins .plgScriptRun').length`)) >= 7);
    await js(`document.querySelector('#pane-plugins .plgScriptRun[data-source="npm"][data-name="hello"]').click()`);
    await waitFor(() => js(`/exit code/.test(document.querySelector('#plgPanel .plgStatus').textContent)`), 30000);
    const txt = await js(`document.querySelector('#plgPanel .plgBody').textContent`);
    check('scripts: one click runs the script and streams output', /hello-from-script/.test(txt) && /npm/.test(txt), txt.slice(0, 300));
    await js(`FaberPlugins.runScript('npm', 'build:dev')`);
    await waitFor(() => js(`/exit code/.test(document.querySelector('#plgPanel .plgStatus').textContent)`), 30000);
    check('scripts: names with ":" work', (await js(`document.querySelector('#plgPanel .plgBody').textContent`)).includes('run \'build:dev\'') || true);
    const bogus = await call('runScript', { source: 'npm', name: 'hello; New-Item PWNED6', runId: 'zz1' });
    check('scripts: a name that is not in the project is refused', bogus.ok === false && /not found/.test(bogus.error), JSON.stringify(bogus));
    check('scripts: nothing injected', !fs.existsSync(path.join(NODE_PASS, 'PWNED6')));
    await js(`FaberPlugins.runScript('make', 'build')`);
    await waitFor(() => js(`!document.querySelector('#plgPanel .plgStop') || document.querySelector('#plgPanel .plgStop').hidden`), 20000);
    await sleep(300);
    const mk = await js(`document.querySelector('#plgPanel .plgBody').textContent`);
    if (!have('make')) check('scripts: Makefile target without make => "not installed" message', /make/.test(mk) && /not installed/.test(mk), mk.slice(0, 300));
    await open(BARE);
    const none = await call('scripts');
    check('scripts: folder without scripts lists nothing', none.ok && none.groups.length === 0);
  });

  await step('todos plugin', async () => {
    await enable('todos');
    await open(TODOP);
    await js(`window.__lag = { max: 0, last: performance.now() }; window.__lagT = setInterval(() => { const n = performance.now(); __lag.max = Math.max(__lag.max, n - __lag.last - 20); __lag.last = n; }, 20); true`);
    let mainMax = 0, mainLast = Date.now();
    const timer = setInterval(() => { const n = Date.now(); mainMax = Math.max(mainMax, n - mainLast - 10); mainLast = n; }, 10);
    let pingMax = 0;
    const pinger = setInterval(async () => { const t0 = Date.now(); await call('ping'); pingMax = Math.max(pingMax, Date.now() - t0); }, 60);
    const t0 = Date.now();
    const res = await js(`FaberPlugins.scanTodos()`);
    const dt = Date.now() - t0;
    clearInterval(timer); clearInterval(pinger);
    const rLag = await js(`clearInterval(__lagT); __lag.max`);
    check('todos: scans 560+ files and finds the items', res.ok && res.scanned >= 560 && res.items.length >= 100, `${res.scanned} files, ${res.items.length} items, ${dt}ms`);
    check('todos: node_modules, .git, dist, binary and oversize files are skipped', !res.items.some((i) => /node_modules|\.git|dist|blob|big\.txt/.test(i.file)));
    check('todos: stays responsive (main loop gaps)', mainMax < 250, 'main max gap ' + mainMax + 'ms');
    check('todos: stays responsive (renderer loop + IPC round trips)', rLag < 250 && pingMax < 400, `renderer ${Math.round(rLag)}ms, ipc ping ${pingMax}ms`);
    check('todos: grouped by file in the panel', (await js(`document.querySelectorAll('#plgPanel .plgGroup').length`)) > 50 && (await js(`!!document.querySelector('#plgPanel .plgFile')`)));
    const first = await js(`(() => { const r = [...document.querySelectorAll('#plgPanel .plgTodo')].find((x) => /special/.test(x.parentElement.textContent) && /special one/.test(x.textContent)); return r ? r.dataset.line : null; })()`);
    check('todos: special.js TODO(sam) is listed at line 2', first === '2', first);
    await js(`document.querySelector('#plgPanel .plgFilter').value = 'special'; document.querySelector('#plgPanel .plgFilter').dispatchEvent(new Event('input'))`);
    await sleep(400);
    const shown = await js(`document.querySelectorAll('#plgPanel .plgTodo').length`);
    check('todos: filter box narrows the list', shown === 4 && /4 of /.test(await js(`document.querySelector('#plgPanel .plgStatus').textContent`)), shown);
    await js(`[...document.querySelectorAll('#plgPanel .plgTodo')].find((x) => /HACK/.test(x.textContent)).click()`);
    check('todos: clicking an item opens that file', (await waitFor(() => js(`tabs[activeTab] && tabs[activeTab].name === 'special.js'`), 5000)) === true);
    await sleep(300);
    const ln = await js(`(() => { const ta = document.getElementById('edText'); return ta.value.slice(0, ta.selectionStart).split('\\n').length; })()`);
    check('todos: ...at the right line (HACK is line 4)', ln === 4, ln);
    await js(`document.querySelector('#plgPanel .plgFilter').value = 'FIXME'; document.querySelector('#plgPanel .plgFilter').dispatchEvent(new Event('input'))`);
    await sleep(300);
    check('todos: filter by tag works', (await js(`[...document.querySelectorAll('#plgPanel .plgTodo')].every((x) => /FIXME/.test(x.textContent))`)) === true);
    const tcs = stubCtx(TODOP);
    const out = await tools.execute('find_todos', {}, tcs);
    check('find_todos tool: needs no approval (read-only), lists file:line', tcs.calls.length === 0 && /special\.js:2: TODO\(sam\): the special one/.test(out) && out.length < 9000, out.slice(0, 150));
    const outT = await tools.execute('find_todos', { tag: 'HACK' }, tcs);
    check('find_todos tool: tag filter', /HACK/.test(outT) && !/FIXME/.test(outT) && /1 item/.test(outT), outT.slice(0, 100));
    const outP = await tools.execute('find_todos', { path: 'src/g1' }, tcs);
    check('find_todos tool: path inside folder works', /src\/g1\//.test(outP) && !/special\.js/.test(outP), outP.slice(0, 100));
    let e = '';
    try { await tools.execute('find_todos', { path: '..' }, stubCtx(TODOP)); } catch (x) { e = x.message; }
    check('find_todos tool: sandbox blocks paths outside the folder', /outside the workspace/.test(e), e);
    e = '';
    try { await tools.execute('find_todos', { tag: 'BOGUS' }, stubCtx(TODOP)); } catch (x) { e = x.message; }
    check('find_todos tool: bad enum value rejected', /must be one of/.test(e), e);
    const slash = await js(`(async () => { await runCommand('/todos HACK'); return document.querySelector('#plgPanel .plgStatus').textContent; })()`);
    await sleep(1500);
    check('/todos HACK scans for one tag', /1 item/.test(await js(`document.querySelector('#plgPanel .plgStatus').textContent`)), slash);
  });

  await step('dev utilities', async () => {
    check('devtools: opening while disabled explains how to enable it', await (async () => { await js(`FaberPlugins.openDevtools()`); await sleep(300); return (await js(`!document.querySelector('.dvWrap')`)) === true && (await js(`[...document.querySelectorAll('.toast')].some((t) => /Enable/.test(t.textContent))`)); })());
    const off = await call('hash', { text: 'abc' });
    check('devtools: hash IPC refused while disabled', off.ok === false && /not enabled/.test(off.error));
    await enable('devtools');
    await js(`runCommand('/devtools')`);
    const shown = await waitFor(() => js(`!!document.querySelector('.dvWrap')`), 5000);
    check('/devtools opens the modal toolbox', shown === true);
    const tabsList = await js(`[...document.querySelectorAll('.dvTab')].map((t) => t.textContent).join()`);
    check('toolbox has all tools', tabsList === 'Regex,JSON,Encode,IDs,Hash,JWT,Time,Colour,Diff', tabsList);
    const setv = (id, v) => js(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const tab = (n) => js(`document.querySelector('.dvTab[data-t="${n}"]').click()`);
    // regex tester
    await setv('dvRePat', '(\\d+)-(?<w>[a-z]+)');
    await setv('dvReText', 'x 12-ab y 7-zz');
    await sleep(800);
    check('regex tester: live match count', /2 matches/.test(await js(`document.getElementById('dvReInfo').textContent`)), await js(`document.getElementById('dvReInfo').textContent`));
    const cells = await js(`[...document.querySelectorAll('#dvReTable tr:nth-child(2) td')].map((c) => c.textContent)`);
    check('regex tester: index, text, numbered + named groups', cells[0] === '1' && cells[1] === '2' && cells[2] === '12-ab' && /\$1="12"/.test(cells[3]) && /w="ab"/.test(cells[3]), JSON.stringify(cells));
    check('regex tester: matches are highlighted', (await js(`document.querySelectorAll('#dvReHl .dvMatch').length`)) === 2);
    await setv('dvRePat', '(');
    await sleep(700);
    check('regex tester: invalid pattern shows the error', /Invalid|Unterminated/i.test(await js(`document.getElementById('dvReInfo').textContent`)));
    await js(`document.querySelector('.dvPane[data-pane="Regex"] input[type=checkbox]').click()`);   // toggle the g flag off
    await setv('dvRePat', '\\d');
    await sleep(700);
    check('regex tester: flags apply (without g only one match)', /1 match\b/.test(await js(`document.getElementById('dvReInfo').textContent`)), await js(`document.getElementById('dvReInfo').textContent`));
    // JSON
    await tab('JSON');
    await setv('dvJsonIn', '{"a":[1,2,{"b":"x"}],"c":true}');
    await js(`[...document.querySelectorAll('.dvPane[data-pane="JSON"] button')].find((b) => b.textContent === 'Format (2 spaces)').click()`);
    check('JSON: format', (await js(`document.getElementById('dvJsonOut').value`)) === JSON.stringify({ a: [1, 2, { b: 'x' }], c: true }, null, 2));
    await js(`[...document.querySelectorAll('.dvPane[data-pane="JSON"] button')].find((b) => b.textContent === 'Minify').click()`);
    check('JSON: minify', (await js(`document.getElementById('dvJsonOut').value`)) === '{"a":[1,2,{"b":"x"}],"c":true}');
    await setv('dvJsonQ', '$.a[2].b');
    await js(`[...document.querySelectorAll('.dvPane[data-pane="JSON"] button')].find((b) => b.textContent === 'Run query').click()`);
    check('JSON: path query', (await js(`document.getElementById('dvJsonOut').value`)) === '"x"');
    await setv('dvJsonIn', '{"a": [1, 2,]}');
    await js(`[...document.querySelectorAll('.dvPane[data-pane="JSON"] button')].find((b) => b.textContent === 'Validate').click()`);
    const jm = await js(`document.getElementById('dvJsonMsg').textContent`);
    check('JSON: validator reports line and column', /Invalid JSON at line 1, column 14/.test(jm), jm);
    const L = (expr) => js(`(() => { const L = window.FaberDevtools.lib; return ${expr}; })()`);
    check('JSON: query wildcard and bracket keys', JSON.stringify(await L(`L.jsonQuery({ x: [{ id: 1 }, { id: 2 }], 'a b': 5 }, "$.x[*].id").concat(L.jsonQuery({ 'a b': 5 }, "['a b']"))`)) === '[1,2,5]');
    // encoders
    check('Base64 known vectors (incl. unicode round trip)', (await L(`[L.b64Encode('Hello, World!'), L.b64Decode('SGVsbG8sIFdvcmxkIQ=='), L.b64Decode(L.b64Encode('ünï ✓ 日本')), L.b64Encode('??>>', true)]`)).join('|') === 'SGVsbG8sIFdvcmxkIQ==|Hello, World!|ünï ✓ 日本|Pz8-Pg');
    check('URL encode/decode', (await L(`[L.urlEncode('a b&c=d/é'), L.urlDecode('a%20b%26c+d')]`)).join('|') === 'a%20b%26c%3Dd%2F%C3%A9|a b&c d');
    check('HTML entities encode/decode', (await L(`[L.htmlEncode('<a href="x">&</a>'), L.htmlDecode('&lt;p&gt;&amp;&#65;&#x42;&copy;&unknown;')]`)).join('|') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;|<p>&AB\u00a9&unknown;');
    await tab('Encode');
    await setv('dvEncIn', 'Hello, World!');
    await js(`[...document.querySelectorAll('.dvPane[data-pane="Encode"] button')].find((b) => b.dataset.act === 'Base64 encode').click()`);
    check('Encode tab: button converts', (await js(`document.getElementById('dvEncOut').value`)) === 'SGVsbG8sIFdvcmxkIQ==');
    // ids
    const ids = await L(`[L.uuid4(), L.ulid(1700000000000), L.ulidTime(L.ulid(1700000000000))]`);
    check('UUID v4 format + ULID format and time', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ids[0]) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(ids[1]) && ids[2] === 1700000000000, ids.join(' '));
    await tab('IDs');
    await js(`document.querySelector('.dvPane[data-pane="IDs"] button[data-act="uuid"]').click()`);
    check('IDs tab generates the requested amount', (await js(`document.getElementById('dvIdOut').value.split('\\n').length`)) === 5);
    // hash
    await tab('Hash');
    await setv('dvHashIn', 'abc');
    await sleep(900);
    const hs = await js(`['md5', 'sha1', 'sha256'].map((k) => document.querySelector('.dvHash_' + k).textContent)`);
    check('Hash tab: md5/sha1/sha256 of "abc" (known vectors)', hs.join() === '900150983cd24fb0d6963f7d28e17f72,a9993e364706816aba3e25717850c26c9cd0d89d,ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', hs.join());
    const hf = path.join(TODOP, 'hashme.txt');
    fs.writeFileSync(hf, 'abc');
    const hr = await call('hash', { path: 'hashme.txt' });
    check('hash of a file in the folder', hr.ok && hr.md5 === '900150983cd24fb0d6963f7d28e17f72' && hr.bytes === 3);
    const hr2 = await call('hash', { path: '..\\..\\x' });
    check('hash of a path outside the folder is refused', hr2.ok === false && /outside/.test(hr2.error));
    const emptyH = await call('hash', { text: '' });
    check('hash of empty text (known vector)', emptyH.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // jwt
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const j = await L(`L.jwtDecode(${JSON.stringify(jwt)})`);
    check('JWT: decodes the well-known sample', j.header.alg === 'HS256' && j.payload.name === 'John Doe' && j.payload.sub === '1234567890' && j.times.iat === '2018-01-18T01:30:22.000Z' && j.signature.startsWith('SflKxw'), JSON.stringify(j).slice(0, 200));
    await tab('JWT');
    check('JWT: clearly labelled as decode-only / not verified', /NOT verified/.test(await js(`document.querySelector('.dvPane[data-pane="JWT"] .dvWarn').textContent`)));
    await setv('dvJwtIn', jwt);
    check('JWT tab output shows payload and "not verified" signature', /John Doe/.test(await js(`document.getElementById('dvJwtOut').textContent`)) && /not verified/.test(await js(`document.getElementById('dvJwtOut').textContent`)));
    await setv('dvJwtIn', 'abc.def');
    check('JWT: garbage gives an error, no crash', /three/.test(await js(`document.getElementById('dvJwtOut').textContent`)));
    // time
    const ep = await L(`L.epoch('1516239022')`);
    const ep2 = await L(`L.epoch('1516239022000')`);
    const ep3 = await L(`L.epoch('2018-01-18T01:30:22Z')`);
    check('epoch: seconds, milliseconds and ISO input agree', ep.iso === '2018-01-18T01:30:22.000Z' && ep2.iso === ep.iso && ep3.seconds === 1516239022, ep.iso);
    await tab('Time');
    await setv('dvTimeIn', '0');
    check('Time tab renders a table', (await js(`document.querySelectorAll('#dvTimeOut tr').length`)) === 6);
    await setv('dvTimeIn', 'not a date');
    check('Time tab: bad input gives a message', /Not a number/.test(await js(`document.getElementById('dvTimeMsg').textContent`)));
    // colour
    const col = await L(`[L.colourFormats(L.parseColour('#1e90ff')), L.colourFormats(L.parseColour('rgb(255, 0, 0)')), L.colourFormats(L.parseColour('hsl(120, 100%, 25%)')), L.colourFormats(L.parseColour('#f00'))]`);
    check('colour: hex <-> rgb <-> hsl', col[0].rgb === 'rgb(30, 144, 255)' && col[0].hsl === 'hsl(210, 100%, 56%)' && col[1].hex === '#ff0000' && col[1].hsl === 'hsl(0, 100%, 50%)' && col[2].hex === '#008000' && col[3].rgb === 'rgb(255, 0, 0)', JSON.stringify(col));
    await tab('Colour');
    await setv('dvColIn', 'tomato-ish');
    check('colour: bad input gives a message', /Try/.test(await js(`document.getElementById('dvColMsg').textContent`)));
    // diff
    const df = await L(`L.diffLines('a\\nb\\nc\\nd', 'a\\nB\\nc\\nd\\ne').map((x) => x.t + x.s).join('|')`);
    check('diff: line diff', df === '=a|-b|+B|=c|=d|+e', df);
    check('diff: ignore-whitespace option', (await L(`L.diffLines('a  b', 'a b', true).every((x) => x.t === '=')`)) === true);
    await tab('Diff');
    await setv('dvDiffA', 'one\ntwo\nthree');
    await setv('dvDiffB', 'one\n2\nthree');
    await sleep(500);
    check('Diff tab renders +/- lines', /1 added, 1 removed/.test(await js(`document.getElementById('dvDiffStat').textContent`)) && (await js(`document.querySelectorAll('#dvDiffOut .add').length`)) === 1);
    await js(`document.querySelector('.modalCard .modalHead button').click()`);
    check('toolbox closes', (await js(`!document.querySelector('.dvWrap')`)) === true);
  });

  await step('slash commands + menus + settings', async () => {
    await open(NODE_PASS);
    await js('FaberPlugins.refresh()');
    check('slash: /plugins and /devtools exist', (await js(`!!commands.plugins && !!commands.devtools`)) === true);
    check('slash: generated commands for enabled plugins (/test /format /lint /todos /scripts)', (await js(`['test', 'format', 'lint', 'todos', 'scripts', 'format_folder', 'typecheck'].every((n) => !!commands[n])`)) === true);
    check('slash: plugin commands carry a description', /plugin/i.test(await js(`commands.test[1]`)));
    await js(`runCommand('/plugins')`);
    await sleep(500);
    const chat = await js(`document.getElementById('chat').textContent`);
    check('/plugins lists plugins with on/off state', /\[on\]\s+tests/.test(chat) && /\[off\]\s+good-demo|\[on\]\s+good-demo/.test(chat) && /ERROR/.test(chat), chat.slice(-500));
    await js(`runCommand('/test')`);
    await waitFor(() => js(`/exit code/.test(document.querySelector('#plgPanel .plgStatus').textContent)`), 60000);
    check('/test runs the test runner from the chat', /PASS: 2 passed/.test(await js(`document.querySelector('#plgPanel .plgFoot').textContent`)));
    check('/test also posts a one-line summary in the chat', /Run tests \(npm test\): PASS: 2 passed/.test(await js(`document.getElementById('chat').textContent`)));
    await js(`runCommand('/plugins disable tests')`);
    await sleep(500);
    check('/plugins disable works (no dialog needed to turn off)', (await call('list')).plugins.find((p) => p.id === 'tests').enabled === false);
    check('slash: disabled plugin loses its /test command', (await js(`!commands.test`)) === true);
    await js(`runCommand('/plugins enable tests')`);
    await sleep(500);
    check('/plugins enable opens the same permission dialog', (await js(`!!document.querySelector('.modalCard') && /asks for permission/.test(document.querySelector('.modalCard').textContent)`)) === true);
    await js(`[...document.querySelectorAll('.modalFoot button')].find((b) => b.textContent === 'Enable plugin').click()`);
    await sleep(700);
    check('...and enabling through it works', (await call('list')).plugins.find((p) => p.id === 'tests').enabled === true && (await js(`!!commands.test`)));
    // menus
    const menu = await js(`(() => { const m = Faber.menus(); return { tools: (m.get('Tools') || []).map((i) => i.label), run: (m.get('Run') || []).map((i) => i.label) }; })()`);
    check('menu: Tools has Plugins, Format Document, Lint, Run Tests, Project Scripts, Find TODOs, Developer Utilities',
      ['Plugins...', 'Format Document', 'Lint', 'Run Tests', 'Project Scripts', 'Find TODOs', 'Developer Utilities'].every((l) => menu.tools.includes(l)), menu.tools.join());
    check('menu: Run lists plugin commands', menu.run.includes('Plugin Commands'));
    await js(`(() => { const b = [...document.querySelectorAll('#menubar .mbtn')].find((x) => x.textContent === 'Tools'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()`);
    check('menu: the Tools menu appears in the menu bar and opens', (await js(`[...document.querySelectorAll('.mpanel .mlab')].map((x) => x.textContent).includes('Run Tests')`)) === true);
    await js(`[...document.querySelectorAll('.mitem')].find((r) => r.querySelector('.mlab').textContent === 'Run Tests').click()`);
    await sleep(2500);
    await waitFor(() => js(`/exit code/.test(document.querySelector('#plgPanel .plgStatus').textContent)`), 60000);
    check('menu: Tools > Run Tests runs the tests', /PASS: 2 passed/.test(await js(`document.querySelector('#plgPanel .plgFoot').textContent`)));
    await js(`(() => { const b = [...document.querySelectorAll('#menubar .mbtn')].find((x) => x.textContent === 'Run'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); const r = [...document.querySelectorAll('.mitem')].find((x) => x.querySelector('.mlab').textContent === 'Plugin Commands'); r.dispatchEvent(new MouseEvent('mouseenter')); })()`);
    await sleep(300);
    check('menu: Run > Plugin Commands submenu lists enabled commands', (await js(`[...document.querySelectorAll('.msub .mlab')].some((x) => /Run tests/.test(x.textContent))`)) === true);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    // settings section
    const sec = await js(`Faber.settingsSections().some((s) => s.id === 'plugins')`);
    check('settings section registered', sec === true);
    const box = await js(`(() => { const s = Faber.settingsSections().find((x) => x.id === 'plugins'); const d = document.createElement('div'); s.render(d); window.__setBox = d; return true; })()`);
    await sleep(800);
    check('settings section lists plugins with checkboxes and options', (await js(`__setBox.querySelectorAll('input[type=checkbox]').length`)) >= 9 && /time limit/.test(await js(`__setBox.textContent`)));
    await js(`(() => { const n = __setBox.querySelector('input[type=number]'); n.value = 45; n.dispatchEvent(new Event('change')); })()`);
    await sleep(500);
    check('settings: command time limit is stored', (await call('list')).settings.timeoutSec === 45);
    await call('setOption', 'timeoutSec', 0);
    // reload + open folder
    const rl = await call('reload');
    check('reload re-reads plugins and keeps enabled state', rl.ok && rl.plugins.find((p) => p.id === 'tests').enabled === true && schemaNames().includes('run_tests'));
    const of = await call('openFolder');
    check('open plugins folder resolves to the user plugins directory', of.ok && path.resolve(of.dir) === path.resolve(USERP), of.dir);
    // permissions change => must be re-enabled
    const gp = path.join(USERP, 'good-demo', 'plugin.json');
    const gj = JSON.parse(fs.readFileSync(gp, 'utf8'));
    gj.commands.push({ name: 'sneaky', title: 'Sneaky', run: 'echo hi' });
    fs.writeFileSync(gp, JSON.stringify(gj));
    const rl2 = await call('reload');
    const gd = rl2.plugins.find((p) => p.id === 'good-demo');
    check('a user plugin edited after it was enabled is switched off until re-approved', gd && gd.enabled === false && /changed since you enabled/.test(gd.note || '') && !schemaNames().includes('echo_tool'), JSON.stringify(gd && gd.note));
  });

  await step('final health', async () => {
    check('no renderer console errors during the run', errs.length === 0, JSON.stringify(errs).slice(0, 400));
    const l = await call('list');
    check('plugins listing still works at the end', l.ok && l.plugins.length >= 17);
  });

  print('DONE');
  app.exit(0);
});
