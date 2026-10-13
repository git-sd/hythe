// Tiny fake Ollama (GET /api/version, GET /api/tags) so tests do not depend on a real Ollama install.
const http = require('http');

module.exports = function fakeOllama() {
  const st = { models: ['qwen3.5:9b'], port: 0, server: null, hits: 0 };
  const make = () => http.createServer((req, res) => {
    st.hits++;
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/tags')) res.end(JSON.stringify({ models: st.models.map((name) => ({ name })) }));
    else if (req.url.startsWith('/api/version')) res.end('{"version":"0.0.0-test"}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  st.listen = (port = 0) => new Promise((ok, bad) => {
    st.server = make();
    st.server.once('error', bad);
    st.server.listen(port, '127.0.0.1', () => { st.port = st.server.address().port; ok(st.port); });
  });
  st.stop = () => new Promise((ok) => {
    const s = st.server;
    st.server = null;
    if (!s) return ok();
    if (s.closeAllConnections) s.closeAllConnections();
    s.close(() => ok());
  });
  return st;
};
