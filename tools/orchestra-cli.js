#!/usr/bin/env node
// Faber from the command line: run the multi-agent orchestrator, look at the model roster, tune a model for the CPU.
// Everything talks to YOUR Ollama (default http://127.0.0.1:11434). The trace of every agent message prints as it happens.
//
//   node tools/orchestra-cli.js run "<task>" [--dir <project folder>] [--host <url>] [--mode auto|edits|ask]
//        [--conductor <model>] [--coder <model>] [--reviewer <model>] [--fast <model>] [--concurrency 1] [--rework 1]
//        [--timeout 900] [--trace <file.jsonl>] [--full] [--color]
//   node tools/orchestra-cli.js roster [--host <url>]
//   node tools/orchestra-cli.js tune --model <model> [--host <url>] [--autotune] [--tokens 48]
//   node tools/orchestra-cli.js demo                      (scripted models, no Ollama needed)
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { createLine } = require('../src/comms');
const { createOrchestrator } = require('../src/orchestrator');
const { resolveRoster } = require('../src/model-roster');
const cpuTune = require('../src/cpu-tune');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['full', 'color', 'autotune'].includes(k)) flags[k] = true; else flags[k] = argv[++i];
  } else rest.push(a);
}
const host = String(flags.host || process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const color = flags.color || process.stdout.isTTY;
const say = (s = '') => console.log(s);

async function jget(p, body) {
  const res = await fetch(host + p, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Ollama ${p}: HTTP ${res.status}`);
  return res.json();
}
async function installed() {
  let tags;
  try { tags = (await jget('/api/tags')).models || []; } catch (e) { throw new Error(`Cannot reach Ollama at ${host}. Start it (open the Ollama app or run "ollama serve").`); }
  return Promise.all(tags.map(async (m) => {
    let caps = null, d = {};
    try { const s = await jget('/api/show', { model: m.name }); caps = Array.isArray(s.capabilities) ? s.capabilities : null; d = s.details || {}; } catch { /* unknown */ }
    return { name: m.name, size: m.size || 0, caps, params: d.parameter_size || '', quant: d.quantization_level || '' };
  }));
}
const gb = (n) => (n / 1073741824).toFixed(1) + ' GB';

async function cmdRoster() {
  const inst = await installed();
  const primary = flags.model || (inst[0] && inst[0].name) || '';
  const r = resolveRoster({ installed: inst, primary, ramTotal: os.totalmem() });
  say(`Installed models (${inst.length}):`);
  for (const m of inst) say(`  ${m.name.padEnd(28)} ${gb(m.size).padStart(8)}  ${m.params} ${m.quant}  caps: ${m.caps ? m.caps.join(',') : 'unknown'}`);
  say('\nRoster (role -> model):');
  for (const o of r.roster) say(`  ${o.role.padEnd(11)} ${o.model.padEnd(28)} (${o.source}: ${o.note})`);
  if (r.suggestions.length) {
    say('\nSpecialists you could add (optional, approximate sizes, check ollama.com/library):');
    for (const s of r.suggestions) say(`  ollama pull ${s.model.padEnd(22)} ${s.role.padEnd(10)} ~${s.sizeGB} GB  ${s.why}`);
  }
}

async function cmdTune() {
  const model = flags.model;
  if (!model) throw new Error('Usage: tune --model <model> [--autotune]');
  const inst = await installed();
  const m = inst.find((x) => x.name === model || x.name === model + ':latest');
  if (!m) throw new Error(`Model ${model} is not installed. Installed: ${inst.map((x) => x.name).join(', ') || 'none'}`);
  const cpu = await cpuTune.detectCpu({ os });
  const ram = { total: os.totalmem(), free: os.freemem() };
  const p = cpuTune.cpuProfile({ cpu, ram, model: { weights: m.size, paramsB: parseFloat(m.params) || 0, quant: m.quant } });
  say(`CPU: ${cpu.model || 'unknown'}: ${cpu.physical} physical cores, ${cpu.logical} threads (${cpu.source})`);
  say(`RAM: ${gb(ram.total)} total, ${gb(ram.free)} free`);
  say(`Model: ${m.name}  ${m.params} ${m.quant}  ${gb(m.size)}`);
  if (p.speed) say(`Expected speed (rough): ${p.speed.low} to ${p.speed.high} tokens/s`);
  say(`Quantization: ${p.quant.text}`);
  for (const w of p.warnings) say(`WARNING: ${w}`);
  say('\nRecommended options:');
  for (const [k, v] of Object.entries(p.options)) say(`  ${(k + ' = ' + v).padEnd(22)} ${p.why[k] || ''}`);
  say('\nOllama environment (set once, then restart Ollama):');
  say(cpuTune.envCommands(p.env).split('\n').map((l) => '  ' + l).join('\n'));
  const tokens = Number(flags.tokens) || 48;
  say('\nMeasuring with the recommended options (loads the model; may take a while on a CPU)...');
  const b = await cpuTune.benchmark({ host, model: m.name, options: p.options, numPredict: tokens });
  if (!b.ok) throw new Error(b.error);
  say(`  ${b.tokPerSec} tokens/s writing, ${b.promptTokPerSec} tokens/s reading the prompt, load ${(b.loadMs / 1000).toFixed(1)}s`);
  if (flags.autotune) {
    say('\nAuto-tuning thread count...');
    const t = await cpuTune.autoTune({ host, model: m.name, cpu, base: { ...p.options, num_thread: undefined }, numPredict: tokens, onProgress: (e) => say(`  ${String(e.threads).padStart(2)} threads: ${e.result.ok ? e.result.tokPerSec + ' tokens/s' : e.result.error}`) });
    if (!t.ok) throw new Error(t.error);
    say(`Best: ${t.best.threads} threads at ${t.best.tokPerSec} tokens/s (${t.gainVsWorst}% faster than the slowest tried).`);
  }
}

async function cmdRun() {
  const task = rest.join(' ').trim();
  if (!task) throw new Error('Usage: run "<task>" [--dir <folder>] ...');
  const dir = path.resolve(flags.dir || process.cwd());
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  const inst = await installed();
  const primary = flags.conductor || flags.model || (inst[0] && inst[0].name);
  if (!primary) throw new Error('No models are installed in Ollama.');
  const r = resolveRoster({ installed: inst, primary, overrides: { conductor: flags.conductor, coder: flags.coder, reviewer: flags.reviewer, fast: flags.fast }, ramTotal: os.totalmem() });
  const pick = (role) => r.roster.find((x) => x.role === role).model;
  const traceFile = flags.trace ? path.resolve(flags.trace) : path.join(os.tmpdir(), `faber-trace-${Date.now()}.jsonl`);
  const line = createLine({ file: traceFile, echo: (s) => console.log(s), clip: flags.full ? 1e9 : 500, color });
  say('='.repeat(78));
  say('FABER MULTI-AGENT ORCHESTRATION');
  say('='.repeat(78));
  say(`Task:    ${task}`);
  say(`Folder:  ${dir}`);
  say(`Ollama:  ${host}`);
  say('Roster:');
  for (const o of r.roster.filter((x) => ['conductor', 'coder', 'reviewer', 'fast'].includes(x.role))) say(`  ${o.role.padEnd(11)} ${pick(o.role).padEnd(28)} (${o.source}: ${o.note})`);
  say('-'.repeat(78));
  // answers come from stdin, one line each; lines that arrive early are queued, and end-of-input means "no"
  const rl = readline.createInterface({ input: process.stdin });
  const queued = [], waiting = [];
  let eof = false;
  rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else queued.push(l); });
  rl.on('close', () => { eof = true; while (waiting.length) waiting.shift()('n'); });
  const nextLine = () => (queued.length ? Promise.resolve(queued.shift()) : eof ? Promise.resolve('n') : new Promise((r) => waiting.push(r)));
  const ask = async (q) => { process.stdout.write(q); const a = await nextLine(); process.stdout.write(a + '\n'); return /^y/i.test(a); };
  const mode = ['ask', 'edits', 'auto'].includes(flags.mode) ? flags.mode : 'auto';
  const orch = createOrchestrator({
    host, workspace: dir, line, mode, concurrency: Number(flags.concurrency) || 1, maxRework: flags.rework === undefined ? 1 : Number(flags.rework), stepTimeoutSec: Number(flags.timeout) || 900,
    roster: { conductor: { model: pick('conductor') }, agents: ['coder', 'reviewer', 'fast'].map((role) => ({ name: role, role, model: pick(role) })) },
    installed: inst.map((m) => m.name), fallbackModel: primary,
    approve: mode === 'auto' ? null : (kind, title, detail) => ask(`\n>>> APPROVAL: ${title}\n${String(detail).slice(0, 600)}\nAllow? [y/N] `),
  });
  process.on('SIGINT', () => { say('\nStopping...'); orch.stop(); });
  const result = await orch.run(task);
  rl.close();
  say('-'.repeat(78));
  say(`RESULT: ${result.status}`);
  say('FINAL ANSWER:\n  ' + (result.final || result.error || '(none)').replace(/\n/g, '\n  '));
  say('\nPer-agent activity:');
  for (const s of line.summary().filter((x) => !['orchestrator', 'tools', 'owner'].includes(x.agent))) say(`  ${s.agent.padEnd(11)} ${s.models.join(', ').padEnd(28)} messages ${String(s.sent).padStart(3)}  tool calls ${String(s.tools).padStart(3)}  tokens ${String(s.tokens).padStart(6)}  errors ${s.errors}`);
  const v = line.verify();
  say(`Trace integrity: ${v.ok ? 'VERIFIED' : 'BROKEN'} (${v.count} entries). Full trace: ${traceFile}`);
  say('='.repeat(78));
  process.exit(result.ok ? 0 : 2);
}

(async () => {
  try {
    if (cmd === 'run') await cmdRun();
    else if (cmd === 'roster') await cmdRoster();
    else if (cmd === 'tune') await cmdTune();
    else if (cmd === 'demo') { const { runDemo } = require('../tests/orchestration-demo'); const r = await runDemo({ color, full: flags.full }); await r.fake.close(); process.exit(r.result.ok && r.testOk ? 0 : 1); }
    else {
      say(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
})();
