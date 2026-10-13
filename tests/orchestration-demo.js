// Multi-agent orchestration demo: four DIFFERENT (scripted) models act as distinct agents on one task, and every message
// between them is printed as a trace. Run:  node tests/orchestration-demo.js [--full] [--color]
// The models are scripted stand-ins (tests/fake-models.js), so this shows the plumbing, not real-model quality.
// To watch the same orchestration with REAL models on your PC: node tools/orchestra-cli.js run "<task>" (see docs/EXTENDING.md).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { startPersonaFake, MODELS } = require('./fake-models');
const { createLine } = require('../src/comms');
const { createOrchestrator } = require('../src/orchestrator');
const { resolveRoster } = require('../src/model-roster');

const TASK = 'Create a small FizzBuzz module: fizzbuzz.js exporting fizzbuzz(n), a test.js that checks it, and a README.md describing both.';

async function runDemo(o = {}) {
  const out = o.out || ((s) => console.log(s));
  const fake = await startPersonaFake(o.fake || {});
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-orch-'));
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-trace-'));
  const traceFile = path.join(traceDir, 'trace.jsonl');
  const line = createLine({ file: traceFile, echo: o.quiet ? null : out, clip: o.full ? 1e9 : 360, color: !!o.color });

  const installed = [
    { name: MODELS.conductor, size: 6.6e9, caps: ['completion', 'tools', 'thinking'] },
    { name: MODELS.coder, size: 4.7e9, caps: ['completion', 'tools'] },
    { name: MODELS.fast, size: 1.3e9, caps: ['completion', 'tools'] },
    { name: MODELS.reviewer, size: 2.5e9, caps: ['completion', 'tools'] },
  ];
  const { roster } = resolveRoster({ installed, primary: MODELS.conductor, overrides: { coder: MODELS.coder, reviewer: MODELS.reviewer } });
  const pick = (role) => roster.find((r) => r.role === role);
  if (!o.quiet) {
    out('='.repeat(78));
    out('FABER MULTI-AGENT ORCHESTRATION TRACE');
    out('='.repeat(78));
    out(`Task: ${TASK}`);
    out('Roster (role -> model):');
    for (const r of roster.filter((x) => ['conductor', 'coder', 'reviewer', 'fast'].includes(x.role))) out(`  ${r.role.padEnd(10)} ${r.model.padEnd(16)} (${r.source}: ${r.note})`);
    out('-'.repeat(78));
  }

  const orch = createOrchestrator({
    host: fake.url, workspace: ws, line, mode: 'auto', concurrency: o.concurrency || 1, maxRework: 1,
    roster: {
      conductor: { model: pick('conductor').model },
      agents: [
        { name: 'coder', role: 'coder', model: pick('coder').model },
        { name: 'reviewer', role: 'reviewer', model: pick('reviewer').model },
        { name: 'fast', role: 'fast', model: pick('fast').model },
      ],
    },
    installed: installed.map((m) => m.name),
  });
  const result = await orch.run(TASK);

  let testOut = '', testOk = false;
  try { testOut = execFileSync(process.execPath, ['test.js'], { cwd: ws, encoding: 'utf8' }).trim(); testOk = true; } catch (e) { testOut = String(e.stdout || e.message); }

  if (!o.quiet) {
    out('-'.repeat(78));
    out('FINAL ANSWER (written by the conductor):');
    out('  ' + result.final.replace(/\n/g, '\n  '));
    out('');
    out('Per-agent activity (from the trace):');
    for (const s of line.summary().filter((x) => !['orchestrator', 'tools', 'owner'].includes(x.agent))) out(`  ${s.agent.padEnd(10)} model(s): ${s.models.join(', ').padEnd(16)} messages: ${String(s.sent).padStart(2)}  tool calls: ${s.tools}  tokens: ${s.tokens}  errors: ${s.errors}`);
    const v = line.verify();
    out(`Trace integrity: ${v.ok ? 'VERIFIED' : 'BROKEN'} (${v.count} entries, head ${line.head().slice(0, 16)}...)`);
    out(`Trace file: ${traceFile}`);
    out(`Files created: ${fs.readdirSync(ws).filter((f) => !f.startsWith('.')).join(', ')}`);
    out(`Running the produced test.js: ${testOk ? 'PASS' : 'FAIL'} - ${testOut}`);
    out('='.repeat(78));
  }
  return { result, line, fake, ws, testOk, testOut, traceFile, orch };
}

module.exports = { runDemo, TASK };

if (require.main === module) {
  const argv = process.argv.slice(2);
  runDemo({ full: argv.includes('--full'), color: argv.includes('--color') || process.stdout.isTTY }).then(async (r) => {
    await r.fake.close();
    process.exit(r.result.ok && r.testOk ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
