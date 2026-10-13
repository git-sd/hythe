// The command-line tool (tools/orchestra-cli.js) end to end against the scripted multi-model Ollama.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { startPersonaFake, MODELS } = require('./fake-models');
const { verify } = require('../src/comms');
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + String(JSON.stringify(x)).slice(0, 400) : '')); };
const cli = (args, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'orchestra-cli.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  if (input) p.stdin.write(input);
  p.stdin.end();
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

(async () => {
  const fake = await startPersonaFake({});
  const host = fake.url;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-cli-'));
  const trace = path.join(os.tmpdir(), `faber-cli-trace-${Date.now()}.jsonl`);

  const run = await cli(['run', 'Create a small FizzBuzz module with tests and a README', '--host', host, '--dir', dir, '--coder', MODELS.coder, '--reviewer', MODELS.reviewer, '--trace', trace]);
  check('run: exits 0 on success', run.code === 0, { code: run.code, err: run.err.slice(0, 200), out: run.out.slice(-300) });
  check('run: prints a header with the roster (role -> model)', /FABER MULTI-AGENT ORCHESTRATION/.test(run.out) && /coder\s+fake-coder:7b/.test(run.out) && /fast\s+fake-fast:1b/.test(run.out) && /reviewer\s+fake-review:3b/.test(run.out));
  check('run: the trace prints live (task, tool, result, plan, final entries)', ['TASK', 'TOOL', 'RESULT', 'PLAN', 'FINAL', 'USAGE'].every((k) => new RegExp('#\\d{3}\\s+\\+[\\d.]+s\\s+' + k).test(run.out)));
  check('run: messages show sender -> receiver and the model', /orchestrator -> coder\s+\[fake-coder:7b\]/.test(run.out) && /coder -> orchestrator\s+\[fake-coder:7b\]/.test(run.out) && /reviewer -> orchestrator\s+\[fake-review:3b\]/.test(run.out));
  check('run: the rework round is visible', /asked for changes/.test(run.out) && /VERDICT: APPROVED/.test(run.out));
  check('run: ends with the final answer, per-agent table and "Trace integrity: VERIFIED"', /FINAL ANSWER:/.test(run.out) && /Per-agent activity:/.test(run.out) && /Trace integrity: VERIFIED/.test(run.out));
  check('run: four different models appear in the per-agent table', [MODELS.conductor, MODELS.coder, MODELS.fast, MODELS.reviewer].every((m) => run.out.split('Per-agent activity:')[1].includes(m)));
  check('run: files created in the chosen folder', ['fizzbuzz.js', 'test.js', 'README.md'].every((f) => fs.existsSync(path.join(dir, f))));
  const E = fs.readFileSync(trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('run: the trace file verifies and holds the full text of long messages', verify(E).ok && E.some((e) => e.kind === 'task' && e.text.length > 600));
  check('run: console clips long bodies but says the file has the rest', /full text in the trace file/.test(run.out));

  const full = await cli(['run', 'Another FizzBuzz', '--host', host, '--dir', fs.mkdtempSync(path.join(os.tmpdir(), 'faber-cli-')), '--coder', MODELS.coder, '--reviewer', MODELS.reviewer, '--full']);
  check('--full prints complete messages (no clipping)', !/full text in the trace file/.test(full.out) && /YOUR STEP s5:/.test(full.out));

  // ask mode: the CLI asks on stdin
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-cli-'));
  const ask = await cli(['run', 'FizzBuzz with approvals', '--host', host, '--dir', askDir, '--coder', MODELS.coder, '--reviewer', MODELS.reviewer, '--mode', 'ask'], 'n\nn\nn\nn\nn\nn\nn\nn\n');
  check('--mode ask: asks for approval on stdin and a "no" blocks the write', /APPROVAL:/.test(ask.out) && !fs.existsSync(path.join(askDir, 'fizzbuzz.js')), ask.out.slice(0, 300));
  check('--mode ask: the question and the denial are both in the trace output', /QUESTION/.test(ask.out) && /ANSWER\s+owner/.test(ask.out) && /denied/.test(ask.out));

  const ver = await cli(['verify', trace]);
  check('verify: an untouched saved trace is reported intact, with the models in it', ver.code === 0 && /Trace intact: \d+ entries, chain unbroken, 4 model\(s\)/.test(ver.out), ver);
  const shown = await cli(['verify', trace, '--show']);
  check('verify --show: reprints the whole trace, then the verdict', /#001/.test(shown.out) && /FINAL/.test(shown.out) && /Trace intact/.test(shown.out));
  const forged = path.join(os.tmpdir(), `faber-cli-forged-${Date.now()}.jsonl`);
  const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
  const k = lines.findIndex((l) => JSON.parse(l).kind === 'result');
  const edited = JSON.parse(lines[k]); edited.text = 'VERDICT: APPROVED (edited afterwards)'; lines[k] = JSON.stringify(edited);
  fs.writeFileSync(forged, lines.join('\n') + '\n');
  const ver2 = await cli(['verify', forged]);
  check('verify: an edited message is caught (exit 3) and the entry is named', ver2.code === 3 && /NOT intact at entry #\d+/.test(ver2.out), ver2);
  fs.writeFileSync(forged, lines.filter((_, i) => i !== k).join('\n') + '\n');
  check('verify: a deleted message is caught too', (await cli(['verify', forged])).code === 3);
  check('verify: a missing file gives a readable error', (await cli(['verify', path.join(os.tmpdir(), 'nope.jsonl')])).code === 1);

  const roster = await cli(['roster', '--host', host]);
  check('roster: lists installed models with sizes and the resolved roster', roster.code === 0 && /Installed models \(4\)/.test(roster.out) && /fast\s+fake-fast:1b/.test(roster.out), roster.out.slice(0, 300));
  check('roster: suggests optional specialists with pull commands', /ollama pull /.test(roster.out));

  const tune = await cli(['tune', '--model', MODELS.conductor, '--host', host, '--autotune', '--tokens', '32']);
  check('tune: prints CPU, expected speed, quantization advice and options', tune.code === 0 && /physical cores/.test(tune.out) && /Expected speed/.test(tune.out) && /num_thread = \d+/.test(tune.out) && /Quantization:/.test(tune.out), tune.out.slice(0, 400));
  check('tune: prints Ollama environment commands', /SetEnvironmentVariable\("OLLAMA_FLASH_ATTENTION"/.test(tune.out));
  check('tune: measures real tokens/s through the API', /tokens\/s writing/.test(tune.out));
  check('tune --autotune: tries several thread counts and names a winner', (tune.out.match(/\d+ threads: [\d.]+ tokens\/s/g) || []).length >= 3 && /Best: \d+ threads/.test(tune.out), tune.out.slice(-500));
  const bad = await cli(['tune', '--model', 'ghost:1b', '--host', host]);
  check('tune: unknown model -> clear error and non-zero exit', bad.code === 1 && /not installed/.test(bad.err), bad);
  const down = await cli(['roster', '--host', 'http://127.0.0.1:1']);
  check('Ollama not running -> readable error', down.code === 1 && /Cannot reach Ollama/.test(down.err), down.err);
  const none = await cli([]);
  check('no command prints usage', /run "<task>"/.test(none.out));

  await fake.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
