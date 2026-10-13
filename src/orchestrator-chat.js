// Talk to the orchestrator. You type "I want 4 agents", "add a reviewer", "use qwen3.5:4b for the coders" or a task such as
// "build a snake game", and the orchestrator creates / changes the team or runs the task with it.
//
// Plain Node, no Electron, no model needed for the team commands: they are understood by rules (instant, offline, the same answer
// every time, unit-tested on many phrasings). Anything that is not a team command is a TASK and goes to the conductor model
// (src/orchestrator.js). Nothing is hidden: every message in both directions is handed to `onMessage` (the app logs it on the
// communication line), and the orchestrator says what it understood and how to undo it.
// Exports a plain object, not a function, so the feature loader never treats this file as a feature.
const { resolveRoster } = require('./model-roster');
const cpuTune = require('./cpu-tune');

const MAX_AGENTS = 12;
const WORDS = { a: 1, an: 1, another: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, 'a couple of': 2, 'a pair of': 2, 'a trio of': 3, 'a few': 3, several: 4, 'a dozen': 12 };
const NUM = '(\\d+|a couple of|a pair of|a trio of|a few|a dozen|several|another|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an|a)';
const toNum = (t) => (/^\d+$/.test(t) ? Number(t) : WORDS[t] || 0);

// What you can ask for. role = how the agent is built (tools, rules); focus = extra instructions for a specialty.
const KINDS = [
  { id: 'coder', re: /^(coders?|developers?|programmers?|engineers?|devs?|builders?|implementers?)$/, role: 'coder', prefix: 'coder', label: 'coder' },
  { id: 'tester', re: /^(testers?|qas?)$/, role: 'coder', prefix: 'tester', label: 'tester', focus: 'writing and running tests; you check that the code really works by running it' },
  { id: 'reviewer', re: /^(reviewers?|critics?|checkers?|auditors?|inspectors?)$/, role: 'reviewer', prefix: 'reviewer', label: 'reviewer' },
  { id: 'researcher', re: /^(researchers?|analysts?|explorers?|readers?|scouts?)$/, role: 'researcher', prefix: 'researcher', label: 'researcher' },
  { id: 'writer', re: /^(writers?|documenters?)$/, role: 'coder', prefix: 'writer', label: 'writer', focus: 'writing documentation: README files, comments and changelogs' },
  { id: 'helper', re: /^(helpers?|assistants?|summari[sz]ers?)$/, role: 'fast', prefix: 'helper', label: 'fast helper' },
];
const GENERIC = /^(agents?|workers?|bots?|members?|teammates?)$/;
const kindOf = (w) => KINDS.find((k) => k.re.test(w));
// which kind an agent is, from what it IS (role and specialty), not from its name: agents can be renamed
const isKind = (a, k) => a.role === k.role && (k.focus ? a.focus === k.focus : !a.focus);
const kindOfAgent = (a) => KINDS.find((k) => isKind(a, k)) || KINDS[0];

const MGMT = /\b(create|make|spawn|spin up|set up|setup|build|start|add|get|give|need|want|use|hire|summon|launch|deploy|bring|assemble|form|like)\b/;
const AGENT_NOUN = /\b(agents?|team|teammates?|workers?|bots?)\b/;
// words that show the message is about code or files, not about the team, when no agent noun is present
const TASK_SIGNAL = /\b[\w-]+\.(js|ts|tsx|jsx|py|html|css|json|md|txt|java|c|cpp|go|rs|rb|php|sh)\b|\b(function|class|component|page|permission|feature|field|column|table|endpoint|route|button|screen|menu|api|role|script|module|file|test suite|bug|app)\b/;
const GLUE = new Set(['create', 'make', 'spawn', 'spin', 'up', 'set', 'setup', 'start', 'add', 'get', 'give', 'need', 'want', 'use', 'hire', 'summon', 'launch', 'deploy', 'bring', 'assemble', 'form', 'like', 'please', 'can', 'could', 'you', 'would', 'i', 'id', 'd', 'ill', 'me', 'us', 'my', 'for', 'a', 'an', 'the', 'some', 'new', 'more', 'extra', 'with', 'using', 'and', 'then', 'to', 'that', 'who', 'which', 'so', 'they', 'them', 'have', 'let', 'should', 'will', 'of', 'team', 'agents', 'agent', 'ok', 'okay', 'now', 'just', 'also', 'plus', 'build']);
const TASK_VERB = /^(build|write|make|create|fix|implement|add|set up|generate|refactor|test|review|document|update|change|remove|rename|convert|port|design|develop|code|check|find|explain|summari[sz]e|analy[sz]e|investigate|optimi[sz]e|clean)\b/;

/* ---------- reading what the user asked for ---------- */
const itemRe = () => new RegExp('\\b' + NUM + '\\s+(?:(?:more|extra|additional|new|other|different|separate)\\s+)*(?:(fast|quick|small)\\s+)?([a-z][a-z-]*)\\b', 'gi');
const VERB_KIND = [[/^(code|develop|program|build|implement|write code)$/, 'coder'], [/^(review|check|audit|critique|inspect)$/, 'reviewer'], [/^(test|verify)$/, 'tester'], [/^(research|read|explore|analy[sz]e|investigate)$/, 'researcher'], [/^(document|write docs)$/, 'writer'], [/^(summari[sz]e|help|assist)$/, 'helper']];
const verbItemRe = () => new RegExp('\\b' + NUM + '\\s+(?:of them\\s+)?(?:agents?\\s+)?to\\s+(code|develop|program|build|implement|write code|review|check|audit|critique|inspect|test|verify|research|read|explore|analy[sz]e|investigate|document|write docs|summari[sz]e|help|assist)\\b', 'gi');
const teamOfRe = () => new RegExp('\\b(?:team|group|crew|squad)\\s+of\\s+' + NUM + '\\b', 'gi');

// -> { total, items:[{kind,count}], spans:[[start,end]], bare:[kind] }  (spans are what the spec used up, so the rest can be the task)
function parseSpec(text, { allowBare = false } = {}) {
  const spec = { total: 0, items: [], spans: [], bare: [] };
  const t = String(text);
  let m;
  const to = teamOfRe();
  while ((m = to.exec(t))) { const n = toNum(m[1].toLowerCase()); if (n) { spec.total += n; spec.spans.push([m.index, m.index + m[0].length]); } }
  const re = itemRe();
  while ((m = re.exec(t))) {
    const n = toNum(m[1].toLowerCase());
    const noun = m[3].toLowerCase();
    const fast = !!m[2];
    const kind = kindOf(noun) || (fast && GENERIC.test(noun) ? KINDS.find((k) => k.id === 'helper') : null);
    if (spec.spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (kind && n) { spec.items.push({ kind, count: n }); spec.spans.push([m.index, m.index + m[0].length]); }
    else if (GENERIC.test(noun) && n) { spec.total += n; spec.spans.push([m.index, m.index + m[0].length]); }
  }
  const vr = verbItemRe();
  while ((m = vr.exec(t))) {
    const n = toNum(m[1].toLowerCase());
    const hit = VERB_KIND.find(([re]) => re.test(m[2].toLowerCase()));
    if (n && hit && !spec.spans.some(([a, b]) => m.index >= a && m.index < b)) { spec.items.push({ kind: KINDS.find((k) => k.id === hit[1]), count: n }); spec.spans.push([m.index, m.index + m[0].length]); }
  }
  if (allowBare) {
    const word = /\b([a-z][a-z-]*)\b/gi;
    while ((m = word.exec(t))) {
      const k = kindOf(m[1].toLowerCase());
      if (k && !spec.spans.some(([a, b]) => m.index >= a && m.index < b)) { spec.bare.push(k); spec.spans.push([m.index, m.index + m[0].length]); }
    }
  }
  spec.spans.sort((a, b) => a[0] - b[0]);
  return spec;
}

// the text outside the spec: is there a task in it ("... to build a snake game")?
function taskFromRest(text, spans) {
  const t = String(text);
  const segs = [];
  let at = 0;
  for (const [a, b] of spans) { segs.push({ s: t.slice(at, a), before: at === 0 }); at = b; }
  segs.push({ s: t.slice(at), last: true });
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  let best = '';
  for (const seg of segs) {
    let s = seg.s.replace(/^[\s,:;.\-]+|[\s,:;.\-]+$/g, '');
    // glue at the edges is not part of the task: "... and have them build X", "build X with"
    const strip = (re) => { let prev; do { prev = s; s = s.replace(re, '').trim(); } while (s !== prev); };
    strip(/^(and|then|to|so|that|who|which|for|please|have them|let them|get them to|they can|they should|they will|with|using|:|,|\.)\s+/i);
    strip(/\s+(with|using|and|for|to|please|so|that|who|which|,|:)$/i);
    const w = words(s);
    if (w.length < 2 || w.every((x) => GLUE.has(x))) continue;
    if (w.length >= 2 && (TASK_VERB.test(s.toLowerCase()) || w.length >= 4) && s.length > best.length) best = s;
  }
  return best;
}

function findModel(text, installed) {
  const t = String(text).toLowerCase();
  const ok = (i, len) => !/[\w.:-]/.test(t[i - 1] || ' ') && !/[\w.:-]/.test(t[i + len] || ' ');
  const names = [...installed].sort((a, b) => b.length - a.length);
  for (const n of names) {
    for (const cand of [n.toLowerCase(), n.toLowerCase().replace(/:latest$/, '')]) {
      let i = t.indexOf(cand);
      while (i >= 0) { if (ok(i, cand.length)) return { model: n, span: [i, i + cand.length] }; i = t.indexOf(cand, i + 1); }
    }
  }
  const unknown = /\b[a-z][\w.-]*:[\w.-]+\b/i.exec(text);
  return unknown ? { unknown: unknown[0] } : null;
}

// who a sentence points at: agent names, kinds ("the coders"), or everyone
function targets(text, team) {
  let t = String(text).toLowerCase();
  const names = [];
  for (const a of team) {
    const re = new RegExp('(^|[^a-z0-9_-])' + a.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9_-])', 'g');
    if (re.test(t)) { names.push(a.name); t = t.replace(re, '$1 '); }
  }
  const kinds = [];
  for (const word of t.split(/[^a-z-]+/).filter(Boolean)) { const k = kindOf(word); if (k && !kinds.includes(k.id)) kinds.push(k.id); }
  return { names, kinds, all: /\b(everyone|everybody|all of them|all agents|all the agents|all of the agents|every agent|them all|all)\b/.test(t), conductor: /\b(conductor|orchestrator|planner)\b/.test(t) };
}

/*
  Understand one message. ctx = { team: [{name, role, model, focus}], models: [installed model names] }.
  Returns { type, ... }:  help undo stop list clear remove rename setmodel concurrency permissions direct create add greeting task
*/
function parseIntent(raw, ctx = {}) {
  const text = String(raw || '').trim();
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const team = ctx.team || [];
  const models = ctx.models || [];
  if (!t) return { type: 'empty' };

  if (/^(undo|undo that|revert|go back)\b/.test(t)) return { type: 'undo' };
  if (/^(help|\?|commands|what can you do|what do you do|how do (i|you)|how does this work)\b/.test(t) || /\b(help me|i need help|need some help|what can i say|what are the commands)\b/.test(t)) return { type: 'help' };
  if (/\b(what|which|list|show)\b.*\bmodels?\b/.test(t) && !/\b(use|switch|change|set|put)\b/.test(t) && t.split(' ').length <= 8) return { type: 'models' };
  if (/^(stop|cancel|abort|halt|enough|stop it|stop everything)\b/.test(t) && t.split(' ').length <= 4) return { type: 'stop' };
  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening)|thanks|thank you|thx|ok|okay|cool|nice)\b[!. ]*$/.test(t)) return { type: 'greeting', thanks: /thank|thx/.test(t) };

  // talking to one agent: "@coder1 do X", "ask coder1 to X", "tell the reviewer to X"
  let m = /^@([a-z][\w-]*)\s+([\s\S]+)$/i.exec(text);
  if (m) return { type: 'direct', who: m[1], text: m[2].trim() };
  m = /^(?:ask|tell|have|let|get)\s+(?:the\s+)?([a-z][\w-]*?)\s+(?:to\s+)?([\s\S]+)$/i.exec(text);
  if (m && !/^(them|everyone|all|the|team|agents?)$/i.test(m[1])) {
    const who = m[1].toLowerCase();
    if (team.some((a) => a.name.toLowerCase() === who) || kindOf(who)) return { type: 'direct', who: m[1], text: m[2].trim() };
  }

  // rename
  m = /^rename\s+([a-z][\w-]*)\s+(?:to|as)\s+([a-z][\w-]*)\s*$/i.exec(text);
  if (m) return { type: 'rename', from: m[1], to: m[2] };

  // look at the team
  if (/^(list|show|status|team|agents|my agents|who|roster|overview)\b.*$/.test(t) && t.split(' ').length <= 6 && !MGMT.test(t.replace(/^(show|list)\b/, ''))) return { type: 'list' };
  if (/\b(how many|which|what|who)\b.*\b(agents?|team)\b.*\b(do i have|are there|have i got|exist|created|do we have)\b/.test(t) || /\b(show|list)\b.*\b(agents|team)\b/.test(t)) return { type: 'list' };

  // remove / disband
  if (/^(clear|reset|disband|dismiss|delete|remove|fire|kill|get rid of)\b/.test(t) || /\b(remove|delete|dismiss|fire|kill|get rid of|disband)\b/.test(t)) {
    const tg = targets(t, team);
    const n = /\b(all|every|everyone|everybody|the team|the whole team|my team|team|everything)\b/.test(t) && !tg.names.length && !tg.kinds.length;
    if (/\b(disband|clear|reset)\b/.test(t) || n || (tg.all && !tg.names.length && !tg.kinds.length)) return { type: 'clear' };
    const sp = parseSpec(t);
    const count = sp.items.length ? sp.items.reduce((a, i) => a + i.count, 0) : sp.total || 0;
    if (tg.names.length || tg.kinds.length || count || AGENT_NOUN.test(t)) return { type: 'remove', names: tg.names, kinds: tg.kinds, count, all: tg.all || /\ball\b/.test(t), last: /\blast\b/.test(t) };
  }

  // settings
  const par = new RegExp('\\b' + NUM + '\\s+(?:agents?\\s+|of them\\s+)?(?:at once|at a time|in parallel|simultaneously|together|concurrently|at the same time)\\b').exec(t);
  if (par) return { type: 'concurrency', n: toNum(par[1]) };
  if (/\b(one at a time|sequentially|one after the other|take turns)\b/.test(t)) return { type: 'concurrency', n: 1 };
  if (/\b(in parallel|at the same time|simultaneously|concurrently)\b/.test(t) && /\b(work|run|go)\b/.test(t) && !/\b(agents?|team)\b.*\b(create|make)\b/.test(t)) return { type: 'concurrency', n: 0 };
  if (/\b(don'?t|do not|never) ask\b|\bauto[- ]?approve\b|\bfull auto\b|\bask (me )?(for )?nothing\b/.test(t)) return { type: 'permissions', mode: 'auto' };
  if (/\bask (me )?(before|for) (everything|every|all)\b|\bpermissions? (to )?ask\b/.test(t)) return { type: 'permissions', mode: 'ask' };
  if (/\b(only )?ask (me )?(before|for) (running )?commands\b|\bpermissions? (to )?edits\b|\bauto[- ]?edit\b/.test(t)) return { type: 'permissions', mode: 'edits' };

  // models: "use qwen3.5:4b for the coders"
  const fm = models.length || /:/.test(t) ? findModel(text, models) : null;
  const creating = MGMT.test(t) && (AGENT_NOUN.test(t) || parseSpec(text).items.length > 0 || parseSpec(text).total > 0);
  if (fm && /\b(use|switch|change|set|put|run|move|swap|make|with|on)\b/.test(t) && !creating) {
    if (fm.unknown) return { type: 'setmodel', unknown: fm.unknown, targets: targets(t, team) };
    const rest = t.slice(0, fm.span[0]) + ' ' + t.slice(fm.span[1]);
    return { type: 'setmodel', model: fm.model, targets: targets(rest, team) };
  }

  // creating / adding agents
  const hasNoun = AGENT_NOUN.test(t);
  const withTeam = new RegExp('\\b(with|using|by|via)\\s+(?:a\\s+(?:team|group|crew)\\s+of\\s+)?' + NUM + '\\s+(?:\\w+\\s+)?(agents?|workers?|bots?|coders?|developers?)\\b').test(t);
  const startsMgmt = /^(please |can you |could you |i('d| would) like |i want |i need |let'?s |go |ok |okay |now )?(create|make|spawn|spin up|set up|setup|start|add|get|give|hire|summon|launch|deploy|bring|assemble|form|use|i want|i need|want|need)\b/.test(t) || /\b(i want|i need|i'd like|give me|get me|make me|create me)\b/.test(t) || /^(another|\w+ more)\b/.test(t) || withTeam || /\b(can|could|may) i (get|have|create|make|use)\b|\bi'?d like to (have|get|use)\b|\bi want to (have|get|use)\b|\blet me have\b/.test(t);
  const spec = parseSpec(text, { allowBare: startsMgmt && !TASK_SIGNAL.test(t) });
  const hasSpec = spec.items.length > 0 || spec.total > 0 || spec.bare.length > 0;
  const strong = hasNoun || spec.total > 0 || spec.items.some((i) => i.count >= 2) || /\b(i want|i need|i'd like|give me|get me|make me|create me)\b/.test(t);
  if (startsMgmt && hasSpec && (strong || !TASK_SIGNAL.test(t))) {
    // "add" only counts when it is the verb of the request, not a word inside the task ("... to fix it and add tests")
    const add = /^(please |can you |could you |also |and |now |then )*(add|plus)\b/.test(t) || new RegExp('\\b' + NUM + '\\s+(more|extra|additional)\\b').test(t) || /^another\b|\bone more\b/.test(t);
    for (const b of spec.bare) spec.items.push({ kind: b, count: 1 });
    let model = null;
    const fm2 = models.length ? findModel(text, models) : null;
    if (fm2 && fm2.model) { model = fm2.model; spec.spans.push(fm2.span); spec.spans.sort((a, b) => a[0] - b[0]); }
    const task = taskFromRest(text, spec.spans);
    const you = /\b(you decide|you choose|your choice|whatever|up to you|you pick)\b/.test(t);
    return { type: add ? 'add' : 'create', spec: { total: spec.total, items: spec.items.map((i) => ({ id: i.kind.id, count: i.count })) }, model, task: task && task.length > 3 ? task : '', unknown: fm2 && fm2.unknown ? fm2.unknown : '', youDecide: you };
  }
  if (/^(you decide|you choose|your choice|whatever|up to you|you pick|auto|automatic|surprise me|any)\b/.test(t) && t.split(' ').length <= 4) return { type: 'decide' };
  // a bare number as the answer to "how many agents?"
  const only = new RegExp('^(?:' + NUM + ')\\s*(?:agents?)?[.!]?$').exec(t);
  if (only && toNum(only[1])) return { type: 'create', spec: { total: toNum(only[1]), items: [] }, model: null, task: '', unknown: '' };

  return { type: 'task', text };
}

/* ---------- building the team ---------- */
// What you get when you only say how many: one reviewer from 2 agents up, a fast helper from 4, a researcher from 6.
function defaultMix(n) {
  const out = [];
  const reviewers = n >= 8 ? 2 : n >= 2 ? 1 : 0;
  const helper = n >= 4 ? 1 : 0;
  const researcher = n >= 6 ? 1 : 0;
  for (let i = 0; i < n - reviewers - helper - researcher; i++) out.push('coder');
  for (let i = 0; i < reviewers; i++) out.push('reviewer');
  if (helper) out.push('helper');
  if (researcher) out.push('researcher');
  return out;
}
function expandSpec(spec) {
  const out = [];
  for (const it of spec.items) for (let i = 0; i < it.count; i++) out.push(it.id);
  if (spec.total) {
    if (!out.length) out.push(...defaultMix(spec.total));
    else if (spec.total > out.length) { const rest = spec.total - out.length; const need = !out.includes('reviewer') && rest >= 2; for (let i = 0; i < rest; i++) out.push(need && i === rest - 1 ? 'reviewer' : 'coder'); }
  }
  return out;
}
function nextName(prefix, taken) {
  let n = 1;
  while (taken.has(prefix + n)) n++;
  taken.add(prefix + n);
  return prefix + n;
}
// ids (['coder','reviewer',...]) -> agent definitions with models from what is installed
function buildAgents(ids, { existing = [], roster = [], model = '' } = {}) {
  const taken = new Set(existing.map((a) => a.name));
  const modelFor = (role) => model || (roster.find((r) => r.role === role) || {}).model || '';
  return ids.map((id) => {
    const k = KINDS.find((x) => x.id === id) || KINDS[0];
    const a = { name: nextName(k.prefix, taken), role: k.role, model: modelFor(k.role) };
    if (k.focus) a.focus = k.focus;
    return a;
  });
}
const kindLabel = (a) => kindOfAgent(a).label;

function table(team) {
  const w = Math.max(...team.map((a) => a.name.length), 4);
  const w2 = Math.max(...team.map((a) => kindLabel(a).length), 4);
  return team.map((a) => `  ${a.name.padEnd(w)}  ${kindLabel(a).padEnd(w2)}  ${a.model || '(no model)'}`).join('\n');
}

// "wrote /tmp/x/project/test.js, ran `cd /tmp/x/project && node test.js`, ran `cd ...`": paths cut to their last part, repeats counted
function compactActions(actions) {
  const short = (actions || []).map((a) => String(a).replace(/(?:[A-Za-z]:)?[\\/][^\s`'"]*[\\/]([^\\/\s`'"]+)/g, '$1'));
  const out = [];
  for (const a of short) { const last = out[out.length - 1]; if (last && last.a === a) last.n++; else out.push({ a, n: 1 }); }
  return out.map((x) => (x.n > 1 ? `${x.a} x${x.n}` : x.a)).join(', ');
}

const HELP = [
  'You can talk to me like this:',
  '  create 4 agents                        I pick the mix (a reviewer from 2 agents up, a fast helper from 4)',
  '  I want 2 coders, a tester and a reviewer     exactly that team (it replaces the current one; "undo" brings it back)',
  '  add 2 more coders / add a researcher   change the team without starting over',
  '  remove coder2  /  remove 2 coders  /  disband',
  '  use qwen3.5:4b for the coders  /  use qwen3.5:9b for the conductor',
  '  rename coder1 to alice',
  '  show the team  /  which models are installed',
  '  build me a snake game in snake.js      any other message is a task: I plan it and hand the steps to the agents',
  '  create 3 agents and have them build X  both at once',
  '  ask coder1 to add a header comment to x.js     (or  @coder1 ...)  talk to one agent directly',
  '  run 2 at a time  /  one at a time      how many agents work at once',
  '  ask me before everything  /  auto-approve  /  ask before commands     what the agents may do without asking',
  '  stop  /  undo',
  'Everything I do and everything the agents say appears in the Trace panel, word for word.',
].join('\n');

/*
  deps: getEnv()            -> Promise<{ ok, installed:[{name,size,caps}], primary, ramTotal, workspace }>
        startRun(job)       -> Promise<result>   job = { task, team, conductor, concurrency, mode, onState }   (src/orchestrator.js)
        ask(name, text, team, conductor) -> Promise<{ text, error, actions }>
        stop()              stops whatever is running
        onMessage(msg)      every message, both directions: { id, from: 'you'|'orchestrator', text, kind, ts }
        onChange(state)     the team or settings changed (so the app can save and show them)
  init: { team, conductor, history, concurrency, mode }
*/
function createChat(deps, init = {}) {
  let team = (init.team || []).map((a) => ({ ...a }));
  let conductor = init.conductor || '';
  let history = (init.history || []).slice(-100);
  let concurrency = init.concurrency || 1;
  let mode = init.mode || 'edits';
  let prev = null;            // for "undo"
  let pendingTask = '';       // a task given before there was a team: run it once the team exists
  let busy = false;
  let seq = history.reduce((m, h) => Math.max(m, h.id || 0), 0);

  const snapshot = () => ({ team: team.map((a) => ({ ...a })), conductor, concurrency, mode });
  const remember = () => { prev = snapshot(); };
  const state = () => ({ team: team.map((a) => ({ ...a })), conductor, history: history.slice(), busy, concurrency, mode, pendingTask });
  const changed = () => { try { deps.onChange && deps.onChange(state()); } catch { /* the app must not break the chat */ } };
  const post = (from, text, kind = 'text') => {
    const msg = { id: ++seq, from, text: String(text), kind, ts: Date.now() };
    history.push(msg);
    if (history.length > 100) history = history.slice(-100);
    try { deps.onMessage && deps.onMessage(msg); } catch { /* ditto */ }
    return msg;
  };
  const say = (text, kind) => post('orchestrator', text, kind);
  // Long work (a run, a question to one agent) goes on in the background so the chat stays free for "stop" and team changes.
  let active = 0, idleWaiters = [];
  function launch(fn) {
    active++;
    return (async () => {
      try { await fn(); } catch (err) { busy = false; say(`Something went wrong: ${err.message}`, 'final'); changed(); } finally {
        active--;
        if (!active) { const w = idleWaiters; idleWaiters = []; for (const f of w) f(); }
      }
    })();
  }
  const idle = () => (active ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

  async function env() {
    try { return await deps.getEnv(); } catch (e) { return { ok: false, installed: [], primary: '', ramTotal: 0, workspace: '', error: e.message }; }
  }
  const rosterOf = (e) => resolveRoster({ installed: e.installed || [], primary: e.primary, ramTotal: e.ramTotal || 0, overrides: {} });
  let lastNote = '';
  // the memory warning is only worth saying again when it changes
  const memoryNote = (e) => { const n = memoryNote0(e); if (n === lastNote) return ''; lastNote = n; return n; };
  const memoryNote0 = (e) => {
    const distinct = [...new Set([...team.map((a) => a.model), conductor || (rosterOf(e).roster.find((r) => r.role === 'conductor') || {}).model].filter(Boolean))];
    if (distinct.length < 2 || !e.ramTotal) return '';
    const sizes = distinct.map((n) => ((e.installed || []).find((m) => m.name === n) || {}).size || 0);
    const ml = cpuTune.maxLoadedModels({ sizes, ramTotal: e.ramTotal });
    if (ml.max >= distinct.length) return '';
    return `\nHeads up: this team uses ${distinct.length} different models (${ml.allGB} GB if all stay loaded) and this PC has room for about ${ml.max} at once. They will take turns, and each swap costs 10 to 30 seconds. Giving more agents the SAME model costs no extra memory. Run Ollama with OLLAMA_MAX_LOADED_MODELS=${ml.max}.`;
  };

  async function doCreate(intent, e) {
    const ids = intent.type === 'add' && !intent.spec.items.length && intent.spec.total ? Array.from({ length: intent.spec.total }, () => 'coder') : expandSpec(intent.spec);
    if (!ids.length) { say('How many agents do you want, and which kinds? For example: "create 4 agents" or "2 coders and a reviewer".'); return; }
    let capped = '';
    if (intent.type === 'create' ? ids.length > MAX_AGENTS : team.length + ids.length > MAX_AGENTS) {
      const room = intent.type === 'create' ? MAX_AGENTS : MAX_AGENTS - team.length;
      if (room <= 0) { say(`The team is already at the limit of ${MAX_AGENTS} agents. Remove some first.`); return; }
      capped = `\n(I capped it at ${MAX_AGENTS} agents in total.)`;
      ids.length = room;
    }
    if (!e.ok && !e.primary) { say('I cannot reach Ollama, and I do not know which model to use. Start Ollama (or pick a model in the Models tab) and ask again.'); return; }
    const r = rosterOf(e);
    if (intent.unknown) { say(`The model "${intent.unknown}" is not installed, so I did not create anything. Installed: ${(e.installed || []).map((m) => m.name).join(', ') || 'none'}.`); return; }
    remember();
    const before = team.length;
    const made = buildAgents(ids, { existing: intent.type === 'add' ? team : [], roster: r.roster, model: intent.model || '' });
    if (intent.type === 'create') team = made; else team = [...team, ...made];
    if (!e.ok) { /* Ollama down: the agents were still created with the primary model */ }
    const verb = intent.type === 'create' ? (before ? `I replaced your team of ${before} with ${made.length} new agent${made.length === 1 ? '' : 's'}` : `I created ${made.length} agent${made.length === 1 ? '' : 's'}`) : `I added ${made.length} agent${made.length === 1 ? '' : 's'} (the team now has ${team.length})`;
    const mix = intent.spec.items.length || !intent.spec.total ? '' : '\nYou did not say which kinds, so I picked a mix: coders do the work, a reviewer checks it independently, a fast helper reads and summarizes.';
    say(`${verb}:\n${table(team)}${mix}${e.ok ? '' : '\n(Ollama is not reachable right now; the agents use ' + e.primary + ' until it is.)'}${memoryNote(e)}${capped}\nSay "undo" if that is not what you meant. Tell me what to build, or change the team ("add a reviewer", "use qwen3.5:4b for the coders").`, 'team');
    changed();
    if (intent.task) await doTask(intent.task, e);
    else if (pendingTask) { const t = pendingTask; pendingTask = ''; await doTask(t, e); }
  }

  function resolveWho(who) {
    const w = String(who).toLowerCase();
    const exact = team.filter((a) => a.name.toLowerCase() === w);
    if (exact.length) return { agent: exact[0] };
    const k = kindOf(w);
    if (k) {
      const same = team.filter((a) => isKind(a, k));
      if (same.length === 1) return { agent: same[0] };
      if (same.length > 1) return { error: `There are ${same.length} ${k.label}s (${same.map((a) => a.name).join(', ')}). Which one?` };
    }
    return { error: `There is no agent called "${who}". Your agents: ${team.map((a) => a.name).join(', ') || 'none yet'}.` };
  }

  async function doTask(task, e) {
    if (busy) { say('I am still working on the last task. Say "stop" to end it, or wait for it to finish.'); return; }
    if (!team.length) {
      pendingTask = task;
      say('Before I start: how many agents do you want? For example "3", "2 coders and a reviewer", or "you decide". I will start the task as soon as the team exists.');
      changed();
      return;
    }
    if (!e.workspace) { say('Open a project folder first (File > Open Folder): the agents read and change files inside it.'); return; }
    if (!e.ok) { say('I cannot reach Ollama. Start it and send the task again.'); return; }
    busy = true;
    changed();
    say(`Starting with ${team.length} agent${team.length === 1 ? '' : 's'} (${team.map((a) => a.name).join(', ')}), ${concurrency === 1 ? 'one at a time' : concurrency + ' at a time'}, permissions: ${mode}. The conductor plans first; on a CPU that can take a minute or two.`, 'progress');
    const seen = new Map();
    const onState = (st) => {
      const r = (st && st.result) || {};
      if (st.phase === 'planning' && !seen.has('plan')) seen.set('plan', 1);
      if (r.plan && !seen.has('plan-posted')) { seen.set('plan-posted', 1); say(`Plan from the conductor:\n${r.plan.map((s) => `  ${s.id} ${s.agent}${s.depends_on && s.depends_on.length ? ' (after ' + s.depends_on.join(', ') + ')' : ''}: ${String(s.instruction).replace(/\s+/g, ' ').slice(0, 110)}`).join('\n')}`, 'progress'); }
      for (const s of r.steps || []) {
        const key = s.id + ':' + s.status + ':' + (s.verdict || '');
        if (seen.get(s.id) === key) continue;
        seen.set(s.id, key);
        if (s.status === 'running') say(`${s.agent} is working on ${s.id}.`, 'progress');
        else if (s.status === 'done') say(`${s.agent} finished ${s.id}${s.verdict && s.verdict !== 'none' ? ' with VERDICT ' + s.verdict.toUpperCase() : ''}${s.actions && s.actions.length ? ' (' + compactActions(s.actions) + ')' : ''}.`, 'progress');
        else if (s.status === 'failed' || s.status === 'skipped') say(`${s.agent} ${s.status} on ${s.id}: ${s.error || ''}`.trim(), 'progress');
      }
    };
    launch(async () => {
    let result;
    try { result = await deps.startRun({ task, team: team.map((a) => ({ ...a })), conductor, concurrency, mode, onState }); } catch (err) { result = { ok: false, status: 'error', error: err.message, final: '' }; }
    busy = false;
    if (result && result.status === 'stopped') say('Stopped.', 'final');
    else if (result && result.status === 'error') say(`The run failed: ${result.error}`, 'final');
    else say(`${result.ok ? 'Done.' : 'Finished with problems.'}\n${result.final || ''}`.trim(), 'final');
    changed();
    });
  }

  async function handle(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    post('you', text);
    const e = await env();
    const intent = parseIntent(text, { team, models: (e.installed || []).map((m) => m.name) });
    switch (intent.type) {
      case 'help': say(HELP); break;
      case 'greeting': say(intent.thanks ? 'You are welcome.' : team.length ? `Hello. You have ${team.length} agent${team.length === 1 ? '' : 's'}. Tell me what to build, or say "help".` : 'Hello. How many agents do you want? For example "create 3 agents", or just give me a task and I will ask.'); break;
      case 'models': {
        const inst = e.installed || [];
        say(e.ok && inst.length ? `Installed models (${inst.length}):\n${inst.map((m) => `  ${m.name.padEnd(28)} ${(m.size / 1e9).toFixed(1).padStart(5)} GB${team.some((a) => a.model === m.name) ? '   used by ' + team.filter((a) => a.model === m.name).map((a) => a.name).join(', ') : ''}`).join('\n')}\nSay "use <model> for the coders" to change who uses what.` : 'I cannot see any models: Ollama is not reachable or has none installed.');
        break;
      }
      case 'list': say(team.length ? `Your team (${team.length}):\n${table(team)}\nConductor: ${conductor || 'automatic'}. Running ${concurrency === 1 ? 'one at a time' : concurrency + ' at a time'}, permissions: ${mode}.${busy ? '\nA task is running now.' : ''}` : 'You have no agents yet. Say how many you want, for example "create 3 agents".', 'team'); break;
      case 'stop':
        if (busy) { deps.stop(); say('Stopping the agents now.'); } else say('Nothing is running.');
        break;
      case 'undo':
        if (!prev) { say('There is nothing to undo.'); break; }
        { const cur = snapshot(); ({ team, conductor, concurrency, mode } = prev); prev = cur; }
        say(`Undone. ${team.length ? 'The team is:\n' + table(team) : 'The team is empty.'} (Say "undo" again to redo.)`, 'team');
        changed();
        break;
      case 'clear':
        if (!team.length) { say('There are no agents to remove.'); break; }
        if (busy) { say('A task is running. Say "stop" first.'); break; }
        remember(); { const n = team.length; team = []; say(`Removed all ${n} agents. Say "undo" to bring them back.`, 'team'); }
        changed();
        break;
      case 'remove': {
        if (busy) { say('A task is running. Say "stop" first.'); break; }
        let victims = [];
        if (intent.names.length) victims = team.filter((a) => intent.names.includes(a.name));
        else if (intent.kinds.length) {
          for (const id of intent.kinds) {
            const k = KINDS.find((x) => x.id === id);
            const same = team.filter((a) => isKind(a, k));
            victims.push(...(intent.all || !intent.count ? same : same.slice(-intent.count)));
          }
        } else if (intent.count || intent.last) victims = team.slice(-(intent.count || 1));
        victims = [...new Set(victims)];
        if (!victims.length) { say(`I could not tell which agents to remove. Your agents: ${team.map((a) => a.name).join(', ') || 'none'}. Try "remove coder2".`); break; }
        remember();
        team = team.filter((a) => !victims.includes(a));
        say(`Removed ${victims.map((a) => a.name).join(', ')}. ${team.length ? 'Left:\n' + table(team) : 'The team is empty now.'}\nSay "undo" to bring them back.`, 'team');
        changed();
        break;
      }
      case 'rename': {
        const r = resolveWho(intent.from);
        if (r.error) { say(r.error); break; }
        if (team.some((a) => a.name.toLowerCase() === intent.to.toLowerCase())) { say(`There is already an agent called ${intent.to}.`); break; }
        remember(); r.agent.name = intent.to;
        say(`Renamed to ${intent.to}.`, 'team'); changed();
        break;
      }
      case 'setmodel': {
        if (intent.unknown) { say(`The model "${intent.unknown}" is not installed. Installed: ${(e.installed || []).map((m) => m.name).join(', ') || 'none'}.`); break; }
        const tg = intent.targets;
        let hit = [];
        if (tg.names.length) hit = team.filter((a) => tg.names.includes(a.name));
        else if (tg.kinds.length) hit = team.filter((a) => tg.kinds.some((id) => isKind(a, KINDS.find((k) => k.id === id))));
        else if (tg.all) hit = team.slice();
        if (tg.conductor && !tg.names.length && !tg.kinds.length) { remember(); conductor = intent.model; say(`The conductor now uses ${intent.model}.`, 'team'); changed(); break; }
        if (!hit.length) { say(`Which agents should use ${intent.model}? For example "use ${intent.model} for the coders" or "use ${intent.model} for everyone".`); break; }
        remember(); for (const a of hit) a.model = intent.model;
        if (tg.conductor) conductor = intent.model;
        say(`${hit.map((a) => a.name).join(', ')} now use${hit.length === 1 ? 's' : ''} ${intent.model}.${memoryNote(e)}`, 'team'); changed();
        break;
      }
      case 'concurrency': {
        remember();
        const n = Math.max(1, Math.min(4, intent.n || Math.min(team.length || 2, 3)));
        concurrency = n;
        say(n === 1 ? 'Agents will work one at a time (the right choice on a CPU: models take turns).' : `Up to ${n} agents will work at the same time. On a CPU this only helps if they use models that are all in memory together and Ollama is set up for parallel requests; otherwise it may not be faster.`);
        changed();
        break;
      }
      case 'permissions':
        remember(); mode = intent.mode;
        say(mode === 'ask' ? 'I will ask you before every edit and command.' : mode === 'auto' ? 'The agents will edit files and run commands without asking. They still only work inside your project folder, and everything is in the trace.' : 'The agents edit files on their own and ask you before running commands.');
        changed();
        break;
      case 'decide':
        if (pendingTask || !team.length) await doCreate({ type: 'create', spec: { total: 3, items: [] }, model: null, task: '', unknown: '' }, e);
        else say('Tell me what to build.');
        break;
      case 'direct': {
        const r = resolveWho(intent.who);
        if (r.error) { say(r.error); break; }
        if (busy) { say('The agents are busy with a task. Say "stop" first, or wait.'); break; }
        if (!e.workspace) { say('Open a project folder first: the agents work on its files.'); break; }
        busy = true; changed();
        say(`Asking ${r.agent.name} (${r.agent.model})...`, 'progress');
        launch(async () => {
          let rep;
          try { rep = await deps.ask(r.agent.name, intent.text, team.map((a) => ({ ...a })), conductor); } catch (err) { rep = { error: err.message }; }
          busy = false;
          say(rep.error ? `${r.agent.name} could not answer: ${rep.error}` : `${r.agent.name}: ${String(rep.text || '(no reply)').trim()}${rep.actions && rep.actions.length ? '\n(tools: ' + compactActions(rep.actions) + ')' : ''}`, 'final');
          changed();
        });
        break;
      }
      case 'create': case 'add': await doCreate(intent, e); break;
      case 'task': await doTask(intent.text, e); break;
      default: break;
    }
  }

  return {
    handle, state, idle,
    team: () => team.map((a) => ({ ...a })),
    setBusy: (b) => { busy = !!b; },
  };
}

module.exports = { compactActions, parseIntent, parseSpec, taskFromRest, defaultMix, expandSpec, buildAgents, createChat, KINDS, MAX_AGENTS, HELP };
