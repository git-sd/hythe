'use strict';
/* Plugin manifests (plugin.json). Plugins are DECLARATIVE: data only, Faber never runs JS from them.

  {
    "id": "my-plugin",                 // ^[a-z][a-z0-9-]{1,31}$ and must equal the folder name
    "name": "My plugin", "version": "1.0.0", "description": "...", "author": "optional",
    "permissions": ["run-commands", "write-files", "read-files", "ai-tools", "snippets"],
    "commands": [{
      "name": "check",                 // ^[a-z][a-z0-9_]{0,29}$ (becomes the slash command /check)
      "title": "Check file", "description": "optional",
      "scope": "file" | "folder" | "none",   // what it works on ({file} {rel} / {folder}); default none
      "appliesTo": ["js", "src/*.ts"],     // extensions or globs (file scope)
      "cwd": "workspace" | "file-dir", "output": "panel" | "terminal" | "toast",
      "timeoutSec": 120, "parse": "none" | "tests", "writes": false,
      "arg": { "label": "Name", "required": true, "pattern": "^[\\w.-]+$", "allowOptions": false },
      "env": { "NAME": "value" },
      "run": "{bin:tool} --flag {file}",       // one template, OR
      "candidates": [{ "label": "tool", "detect": ["file:x.toml"], "requires": ["py:mod"], "appliesTo": [...],
                       "run": "...", "cwd": "...", "env": {}, "hint": "text shown when missing" }]
    }],
    "tools": [{                         // AI tools, only exist while the plugin is enabled
      "name": "my_tool", "description": "...", "effect": "read" | "write",
      "parameters": { "type": "object", "properties": { "x": { "type": "string", "description": "...", "format": "path" } }, "required": ["x"] },
      "run": "{bin:tool} {x}"  (or "candidates"), OR "command": "<command name in this plugin>"
    }],
    "snippets": [{ "prefix": "clg", "body": "console.log($1);$0", "languages": ["js", "ts"] }]
  }

  Requirements: bin:NAME (executable; project node_modules/.bin and .venv first for tools, PATH otherwise),
  py:MODULE, file:NAME (workspace root, a star wildcard is allowed), script:NAME (package.json), sdk:dotnet.
  "a|b" means either. Built-in plugins (shipped in the app) may also use "handler" for native actions.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./template');

const MAX_BYTES = 64 * 1024;
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const CMD_RE = /^[a-z][a-z0-9_]{0,29}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{2,39}$/;
const PARAM_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
const RESERVED_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command']);
const HANDLERS = new Set(['todo-scan', 'scripts', 'ui:devtools']);

const PERMISSIONS = {
  'run-commands': 'Run commands on your computer, in the open folder',
  'write-files': 'Modify files in the open folder',
  'read-files': 'Read files in the open folder (or files you pick)',
  'ai-tools': 'Give the AI assistant extra tools (they ask for approval unless you chose Auto-approve)',
  snippets: 'Add editor snippets (type a prefix, press Tab)',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

class Check {
  constructor() { this.errors = []; }
  err(where, msg) { this.errors.push(`${where}: ${msg}`); }
  keys(where, obj, allowed) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.err(where, `unknown key "${k}"`);
  }
  str(where, v, { min = 1, max = 200, re, optional } = {}) {
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string') { this.err(where, 'must be a string'); return undefined; }
    if (v.length < min || v.length > max) { this.err(where, `must be ${min}-${max} characters`); return undefined; }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) { this.err(where, 'contains control characters'); return undefined; }
    if (re && !re.test(v)) { this.err(where, `has an invalid format (${re})`); return undefined; }
    return v;
  }
  list(where, v, { max = 50, optional = true } = {}) {
    if (v === undefined) { if (!optional) this.err(where, 'is required'); return []; }
    if (!Array.isArray(v)) { this.err(where, 'must be an array'); return []; }
    if (v.length > max) { this.err(where, `has more than ${max} entries`); return v.slice(0, max); }
    return v;
  }
}

const REQ_RE = /^(?:(?:bin|py|sdk):[A-Za-z0-9._+-]+(?:\|(?:bin|py|sdk):[A-Za-z0-9._+-]+)*|(?:file|script):[\w.@*/-]+(?:\|[\w.@*/-]+)*)$/;

function checkList(c, where, v, re, max = 40) {
  return c.list(where, v, { max }).map((x, i) => c.str(`${where}[${i}]`, x, { max: 300, re })).filter(Boolean);
}

function checkEnv(c, where, v) {
  if (v === undefined) return {};
  if (!isObj(v)) { c.err(where, 'must be an object'); return {}; }
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Z_][A-Z0-9_]{0,40}$/.test(k)) { c.err(where, `bad variable name "${k}"`); continue; }
    if (/^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PSModulePath)$/i.test(k)) { c.err(where, `"${k}" cannot be set`); continue; }
    const s = c.str(`${where}.${k}`, val, { min: 0, max: 200 });
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function checkTemplate(c, where, tpl, allowed) {
  for (const e of T.validateTemplate(tpl, allowed)) c.err(where, e);
}

function normCandidates(c, where, o, allowed, defaultLabel) {
  if (o.run !== undefined && o.candidates !== undefined) { c.err(where, 'use either "run" or "candidates", not both'); return []; }
  if (o.run !== undefined) {
    checkTemplate(c, `${where}.run`, o.run, allowed);
    return [{ label: defaultLabel, hint: '', detect: [], requires: [], appliesTo: null, run: o.run, cwd: null, env: {} }];
  }
  const list = c.list(`${where}.candidates`, o.candidates, { max: 30 });
  const out = [];
  list.forEach((x, i) => {
    const w = `${where}.candidates[${i}]`;
    if (!isObj(x)) return c.err(w, 'must be an object');
    c.keys(w, x, ['label', 'hint', 'detect', 'requires', 'appliesTo', 'run', 'cwd', 'env']);
    const label = c.str(`${w}.label`, x.label, { max: 60 });
    checkTemplate(c, `${w}.run`, x.run, allowed);
    const cwd = x.cwd === undefined ? null : x.cwd;
    if (cwd !== null && !['workspace', 'file-dir'].includes(cwd)) c.err(`${w}.cwd`, 'must be "workspace" or "file-dir"');
    out.push({
      label: label || defaultLabel, hint: c.str(`${w}.hint`, x.hint, { optional: true, min: 0, max: 200 }) || '',
      detect: checkList(c, `${w}.detect`, x.detect, REQ_RE), requires: checkList(c, `${w}.requires`, x.requires, REQ_RE),
      appliesTo: x.appliesTo === undefined ? null : checkList(c, `${w}.appliesTo`, x.appliesTo, /^[\w.*/?-]+$/),
      run: x.run, cwd, env: checkEnv(c, `${w}.env`, x.env),
    });
  });
  return out;
}

function allowedVars(scope, hasArg) {
  const s = new Set(['ws']);
  if (scope === 'file') { s.add('file'); s.add('rel'); s.add('folder'); }
  if (scope === 'folder') s.add('folder');
  if (hasArg) s.add('arg');
  return s;
}

function normCommand(c, i, x, source) {
  const w = `commands[${i}]`;
  if (!isObj(x)) { c.err(w, 'must be an object'); return null; }
  c.keys(w, x, ['name', 'title', 'description', 'scope', 'appliesTo', 'cwd', 'output', 'timeoutSec', 'parse', 'writes', 'arg', 'env', 'run', 'candidates', 'handler']);
  const name = c.str(`${w}.name`, x.name, { max: 30, re: CMD_RE });
  const title = c.str(`${w}.title`, x.title, { max: 60 });
  const scope = x.scope === undefined ? 'none' : x.scope;
  if (!['file', 'folder', 'none'].includes(scope)) c.err(`${w}.scope`, 'must be "file", "folder" or "none"');
  const output = x.output === undefined ? 'panel' : x.output;
  if (!['panel', 'terminal', 'toast'].includes(output)) c.err(`${w}.output`, 'must be "panel", "terminal" or "toast"');
  const cwd = x.cwd === undefined ? 'workspace' : x.cwd;
  if (!['workspace', 'file-dir'].includes(cwd)) c.err(`${w}.cwd`, 'must be "workspace" or "file-dir"');
  if (cwd === 'file-dir' && scope !== 'file') c.err(`${w}.cwd`, '"file-dir" needs scope "file"');
  const parse = x.parse === undefined ? 'none' : x.parse;
  if (!['none', 'tests'].includes(parse)) c.err(`${w}.parse`, 'must be "none" or "tests"');
  let timeoutSec = x.timeoutSec === undefined ? 120 : x.timeoutSec;
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 1800) { c.err(`${w}.timeoutSec`, 'must be 1-1800'); timeoutSec = 120; }
  let arg = null;
  if (x.arg !== undefined) {
    if (!isObj(x.arg)) c.err(`${w}.arg`, 'must be an object');
    else {
      c.keys(`${w}.arg`, x.arg, ['label', 'required', 'pattern', 'allowOptions']);
      arg = { label: c.str(`${w}.arg.label`, x.arg.label, { max: 60 }) || 'Argument', required: !!x.arg.required, allowOptions: !!x.arg.allowOptions, pattern: null };
      if (x.arg.pattern !== undefined) {
        const p = c.str(`${w}.arg.pattern`, x.arg.pattern, { max: 200 });
        try { if (p) { new RegExp(p); arg.pattern = p; } } catch { c.err(`${w}.arg.pattern`, 'is not a valid regular expression'); }
      }
    }
  }
  const out = {
    name, title, description: c.str(`${w}.description`, x.description, { optional: true, min: 0, max: 300 }) || '',
    scope, appliesTo: x.appliesTo === undefined ? null : checkList(c, `${w}.appliesTo`, x.appliesTo, /^[\w.*/?-]+$/, 80),
    cwd, output, timeoutSec, parse, writes: !!x.writes, arg, env: checkEnv(c, `${w}.env`, x.env), handler: null, candidates: [],
  };
  if (x.handler !== undefined) {
    if (source !== 'builtin') c.err(`${w}.handler`, 'native handlers are only available to built-in plugins');
    else if (!HANDLERS.has(x.handler)) c.err(`${w}.handler`, `unknown handler "${x.handler}"`);
    else out.handler = x.handler;
    if (x.run !== undefined || x.candidates !== undefined) c.err(w, 'a handler command cannot also have run/candidates');
  } else {
    if (x.run === undefined && x.candidates === undefined) c.err(w, 'needs "run" or "candidates"');
    else out.candidates = normCandidates(c, w, x, allowedVars(scope, !!arg), title || name || 'command');
  }
  return out;
}

function normTool(c, i, x, source, commandNames) {
  const w = `tools[${i}]`;
  if (!isObj(x)) { c.err(w, 'must be an object'); return null; }
  c.keys(w, x, ['name', 'description', 'effect', 'parameters', 'run', 'candidates', 'command', 'handler', 'timeoutSec']);
  const name = c.str(`${w}.name`, x.name, { max: 40, re: TOOL_RE });
  if (name && RESERVED_TOOLS.has(name)) c.err(`${w}.name`, `"${name}" is a core tool name`);
  const effect = x.effect === undefined ? 'read' : x.effect;
  if (!['read', 'write'].includes(effect)) c.err(`${w}.effect`, 'must be "read" or "write"');
  const props = {};
  const required = [];
  let hasPath = false;
  const p = x.parameters;
  if (p !== undefined) {
    if (!isObj(p)) c.err(`${w}.parameters`, 'must be a JSON schema object');
    else {
      c.keys(`${w}.parameters`, p, ['type', 'properties', 'required']);
      if (p.type !== undefined && p.type !== 'object') c.err(`${w}.parameters.type`, 'must be "object"');
      const entries = isObj(p.properties) ? Object.entries(p.properties) : [];
      if (p.properties !== undefined && !isObj(p.properties)) c.err(`${w}.parameters.properties`, 'must be an object');
      if (entries.length > 8) c.err(`${w}.parameters.properties`, 'at most 8 parameters');
      for (const [k, v] of entries.slice(0, 8)) {
        const pw = `${w}.parameters.properties.${k}`;
        if (!PARAM_RE.test(k)) { c.err(pw, 'bad parameter name'); continue; }
        if (!isObj(v)) { c.err(pw, 'must be an object'); continue; }
        c.keys(pw, v, ['type', 'description', 'enum', 'pattern', 'maxLength', 'minimum', 'maximum', 'format']);
        if (!['string', 'number', 'integer', 'boolean'].includes(v.type)) { c.err(`${pw}.type`, 'must be string, number, integer or boolean'); continue; }
        const d = { type: v.type, description: c.str(`${pw}.description`, v.description, { max: 300, optional: true, min: 0 }) || '' };
        if (v.enum !== undefined) { d.enum = c.list(`${pw}.enum`, v.enum, { max: 30 }).filter((e) => typeof e === 'string' && e.length < 100); }
        if (v.pattern !== undefined) { try { new RegExp(v.pattern); d.pattern = String(v.pattern).slice(0, 200); } catch { c.err(`${pw}.pattern`, 'invalid regular expression'); } }
        if (v.maxLength !== undefined) d.maxLength = Math.min(4096, Math.max(1, Number(v.maxLength) || 4096));
        if (v.minimum !== undefined) d.minimum = Number(v.minimum);
        if (v.maximum !== undefined) d.maximum = Number(v.maximum);
        if (v.format !== undefined) { if (v.format !== 'path' || v.type !== 'string') c.err(`${pw}.format`, 'only "path" on strings is supported'); else { d.format = 'path'; hasPath = true; } }
        props[k] = d;
      }
      for (const r of c.list(`${w}.parameters.required`, p.required, { max: 8 })) {
        if (typeof r === 'string' && props[r]) required.push(r); else c.err(`${w}.parameters.required`, `unknown parameter ${JSON.stringify(r)}`);
      }
    }
  }
  const out = { name, description: c.str(`${w}.description`, x.description, { max: 600 }) || '', effect, properties: props, required, hasPath, command: null, handler: null, candidates: [], timeoutSec: 120 };
  if (x.timeoutSec !== undefined) { if (Number.isFinite(x.timeoutSec) && x.timeoutSec >= 1 && x.timeoutSec <= 1800) out.timeoutSec = x.timeoutSec; else c.err(`${w}.timeoutSec`, 'must be 1-1800'); }
  const modes = ['run', 'candidates', 'command', 'handler'].filter((k) => x[k] !== undefined);
  if (modes.length !== 1) c.err(w, 'needs exactly one of run, candidates, command, handler');
  if (x.handler !== undefined) {
    if (source !== 'builtin') c.err(`${w}.handler`, 'native handlers are only available to built-in plugins');
    else if (!HANDLERS.has(x.handler)) c.err(`${w}.handler`, `unknown handler "${x.handler}"`);
    else out.handler = x.handler;
  } else if (x.command !== undefined) {
    if (typeof x.command !== 'string' || !commandNames.has(x.command)) c.err(`${w}.command`, 'must name a command of this plugin');
    else out.command = x.command;
  } else if (x.run !== undefined || x.candidates !== undefined) {
    const allowed = new Set(['ws', ...Object.keys(props)]);
    out.candidates = normCandidates(c, w, x, allowed, name || 'tool');
  }
  return out;
}

// -> {ok, manifest, errors}. `raw` is the parsed JSON. opts: {source:'builtin'|'user', folderName}
function validate(raw, opts = {}) {
  const source = opts.source || 'user';
  const c = new Check();
  if (!isObj(raw)) return { ok: false, manifest: null, errors: ['plugin.json must contain a JSON object'] };
  c.keys('plugin.json', raw, ['id', 'name', 'version', 'description', 'author', 'permissions', 'commands', 'tools', 'snippets']);
  const id = c.str('id', raw.id, { max: 32, re: ID_RE });
  if (id && opts.folderName !== undefined && id !== opts.folderName) c.err('id', `must equal the folder name "${opts.folderName}"`);
  const name = c.str('name', raw.name, { max: 60 });
  const version = c.str('version', raw.version, { max: 20, re: /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][\w.]{1,16})?$/ });
  const description = c.str('description', raw.description, { max: 500 });
  const author = c.str('author', raw.author, { optional: true, min: 0, max: 80 }) || '';
  const permissions = [];
  for (const [i, p] of c.list('permissions', raw.permissions, { max: 10 }).entries()) {
    if (typeof p !== 'string' || !PERMISSIONS[p]) c.err(`permissions[${i}]`, `unknown permission ${JSON.stringify(p)}`);
    else if (!permissions.includes(p)) permissions.push(p);
  }
  const rawCmds = c.list('commands', raw.commands, { max: 30 });
  const cmdNames = new Set(rawCmds.map((x) => x && x.name).filter((n) => typeof n === 'string'));
  const commands = [];
  rawCmds.forEach((x, i) => {
    const cmd = normCommand(c, i, x, source);
    if (!cmd) return;
    if (cmd.name && commands.some((o) => o.name === cmd.name)) c.err(`commands[${i}].name`, 'duplicate command name');
    commands.push(cmd);
  });
  const tools = [];
  c.list('tools', raw.tools, { max: 10 }).forEach((x, i) => {
    const t = normTool(c, i, x, source, cmdNames);
    if (!t) return;
    if (t.name && tools.some((o) => o.name === t.name)) c.err(`tools[${i}].name`, 'duplicate tool name');
    if (t.command) {
      const cmd = commands.find((k) => k.name === t.command);
      if (cmd && cmd.handler) c.err(`tools[${i}].command`, 'cannot reuse a handler command');
      if (cmd && cmd.scope === 'file' && !t.properties.path) c.err(`tools[${i}]`, 'a tool for a file/folder command needs a "path" parameter');
      if (cmd && cmd.arg && !t.properties.arg) c.err(`tools[${i}]`, 'a tool for a command with an argument needs an "arg" parameter');
    }
    tools.push(t);
  });
  const snippets = [];
  c.list('snippets', raw.snippets, { max: 200 }).forEach((x, i) => {
    const w = `snippets[${i}]`;
    if (!isObj(x)) return c.err(w, 'must be an object');
    c.keys(w, x, ['prefix', 'body', 'languages', 'description']);
    const prefix = c.str(`${w}.prefix`, x.prefix, { max: 24, re: /^[A-Za-z][A-Za-z0-9_-]{0,23}$/ });
    const body = c.str(`${w}.body`, x.body, { max: 4000 });
    const languages = x.languages === undefined ? ['*'] : checkList(c, `${w}.languages`, x.languages, /^(?:\*|[A-Za-z0-9_+-]{1,12})$/, 40);
    if (prefix && snippets.some((s) => s.prefix === prefix && s.languages.some((l) => languages.includes(l)))) c.err(`${w}.prefix`, 'duplicate prefix');
    if (prefix && body !== undefined) snippets.push({ prefix, body, languages: languages.map((l) => l.toLowerCase()), description: c.str(`${w}.description`, x.description, { optional: true, min: 0, max: 80 }) || '' });
  });

  // declared permissions must cover what the plugin actually does
  const need = (perm, why) => { if (!permissions.includes(perm)) c.err('permissions', `"${perm}" is required because ${why}`); };
  for (const k of commands) {
    if (k.candidates.length) need('run-commands', `command "${k.name}" runs shell commands`);
    if (k.writes) need('write-files', `command "${k.name}" modifies files`);
    if (k.handler === 'todo-scan' || k.handler === 'scripts') need('read-files', `command "${k.name}" reads files`);
  }
  for (const t of tools) {
    need('ai-tools', `tool "${t.name}" is offered to the AI`);
    if (t.candidates.length) need('run-commands', `tool "${t.name}" runs shell commands`);
    if (t.effect === 'write') need('write-files', `tool "${t.name}" modifies files`);
    if (t.handler === 'todo-scan') need('read-files', `tool "${t.name}" reads files`);
    if (t.command) {
      const cmd = commands.find((k) => k.name === t.command);
      if (cmd && cmd.writes && t.effect !== 'write') c.err(`tool "${t.name}"`, 'its command writes files, so effect must be "write"');
    }
  }
  if (snippets.length) need('snippets', 'it adds snippets');

  if (c.errors.length) return { ok: false, manifest: null, errors: c.errors.slice(0, 30) };
  return { ok: true, errors: [], manifest: { id, name, version, description, author, permissions, commands, tools, snippets, source } };
}

// Read + validate one plugin folder. Never throws. -> {id, dir, source, manifest|null, errors[], hash}
function loadFolder(dir, source) {
  const folderName = path.basename(dir);
  const res = { id: folderName, dir, source, manifest: null, errors: [], hash: '' };
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) { res.errors.push('plugin folders must be real folders (symbolic links are not allowed)'); return res; }
    if (!ID_RE.test(folderName)) { res.errors.push('folder name must be lowercase letters, digits and "-" (2-32 characters, starting with a letter)'); return res; }
    const file = path.join(dir, 'plugin.json');
    let fst;
    try { fst = fs.lstatSync(file); } catch { res.errors.push('plugin.json is missing'); return res; }
    if (fst.isSymbolicLink() || !fst.isFile()) { res.errors.push('plugin.json must be a regular file'); return res; }
    if (fst.size > MAX_BYTES) { res.errors.push(`plugin.json is too large (${fst.size} bytes, limit ${MAX_BYTES})`); return res; }
    const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    res.hash = crypto.createHash('sha256').update(text).digest('hex');
    let raw;
    try { raw = JSON.parse(text); } catch (e) { res.errors.push('plugin.json is not valid JSON: ' + e.message); return res; }
    const v = validate(raw, { source, folderName });
    res.errors = v.errors;
    res.manifest = v.manifest;
    if (v.manifest) res.id = v.manifest.id;
  } catch (e) {
    res.manifest = null;
    res.errors.push('could not be read: ' + e.message);
  }
  return res;
}

// Scan a directory of plugin folders. Never throws.
function scanDir(dir, source) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && !n.startsWith('_')).sort().map((n) => loadFolder(path.join(dir, n), source));
}

module.exports = { validate, loadFolder, scanDir, PERMISSIONS, HANDLERS, MAX_BYTES, ID_RE, RESERVED_TOOLS };
