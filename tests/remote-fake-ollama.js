// Fake Ollama server for tests: /api/version, /api/tags, streaming NDJSON /api/chat and /api/pull, optional bearer check.
const http = require('http');

function startFake({ token = '', chunks = 5, delayMs = 250 } = {}) {
  const state = { token, seen: [], authHeaders: [] };
  const server = http.createServer((req, res) => {
    state.seen.push(req.method + ' ' + req.url);
    state.authHeaders.push(req.headers.authorization || '');
    if (state.token && req.headers.authorization !== 'Bearer ' + state.token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      state.lastBody = Buffer.concat(body).toString();
      if (req.url === '/api/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"version":"0.0.0-fake"}'); }
      if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake-model:1b', size: 123456 }, { name: 'qwen3.5:9b', size: 999 }] })); }
      if (req.url === '/api/chat' || req.url === '/api/pull') {
        const chat = req.url === '/api/chat';
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let i = 0;
        const t = setInterval(() => {
          i++;
          if (i > chunks) { clearInterval(t); res.write(JSON.stringify(chat ? { message: { role: 'assistant', content: '' }, done: true } : { status: 'success' }) + '\n'); return res.end(); }
          res.write(JSON.stringify(chat ? { message: { role: 'assistant', content: `tok${i} ` }, done: false } : { status: 'pulling', total: chunks, completed: i }) + '\n');
        }, delayMs);
        res.on('close', () => { clearInterval(t); state.closedEarly = i <= chunks; });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"model not found"}'.replace('model not found', 'nope'));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, url: 'http://127.0.0.1:' + server.address().port, state,
    sockets: (server._s = new Set()),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}
module.exports = { startFake };
