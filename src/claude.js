// Optional ONLINE provider: Claude through the Anthropic Messages API (streaming + tool use).
// Opt-in only: a model named "claude:<id>" is routed here instead of Ollama, and only while the user has turned
// Claude on and saved their own API key (src/features/claude.js does that and keeps the key in safeStorage).
// This module speaks plain HTTPS from the main process. It translates Faber's Ollama-style conversation
// ({role, content, tool_calls} + {role:'tool'}) to Messages API blocks and the SSE stream back to Ollama-style parts,
// so src/agent.js can treat both providers the same way.
const PREFIX = 'claude:';
const API_VERSION = '2023-06-01';
const BASE = 'https://api.anthropic.com';

// Models offered in the picker. Pricing is per million tokens (input/output), from the public price list.
const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Fast and capable for everyday coding', price: '$2 / $10' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable', price: '$4 / $20' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Cheapest and quickest', price: '$0.10 / $0.50' },
];

const MAX_TOKENS = { low: 4096, medium: 8192, high: 16000 };

let cfg = { getKey: () => null, enabled: () => false, baseUrl: BASE };
// getKey() -> string | null, enabled() -> bool. baseUrl is for tests only (the feature never sets it from user input).
const configure = (c) => { cfg = { ...cfg, ...c }; };

const isClaude = (model) => String(model || '').startsWith(PREFIX);
const idOf = (model) => String(model).slice(PREFIX.length);

const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try { return JSON.parse(a || '{}'); } catch { return {}; }
};

// Ollama tool schemas -> Anthropic tools. The non-standard `secret` marker is ours, drop it.
function toTools(list) {
  return (list || []).map((t) => {
    const f = t.function || {};
    const params = JSON.parse(JSON.stringify(f.parameters || { type: 'object', properties: {} }));
    for (const p of Object.values(params.properties || {})) if (p && typeof p === 'object') delete p.secret;
    return { name: f.name, description: f.description || '', input_schema: params };
  });
}

// Conversation -> { system, messages }. Every tool_use must be answered by a tool_result in the NEXT user message,
// all results of one assistant turn together.
function toMessages(msgs, model) {
  let system = '';
  const out = [];
  let ids = [];            // tool_use ids of the latest assistant turn, in call order
  let n = 0;
  const push = (role, blocks) => { if (blocks.length) out.push({ role, content: blocks }); };
  for (const m of msgs) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + m.content; continue; }
    if (m.role === 'user') { if (String(m.content || '').trim()) push('user', [{ type: 'text', text: String(m.content) }]); ids = []; continue; }
    if (m.role === 'assistant') {
      let blocks;
      if (Array.isArray(m.claude) && m.claudeModel === model) {
        blocks = m.claude;      // replayed exactly as received, so thinking signatures stay valid
      } else {
        blocks = [];
        if (String(m.content || '').trim()) blocks.push({ type: 'text', text: String(m.content) });
        for (const c of m.tool_calls || []) blocks.push({ type: 'tool_use', id: `toolu_${++n}`, name: c.function.name, input: parseArgs(c.function.arguments) });
      }
      ids = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
      push('assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      const id = ids.shift();
      const text = String(m.content == null ? '' : m.content) || '(no output)';
      const last = out[out.length - 1];
      const block = id ? { type: 'tool_result', tool_use_id: id, content: text } : { type: 'text', text: `Tool result (${m.tool_name || 'tool'}):\n${text}` };
      if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result' || b.type === 'text') && id && last.content[0].type === 'tool_result') last.content.push(block);
      else push('user', [block]);
    }
  }
  // a tool_use with no reply (e.g. an interrupted run) would be rejected by the API
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant') continue;
    const need = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!need.length) continue;
    const next = out[i + 1];
    const have = new Set(next && next.role === 'user' ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []);
    const missing = need.filter((id) => !have.has(id));
    if (!missing.length) continue;
    const fill = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'Interrupted before this ran.', is_error: true }));
    if (next && next.role === 'user' && next.content[0].type === 'tool_result') next.content.unshift(...fill);
    else out.splice(i + 1, 0, { role: 'user', content: fill });
  }
  return { system, messages: out };
}

function buildRequest(body) {
  const model = idOf(body.model);
  const { system, messages } = toMessages(body.messages, body.model);
  const eff = body.__effort || 'medium';
  const req = {
    model, max_tokens: MAX_TOKENS[eff] || MAX_TOKENS.medium, stream: true,
    messages, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: ['low', 'medium', 'high'].includes(eff) ? eff : 'medium' },
  };
  if (system) req.system = system;
  const tools = toTools(body.tools);
  if (tools.length) req.tools = tools;
  return req;
}

function headers(key) {
  return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
}

function friendlyError(status, text) {
  let msg = text;
  try { const j = JSON.parse(text); msg = (j.error && j.error.message) || j.message || text; } catch { /* plain text */ }
  if (status === 401) return 'Claude rejected the API key (401). Check it in Settings > Claude (online).';
  if (status === 403) return `Claude refused access (403): ${msg}`;
  if (status === 404) return `Claude model not found (404): ${msg}`;
  if (status === 429) return 'Claude rate limit or spending limit reached (429). Wait a moment and send again.';
  if (status === 529 || status === 503) return 'Claude is overloaded right now. Try again in a minute.';
  return `Claude error ${status}: ${String(msg).slice(0, 400)}`;
}

function precheck() {
  if (!cfg.enabled()) throw new Error('Claude (online) is turned off. Turn it on in Settings > Claude (online), or pick a local model.');
  const key = cfg.getKey();
  if (!key) throw new Error('No Claude API key is saved. Add your own key in Settings > Claude (online).');
  return key;
}

// Parses an SSE byte stream into { event, data } objects.
async function* sse(body) {
  const dec = new TextDecoder();
  let buf = '';
  const parse = (chunk) => {
    let event = 'message', data = '';
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
    }
    if (!data) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return null; }
  };
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const ev = parse(raw);
      if (ev) yield ev;
    }
  }
  if (buf.trim()) { const ev = parse(buf); if (ev) yield ev; }
}

// body = the Ollama-style request agent.js built. Yields Ollama-style parts.
async function* stream(body, signal, settings = {}) {
  const key = precheck();
  const req = buildRequest({ ...body, __effort: settings.effort });
  let res;
  try {
    res = await fetch(cfg.baseUrl + '/v1/messages', { method: 'POST', headers: headers(key), body: JSON.stringify(req), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Cannot reach the Claude API (api.anthropic.com). Check your internet connection.');
  }
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, await res.text()));
    err.status = res.status;
    throw err;
  }
  const blocks = [];       // accumulated content blocks, in order
  const partial = {};      // index -> tool input json text
  let stop = null, details = null, inTok = 0, outTok = 0;
  for await (const { event, data } of sse(res.body)) {
    if (event === 'error' || data.type === 'error') throw new Error(friendlyError(data.error && data.error.type === 'overloaded_error' ? 529 : 500, JSON.stringify(data)));
    if (data.type === 'message_start' && data.message && data.message.usage) {
      const u = data.message.usage;
      inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      outTok = u.output_tokens || 0;
    } else if (data.type === 'content_block_start') {
      const b = { ...data.content_block };
      if (b.type === 'text') b.text = b.text || '';
      if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
      if (b.type === 'tool_use') { b.input = {}; partial[data.index] = ''; }
      blocks[data.index] = b;
    } else if (data.type === 'content_block_delta') {
      const b = blocks[data.index], d = data.delta || {};
      if (!b) continue;
      if (d.type === 'text_delta') { b.text += d.text; yield { message: { role: 'assistant', content: d.text } }; }
      else if (d.type === 'thinking_delta') { b.thinking += d.thinking; yield { message: { role: 'assistant', content: '', thinking: d.thinking } }; }
      else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
      else if (d.type === 'input_json_delta') partial[data.index] += d.partial_json;
    } else if (data.type === 'content_block_stop') {
      const b = blocks[data.index];
      if (b && b.type === 'tool_use') {
        try { b.input = partial[data.index] ? JSON.parse(partial[data.index]) : {}; } catch { throw new Error(`Claude sent a tool call (${b.name}) with unreadable arguments. Try again.`); }
        yield { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: b.name, arguments: b.input } }] } };
      }
    } else if (data.type === 'message_delta') {
      if (data.delta) { stop = data.delta.stop_reason || stop; details = data.delta.stop_details || details; }
      if (data.usage) outTok = data.usage.output_tokens || outTok;
    }
  }
  if (stop === 'refusal') {
    const cat = details && details.category ? ` (${details.category})` : '';
    throw new Error(`Claude declined this request${cat}. Rephrase it or use a different model.`);
  }
  const kept = blocks.filter(Boolean).filter((b) => !(b.type === 'text' && !b.text));
  yield {
    done: true, done_reason: stop === 'max_tokens' ? 'length' : stop === 'tool_use' ? 'tool_calls' : 'stop',
    prompt_eval_count: inTok, eval_count: outTok,
    message: { role: 'assistant', content: '', raw: kept, rawModel: body.model },
  };
}

// One-shot, non-streaming completion without tools (used by /compact).
async function complete(messages, model, signal) {
  const key = precheck();
  const { system, messages: msgs } = toMessages(messages, model);
  const req = { model: idOf(model), max_tokens: 2048, messages: msgs, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
  if (system) req.system = system;
  let res;
  try { res = await fetch(cfg.baseUrl + '/v1/messages', { method: 'POST', headers: headers(key), body: JSON.stringify(req), signal }); }
  catch { throw new Error('Cannot reach the Claude API (api.anthropic.com).'); }
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));
  const j = await res.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Cheap key check: lists one model. Returns { ok, error? }.
async function testKey(key) {
  try {
    const res = await fetch(cfg.baseUrl + '/v1/models?limit=1', { headers: headers(key) });
    if (res.ok) return { ok: true };
    return { ok: false, error: friendlyError(res.status, await res.text()) };
  } catch { return { ok: false, error: 'Cannot reach the Claude API (api.anthropic.com). Check your internet connection.' }; }
}

module.exports = { PREFIX, MODELS, isClaude, idOf, configure, stream, complete, testKey, toMessages, toTools, buildRequest };
