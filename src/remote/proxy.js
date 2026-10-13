// Tiny local reverse proxy: 127.0.0.1:<random> -> remote Ollama, adding the Authorization header.
// Streams in both directions without buffering (NDJSON). Keeps the token out of core code and settings.
'use strict';
const http = require('http');
const https = require('https');
const { describeError, tunnelMessage } = require('./net');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host']);
const TUNNEL_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

function createProxy({ target, token = '', label = 'remote server', onEvent = () => {}, timeouts = {} }) {
  const T = { connectMs: 15000, headersMs: 15 * 60 * 1000, idleMs: 5 * 60 * 1000, ...timeouts };
  const base = new URL(target);
  const lib = base.protocol === 'https:' ? https : http;
  const basePath = base.pathname.replace(/\/+$/, '');
  const agent = new lib.Agent({ keepAlive: false });
  const stats = { requests: 0, active: 0, bytesOut: 0, bytesIn: 0, errors: 0, lastError: '' };
  const sockets = new Set();
  let port = 0;

  const fail = (res, status, message) => {
    stats.errors++; stats.lastError = message;
    onEvent({ type: 'error', status, message });
    if (res.headersSent) { res.destroy(); return; }
    const body = JSON.stringify({ error: message });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  function handle(req, res) {
    // Only the app's own main process may use this relay: refuse web pages (DNS rebinding / drive-by requests).
    if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']) return fail(res, 403, 'Browser requests are not allowed on the Faber local relay.');
    const hostHdr = String(req.headers.host || '').toLowerCase();
    if (hostHdr !== `127.0.0.1:${port}` && hostHdr !== `localhost:${port}`) return fail(res, 403, 'Unexpected Host header.');
    if (!['GET', 'POST', 'DELETE', 'HEAD'].includes(req.method)) return fail(res, 405, 'Method not allowed.');
    const url = req.url || '/';
    if (!(url === '/' || url.startsWith('/api/') || url.startsWith('/v1/')) || url.includes('..') || url.includes('\\')) return fail(res, 404, 'Not an Ollama API path.');

    stats.requests++; stats.active++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; stats.active--; } };
    res.on('close', finish);
    req.socket.setNoDelay(true);
    req.on('data', (c) => { stats.bytesOut += c.length; });

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || k === 'authorization' || k === 'accept-encoding') continue;
      headers[k] = v;
    }
    headers.host = base.host;
    headers['accept-encoding'] = 'identity';
    if (token) headers.authorization = 'Bearer ' + token;

    let headersTimer = null;
    const up = lib.request({
      protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || (base.protocol === 'https:' ? 443 : 80),
      method: req.method, path: basePath + url, headers, agent,
    }, (upRes) => {
      clearTimeout(headersTimer);
      const code = upRes.statusCode;
      const drain = () => upRes.resume();
      if (code >= 300 && code < 400 && code !== 304) {
        drain();
        return fail(res, 502, `${label} redirected the request to ${upRes.headers.location || 'another address'}. Faber does not follow redirects; edit the server address.`);
      }
      if (code === 401 || code === 403) {
        drain();
        return fail(res, code, token
          ? `${label} rejected the access token (HTTP ${code}). Edit the server profile and enter the current token.`
          : `${label} requires an access token (HTTP ${code}). Edit the server profile and add the token.`);
      }
      if (TUNNEL_STATUS.has(code) && !/json/i.test(String(upRes.headers['content-type'] || ''))) {
        drain();
        return fail(res, 502, `${label}: ${tunnelMessage(code)}`);
      }
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(code, out);
      res.flushHeaders();
      if (res.socket) res.socket.setNoDelay(true);
      upRes.on('data', (c) => { stats.bytesIn += c.length; });
      upRes.pipe(res);
      upRes.setTimeout(T.idleMs, () => upRes.destroy(Object.assign(new Error('idle'), { code: 'FABER_IDLE' })));
      upRes.on('error', () => {});
      upRes.on('close', () => {
        if (upRes.complete) return;
        const msg = `${label} stopped sending the answer part way through: ${describeError(upRes.errored || { code: 'ECONNRESET' })}.`;
        stats.errors++; stats.lastError = msg;
        onEvent({ type: 'error', midStream: true, message: msg });
        if (req.url.startsWith('/api/pull') && !res.writableEnded) { res.end(JSON.stringify({ error: msg }) + '\n'); } else res.destroy();
      });
    });
    up.on('socket', (s) => {
      s.setNoDelay(true);
      if (s.connecting) {
        const t = setTimeout(() => up.destroy(Object.assign(new Error('connect timeout'), { code: 'FABER_CONNECT_TIMEOUT' })), T.connectMs);
        s.once(base.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(t));
        s.once('close', () => clearTimeout(t));
      }
    });
    headersTimer = setTimeout(() => up.destroy(Object.assign(new Error('no answer'), { code: 'FABER_HEADERS_TIMEOUT' })), T.headersMs);
    up.on('error', (e) => {
      clearTimeout(headersTimer);
      if (res.writableEnded || res.destroyed) return;
      fail(res, 502, `${label} is unreachable: ${describeError(e)}.`);
    });
    // The app stopped waiting (Stop button): stop the remote work too.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  const server = http.createServer(handle);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('clientError', (_e, s) => { try { s.destroy(); } catch { /* gone */ } });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`, port, stats,
        close() { return new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }); },
      });
    });
  });
}

module.exports = { createProxy };
