// The communication line between agents: every message between agents (and between the orchestrator and an agent)
// goes through here and is recorded BEFORE it is delivered. Nothing is summarised away: the full text is kept
// in memory, in a JSONL file, and can be shown live in the UI or printed to the console.
//
// Structural guarantee: the only way the orchestrator / team feature talks to an agent is line.request(), which
// logs the task, runs the agent, then logs the reply or error. There is no second channel.
// Tamper evidence: each entry carries the SHA-256 of the previous entry, so a deleted, edited or reordered entry
// is detected by verify(). (It proves integrity of the record, not that the model told the truth.)
// Exports a plain object, not a function, so the feature loader never treats this file as a feature.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KINDS = ['system', 'plan', 'task', 'result', 'question', 'answer', 'board', 'tool', 'tool-result', 'thought', 'usage', 'error', 'final'];
const ANSI = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m' };
const KIND_COLOR = { system: 'gray', plan: 'magenta', task: 'cyan', result: 'green', question: 'yellow', answer: 'yellow', board: 'blue', tool: 'gray', 'tool-result': 'gray', thought: 'gray', usage: 'gray', error: 'red', final: 'green' };

const GENESIS = '0'.repeat(64);
const hashOf = (e) => crypto.createHash('sha256').update(e.prev + JSON.stringify([e.seq, e.ts, e.run, e.from, e.to, e.kind, e.model, e.text, e.meta])).digest('hex');
const clipText = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + ` ... [+${s.length - n} chars, full text in the trace file]` : s; };

// Check a list of entries. Works on a window too: the first entry's `prev` is trusted as the anchor.
function verify(entries) {
  if (!entries.length) return { ok: true, count: 0 };
  let prev = entries[0].prev;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.seq !== entries[i - 1].seq + 1) return { ok: false, count: entries.length, brokenAt: e.seq, reason: `gap: entry ${entries[i - 1].seq + 1} is missing` };
    if (e.prev !== prev) return { ok: false, count: entries.length, brokenAt: e.seq, reason: 'chain broken: the previous-entry hash does not match' };
    if (hashOf(e) !== e.hash) return { ok: false, count: entries.length, brokenAt: e.seq, reason: 'entry was altered: its hash does not match its content' };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

/*
  opts: file     JSONL path (appended as entries happen); omit for memory only
        echo     function(text) called with each formatted entry (e.g. console.log); omit for silence
        clip     characters of a message body shown by echo / format (the file and UI keep the full text)
        color    use ANSI colours in formatted output
        keep     entries kept in memory (older ones stay in the file)
*/
function createLine(opts = {}) {
  const { file = '', echo = null, clip = 600, color = false, keep = 5000 } = opts;
  const subs = new Set();
  let list = [];
  let seq = 0;
  let prev = GENESIS;
  const t0 = Date.now();
  let run = '';

  const col = (c, s) => (color && ANSI[c] ? ANSI[c] + s + ANSI.reset : s);

  function format(e, o = {}) {
    const n = o.full ? Infinity : (o.clip || clip);
    const when = `+${(e.t / 1000).toFixed(3)}s`.padStart(9);
    const who = `${e.from} -> ${e.to}`;
    const head = `#${String(e.seq).padStart(3, '0')} ${when}  ${e.kind.toUpperCase().padEnd(11)} ${who}${e.model ? '  [' + e.model + ']' : ''}${e.meta && e.meta.ms !== undefined ? '  (' + (e.meta.ms / 1000).toFixed(1) + 's)' : ''}`;
    // short one-line messages stay on the header line; longer ones are indented underneath
    if (e.text && !e.text.includes('\n') && e.text.length <= 100) return col(KIND_COLOR[e.kind] || 'reset', head) + col('dim', '  | ' + e.text);
    const body = clipText(e.text, n).split('\n').map((l) => '        | ' + l).join('\n');
    return col(KIND_COLOR[e.kind] || 'reset', head) + (e.text ? '\n' + col('dim', body) : '');
  }

  function log({ from, to = 'all', kind = 'system', model = '', text = '', meta = {} }) {
    if (!from) throw new Error('A trace entry needs a sender.');
    const e = { seq: ++seq, ts: Date.now(), t: Date.now() - t0, run, from: String(from), to: String(to), kind: KINDS.includes(kind) ? kind : 'system', model: String(model || ''), text: String(text == null ? '' : text), meta: meta || {}, prev };
    e.hash = hashOf(e);
    prev = e.hash;
    list.push(e);
    if (list.length > keep) list = list.slice(list.length - keep);
    if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* the in-memory record stays complete */ } }
    if (echo) { try { echo(format(e)); } catch { /* printing must never break the run */ } }
    for (const f of subs) { try { f(e); } catch { /* a viewer must never break the run */ } }
    return e;
  }

  // Talk to an agent. `to` = { name, model, run(text) -> string | { text, error, stopped } }.
  async function request(from, to, text, meta = {}) {
    log({ from, to: to.name, kind: meta.kind || 'task', model: to.model, text, meta: { ...meta, kind: undefined } });
    const s = Date.now();
    let reply;
    try { reply = await to.run(text); } catch (err) {
      log({ from: to.name, to: from, kind: 'error', model: to.model, text: err.message, meta: { ms: Date.now() - s } });
      throw err;
    }
    const out = typeof reply === 'string' ? reply : (reply && reply.text) || '';
    const failed = reply && typeof reply === 'object' && (reply.error || reply.stopped);
    log({
      from: to.name, to: from, kind: failed ? 'error' : (meta.replyKind || 'result'), model: to.model,
      text: failed ? (reply.error || 'stopped') + (out ? '\n' + out : '') : out, meta: { ms: Date.now() - s },
    });
    return reply;
  }

  function summary() {
    const by = {};
    for (const e of list) {
      const k = e.from;
      const a = (by[k] ||= { sent: 0, models: new Set(), tokens: 0, tools: 0, errors: 0 });
      a.sent++;
      if (e.model) a.models.add(e.model);
      if (e.kind === 'usage') a.tokens += (e.meta.prompt || 0) + (e.meta.eval || 0);
      if (e.kind === 'tool') a.tools++;
      if (e.kind === 'error') a.errors++;
    }
    return Object.entries(by).map(([agent, a]) => ({ agent, sent: a.sent, models: [...a.models], tokens: a.tokens, tools: a.tools, errors: a.errors }));
  }

  return {
    log, request, format, summary,
    entries: () => list.slice(),
    count: () => seq,
    head: () => prev,
    verify: () => verify(list),
    on: (f) => { subs.add(f); return () => subs.delete(f); },
    startRun: (label) => { run = String(label || ''); return log({ from: 'orchestrator', to: 'all', kind: 'system', text: `run started: ${label}` }); },
    toJSONL: () => list.map((e) => JSON.stringify(e)).join('\n') + (list.length ? '\n' : ''),
    file: () => file,
    clear: () => { list = []; },
  };
}

/*
  Turns an agent's event stream (src/agent.js) into trace entries: reasoning, text said before a tool call, every tool
  call with its arguments, every tool result, token usage and errors. The final reply is NOT logged here: it is the
  RESULT of the request (line.request) so it appears exactly once.
  def = { name, model }. Returns function(ev).
*/
function agentEventLogger(line, def) {
  const buf = { thinking: '', say: '' };
  const flush = () => {
    if (buf.thinking.trim()) line.log({ from: def.name, to: 'owner', kind: 'thought', model: def.model, text: buf.thinking.trim(), meta: { channel: 'thinking' } });
    if (buf.say.trim()) line.log({ from: def.name, to: 'owner', kind: 'thought', model: def.model, text: buf.say.trim(), meta: { channel: 'say' } });
    buf.thinking = ''; buf.say = '';
  };
  return (ev) => {
    switch (ev.type) {
      case 'thinking': buf.thinking += ev.text; break;
      case 'token': buf.say += ev.text; break;
      case 'tool_start': case 'turn_end':
        flush();
        if (ev.type === 'tool_start') line.log({ from: def.name, to: 'tools', kind: 'tool', model: def.model, text: `${ev.name} ${typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args)}`, meta: { call: ev.id } });
        break;
      case 'tool_result': line.log({ from: 'tools', to: def.name, kind: 'tool-result', model: def.model, text: String(ev.output == null ? '' : ev.output), meta: { ok: ev.ok, call: ev.id } }); break;
      case 'usage': line.log({ from: def.name, to: 'owner', kind: 'usage', model: ev.model || def.model, text: `${ev.model || def.model}: ${ev.prompt} prompt + ${ev.eval} generated tokens${ev.tps ? ', ' + ev.tps + ' tokens/s' : ''}, ${(ev.ms / 1000).toFixed(1)}s`, meta: { prompt: ev.prompt, eval: ev.eval, tps: ev.tps, ms: ev.ms } }); break;
      case 'notice': line.log({ from: def.name, to: 'owner', kind: 'system', model: def.model, text: ev.text }); break;
      case 'error': flush(); line.log({ from: def.name, to: 'owner', kind: 'error', model: def.model, text: ev.message }); break;
      case 'done': buf.say = ''; flush(); break;
      default: break;
    }
  };
}

// One line per process, shared by every multi-agent feature, so the owner sees ALL agent traffic in one place.
let sharedLine = null;
const shared = (opts) => (sharedLine ||= createLine(opts || {}));
const resetShared = (opts) => { sharedLine = createLine(opts || {}); return sharedLine; };

module.exports = { createLine, verify, hashOf, KINDS, GENESIS, agentEventLogger, shared, resetShared };
