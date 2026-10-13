// feature: plugins (main process). Declarative plugins: manifests are data, never code.
// Libraries live in src/plugins-lib/. Built-in plugin definitions are in <app>/plugins/,
// user plugins in <userData>/plugins/<id>/plugin.json. See src/plugins-lib/manifest.js for the format.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../plugins-lib/manifest');
const T = require('../plugins-lib/template');
const P = require('../plugins-lib/plan');
const R = require('../plugins-lib/runner');
const PARSE = require('../plugins-lib/parse');
const TODO = require('../plugins-lib/todo');
const SCRIPTS = require('../plugins-lib/scripts');
const DEV = require('../plugins-lib/devtools');

const SNAP_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next']);

module.exports = function (ctx) {
  const builtinDir = path.join(__dirname, '..', '..', 'plugins');
  const userDir = path.join(ctx.dataDir, 'plugins');
  const entries = new Map();            // id -> {id, source, dir, manifest, errors, hash}
  const toolState = new Map();          // tool name -> {pluginId, schema}
  const jobs = new Map();               // runId -> {kill}
  const cancelled = new Set();
  const notes = new Map();              // id -> message ("permissions changed, enable again")

  const cfg = () => ctx.featureSettings('plugins') || {};
  const enabledMap = () => cfg().enabled || {};
  const isEnabled = (id) => !!enabledMap()[id] && entries.has(id) && !!entries.get(id).manifest;
  const setEnabled = (map) => ctx.setFeatureSettings('plugins', { enabled: map });
  const fingerprint = (e) => (e.source === 'builtin'
    ? crypto.createHash('sha256').update(JSON.stringify([...e.manifest.permissions].sort())).digest('hex')
    : e.hash);

  /* ---------------- loading ---------------- */
  function load() {
    entries.clear();
    const all = [...M.scanDir(builtinDir, 'builtin'), ...M.scanDir(userDir, 'user')];
    for (const e of all) {
      if (e.source === 'user' && entries.has(e.id) && entries.get(e.id).source === 'builtin') {
        e.manifest = null; e.errors = [`id "${e.id}" is used by a built-in plugin`]; e.id = 'user-' + path.basename(e.dir);
      }
      if (entries.has(e.id)) { e.manifest = null; e.errors = ['duplicate plugin id']; e.id = e.id + '#' + entries.size; }
      entries.set(e.id, e);
    }
    // enabled plugins whose permissions/manifest changed must be reviewed again
    const map = { ...enabledMap() };
    let dirty = false;
    notes.clear();
    for (const [id, fp] of Object.entries(map)) {
      const e = entries.get(id);
      if (!e || !e.manifest) { if (!e) { delete map[id]; dirty = true; } continue; }
      if (fp !== fingerprint(e)) { delete map[id]; dirty = true; notes.set(id, 'This plugin changed since you enabled it. Review its permissions and enable it again.'); }
    }
    if (dirty) setEnabled(map);
    syncTools();
  }

  /* ---------------- AI tools ---------------- */
  function schemaFor(t) {
    const props = {};
    for (const [k, p] of Object.entries(t.properties)) {
      props[k] = { type: p.type === 'integer' ? 'number' : p.type, description: (p.description || k) + (p.format === 'path' ? ' (relative to the project folder)' : '') };
      if (p.enum && p.enum.length) props[k].enum = p.enum;
    }
    return ctx.tools.helpers.fn(t.name, t.description, props, t.required);
  }

  function removeTool(name) {
    const st = toolState.get(name);
    if (!st) return;
    const i = ctx.tools.schemas.indexOf(st.schema);
    if (i >= 0) ctx.tools.schemas.splice(i, 1);
    toolState.delete(name);
  }

  function syncTools() {
    const want = new Map();
    for (const [id, e] of entries) if (isEnabled(id)) for (const t of e.manifest.tools) want.set(t.name, { id, t });
    for (const name of [...toolState.keys()]) removeTool(name);     // rebuild: definitions may have changed
    for (const [name, { id, t }] of want) {
      const taken = ctx.tools.schemas.some((s) => s.function.name === name);
      if (taken) { notes.set(id, `Tool name "${name}" is already used by another tool, so it was not offered to the AI.`); continue; }
      const schema = schemaFor(t);
      ctx.tools.registerTool(schema, (args, tc) => runTool(id, name, args, tc));
      toolState.set(name, { pluginId: id, schema });
    }
  }

  /* ---------------- helpers ---------------- */
  const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

  // Resolve a path the AI (or UI) gave us. With the sandbox on it must stay inside the workspace.
  function resolveInside(tc, p) {
    const ws = tc.workspace;
    const abs = path.resolve(ws, String(p === undefined || p === '' ? '.' : p));
    if (tc.sandbox !== false) {
      const out = () => new Error(`Path is outside the workspace (${ws}). Open a different folder to work there.`);
      const rel = path.relative(ws, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw out();
      let probe = abs;
      while (probe && !fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
      const rp = realOf(probe), rw = realOf(ws);
      if (rp && rw) { const r2 = path.relative(rw, rp); if (r2.startsWith('..') || path.isAbsolute(r2)) throw out(); }
    }
    return abs;
  }

  function checkParams(t, args) {
    const values = {};
    for (const [k, p] of Object.entries(t.properties)) {
      let v = args[k];
      if (v === undefined || v === null || v === '') {
        if (t.required.includes(k)) throw new Error(`Missing required parameter "${k}".`);
        continue;
      }
      if (p.type === 'string') {
        if (typeof v !== 'string') throw new Error(`Parameter "${k}" must be a string.`);
        if (p.maxLength && v.length > p.maxLength) throw new Error(`Parameter "${k}" is too long.`);
        if (p.enum && p.enum.length && !p.enum.includes(v)) throw new Error(`Parameter "${k}" must be one of: ${p.enum.join(', ')}.`);
        if (p.pattern && !new RegExp(p.pattern).test(v)) throw new Error(`Parameter "${k}" has an invalid format.`);
      } else if (p.type === 'boolean') {
        if (typeof v === 'string') v = v === 'true';
        if (typeof v !== 'boolean') throw new Error(`Parameter "${k}" must be true or false.`);
      } else {
        v = Number(v);
        if (!Number.isFinite(v) || (p.type === 'integer' && !Number.isInteger(v))) throw new Error(`Parameter "${k}" must be a number.`);
        if (p.minimum !== undefined && v < p.minimum) throw new Error(`Parameter "${k}" is below the minimum.`);
        if (p.maximum !== undefined && v > p.maximum) throw new Error(`Parameter "${k}" is above the maximum.`);
      }
      values[k] = v;
    }
    return values;
  }

  function checkArg(cmd, raw) {
    const a = cmd.arg;
    const v = raw === undefined || raw === null ? '' : String(raw);
    if (!a) return undefined;
    if (!v) { if (a.required) throw new Error(`${a.label} is required.`); return ''; }
    if (a.pattern && !new RegExp(a.pattern).test(v)) throw new Error(`${a.label} has an invalid format.`);
    return v;
  }

  function commandDef(cmd) {
    return { title: cmd.title, scope: cmd.scope, appliesTo: cmd.appliesTo, cwd: cmd.cwd, env: cmd.env, candidates: cmd.candidates };
  }

  function snapshot(target, isDir) {
    const snap = new Map();
    const add = (p) => { try { const s = fs.statSync(p); snap.set(p, `${s.mtimeMs}:${s.size}`); } catch { /* gone */ } };
    if (!isDir) { add(target); return snap; }
    const stack = [target];
    while (stack.length && snap.size < 3000) {
      const d = stack.pop();
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SNAP_SKIP.has(e.name)) stack.push(path.join(d, e.name)); } else add(path.join(d, e.name));
      }
    }
    return snap;
  }
  const changedFiles = (before, after) => {
    const out = [];
    for (const [p, sig] of after) if (before.get(p) !== sig) out.push(p);
    return out;
  };

  function userTimeout(def) {
    const s = Number(cfg().timeoutSec);
    return (s >= 5 && s <= 1800 ? s : def) * 1000;
  }

  /* ---------------- running AI tools ---------------- */
  async function runTool(pluginId, name, args, tc) {
    const e = entries.get(pluginId);
    if (!e || !isEnabled(pluginId)) throw new Error(`The tool "${name}" is disabled. The user must enable its plugin first.`);
    const t = e.manifest.tools.find((x) => x.name === name);
    if (!t) throw new Error(`Unknown tool: ${name}`);
    if (!tc || !tc.workspace) throw new Error('No project folder is open.');
    args = args && typeof args === 'object' ? args : {};

    if (t.handler === 'todo-scan') {
      const values = checkParams(t, args);
      const dir = values.path ? resolveInside(tc, values.path) : tc.workspace;
      const res = await TODO.scan({ root: tc.workspace, dir, tags: values.tag ? [values.tag] : undefined });
      return PARSE.trimOutput(TODO.format(res), 8000);
    }

    let def, input, targetFile = '', targetDir = '', cmd = null;
    const values = checkParams(t, args);
    if (t.command) {
      cmd = e.manifest.commands.find((c) => c.name === t.command);
      def = commandDef(cmd);
      input = { workspace: tc.workspace };
      if (cmd.scope === 'file') {
        targetFile = resolveInside(tc, values.path);
        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) throw new Error(`Not a file: ${values.path}`);
        input.file = targetFile;
      } else if (cmd.scope === 'folder') {
        targetDir = values.path ? resolveInside(tc, values.path) : tc.workspace;
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) throw new Error(`Not a folder: ${values.path}`);
        input.folder = targetDir;
      }
      if (cmd.arg) { input.arg = checkArg(cmd, values.arg); input.allow = cmd.arg.allowOptions ? new Set(['arg']) : undefined; }
    } else {
      def = { title: t.name, scope: 'none', candidates: t.candidates, cwd: 'workspace', env: {} };
      const params = {};
      const allow = new Set();
      for (const [k, p] of Object.entries(t.properties)) {
        if (values[k] === undefined) continue;
        params[k] = p.format === 'path' ? resolveInside(tc, values[k]) : String(values[k]);
        if (p.type !== 'string' || p.pattern) allow.add(k);
      }
      input = { workspace: tc.workspace, params, allow };
    }

    const plan = await P.plan(def, input);
    if (!plan.ok) throw new Error(plan.message);
    const detail = `${plan.command}\n\n(in ${plan.cwd}, using ${plan.label})`;
    if (tc.mode !== 'auto' && !(await tc.approve('command', `Plugin "${e.manifest.name}": ${t.name}`, detail))) throw new Error('User denied this action.');

    const writes = t.effect === 'write';
    const before = writes ? (targetFile ? snapshot(targetFile, false) : snapshot(targetDir || tc.workspace, true)) : null;
    const job = R.start({ command: plan.command, cwd: plan.cwd, env: plan.env, timeoutMs: userTimeout(cmd ? cmd.timeoutSec : t.timeoutSec), onData: tc.onOutput });
    if (tc.setKill) tc.setKill(job.kill);
    const res = await job.promise;
    let extra = '';
    if (writes) {
      const changed = changedFiles(before, targetFile ? snapshot(targetFile, false) : snapshot(targetDir || tc.workspace, true));
      for (const f of changed.slice(0, 5)) if (tc.changed) tc.changed(f);
      extra = changed.length ? `\nChanged ${changed.length} file(s): ${changed.slice(0, 5).map((f) => path.relative(tc.workspace, f)).join(', ')}` : '\nNo files changed (already formatted or nothing to do).';
    }
    const sum = cmd && cmd.parse === 'tests' ? PARSE.summarizeTests(res.output, res.code) : null;
    const head = `${sum ? sum.line + '\n' : ''}[${t.name} used ${plan.label}${res.timedOut ? ', timed out' : ''}, exit code ${res.code}]${extra}\n`;
    return head + PARSE.trimOutput(res.output, sum ? 6000 : 8000);
  }

  /* ---------------- running from the UI ---------------- */
  const send = (ch, p) => ctx.send(ch, p);
  const fail = (error, kind) => ({ ok: false, error, kind: kind || 'error' });

  function terminalCommand(plan, ws) {
    if (plan.shell === 'ps' && plan.cwd !== ws) return `Push-Location -LiteralPath ${T.quote(plan.cwd, 'ps')}; ${plan.command}; Pop-Location`;
    if (plan.shell === 'sh' && plan.cwd !== ws) return `(cd ${T.quote(plan.cwd, 'sh')} && ${plan.command})`;
    return plan.command;
  }

  function launch(plan, meta) {
    const { runId, parse, writes, timeoutSec, target, isDir, ws } = meta;
    const before = writes ? snapshot(target, isDir) : null;
    const job = R.start({
      command: plan.command, cwd: plan.cwd, env: plan.env, timeoutMs: userTimeout(timeoutSec),
      onData: (text) => send('feat:plugins:out', { id: runId, text }),
    });
    jobs.set(runId, job);
    job.promise.then((res) => {
      jobs.delete(runId);
      const summary = parse === 'tests' ? PARSE.summarizeTests(res.output, res.code) : null;
      const changed = writes ? changedFiles(before, snapshot(target, isDir)).map((f) => path.relative(ws, f)) : [];
      send('feat:plugins:done', { id: runId, code: res.code, ms: res.ms, timedOut: res.timedOut, killed: res.killed, summary, changed: changed.slice(0, 50), label: plan.label });
    });
    return { ok: true, id: runId, label: plan.label, command: plan.command, cwd: plan.cwd, used: plan.used };
  }

  async function run(a) {
    a = a || {};
    const runId = String(a.runId || '').slice(0, 40);
    if (!/^[\w-]{1,40}$/.test(runId)) return fail('Bad run id.');
    if (jobs.has(runId)) return fail('That run id is already in use.');
    const e = entries.get(a.pluginId);
    if (!e || !isEnabled(e.id)) return fail('That plugin is not enabled.');
    const cmd = e.manifest.commands.find((c) => c.name === a.command);
    if (!cmd || cmd.handler) return fail('Unknown command.');
    const ws = ctx.workspace();
    if (!ws) return fail('Open a folder first.', 'no-folder');
    let input = { workspace: ws };
    let target = ws, isDir = true;
    try {
      if (cmd.scope === 'file') {
        if (!a.file) return fail('Open a file in the editor first.', 'no-file');
        const f = resolveInside({ workspace: ws, sandbox: true }, a.file);
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return fail('File not found: ' + a.file);
        input.file = f; target = f; isDir = false;
      }
      if (cmd.arg) { input.arg = checkArg(cmd, a.arg); if (cmd.arg.allowOptions) input.allow = new Set(['arg']); }
    } catch (err) { return fail(err.message); }
    const plan = await P.plan(commandDef(cmd), input);
    if (!plan.ok) return fail(plan.message, plan.kind);
    if (a.dryRun) return { ok: true, id: runId, label: plan.label, command: plan.command, cwd: plan.cwd, used: plan.used };
    if (cmd.output === 'terminal') return { ok: true, mode: 'terminal', label: plan.label, command: terminalCommand(plan, ws), used: plan.used };
    return launch(plan, { runId, parse: cmd.parse, writes: cmd.writes, timeoutSec: cmd.timeoutSec, target, isDir, ws });
  }

  /* ---------------- built-in handlers ---------------- */
  function handlerEntry(name) {
    for (const [id, e] of entries) {
      if (!isEnabled(id)) continue;
      if (e.manifest.commands.some((c) => c.handler === name) || e.manifest.tools.some((t) => t.handler === name)) return e;
    }
    return null;
  }

  async function todos(a) {
    a = a || {};
    if (!handlerEntry('todo-scan')) return fail('The TODO scanner plugin is not enabled.');
    const ws = ctx.workspace();
    if (!ws) return fail('Open a folder first.', 'no-folder');
    const runId = String(a.runId || '');
    if (!/^[\w-]{1,40}$/.test(runId)) return fail('Bad run id.');
    const t0 = Date.now();
    let last = 0;
    const res = await TODO.scan({
      root: ws, tags: a.tag ? [String(a.tag)] : undefined,
      isCancelled: () => cancelled.has(runId),
      onProgress: (n) => { if (Date.now() - last > 120) { last = Date.now(); send('feat:plugins:progress', { id: runId, scanned: n }); } },
    });
    cancelled.delete(runId);
    return { ok: true, ...res, ms: Date.now() - t0, root: ws };
  }

  function scriptList() {
    if (!handlerEntry('scripts')) return fail('The Project scripts plugin is not enabled.');
    const ws = ctx.workspace();
    if (!ws) return { ok: true, groups: [], noFolder: true };
    const groups = SCRIPTS.detect(ws).map((g) => {
      const bin = SCRIPTS.TEMPLATES[g.source].match(/bin:([\w.-]+)/)[1];
      const found = T.which(bin, { workspace: ws });
      return { ...g, tool: bin, missing: found ? '' : `${bin} is not installed (or not on PATH)` };
    });
    return { ok: true, groups };
  }

  async function runScript(a) {
    a = a || {};
    if (!handlerEntry('scripts')) return fail('The Project scripts plugin is not enabled.');
    const ws = ctx.workspace();
    if (!ws) return fail('Open a folder first.', 'no-folder');
    const runId = String(a.runId || '');
    if (!/^[\w-]{1,40}$/.test(runId) || jobs.has(runId)) return fail('Bad run id.');
    const group = SCRIPTS.detect(ws).find((g) => g.source === a.source);
    const item = group && group.scripts.find((s) => s.name === a.name);
    if (!item) return fail('That script was not found in the project any more.');
    const def = { title: `${a.source} ${a.name}`, scope: 'none', cwd: 'workspace', env: {}, candidates: [{ label: `${a.source} run ${a.name}`, hint: '', detect: [], requires: [], appliesTo: null, run: SCRIPTS.TEMPLATES[a.source], cwd: null, env: {} }] };
    const plan = await P.plan(def, { workspace: ws, arg: item.name });
    if (!plan.ok) return fail(plan.message, plan.kind);
    return launch(plan, { runId, parse: 'none', writes: false, timeoutSec: 300, target: ws, isDir: true, ws });
  }

  /* ---------------- listing ---------------- */
  function describe(e) {
    const m = e.manifest;
    if (!m) return { id: e.id, name: path.basename(e.dir), version: '', description: '', source: e.source, enabled: false, error: e.errors.join('\n'), permissions: [], commands: [], tools: [], snippets: 0, dir: e.dir };
    return {
      id: m.id, name: m.name, version: m.version, description: m.description, author: m.author, source: e.source, enabled: isEnabled(m.id),
      error: '', note: notes.get(m.id) || '', dir: e.dir,
      permissions: m.permissions.map((k) => ({ key: k, label: M.PERMISSIONS[k] })),
      commands: m.commands.map((c) => ({
        name: c.name, title: c.title, description: c.description, scope: c.scope, output: c.output, appliesTo: c.appliesTo, arg: c.arg, handler: c.handler, writes: c.writes,
        templates: c.candidates.map((k) => ({ label: k.label, run: k.run })),
      })),
      tools: m.tools.map((t) => ({ name: t.name, description: t.description, effect: t.effect, templates: (t.candidates || []).map((k) => k.run) })),
      snippets: m.snippets.length,
    };
  }

  function list() {
    const plugins = [...entries.values()].map(describe).sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'builtin' ? -1 : 1));
    return { ok: true, plugins, userDir, builtinDir, folder: ctx.workspace(), settings: { timeoutSec: Number(cfg().timeoutSec) || 0, autoSave: cfg().autoSave !== false } };
  }

  function enable(id, on) {
    const e = entries.get(id);
    if (!e || !e.manifest) return fail('That plugin cannot be enabled: ' + (e ? e.errors.join('; ') : 'not found'));
    const map = { ...enabledMap() };
    if (on) {
      for (const t of e.manifest.tools) {
        const st = toolState.get(t.name);
        if (!st && ctx.tools.schemas.some((s) => s.function.name === t.name)) return fail(`The tool name "${t.name}" is already used by another tool.`);
        if (st && st.pluginId !== id) return fail(`The tool name "${t.name}" is already used by another plugin.`);
      }
      map[id] = fingerprint(e);
      notes.delete(id);
    } else delete map[id];
    setEnabled(map);
    syncTools();
    return { ok: true, plugin: describe(e) };
  }

  function snippets() {
    const out = [];
    for (const [id, e] of entries) if (isEnabled(id)) for (const s of e.manifest.snippets) out.push({ prefix: s.prefix, body: s.body, languages: s.languages, plugin: id });
    return { ok: true, snippets: out };
  }

  /* ---------------- IPC ---------------- */
  const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { return fail(err && err.message ? err.message : String(err)); } };
  load();
  ctx.handle('feat:plugins:list', safe(() => list()));
  ctx.handle('feat:plugins:reload', safe(() => { P.clearProbes(); load(); return list(); }));
  ctx.handle('feat:plugins:enable', safe((id, on) => enable(String(id), !!on)));
  ctx.handle('feat:plugins:run', safe(run));
  ctx.handle('feat:plugins:stop', safe((id) => {
    id = String(id);
    cancelled.add(id);
    const j = jobs.get(id);
    if (j) j.kill();
    return { ok: true, running: !!j };
  }));
  ctx.handle('feat:plugins:todos', safe(todos));
  ctx.handle('feat:plugins:scripts', safe(() => scriptList()));
  ctx.handle('feat:plugins:runScript', safe(runScript));
  ctx.handle('feat:plugins:snippets', safe(() => snippets()));
  ctx.handle('feat:plugins:ping', () => Date.now());
  ctx.handle('feat:plugins:openFolder', safe(() => {
    fs.mkdirSync(userDir, { recursive: true });
    if (!process.env.FABER_NO_OPEN) require('electron').shell.openPath(userDir);
    return { ok: true, dir: userDir };
  }));
  ctx.handle('feat:plugins:setOption', safe((key, value) => {
    if (key === 'timeoutSec') ctx.setFeatureSettings('plugins', { timeoutSec: Math.max(0, Math.min(1800, Number(value) || 0)) });
    else if (key === 'autoSave') ctx.setFeatureSettings('plugins', { autoSave: !!value });
    else return fail('Unknown option.');
    return list();
  }));

  // Developer utilities (the plugin must be enabled)
  const needDev = () => { const e = [...entries.values()].find((x) => x.manifest && isEnabled(x.id) && x.manifest.commands.some((c) => c.handler === 'ui:devtools')); if (!e) throw new Error('The Developer utilities plugin is not enabled.'); };
  ctx.handle('feat:plugins:hash', safe(async (a) => {
    needDev();
    a = a || {};
    if (typeof a.text === 'string') return { ok: true, ...DEV.hashBuffer(Buffer.from(a.text, 'utf8')) };
    let file = a.path;
    if (a.pick) {
      const r = await ctx.dialog.showOpenDialog(ctx.window(), { properties: ['openFile'], defaultPath: ctx.workspace() || undefined });
      if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Cancelled.' };
      file = r.filePaths[0];
    } else if (file) {
      const ws = ctx.workspace();
      if (!ws) throw new Error('Open a folder first, or use Choose file.');
      file = resolveInside({ workspace: ws, sandbox: true }, file);
    } else throw new Error('Nothing to hash.');
    if (!fs.statSync(file).isFile()) throw new Error('Not a file.');
    return { ok: true, file, ...(await DEV.hashFile(file)) };
  }));
  ctx.handle('feat:plugins:regex', safe((a) => { needDev(); return DEV.regexTest(a || {}); }));
};
