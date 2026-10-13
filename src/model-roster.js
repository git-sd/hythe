// Which model plays which role. Pure functions (no I/O) so they are easy to test. Exports an object, not a function,
// so the feature loader never treats this file as a feature.
//
// Roles:  conductor (plans, checks, writes the final answer)   coder (edits files, runs commands)
//         reviewer (independent check, read-only)              researcher (reads the project, read-only)
//         fast (small quick model for summaries / simple jobs)
// Resolution works with whatever is installed: preferences first, then the primary model. Nothing is downloaded here.
// SUGGESTIONS are well-known Ollama library names with APPROXIMATE download sizes; library names and sizes change,
// so check ollama.com/library before pulling. They are suggestions, never installed automatically.

const GB = 1073741824;
const ROLES = ['conductor', 'coder', 'reviewer', 'researcher', 'fast'];

// Preference lists: first match among the installed models wins. A name without a tag matches any tag of that family.
const PREFS = {
  conductor: ['qwen3.5', 'qwen3', 'llama3.3', 'llama3.1', 'gemma3', 'phi4'],
  coder: ['qwen2.5-coder', 'qwen3-coder', 'deepseek-coder-v2', 'deepseek-coder', 'codellama', 'starcoder2', 'codegemma'],
  reviewer: ['qwen3.5', 'qwen3', 'gemma3', 'phi4', 'llama3.1'],
  researcher: ['qwen3.5', 'qwen3', 'llama3.1', 'gemma3'],
  fast: ['llama3.2:1b', 'qwen2.5:1.5b', 'gemma3:1b', 'qwen3:1.7b', 'smollm2', 'qwen2.5:3b', 'llama3.2:3b', 'phi4-mini'],
};

const SUGGESTIONS = [
  { role: 'fast', model: 'llama3.2:1b', sizeGB: 1.3, why: 'Very small and quick: summaries, titles, simple edits. Runs well on any CPU.' },
  { role: 'fast', model: 'qwen2.5:1.5b', sizeGB: 1.0, why: 'Small multilingual model with tool support.' },
  { role: 'fast', model: 'gemma3:1b', sizeGB: 0.8, why: 'Smallest option here; good for light text work.' },
  { role: 'coder', model: 'qwen2.5-coder:1.5b', sizeGB: 1.0, why: 'A fast code specialist for small edits and completions.' },
  { role: 'coder', model: 'qwen2.5-coder:7b', sizeGB: 4.7, why: 'A stronger code specialist. Fits in 15 GB RAM; slower on CPU.' },
  { role: 'reviewer', model: 'phi4-mini', sizeGB: 2.5, why: 'A compact model with good reasoning, a different family from the coder for an independent check.' },
  { role: 'researcher', model: 'qwen3:4b', sizeGB: 2.6, why: 'Mid-size reader/summariser with tool support.' },
];

const family = (n) => String(n).split(':')[0];
const canon = (n) => (String(n).includes(':') ? String(n) : String(n) + ':latest');
const isEmbed = (m) => !!m.caps && m.caps.includes('embedding') && !m.caps.includes('completion');
const canTool = (m) => !m.caps || m.caps.includes('tools');   // unknown capabilities count as possible

function matches(name, pref) {
  if (pref.includes(':')) return canon(name) === canon(pref);
  return family(name) === pref;
}
const firstPref = (installed, prefs, skip) => {
  for (const p of prefs) {
    const hit = installed.filter((m) => matches(m.name, p) && !skip(m)).sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    if (hit) return hit;
  }
  return null;
};

/*
  installed: [{ name, size (bytes), caps (array | null) }]
  primary:   the user's main model name (always the last fallback)
  overrides: { role: modelName }  explicit choices win
  ramTotal:  bytes, used only to filter suggestions
  returns { roster: [{ role, model, source, note }], suggestions: [...] }
*/
function resolveRoster({ installed = [], primary, overrides = {}, ramTotal = 0 } = {}) {
  const usable = installed.filter((m) => !isEmbed(m) && canTool(m));
  const names = new Set(installed.map((m) => canon(m.name)));
  const prim = installed.find((m) => canon(m.name) === canon(primary)) || { name: primary, size: 0 };
  const out = [];
  const pick = (role, model, source, note) => out.push({ role, model, source, note });

  for (const role of ROLES) {
    const ov = overrides[role];
    if (ov) {
      if (names.has(canon(ov)) || !installed.length) { pick(role, ov, 'chosen', 'chosen by you'); continue; }
      pick(role, primary, 'primary', `${ov} is not installed, using ${primary}`);
      continue;
    }
    if (role === 'fast') {
      // the speed specialist: the smallest installed model that can use tools and is clearly lighter than the primary
      const fp = firstPref(usable, PREFS.fast, (m) => canon(m.name) === canon(primary));
      const smallest = [...usable].filter((m) => canon(m.name) !== canon(primary)).sort((a, b) => (a.size || 1e18) - (b.size || 1e18))[0];
      const light = (m) => m && (!prim.size || !m.size || m.size <= prim.size * 0.6);
      const chosen = [fp, smallest].find(light);
      if (chosen) pick(role, chosen.name, fp && chosen === fp ? 'preferred' : 'smallest', `smallest suitable installed model (${chosen.size ? (chosen.size / GB).toFixed(1) + ' GB' : 'size unknown'})`);
      else pick(role, primary, 'primary', 'no smaller model installed');
      continue;
    }
    const hit = firstPref(usable, PREFS[role], () => false);
    if (role === 'reviewer') {
      // an independent check is worth more from a different model than the coder's
      const coder = out.find((o) => o.role === 'coder');
      const other = firstPref(usable, PREFS.reviewer, (m) => coder && canon(m.name) === canon(coder.model));
      if (other) { pick(role, other.name, 'preferred', 'different from the coder, for an independent check'); continue; }
      if (hit) { pick(role, hit.name, 'preferred', 'same as the coder (no other suitable model installed)'); continue; }
      pick(role, primary, 'primary', 'no other model installed');
      continue;
    }
    if (hit) pick(role, hit.name, 'preferred', `best installed ${role} model`);
    else pick(role, primary, 'primary', `no ${role} specialist installed, using the primary model`);
  }

  const have = (role) => out.find((o) => o.role === role);
  const suggestions = SUGGESTIONS.filter((s) => {
    if (names.has(canon(s.model))) return false;
    const r = have(s.role);
    if (r && r.source !== 'primary' && r.source !== 'smallest') return false;   // that role already has a specialist
    return !ramTotal || s.sizeGB * GB * 1.3 < ramTotal * 0.5;
  });
  return { roster: out, suggestions };
}

module.exports = { ROLES, PREFS, SUGGESTIONS, resolveRoster, matches };
