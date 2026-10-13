// feature: team (main process). Several agents collaborate on one task through a shared board.
// Members are ordinary agent sessions (src/features/agents.js, reached through src/bus.js), so each one shows up as a tab and
// can be shown in its own split pane. This file adds: the board tools, file claims, and the round loop
// (plan by the lead -> rounds where members work -> final summary), with stop / pause / resume / checkpoints.
// Channels: feat:team:state start stop pause resume restore reset addTask addNote message releaseClaim closeMembers.
// Event: feat:team:state (the whole public state, throttled).
const bus = require('../bus');
const T = require('../team-lib');
const comms = require('../comms');

const BOARD_TOOLS = ['board_read', 'board_add_task', 'board_update_task', 'board_note', 'board_message', 'claim_files', 'release_files', 'finish_work'];
const READ = ['read_file', 'list_dir', 'search_files', 'git_status', 'git_diff'];
const ROLE_TOOLS = {
  lead: [...READ, ...BOARD_TOOLS],
  researcher: [...READ, ...BOARD_TOOLS],
  reviewer: [...READ, ...BOARD_TOOLS],
  coder: [...READ, 'write_file', 'edit_file', 'run_command', ...BOARD_TOOLS],
};
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/;
const ACTIVE = new Set(['planning', 'running', 'stopping']);

module.exports = function (ctx) {
  const { fs, path } = ctx;
  const { fn, str } = ctx.tools.helpers;
  const DIR = path.join(ctx.dataDir, 'teams');
  const FILE = path.join(DIR, 'current.json');
  let team = null;
  let pushT = null, saveT = null;

  const line = () => comms.shared();
  const ws = () => ctx.workspace();
  const rel = (p) => { const w = ws(); return w && String(p).toLowerCase().startsWith(w.toLowerCase()) ? path.relative(w, p) || '.' : p; };
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const memberBySid = (sid) => (team ? team.members.find((m) => m.sid === sid) : null);
  const memberByName = (name) => (team ? team.members.find((m) => m.name.toLowerCase() === String(name).trim().toLowerCase()) : null);
  const live = () => !!team && ACTIVE.has(team.status);

  /* ---------- state shown in the UI ---------- */
  function publicState() {
    if (!team) return { team: null };
    const b = team.board;
    return {
      team: {
        id: team.id, task: team.task, status: team.status, round: team.round, maxRounds: team.maxRounds, mode: team.mode,
        roundTimeoutSec: team.roundTimeoutSec, pauseAfter: team.pauseAfter, summary: team.summary, error: team.error, started: team.started, ended: team.ended,
        members: team.members.map((m) => ({ name: m.name, role: m.role, sid: m.sid, model: m.model, status: m.status, finished: m.finished, last: m.last, exists: bus.agents ? bus.agents.has(m.sid) : false })),
        board: {
          tasks: b.tasks, notes: b.notes.slice(-80), messages: b.messages.slice(-80).map((x) => ({ id: x.id, from: x.from, to: x.to, text: x.text, ts: x.ts })),
          claims: b.claimsList().map((c) => ({ path: rel(c.path), full: c.path, owner: c.owner })),
        },
        checkpoints: team.checkpoints.map((c, i) => ({ i, round: c.round, label: c.label, at: c.at, done: c.done, total: c.total })),
      },
    };
  }
  function push() {
    if (pushT) return;
    pushT = setTimeout(() => { pushT = null; ctx.send('feat:team:state', publicState()); }, 80);
    save();
  }
  function save() {
    if (saveT || !team) return;
    saveT = setTimeout(() => {
      saveT = null;
      if (!team) return;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const data = { ...team, board: team.board.toJSON() };
        fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
        fs.renameSync(FILE + '.tmp', FILE);
      } catch (e) { console.error('team: could not save', e.message); }
    }, 400);
  }
  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      d.board = new T.Board(d.board);
      d.members = (d.members || []).map((m) => ({ ...m, status: 'idle' }));
      // a run that was going when Faber closed did not finish: show it as stopped so it can be resumed
      if (ACTIVE.has(d.status) || d.status === 'paused') d.status = 'stopped';
      team = d;
    } catch { /* no saved team */ }
  }

  /* ---------- the board tools (offered only to team members) ---------- */
  const forMember = (sid) => !!memberBySid(sid);
  const who = (tctx) => { const m = memberBySid(tctx.agent && tctx.agent.id); if (!m) throw new Error('You are not part of a team.'); return m; };
  const paths = (v) => String(v || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const abs = (p) => path.resolve(ws() || '.', p);
  // every board action is a message on the line: who did what to the shared board, with the arguments
  const reg = (schema, impl) => ctx.tools.registerTool(schema, async (a, tctx) => {
    const m = who(tctx);
    const name = schema.function.name;
    const r = await impl(a || {}, m);
    line().log({ from: m.name, to: name === 'board_message' ? String((a || {}).to || 'all') : 'board', kind: 'board', model: m.model, text: `${name} ${JSON.stringify(a || {})}\n=> ${typeof r === 'string' ? r.split('\n')[0] : ''}`.trim() });
    push();
    return r;
  }, { when: forMember });

  reg(fn('board_read', 'Show the team board: tasks, file claims, recent notes, and messages addressed to you.', {}, []), (a, m) => {
    const inbox = team.board.inbox(m.name);
    return team.board.summary(rel, 30) + (inbox.length ? '\nMESSAGES FOR YOU:\n' + inbox.map((x) => `  from ${x.from}${x.to === 'all' ? ' (to all)' : ''}: ${x.text}`).join('\n') : '');
  });
  reg(fn('board_add_task', 'Add a task to the shared board.', { title: str('Short title'), owner: str('Member name who should do it (optional)'), detail: str('More detail (optional)') }, ['title']), (a, m) => {
    if (a.owner && !memberByName(a.owner)) throw new Error(`No member called "${a.owner}". Members: ${team.members.map((x) => x.name).join(', ')}.`);
    const t = team.board.addTask({ title: a.title, owner: a.owner ? memberByName(a.owner).name : '', detail: a.detail, by: m.name });
    return `Added ${t.id}: ${t.title}${t.owner ? ' (owner ' + t.owner + ')' : ''}`;
  });
  reg(fn('board_update_task', 'Change a task: status (todo, doing, done, blocked), owner, or a short result.', { id: str('Task id such as t1'), status: str('todo | doing | done | blocked'), owner: str('New owner (optional)'), result: str('What came out of it (optional)') }, ['id']), (a) => {
    if (a.owner && !memberByName(a.owner)) throw new Error(`No member called "${a.owner}".`);
    const t = team.board.updateTask(a.id, { status: a.status || undefined, owner: a.owner ? memberByName(a.owner).name : undefined, result: a.result || undefined });
    return `${t.id} is now [${t.status}]${t.owner ? ', owner ' + t.owner : ''}`;
  });
  reg(fn('board_note', 'Tell the whole team something they should know (decisions, interfaces, findings).', { text: str('The note') }, ['text']), (a, m) => { team.board.addNote(m.name, a.text); return 'Note added.'; });
  reg(fn('board_message', 'Send a message to one member (by name) or to "all". It is delivered at the start of their next turn.', { to: str('Member name or "all"'), text: str('The message') }, ['to', 'text']), (a, m) => {
    const to = String(a.to || '').trim().toLowerCase() === 'all' ? 'all' : (memberByName(a.to) || {}).name;
    if (!to) throw new Error(`No member called "${a.to}". Members: ${team.members.map((x) => x.name).join(', ')} or "all".`);
    team.board.addMessage(m.name, to, a.text);
    return `Message sent to ${to}.`;
  });
  reg(fn('claim_files', 'Claim files or folders so nobody else edits them. A claim on a folder covers everything below it.', { paths: str('Paths separated by commas or new lines') }, ['paths']), (a, m) => {
    const r = team.board.claim(m.name, paths(a.paths).map(abs));
    return [r.ok.length ? 'Claimed: ' + r.ok.map(rel).join(', ') : '', r.denied.length ? 'Not claimed (held by someone else): ' + r.denied.map((d) => `${rel(d.path)} (${d.by})`).join(', ') : ''].filter(Boolean).join('\n') || 'Nothing to claim.';
  });
  reg(fn('release_files', 'Release file claims you no longer need (default: all of yours).', { paths: str('Paths separated by commas (optional)') }, []), (a, m) => {
    const list = paths(a.paths);
    const out = team.board.release(m.name, list.length ? list.map(abs) : 'all');
    return out.length ? 'Released: ' + out.map(rel).join(', ') : 'You had no matching claims.';
  });
  reg(fn('finish_work', 'Call this when you have nothing more to do for now. Give a one-line result.', { result: str('One line: what you did') }, []), (a, m) => {
    m.finished = true; m.last = clean(a.result, 300) || m.last;
    return 'Noted. Stop here and end your reply.';
  });

  // Nobody may change a file another member holds. Unclaimed files are claimed by whoever writes them first.
  ctx.tools.setWriteGuard((file, tctx) => {
    if (!live()) return;
    const m = memberBySid(tctx && tctx.agent && tctx.agent.id);
    if (!m) return;
    const owner = team.board.ownerOf(file);
    if (owner && owner !== m.name) throw new Error(`${rel(file)} is claimed by ${owner}. Ask ${owner} with board_message, or work on a different file.`);
    if (!owner) { team.board.claim(m.name, [file]); push(); }
  });

  // the members' own activity (reasoning, tool calls, tokens) goes on the line too
  const loggers = new Map();      // sid -> logger
  bus.on('agent-event', ({ session, ev }) => {
    const m = memberBySid(session);
    if (!m || !live()) return;
    let lg = loggers.get(session);
    if (!lg || lg.model !== m.model) { lg = { model: m.model, fn: comms.agentEventLogger(line(), m) }; loggers.set(session, lg); }
    lg.fn(ev);
  });

  /* ---------- running ---------- */
  const snapshot = (label) => {
    const b = team.board;
    team.checkpoints.push({ round: team.round, label, at: Date.now(), done: b.tasks.filter((t) => t.status === 'done').length, total: b.tasks.length, board: JSON.parse(JSON.stringify(b.toJSON())), finished: team.members.map((m) => [m.name, m.finished]) });
    if (team.checkpoints.length > 20) team.checkpoints.shift();
  };
  const hasUnread = (name) => team.board.messages.some((m) => !m.readBy.includes(name) && (m.to === 'all' || m.to === name));

  async function turn(m, prompt) {
    if (!bus.agents.has(m.sid)) { m.status = 'missing'; team.board.addNote('system', `${m.name}'s agent was closed, so it cannot take part.`); return; }
    m.status = 'working'; m.finished = false; push();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; bus.agents.stop(m.sid); }, team.roundTimeoutSec * 1000);
    let r;
    try { r = await line().request('team', { name: m.name, model: m.model, run: (t) => bus.agents.run(m.sid, t) }, prompt, { round: team.round }); } catch (e) { r = { error: e.message }; } finally { clearTimeout(timer); }
    if (r.error) { m.status = 'error'; team.board.addNote('system', `${m.name} stopped with an error: ${r.error}`); }
    else if (r.stopped) { m.status = timedOut ? 'timeout' : 'stopped'; if (timedOut) team.board.addNote('system', `${m.name} ran out of time (${team.roundTimeoutSec}s) in round ${team.round}.`); }
    else m.status = 'idle';
    if (r.text && !m.finished) m.last = clean(r.text, 300);
    push();
  }

  const shouldRun = (m) => !m.finished || team.board.open(m.name).length > 0 || hasUnread(m.name);
  const allDone = () => team.members.every((m) => m.finished || m.status === 'missing') && team.board.open().length === 0;

  async function drive() {
    const t = team;
    t.stopRequested = false;
    t.error = '';
    let finished = false;
    try {
      const lead = t.members.find((m) => m.role === 'lead');
      if (t.round === 0) {
        if (lead) {
          t.status = 'planning'; push();
          await turn(lead, T.planPrompt(t.task, t.members));
          snapshot('plan');
        }
        t.round = 1;
      }
      while (t.round <= t.maxRounds && !t.stopRequested) {
        t.status = 'running'; push();
        const waves = [t.members.filter((m) => m.role !== 'reviewer'), t.members.filter((m) => m.role === 'reviewer')];
        for (const wave of waves) {
          const go = wave.filter(shouldRun);
          await Promise.all(go.map((m) => turn(m, T.roundPrompt(t.round, t.maxRounds, t.board, m, t.board.inbox(m.name), rel))));
          if (t.stopRequested) break;
        }
        if (t.stopRequested) break;
        snapshot(`round ${t.round}`);
        if (allDone()) { finished = true; break; }
        t.round++;
        if (t.pauseAfter && t.round <= t.maxRounds) { t.pauseAfter = false; t.status = 'paused'; push(); return; }
      }
      if (t.stopRequested) { t.status = 'stopped'; t.summary = T.fallbackSummary(t.task, t.board, rel); snapshot('stopped'); }
      else {
        t.status = 'running'; push();
        const head = lead || t.members[0];
        let text = '';
        if (head && bus.agents.has(head.sid)) {
          head.status = 'working'; push();
          const r = await line().request('team', { name: head.name, model: head.model, run: (x) => bus.agents.run(head.sid, x) }, T.summaryPrompt(t.task, t.board, rel), { replyKind: 'final' }).catch((e) => ({ error: e.message }));
          text = r.error ? '' : String(r.text || '').trim();
          head.status = 'idle';
        }
        t.summary = text || T.fallbackSummary(t.task, t.board, rel);
        t.status = finished ? 'done' : 'limit';
        snapshot('summary');
      }
    } catch (e) {
      t.status = 'error'; t.error = e.message;
    } finally {
      if (t.status === 'done' || t.status === 'limit' || t.status === 'stopped' || t.status === 'error') {
        for (const m of t.members) if (m.status === 'working') m.status = 'idle';
        // claims stay visible after a stop so the user can see who held what; they are cleared when the team is done
        if (t.status === 'done') for (const m of t.members) t.board.release(m.name, 'all');
        t.ended = Date.now();
      }
      push();
    }
  }

  /* ---------- starting ---------- */
  function validateMembers(list) {
    if (!Array.isArray(list) || list.length < 2 || list.length > 6) throw new Error('A team needs 2 to 6 members.');
    const seen = new Set();
    let leads = 0;
    const out = list.map((m) => {
      const name = clean(m && m.name, 30);
      const role = String((m && m.role) || 'coder').toLowerCase();
      if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid member name. Use letters, digits, space, _ or - (up to 30).`);
      if (!T.ROLES.includes(role)) throw new Error(`Role must be one of ${T.ROLES.join(', ')}.`);
      if (seen.has(name.toLowerCase())) throw new Error(`Two members are called "${name}". Names must differ.`);
      seen.add(name.toLowerCase());
      if (role === 'lead') leads++;
      return { name, role, model: clean(m && m.model, 200) };
    });
    if (leads > 1) throw new Error('Only one member can be the lead.');
    if (!out.some((m) => m.role === 'coder')) throw new Error('A team needs at least one coder.');
    return out;
  }
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : d; };

  function start(p) {
    p = p || {};
    if (live()) throw new Error('A team is already running. Stop it first.');
    if (!bus.agents) throw new Error('The agents feature is not available.');
    if (!ws()) throw new Error('Open a project folder first: the team works on its files.');
    const task = clean(p.task, 4000);
    if (!task) throw new Error('Describe the task for the team.');
    const members = validateMembers(p.members);
    const g = ctx.getSettings();
    const mode = ['ask', 'edits', 'auto'].includes(p.mode) ? p.mode : g.mode;
    const id = 'team' + Date.now().toString(36);
    const t = {
      id, task, status: 'idle', round: 0, maxRounds: num(p.maxRounds, 4, 1, 12), mode, roundTimeoutSec: num(p.roundTimeoutSec, 600, 30, 7200),
      pauseAfter: false, summary: '', error: '', started: Date.now(), ended: 0, checkpoints: [], board: new T.Board(), members: [],
    };
    try {
      for (const m of members) {
        const info = bus.agents.create({
          name: m.name, model: m.model || g.model, effort: p.effort || g.effort, mode,
          allowedTools: ROLE_TOOLS[m.role], teamSystem: T.memberSystem(m, members, task), team: id,
        });
        t.members.push({ ...m, sid: info.id, model: info.model, status: 'idle', finished: false, last: '' });
      }
    } catch (e) { for (const m of t.members) bus.agents.close(m.sid); throw e; }
    team = t;
    line().startRun('team: ' + task.slice(0, 70));
    line().log({ from: 'team', to: 'all', kind: 'system', text: `team started: ${t.members.map((m) => `${m.name} (${m.role}, ${m.model})`).join('; ')}` });
    push();
    drive();
    return publicState();
  }

  /* ---------- controls ---------- */
  const H = ctx.handle;
  H('feat:team:state', () => publicState());
  H('feat:team:start', (p) => start(p));
  H('feat:team:stop', () => {
    if (!live()) return publicState();
    team.stopRequested = true; team.status = 'stopping';
    for (const m of team.members) bus.agents.stop(m.sid);
    push();
    return publicState();
  });
  H('feat:team:pause', (on) => {
    if (!team) throw new Error('No team.');
    team.pauseAfter = on !== false;
    push();
    return publicState();
  });
  H('feat:team:resume', (extra) => {
    if (!team) throw new Error('No team.');
    if (live()) throw new Error('The team is already running.');
    if (team.status === 'done') throw new Error('The team already finished. Start a new one.');
    if (team.status === 'limit' || team.round > team.maxRounds) team.maxRounds = Math.max(team.round, team.maxRounds) + num(extra, 2, 1, 12);
    team.summary = team.status === 'limit' ? '' : team.summary;
    team.pauseAfter = false;
    push();
    drive();
    return publicState();
  });
  H('feat:team:restore', (i) => {
    if (!team || live()) throw new Error('Stop the team first.');
    const cp = team.checkpoints[Number(i)];
    if (!cp) throw new Error('No such checkpoint.');
    team.board = new T.Board(JSON.parse(JSON.stringify(cp.board)));
    team.round = cp.label === 'plan' ? 0 : /^round/.test(cp.label) ? cp.round + 1 : cp.round;
    for (const [name, f] of cp.finished || []) { const m = memberByName(name); if (m) m.finished = f; }
    team.checkpoints = team.checkpoints.slice(0, Number(i) + 1);
    team.status = 'stopped'; team.summary = ''; team.error = '';
    push();
    return publicState();
  });
  H('feat:team:reset', () => {
    if (live()) throw new Error('Stop the team first.');
    team = null;
    try { fs.rmSync(FILE, { force: true }); } catch { /* none */ }
    ctx.send('feat:team:state', publicState());
    return publicState();
  });
  H('feat:team:closeMembers', () => {
    if (!team || live()) throw new Error('Stop the team first.');
    for (const m of team.members) bus.agents.close(m.sid);
    push();
    return publicState();
  });
  // the user can steer a running team from the board
  H('feat:team:addTask', (p) => {
    if (!team) throw new Error('No team.');
    const o = p && p.owner ? memberByName(p.owner) : null;
    if (p && p.owner && !o) throw new Error(`No member called "${p.owner}".`);
    team.board.addTask({ title: p && p.title, owner: o ? o.name : '', by: 'You' });
    push();
    return publicState();
  });
  H('feat:team:addNote', (text) => { if (!team) throw new Error('No team.'); team.board.addNote('You', text); push(); return publicState(); });
  H('feat:team:message', (p) => {
    if (!team) throw new Error('No team.');
    const to = !p || String(p.to || 'all').toLowerCase() === 'all' ? 'all' : (memberByName(p.to) || {}).name;
    if (!to) throw new Error(`No member called "${p.to}".`);
    team.board.addMessage('You', to, p && p.text);
    push();
    return publicState();
  });
  H('feat:team:releaseClaim', (full) => {
    if (!team) throw new Error('No team.');
    for (const c of team.board.claimsList()) if (c.path === full) team.board.release(c.owner, [full]);
    push();
    return publicState();
  });

  load();
  ctx.app.on('before-quit', () => { if (saveT) { clearTimeout(saveT); saveT = null; } if (team) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ ...team, board: team.board.toJSON() })); } catch { /* ignore */ } } });
};
