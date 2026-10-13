// Team mode, pure logic (no Electron, no network): the shared board and the prompts. Exports an object, not a function,
// so the feature loader never treats this file as a feature.
const path = require('path');

const WIN = process.platform === 'win32';
const key = (p) => { const n = path.resolve(String(p)); return WIN ? n.toLowerCase() : n; };
const within = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '...' : s; };

const STATUS = ['todo', 'doing', 'done', 'blocked'];

class Board {
  constructor(data) {
    this.tasks = []; this.notes = []; this.messages = []; this.claims = {};   // claims: key(path) -> { owner, path }
    this.seq = 0;
    if (data) this.load(data);
  }
  load(d) {
    this.tasks = Array.isArray(d.tasks) ? d.tasks : [];
    this.notes = Array.isArray(d.notes) ? d.notes : [];
    this.messages = Array.isArray(d.messages) ? d.messages : [];
    this.claims = d.claims && typeof d.claims === 'object' ? d.claims : {};
    this.seq = Number(d.seq) || 0;
  }
  toJSON() { return { tasks: this.tasks, notes: this.notes, messages: this.messages, claims: this.claims, seq: this.seq }; }
  id(prefix) { return prefix + (++this.seq); }

  /* ---- tasks ---- */
  addTask({ title, owner = '', by = '', detail = '' }) {
    title = clip(String(title || '').trim(), 200);
    if (!title) throw new Error('A task needs a title.');
    const t = { id: this.id('t'), title, detail: clip(detail, 1000), owner: String(owner || ''), status: 'todo', by, result: '', ts: Date.now() };
    this.tasks.push(t);
    return t;
  }
  task(id) {
    const t = this.tasks.find((x) => x.id === String(id));
    if (!t) throw new Error(`No task "${id}". Use board_read to see the task ids.`);
    return t;
  }
  updateTask(id, patch) {
    const t = this.task(id);
    if (patch.status !== undefined) {
      if (!STATUS.includes(patch.status)) throw new Error(`Status must be one of ${STATUS.join(', ')}.`);
      t.status = patch.status;
    }
    if (patch.owner !== undefined) t.owner = String(patch.owner);
    if (patch.result !== undefined) t.result = clip(patch.result, 1000);
    t.ts = Date.now();
    return t;
  }
  open(owner) { return this.tasks.filter((t) => (t.status === 'todo' || t.status === 'doing' || t.status === 'blocked') && (owner === undefined || t.owner === owner)); }

  /* ---- notes + messages ---- */
  addNote(by, text) {
    text = clip(String(text || '').trim(), 2000);
    if (!text) throw new Error('The note is empty.');
    const n = { id: this.id('n'), by, text, ts: Date.now() };
    this.notes.push(n);
    if (this.notes.length > 300) this.notes.splice(0, this.notes.length - 300);
    return n;
  }
  addMessage(from, to, text) {
    text = clip(String(text || '').trim(), 2000);
    if (!text) throw new Error('The message is empty.');
    const m = { id: this.id('m'), from, to: to || 'all', text, ts: Date.now(), readBy: [from] };
    this.messages.push(m);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    return m;
  }
  inbox(name, mark = true) {
    const mine = this.messages.filter((m) => !m.readBy.includes(name) && (m.to === 'all' || m.to === name));
    if (mark) for (const m of mine) m.readBy.push(name);
    return mine;
  }

  /* ---- file claims: a claim on a folder covers everything below it ---- */
  ownerOf(file) {
    const f = key(file);
    let best = null;
    for (const [k, c] of Object.entries(this.claims)) if (within(f, k) && (!best || k.length > best.k.length)) best = { k, c };
    return best ? best.c.owner : null;
  }
  claim(owner, paths) {
    const ok = [], denied = [];
    for (const p of paths) {
      const abs = path.resolve(String(p));
      const cur = this.ownerOf(abs);
      if (cur && cur !== owner) { denied.push({ path: abs, by: cur }); continue; }
      // a folder claim must not swallow files another member already holds below it
      const k = key(abs);
      const inner = Object.entries(this.claims).find(([kk, c]) => kk !== k && within(kk, k) && c.owner !== owner);
      if (inner) { denied.push({ path: abs, by: inner[1].owner }); continue; }
      this.claims[k] = { owner, path: abs };
      ok.push(abs);
    }
    return { ok, denied };
  }
  release(owner, paths) {
    const out = [];
    for (const [k, c] of Object.entries(this.claims)) {
      if (c.owner !== owner) continue;
      if (paths === 'all' || paths.some((p) => key(p) === k)) { delete this.claims[k]; out.push(c.path); }
    }
    return out;
  }
  claimsList() { return Object.values(this.claims).map((c) => ({ path: c.path, owner: c.owner })); }

  /* ---- text for prompts and for board_read ---- */
  summary(rel = (p) => p, notesLimit = 12) {
    const L = [];
    L.push('TASKS:');
    if (!this.tasks.length) L.push('  (none yet)');
    for (const t of this.tasks) L.push(`  ${t.id} [${t.status}] ${t.title}${t.owner ? '  (owner: ' + t.owner + ')' : ''}${t.result ? '  -> ' + clip(t.result, 160) : ''}`);
    L.push('FILE CLAIMS:');
    const cl = this.claimsList();
    if (!cl.length) L.push('  (none)');
    for (const c of cl) L.push(`  ${rel(c.path)}  ->  ${c.owner}`);
    L.push('RECENT NOTES:');
    const ns = this.notes.slice(-notesLimit);
    if (!ns.length) L.push('  (none)');
    for (const n of ns) L.push(`  [${n.by}] ${clip(n.text, 300)}`);
    return L.join('\n');
  }
}

/* ---------- prompts ---------- */
const ROLE_TEXT = {
  lead: 'You are the lead. You plan the work, split it into tasks on the board with an owner each, answer questions from the others, check their results and write the final summary. You do not edit files yourself unless nothing else works.',
  coder: 'You are a coder. You do the implementation tasks assigned to you: read the relevant code, make the change, and report what you changed.',
  reviewer: 'You are a reviewer. After the coders have finished a piece of work, read the changed files and report concrete problems (bugs, missing cases) as board notes or messages to the author. You cannot change files.',
  researcher: 'You are a researcher. You investigate the project with the read-only tools and put findings on the board for the others. You cannot change files.',
};
const ROLES = Object.keys(ROLE_TEXT);

const BOARD_RULES = [
  'Shared board tools: board_read (see tasks, notes, claims), board_add_task, board_update_task, board_note (tell everyone something), board_message (to one member or "all"), claim_files / release_files, finish_work.',
  'write_file and edit_file claim a file for you automatically, and you cannot change a file another member holds. If you need such a file, message its owner.',
  'Keep the board current: mark your tasks doing/done with a short result. Put what the others need to know into notes. Do your own part and do not redo work that is on the board.',
  'When you have nothing more to do for now, call finish_work with a one-line result. Keep your replies short.',
].join('\n');

function memberSystem(member, members, task) {
  const names = members.map((m) => `${m.name} (${m.role})`).join(', ');
  return [
    `TEAM MODE. You are "${member.name}", the ${member.role}, in a team of AI agents working together in the user's project folder.`,
    `Team: ${names}.`,
    `Overall task: ${task}`,
    ROLE_TEXT[member.role] || ROLE_TEXT.coder,
    BOARD_RULES,
  ].join('\n');
}

function planPrompt(task, members) {
  const w = members.filter((m) => m.role !== 'lead').map((m) => `${m.name} (${m.role})`).join(', ') || '(no one else)';
  return `The team's task:\n${task}\n\nPlan it now. Look at the project if you need to, then create the tasks on the board with board_add_task, giving each an owner from: ${w}. Make tasks small and independent where you can, and note anything shared (for example agreed file names or interfaces) with board_note. Do not implement anything. When the plan is on the board, call finish_work.`;
}

function roundPrompt(round, max, board, member, inbox, rel) {
  const L = [`Round ${round} of at most ${max}. You are ${member.name} (${member.role}).`, '', board.summary(rel)];
  if (inbox.length) { L.push('', 'MESSAGES FOR YOU:'); for (const m of inbox) L.push(`  from ${m.from}${m.to === 'all' ? ' (to all)' : ''}: ${m.text}`); }
  const mine = board.open(member.name);
  L.push('', mine.length ? `Your open tasks: ${mine.map((t) => t.id).join(', ')}. Work on them now.` : 'You have no open tasks. Check the board and the messages, help where it is useful, otherwise call finish_work.');
  L.push('When you are done for now, call finish_work.');
  return L.join('\n');
}

function summaryPrompt(task, board, rel) {
  return `The team has stopped. Write the final summary for the user (under 250 words): what was done, which files were changed, what is still open or needs checking.\n\nOriginal task: ${task}\n\n${board.summary(rel, 30)}`;
}

// A short plain-text summary built from the board, used when the lead cannot write one.
function fallbackSummary(task, board, rel) {
  const done = board.tasks.filter((t) => t.status === 'done').length;
  return `Task: ${task}\n${done} of ${board.tasks.length} tasks done.\n\n${board.summary(rel, 30)}`;
}

module.exports = { Board, ROLES, ROLE_TEXT, memberSystem, planPrompt, roundPrompt, summaryPrompt, fallbackSummary, STATUS };
