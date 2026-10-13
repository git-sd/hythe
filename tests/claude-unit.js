// Claude provider: request translation, SSE parsing, tool loop through the real agent, errors. Plain Node, fake server.
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const claude = require('../src/claude');
const { createAgent } = require('../src/agent');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.end();
};
const start = (idx, block) => ['content_block_start', { index: idx, content_block: block }];
const delta = (idx, d) => ['content_block_delta', { index: idx, delta: d }];
const stop = (idx) => ['content_block_stop', { index: idx }];

(async () => {
  const seen = [];
  let mode = 'normal';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        if (req.headers['x-api-key'] !== 'sk-ant-test-key-aaaaaaaaaaaa') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid x-api-key"}}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}');
      }
      const body = JSON.parse(raw);
      seen.push({ headers: req.headers, body });
      if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
      if (mode === 'refusal') return sse(res, [['message_start', { message: { usage: { input_tokens: 5 } } }], ['message_delta', { delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 0 } }], ['message_stop', {}]]);
      const hasResult = JSON.stringify(body.messages).includes('tool_result');
      if (!hasResult) {
        return sse(res, [
          ['message_start', { message: { usage: { input_tokens: 100, output_tokens: 1 } } }],
          start(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'let me look' }), delta(0, { type: 'signature_delta', signature: 'SIG123' }), stop(0),
          start(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'Reading ' }), delta(1, { type: 'text_delta', text: 'the file.' }), stop(1),
          start(2, { type: 'tool_use', id: 'toolu_abc', name: 'read_file', input: {} }), delta(2, { type: 'input_json_delta', partial_json: '{"pa' }), delta(2, { type: 'input_json_delta', partial_json: 'th":"n.txt"}' }), stop(2),
          ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }], ['message_stop', {}],
        ]);
      }
      sse(res, [
        ['message_start', { message: { usage: { input_tokens: 150, output_tokens: 1 } } }],
        start(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'It says ' }), delta(0, { type: 'text_delta', text: 'HELLO-FILE.' }), stop(0),
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }], ['message_stop', {}],
      ]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let enabled = true;
  claude.configure({ baseUrl: url, getKey: () => 'sk-ant-test-key-aaaaaaaaaaaa', enabled: () => enabled });

  /* ---- pure translation ---- */
  const tr = claude.toMessages([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'a', arguments: { x: 1 } } }, { function: { name: 'b', arguments: '{"y":2}' } }] },
    { role: 'tool', tool_name: 'a', content: 'ra' },
    { role: 'tool', tool_name: 'b', content: 'rb' },
    { role: 'user', content: 'next' },
  ], 'claude:m');
  check('system extracted', tr.system === 'SYS');
  check('roles alternate user/assistant/user/user', tr.messages.map((m) => m.role).join() === 'user,assistant,user,user', tr.messages.map((m) => m.role));
  const tu = tr.messages[1].content.filter((b) => b.type === 'tool_use');
  check('two tool_use blocks with parsed args', tu.length === 2 && tu[0].input.x === 1 && tu[1].input.y === 2);
  const trs = tr.messages[2].content;
  check('both tool_results in ONE user message, ids matched in order', trs.length === 2 && trs[0].tool_use_id === tu[0].id && trs[1].tool_use_id === tu[1].id, trs);
  const dangling = claude.toMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a', arguments: {} } }] }, { role: 'user', content: 'again' }], 'claude:m');
  check('unanswered tool_use gets an error tool_result', dangling.messages[2].content[0].type === 'tool_result' && dangling.messages[2].content[0].is_error === true, dangling.messages);
  const tl = claude.toTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { k: { type: 'string', secret: true } }, required: ['k'] } } }]);
  check('tool schema converted and secret marker removed', tl[0].name === 'f' && tl[0].input_schema.properties.k.secret === undefined && tl[0].input_schema.required[0] === 'k');

  /* ---- through the real agent: thinking, text, tool call, tool result, final text ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
  fs.writeFileSync(path.join(dir, 'n.txt'), 'HELLO-FILE\n');
  const events = [];
  const agent = createAgent({
    id: 't', emit: (e) => events.push(e), approve: async () => true,
    getSettings: () => ({ host: 'http://127.0.0.1:1', model: 'claude:claude-sonnet-5-5', effort: 'high', mode: 'auto', hasFolder: true, workspace: dir, sandbox: true, numCtx: 8192 }),
  });
  const r = await agent.send('what is in n.txt?');
  check('agent finished without error', !r.error && r.text.includes('HELLO-FILE'), r);
  check('streamed thinking + text + tool events', events.some((e) => e.type === 'thinking') && events.some((e) => e.type === 'token' && e.text.includes('Reading')) && events.some((e) => e.type === 'tool_start' && e.name === 'read_file'));
  check('tool actually ran against the file', events.some((e) => e.type === 'tool_result' && e.ok && /HELLO-FILE/.test(e.output)));
  check('two requests were made', seen.length === 2, seen.length);
  const h = seen[0].headers, b0 = seen[0].body;
  check('API key and version headers sent', h['x-api-key'] === 'sk-ant-test-key-aaaaaaaaaaaa' && h['anthropic-version'] === '2023-06-01');
  check('model id has the claude: prefix removed', b0.model === 'claude-sonnet-5-5');
  check('streaming + adaptive thinking + effort', b0.stream === true && b0.thinking.type === 'adaptive' && b0.output_config.effort === 'high' && b0.max_tokens === 16000);
  check('no sampling params sent (rejected by new models)', b0.temperature === undefined && b0.top_p === undefined);
  check('tools sent as input_schema', Array.isArray(b0.tools) && b0.tools.some((t) => t.name === 'read_file' && t.input_schema));
  check('system prompt sent as top-level system', typeof b0.system === 'string' && b0.system.includes('Faber'));
  const asst = seen[1].body.messages.find((m) => m.role === 'assistant');
  check('second request replays thinking block with its signature', asst && asst.content[0].type === 'thinking' && asst.content[0].signature === 'SIG123', asst);
  const res2 = seen[1].body.messages[seen[1].body.messages.length - 1].content[0];
  check('tool_result uses the tool_use id Claude produced', res2.type === 'tool_result' && res2.tool_use_id === 'toolu_abc', res2);
  const conv = agent.transcript();
  check('transcript stores raw blocks only for claude', conv.some((m) => m.claude));

  /* ---- errors + gating ---- */
  mode = '429';
  let r2 = await agent.send('again');
  check('429 becomes a readable message', /rate limit/i.test(r2.error || ''), r2.error);
  mode = 'refusal';
  r2 = await agent.send('again2');
  check('refusal becomes a readable message with category', /declined.*cyber/i.test(r2.error || ''), r2.error);
  mode = 'normal';
  const n0 = seen.length;
  enabled = false;
  r2 = await agent.send('again3');
  check('disabled provider refuses WITHOUT any network call', /turned off/i.test(r2.error || '') && seen.length === n0, r2.error);
  enabled = true;
  claude.configure({ getKey: () => null });
  r2 = await agent.send('again4');
  check('missing key refuses with a clear message', /No Claude API key/.test(r2.error || ''), r2.error);
  claude.configure({ getKey: () => 'sk-ant-test-key-aaaaaaaaaaaa' });

  /* ---- key test + ollama strip ---- */
  check('testKey ok with the right key', (await claude.testKey('sk-ant-test-key-aaaaaaaaaaaa')).ok);
  const bad = await claude.testKey('sk-ant-wrong');
  check('testKey reports a bad key', !bad.ok && /rejected/.test(bad.error), bad);
  const sent = [];
  const fakeOllama = http.createServer((req, res) => { let d = ''; req.on('data', (x) => { d += x; }); req.on('end', () => { sent.push(JSON.parse(d)); res.writeHead(200); res.end(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n'); }); });
  await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r));
  const local = createAgent({
    id: 'l', emit: () => {}, approve: async () => true, conv: conv.slice(),
    getSettings: () => ({ host: `http://127.0.0.1:${fakeOllama.address().port}`, model: 'qwen3.5:9b', effort: 'low', mode: 'auto', hasFolder: false, workspace: dir, sandbox: true }),
  });
  await local.send('hello local');
  check('switching to a local model never sends Claude raw blocks to Ollama', sent.length === 1 && !JSON.stringify(sent[0]).includes('SIG123'), sent.length);

  server.close(); fakeOllama.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
