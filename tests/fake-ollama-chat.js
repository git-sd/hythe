// Fake Ollama with a streaming /api/chat for the agents/debug/team/split-chat tests (+ /api/tags, /api/version).
// Default behaviour is a mini script language in the LAST user message:
//   [say TEXT]  [slow N]  [think TEXT]  [err]  [read PATH]  [write PATH|CONTENT]  [delegate ROLE :: TASK]
// After a tool result the fake answers "<TAG>-DONE: <tool result>". Tests can replace fake.script(body, rec) to
// drive anything, returning { content, thinking, calls:[{name,args}], delay }.
const http = require('http');

function startFake(opts = {}) {
  const fake = {
    requests: [], inflight: 0, maxInflight: 0, aborted: 0, port: 0, url: '',
    models: opts.models || ['qwen3.5:9b', 'fake-b:1b', 'nothink:1b'], sizes: opts.sizes || {}, loaded: opts.loaded || [],
    script: null,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
  };

  function defaultScript(body) {
    const msgs = body.messages;
    let li = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
    const user = li >= 0 ? msgs[li].content : '';
    const toolMsgs = msgs.slice(li + 1).filter((m) => m.role === 'tool');
    const cmd = user.match(/\[(\w+)\s*([\s\S]*)\]\s*$/) || [];
    const word = cmd[1], arg = (cmd[2] || '').trim();
    if (toolMsgs.length) return { content: `${(word || 'x').toUpperCase()}-DONE: ${toolMsgs[toolMsgs.length - 1].content.slice(0, 300)}` };
    switch (word) {
      case 'say': return { content: arg };
      case 'slow': return { content: Array.from({ length: Number(arg) || 10 }, (_, i) => `w${i} `).join(''), delay: 150 };
      case 'think': return { thinking: 'pondering ' + arg, content: 'THOUGHT-DONE ' + arg };
      case 'read': return { calls: [{ name: 'read_file', args: { path: arg } }] };
      case 'write': { const [p, ...c] = arg.split('|'); return { calls: [{ name: 'write_file', args: { path: p, content: c.join('|') } }] }; }
      case 'delegate': { const [role, ...t] = arg.split(' :: '); return { calls: [{ name: 'delegate_task', args: { role: role.trim(), task: t.join(' :: ') } }] }; }
      default: return { content: 'ok: ' + user.slice(0, 40) };
    }
  }

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/version') return json(200, { version: '0.0.0-fake' });
    if (req.url === '/api/tags') return json(200, { models: fake.models.map((name) => ({ name, model: name, size: fake.sizes[name] || 5.5e9 })) });
    if (req.url === '/api/ps') return json(200, { models: fake.loaded || [] });
    if (req.url === '/api/show') {
      return json(200, { details: { parameter_size: '9B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools', 'thinking'], parameters: '', template: '', model_info: { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096, 'llama.context_length': 131072 } });
    }
    if (req.url !== '/api/chat') return json(404, { error: 'not found' });
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const rec = { model: body.model, think: body.think, options: body.options, keep_alive: body.keep_alive, messages: body.messages, tools: (body.tools || []).map((t) => t.function.name), stream: body.stream, t0: Date.now(), aborted: false, system: body.messages[0] && body.messages[0].content };
      fake.requests.push(rec);
      if (/^nothink/.test(body.model) && body.think !== undefined) return json(400, { error: `"${body.model}" does not support thinking` });
      const user = [...body.messages].reverse().find((m) => m.role === 'user');
      if (user && /\[err\]\s*$/.test(user.content)) return json(500, { error: 'boom from fake' });
      const out = await (fake.script || defaultScript)(body, rec);
      if (body.stream === false) return json(200, { model: body.model, message: { role: 'assistant', content: 'SUMMARY: fake summary' }, done: true, done_reason: 'stop' });
      fake.inflight++;
      fake.maxInflight = Math.max(fake.maxInflight, fake.inflight);
      let closed = false;
      res.on('close', () => { if (!closed) { closed = true; rec.aborted = !res.writableEnded; if (rec.aborted) fake.aborted++; fake.inflight--; } });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const line = (o) => res.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), ...o }) + '\n');
      const delay = out.delay || 8;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let n = 0;
      if (out.thinking && body.think) line({ message: { role: 'assistant', content: '', thinking: out.thinking }, done: false });
      for (const tok of (out.content || '').match(/\S+\s*/g) || []) {
        if (res.destroyed || res.writableEnded) break;
        line({ message: { role: 'assistant', content: tok }, done: false });
        n++;
        await sleep(delay);
      }
      if (res.destroyed) return;
      if (out.calls && out.calls.length) {
        line({ message: { role: 'assistant', content: '', tool_calls: out.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }, done: false });
      }
      line({ message: { role: 'assistant', content: '' }, done: true, done_reason: out.calls && out.calls.length ? 'tool_calls' : 'stop', total_duration: 900e6, load_duration: 100e6, prompt_eval_count: 50 + body.messages.length * 7, prompt_eval_duration: 200e6, eval_count: Math.max(1, n) * 2, eval_duration: Math.max(1, n) * 2 * 25e6 });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.port = server.address().port;
      fake.url = `http://127.0.0.1:${fake.port}`;
      resolve(fake);
    });
  });
}

module.exports = { startFake };
