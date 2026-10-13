'use strict';
// Finds runnable project scripts: package.json scripts, Makefile targets, pyproject task tables.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,80}$/;
const read = (p, max = 1000000) => { try { if (fs.statSync(p).size > max) return null; return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// source -> command template (the script name is always passed as the quoted, validated {arg})
const TEMPLATES = {
  npm: '{bin:npm} run {arg}', pnpm: '{bin:pnpm} run {arg}', yarn: '{bin:yarn} run {arg}',
  make: '{bin:make} {arg}', poe: '{bin:poe} {arg}', pdm: '{bin:pdm} run {arg}', rye: '{bin:rye} run {arg}', hatch: '{bin:hatch} run {arg}',
};

function pyprojectTables(text) {
  const map = { 'tool.poe.tasks': 'poe', 'tool.pdm.scripts': 'pdm', 'tool.rye.scripts': 'rye', 'tool.hatch.envs.default.scripts': 'hatch' };
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { cur = map[h[1].trim()] || null; continue; }
    if (!cur || !line || line.startsWith('#')) continue;
    const m = /^("?)([A-Za-z0-9][A-Za-z0-9_.:-]*)\1\s*=\s*(.*)$/.exec(line);
    if (m) out.push({ source: cur, name: m[2], detail: m[3].slice(0, 100) });
  }
  return out;
}

// -> [{source, label, file, scripts:[{name, detail}]}]
function detect(ws) {
  const groups = [];
  const pkgText = read(path.join(ws, 'package.json'));
  if (pkgText) {
    try {
      const scripts = JSON.parse(pkgText).scripts;
      const names = scripts && typeof scripts === 'object' ? Object.keys(scripts).filter((n) => NAME_RE.test(n) && typeof scripts[n] === 'string') : [];
      if (names.length) {
        const mgr = fs.existsSync(path.join(ws, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(ws, 'yarn.lock')) ? 'yarn' : 'npm';
        groups.push({ source: mgr, label: `package.json (${mgr})`, file: 'package.json', scripts: names.map((n) => ({ name: n, detail: scripts[n].slice(0, 100) })) });
      }
    } catch { /* invalid package.json: nothing to list */ }
  }
  for (const f of ['Makefile', 'makefile', 'GNUmakefile']) {
    const t = read(path.join(ws, f));
    if (t === null) continue;
    const seen = new Set();
    for (const line of t.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=:])/.exec(line);
      if (m && !seen.has(m[1]) && NAME_RE.test(m[1])) seen.add(m[1]);
    }
    if (seen.size) groups.push({ source: 'make', label: f, file: f, scripts: [...seen].map((n) => ({ name: n, detail: '' })) });
    break;
  }
  const py = read(path.join(ws, 'pyproject.toml'));
  if (py) {
    const bySource = {};
    for (const s of pyprojectTables(py)) if (NAME_RE.test(s.name)) (bySource[s.source] ||= []).push({ name: s.name, detail: s.detail });
    for (const [source, scripts] of Object.entries(bySource)) groups.push({ source, label: `pyproject.toml (${source})`, file: 'pyproject.toml', scripts });
  }
  return groups;
}

module.exports = { detect, TEMPLATES, NAME_RE };
