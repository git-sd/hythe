'use strict';
// Command templates for declarative plugins.
//
// A template is plain shell text with {variables}. Variable VALUES are never pasted raw: each one is
// turned into exactly one quoted word (PowerShell single quotes on Windows, POSIX single quotes
// elsewhere), after being checked for characters that cannot be passed safely. Variables may not
// sit inside quotes in the template. Literal braces are written {{ and }}.
//
// Variables: {file} {rel} {folder} {ws} {arg}, tool parameter names, {bin:NAME} (resolved executable,
// expands to an invocation) and {py} (the python interpreter). There is deliberately NO {selection}.
const fs = require('fs');
const path = require('path');

class TemplateError extends Error {}

const VAR_RE = /^(?:[a-z][A-Za-z0-9_]{0,31}|bin:[A-Za-z0-9._+-]{1,40})$/;
const MAX_VALUE = 4096;

function tokenize(tpl) {
  const out = [];
  let lit = '';
  for (let i = 0; i < tpl.length; i++) {
    const c = tpl[i];
    if (c === '{') {
      if (tpl[i + 1] === '{') { lit += '{'; i++; continue; }
      const j = tpl.indexOf('}', i + 1);
      if (j < 0) throw new TemplateError('unclosed "{" (write "{{" for a literal brace)');
      const name = tpl.slice(i + 1, j);
      if (!VAR_RE.test(name)) throw new TemplateError(`bad variable "{${name}}"`);
      if (lit) { out.push({ lit }); lit = ''; }
      out.push({ v: name });
      i = j;
    } else if (c === '}') {
      if (tpl[i + 1] === '}') { lit += '}'; i++; continue; }
      throw new TemplateError('stray "}" (write "}}" for a literal brace)');
    } else lit += c;
  }
  if (lit) out.push({ lit });
  return out;
}

// Returns a list of problems (empty = fine). `allowed` is the set of plain variable names.
function validateTemplate(tpl, allowed) {
  const errors = [];
  if (typeof tpl !== 'string' || !tpl.trim()) return ['must be a non-empty string'];
  if (tpl.length > 2000) return ['is longer than 2000 characters'];
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(tpl)) return ['must be a single line without control characters'];
  let tokens;
  try { tokens = tokenize(tpl); } catch (e) { return [e.message]; }
  let q = null;
  for (const t of tokens) {
    if (t.lit !== undefined) {
      for (const ch of t.lit) {
        if (!q && (ch === "'" || ch === '"')) q = ch; else if (q && ch === q) q = null;
      }
    } else {
      if (q) errors.push(`{${t.v}} must not be inside quotes (it is quoted automatically)`);
      if (!t.v.startsWith('bin:') && t.v !== 'py' && !allowed.has(t.v)) errors.push(`unknown variable {${t.v}}`);
    }
  }
  if (q) errors.push('has an unbalanced quote');
  return errors;
}

function quote(v, shell) {
  if (shell === 'ps') return "'" + v.replace(/['\u2018\u2019\u201a\u201b]/g, (m) => m + m) + "'";
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

function checkValue(name, v, o) {
  if (v.length > MAX_VALUE) throw new TemplateError(`{${name}} is too long`);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) throw new TemplateError(`{${name}} contains control characters and was rejected`);
  if (o.win32 && v.includes('"')) throw new TemplateError(`{${name}} contains a double quote, which cannot be passed safely on Windows`);
  if (o.win32 && /\\$/.test(v) && /\s/.test(v)) throw new TemplateError(`{${name}} ends with a backslash and contains spaces, which cannot be passed safely on Windows`);
  if (o.strictCmd && /[&|<>^%]/.test(v)) throw new TemplateError(`{${name}} contains one of & | < > ^ % which cannot be passed safely to a .cmd/.bat tool on Windows (rename the file or use another tool)`);
  if (!o.allowDash && v.startsWith('-')) throw new TemplateError(`{${name}} must not start with "-" (it could be taken for an option)`);
}

function invocation(b, shell) {
  const words = [b.path, ...(b.args || [])].map((x) => quote(x, shell));
  return (shell === 'ps' ? '& ' : '') + words.join(' ');
}

// values: {name: string}; bins: {NAME: {path,args?}, $py: {...}}; opts: {shell, win32, strictCmd, allowDash:Set}
function render(tpl, values, bins, opts = {}) {
  const shell = opts.shell || (process.platform === 'win32' ? 'ps' : 'sh');
  const win32 = opts.win32 ?? process.platform === 'win32';
  let out = '';
  for (const t of tokenize(tpl)) {
    if (t.lit !== undefined) { out += t.lit; continue; }
    if (t.v.startsWith('bin:')) {
      const b = bins && bins[t.v.slice(4)];
      if (!b) throw new TemplateError(`${t.v.slice(4)} was not found`);
      out += invocation(b, shell);
    } else if (t.v === 'py') {
      const b = bins && bins.$py;
      if (!b) throw new TemplateError('python was not found');
      out += invocation(b, shell);
    } else {
      const raw = values[t.v];
      if (raw === undefined || raw === null) throw new TemplateError(`no value for {${t.v}}`);
      const v = String(raw);
      checkValue(t.v, v, { win32, strictCmd: !!opts.strictCmd, allowDash: !!(opts.allowDash && opts.allowDash.has(t.v)) });
      if (v !== '') out += quote(v, shell);
    }
  }
  return out;
}

/* ---- finding executables ---- */
const WIN_EXT = ['.exe', '.cmd', '.bat', '.com'];
// Core runtimes are only ever taken from PATH, never from a project folder.
const SYSTEM_BINS = new Set(['node', 'npm', 'npx', 'yarn', 'pnpm', 'python', 'python3', 'py', 'pip', 'git', 'go', 'gofmt', 'cargo', 'rustc', 'rustfmt', 'dotnet', 'make', 'powershell', 'pwsh', 'bash', 'sh', 'cmd']);

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function findIn(dirs, name, win32) {
  const hasExt = win32 && WIN_EXT.includes(path.extname(name).toLowerCase());
  for (const d of dirs) {
    if (!d) continue;
    if (win32) {
      if (hasExt && isFile(path.join(d, name))) return path.join(d, name);
      for (const e of WIN_EXT) if (isFile(path.join(d, name + e))) return path.join(d, name + e);
    } else {
      const p = path.join(d, name);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

function pathDirs() {
  return String(process.env.PATH || process.env.Path || '').split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function localDirs(workspace, startDir) {
  const dirs = [];
  if (workspace) {
    let d = path.resolve(startDir || workspace);
    const root = path.resolve(workspace);
    for (let i = 0; i < 20; i++) {
      const rel = path.relative(root, d);
      if (rel.startsWith('..') || path.isAbsolute(rel)) break;
      dirs.push(path.join(d, 'node_modules', '.bin'));
      if (d === root) break;
      d = path.dirname(d);
    }
    for (const v of ['.venv', 'venv']) dirs.push(path.join(root, v, 'Scripts'), path.join(root, v, 'bin'));
  }
  return dirs;
}

// -> {path, local} | null
function which(name, { workspace, startDir, win32 = process.platform === 'win32' } = {}) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  if (!SYSTEM_BINS.has(name.toLowerCase())) {
    const l = findIn(localDirs(workspace, startDir), name, win32);
    if (l) return { path: l, local: true };
  }
  const p = findIn(pathDirs(), name, win32);
  return p ? { path: p, local: false } : null;
}

const isCmdShim = (p) => /\.(cmd|bat)$/i.test(p || '');

// First word of every statement in the literal text of a template (to spot .cmd tools called by name).
function commandWords(tokens) {
  const text = tokens.map((t) => (t.lit !== undefined ? t.lit : '\u0001')).join('');
  const words = [];
  for (const part of text.split(/[;|&\n]/)) {
    const m = /^\s*(?:[&.]\s+)?([A-Za-z0-9._-]+)/.exec(part);
    if (m) words.push(m[1]);
  }
  return words;
}

module.exports = { TemplateError, tokenize, validateTemplate, render, quote, which, localDirs, isCmdShim, commandWords, findIn, SYSTEM_BINS };
