// Helpers for talking to a remote Ollama-compatible server: URL handling, error wording, connection test.
'use strict';

const PRIVATE_NAME = /\.(local|lan|internal|home|home\.arpa|ts\.net)$/i;

// Accepts a pasted address (or a whole blob of text containing one) and returns a clean base URL.
function normalizeUrl(input) {
  let s = String(input || '').trim();
  const m = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) s = m[0];
  else s = s.replace(/^["'<]+|["'>]+$/g, '');
  if (!s) throw new Error('Enter the server address, for example https://something.trycloudflare.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^[A-Za-z0-9._\-[\]:]+(\/\S*)?$/.test(s)) throw new Error('That does not look like a web address.');
    const guess = new URL('http://' + s);
    s = (classify(guess.href).scope === 'public' ? 'https://' : 'http://') + s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are supported.');
  if (u.username || u.password) throw new Error('Do not put a user name or password in the address. Use the token field instead.');
  let p = u.pathname.replace(/\/+$/, '');
  const i = p.indexOf('/api');
  if (i >= 0) p = p.slice(0, i);
  return u.origin + p;
}

// loopback | private | public. "private" means a LAN / VPN style address.
function classify(url) {
  const u = new URL(url);
  const h = u.hostname.toLowerCase();
  let scope = 'public';
  if (h === 'localhost' || /^127\./.test(h) || h === '[::1]') scope = 'loopback';
  else if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /^\[f[cd]/.test(h) || /^\[fe80/.test(h)
    || PRIVATE_NAME.test(h) || (!h.includes('.') && !h.startsWith('['))) scope = 'private';
  return { host: u.host, hostname: u.hostname, https: u.protocol === 'https:', scope };
}

function describeError(e) {
  const code = e && (e.code || (e.cause && e.cause.code));
  switch (code) {
    case 'ECONNREFUSED': return 'connection refused (nothing is listening there: the server, tunnel or SSH forward is not running)';
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'the host name cannot be found (wrong address, or the tunnel URL has expired)';
    case 'ETIMEDOUT': case 'FABER_CONNECT_TIMEOUT': return 'timed out while connecting (host offline, firewalled, or wrong address)';
    case 'FABER_HEADERS_TIMEOUT': return 'the server accepted the connection but sent no answer for too long';
    case 'FABER_IDLE': return 'the server stopped sending data';
    case 'ECONNRESET': case 'UND_ERR_SOCKET': return 'the connection was reset or closed by the server or network';
    case 'EHOSTUNREACH': case 'ENETUNREACH': return 'the network cannot reach that host';
    case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'the TLS certificate is not trusted (' + code + ')';
    default:
  }
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timed out';
  const cause = e && e.cause && e.cause.message;
  return (cause || (e && e.message) || String(e)).replace(/\s+/g, ' ');
}

function tunnelMessage(status) {
  if (status === 530 || status === 1033) return `The tunnel has no server behind it any more (HTTP ${status}). The notebook session probably ended or was restarted. Start it again and paste the new URL.`;
  return `The tunnel could not get an answer from the model server (HTTP ${status}). The remote session may have ended, or the model is still loading.`;
}

// Short, safe test: GET /api/version then /api/tags.
async function testServer(url, token, { timeoutMs = 6000 } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const get = async (p) => {
    const t0 = performance.now();
    const r = await fetch(url + p, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { r, ms: Math.round(performance.now() - t0) };
  };
  const out = { ok: false, url };
  try {
    const { r, ms } = await get('/api/version');
    out.latencyMs = ms; out.status = r.status;
    if (r.status >= 300 && r.status < 400) { out.error = `The address redirects to ${r.headers.get('location') || 'another address'}. Use that address directly.`; return out; }
    if (r.status === 401 || r.status === 403) {
      out.authRequired = true;
      out.error = token ? `The server rejected the access token (HTTP ${r.status}). Check the token; it changes every time the notebook is restarted.` : `The server needs an access token (HTTP ${r.status}). Add the token to the server profile.`;
      return out;
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (r.status === 530 || (r.status >= 502 && r.status <= 524 && !j)) { out.error = tunnelMessage(r.status); return out; }
    if (!r.ok || !j || typeof j.version !== 'string') {
      out.error = `This address answered (HTTP ${r.status}) but not like an Ollama server. Check the URL.`;
      return out;
    }
    out.version = j.version;
    const t = await get('/api/tags');
    out.latencyMs = Math.round((ms + t.ms) / 2);
    if (t.r.ok) {
      const tj = await t.r.json().catch(() => ({}));
      out.models = (tj.models || []).map((m) => ({ name: m.name, size: m.size || 0 }));
    } else out.models = [];
    out.ok = true;
  } catch (e) {
    out.error = 'Cannot reach the server: ' + describeError(e) + '.';
  }
  return out;
}

// LAN discovery. Only called after the user presses Scan. prefixes: ['192.168.1'] etc. Probes /api/version.
async function probeOllama(host, port, timeoutMs) {
  const url = `http://${host}:${port}`;
  try {
    const r = await fetch(url + '/api/version', { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.version === 'string' ? { host, port, url, version: j.version } : null;
  } catch { return null; }
}
async function scanLan(prefixes, { port = 11434, timeoutMs = 500, concurrency = 64, shouldStop = () => false, onProgress } = {}) {
  const addrs = [];
  for (const p of prefixes) { if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p)) continue; for (let i = 1; i < 255; i++) addrs.push(`${p}.${i}`); }
  const found = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < addrs.length && !shouldStop()) {
      const a = addrs[next++];
      const r = await probeOllama(a, port, timeoutMs);
      if (r) found.push(r);
      done++;
      if (onProgress && done % 16 === 0) onProgress(done, addrs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, addrs.length) }, worker));
  if (onProgress) onProgress(done, addrs.length);
  return found;
}
// The /24 prefixes of this PC's private IPv4 interfaces.
function lanPrefixes(interfaces) {
  const out = new Set();
  for (const list of Object.values(interfaces || {})) for (const i of list || []) {
    if (i.family !== 'IPv4' && i.family !== 4) continue;
    if (i.internal) continue;
    if (classify('http://' + i.address).scope !== 'private') continue;
    out.add(i.address.split('.').slice(0, 3).join('.'));
  }
  return [...out];
}

module.exports = { normalizeUrl, classify, describeError, tunnelMessage, testServer, probeOllama, scanLan, lanPrefixes };
