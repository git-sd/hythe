/* feature: team (renderer). The Team tab: describe a task, pick the members, watch the shared board while the agents work.
   Main process side: src/features/team.js. Members are normal agents (tabs, and split panes via "Show as panes"). */
Faber.register('team', (F) => {
  const { el } = F;
  const NS = 'feat:team:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a);
  const fail = (e) => F.error('Team: ' + clean(e));
  const run = (p) => Promise.resolve(p).catch(fail);
  const ROLE_HELP = {
    lead: 'plans the work, answers questions, writes the final summary (read-only)',
    coder: 'edits files and runs commands',
    reviewer: 'reads the result and reports problems (read-only)',
    researcher: 'investigates and reports findings (read-only)',
  };
  const STATUS_TEXT = { idle: 'idle', planning: 'planning', running: 'running', stopping: 'stopping', stopped: 'stopped', paused: 'paused after the round', done: 'done', limit: 'round limit reached', error: 'error' };
  let S = null;                 // the team (or null)
  let pane = null, setupBox = null, runBox = null;
  const draft = { task: '', members: [{ name: 'Lead', role: 'lead', model: '' }, { name: 'Coder', role: 'coder', model: '' }, { name: 'Reviewer', role: 'reviewer', model: '' }], maxRounds: 4, mode: '', timeout: 600 };

  /* ---------- small helpers ---------- */
  const btn = (label, onClick, cls, title) => { const b = el('button', cls || '', label); if (title) b.title = title; b.onclick = onClick; return b; };
  const live = () => !!S && ['planning', 'running', 'stopping'].includes(S.status);

  /* ---------- setup form ---------- */
  function paintSetup() {
    setupBox.innerHTML = '';
    setupBox.appendChild(el('div', 'tmHint', 'Several agents work on one task at the same time and coordinate through a shared board. Each member is a normal agent: it gets its own tab and can be shown in a split pane.'));
    const task = el('textarea', 'tmTask');
    task.rows = 4; task.placeholder = 'What should the team do? Be specific, for example: "Add a /health endpoint to the server and write tests for it."';
    task.value = draft.task;
    task.oninput = () => { draft.task = task.value; };
    setupBox.append(el('b', '', 'Task'), task, el('b', '', 'Members'));
    const list = el('div', 'tmMembers');
    draft.members.forEach((m, i) => {
      const row = el('div', 'tmMember');
      const name = el('input'); name.value = m.name; name.placeholder = 'Name'; name.oninput = () => { m.name = name.value; };
      const role = el('select');
      for (const r of Object.keys(ROLE_HELP)) role.appendChild(Object.assign(el('option', '', r), { value: r }));
      role.value = m.role; role.title = ROLE_HELP[m.role];
      role.onchange = () => { m.role = role.value; role.title = ROLE_HELP[m.role]; };
      const model = el('input'); model.value = m.model; model.placeholder = 'model (default)'; model.title = 'Leave empty to use the current model. Ollama name, or claude:... if Claude (online) is on.';
      model.oninput = () => { m.model = model.value; };
      const rm = btn('x', () => { draft.members.splice(i, 1); paintSetup(); }, 'ghost', 'Remove member');
      row.append(name, role, model, rm);
      list.appendChild(row);
    });
    setupBox.appendChild(list);
    setupBox.appendChild(btn('Add member', () => { if (draft.members.length < 6) { draft.members.push({ name: 'Coder' + (draft.members.length), role: 'coder', model: '' }); paintSetup(); } }, ''));
    const opt = el('div', 'tmOpts');
    const num = (label, key, min, max, hint) => { const l = el('label', 'tmOpt'); l.append(el('span', '', label)); const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.value = draft[key]; i.title = hint || ''; i.oninput = () => { draft[key] = Number(i.value); }; l.appendChild(i); opt.appendChild(l); };
    num('Max rounds', 'maxRounds', 1, 12, 'Each round every member takes one turn. The team stops at this limit.');
    num('Turn timeout (s)', 'timeout', 30, 7200, 'A member that takes longer than this in one turn is stopped.');
    const ml = el('label', 'tmOpt'); ml.appendChild(el('span', '', 'Permissions'));
    const ms = el('select');
    for (const [v, t] of [['', 'Same as chat'], ['ask', 'Ask first'], ['edits', 'Auto-edit files'], ['auto', 'Auto-approve all']]) ms.appendChild(Object.assign(el('option', '', t), { value: v }));
    ms.value = draft.mode; ms.onchange = () => { draft.mode = ms.value; };
    ml.appendChild(ms); opt.appendChild(ml);
    setupBox.appendChild(opt);
    setupBox.appendChild(el('div', 'tmHint', 'Approvals appear inside each member\'s own chat. How many members talk to the model at once is set under Settings > Agents ("Agents running at once"); the others wait their turn. Members cannot change a file another member has claimed. Commands run by a coder are not checked against claims.'));
    const go = btn('Start team', async () => {
      if (!F.folder()) return F.error('Open a project folder first: the team works on its files.');
      go.disabled = true;
      try {
        const members = draft.members.map((m) => ({ name: m.name.trim(), role: m.role, model: m.model.trim() }));
        await call('start', { task: draft.task, members, maxRounds: draft.maxRounds, roundTimeoutSec: draft.timeout, mode: draft.mode || undefined });
        await F.panes.show((await call('state')).team.members.map((m) => m.sid));
      } catch (e) { fail(e); }
      go.disabled = false;
    }, 'primary');
    setupBox.appendChild(go);
  }

  /* ---------- run view ---------- */
  const secs = {};
  function section(id, title, open) {
    const d = el('details', 'tmSec');
    d.open = !!open;
    const sm = el('summary', '', title);
    const body = el('div', 'tmBody');
    d.append(sm, body);
    runBox.appendChild(d);
    secs[id] = { d, sm, body, key: null };
    return secs[id];
  }
  // rebuild a section only when its data changed, so open forms and scroll positions survive the live updates
  function setSec(id, title, data, build) {
    const s = secs[id];
    const key = JSON.stringify(data);
    s.sm.textContent = title;
    if (s.key === key) return;
    s.key = key;
    s.body.innerHTML = '';
    build(s.body);
  }
  const ago = (t) => { const d = Math.round((Date.now() - t) / 1000); return d < 60 ? d + 's ago' : d < 3600 ? Math.round(d / 60) + ' min ago' : Math.round(d / 3600) + ' h ago'; };

  function buildRun() {
    runBox.innerHTML = '';
    const head = el('div', 'tmHead'); head.id = 'tmHead'; runBox.appendChild(head);
    const mem = el('div', 'tmMembersLive'); runBox.appendChild(mem);
    secs.head = { box: head }; secs.mem = { box: mem, key: null };
    section('summary', 'Summary', true);
    section('tasks', 'Tasks', true);
    section('claims', 'File claims', false);
    section('notes', 'Notes', false);
    section('msgs', 'Messages', false);
    section('cps', 'Checkpoints', false);
    // forms that must keep their text: built once
    const tf = el('div', 'tmForm');
    const ti = el('input'); ti.placeholder = 'Add a task...';
    const to = el('select'); to.id = 'tmOwner';
    const add = btn('Add', () => { if (ti.value.trim()) { const v = ti.value; ti.value = ''; run(call('addTask', { title: v, owner: to.value })); } });
    ti.onkeydown = (e) => { if (e.key === 'Enter') add.click(); };
    tf.append(ti, to, add);
    secs.tasks.d.appendChild(tf);
    const nf = el('div', 'tmForm');
    const ni = el('input'); ni.placeholder = 'Tell the team something...';
    const nadd = btn('Post', () => { if (ni.value.trim()) { const v = ni.value; ni.value = ''; run(call('addNote', v)); } });
    ni.onkeydown = (e) => { if (e.key === 'Enter') nadd.click(); };
    nf.append(ni, nadd);
    secs.notes.d.appendChild(nf);
    const mf = el('div', 'tmForm');
    const mt = el('select'); mt.id = 'tmMsgTo';
    const mi = el('input'); mi.placeholder = 'Message a member...';
    const madd = btn('Send', () => { if (mi.value.trim()) { const v = mi.value; mi.value = ''; run(call('message', { to: mt.value, text: v })); } });
    mi.onkeydown = (e) => { if (e.key === 'Enter') madd.click(); };
    mf.append(mt, mi, madd);
    secs.msgs.d.appendChild(mf);
  }

  function paintRun() {
    const t = S;
    const head = secs.head.box;
    const hk = JSON.stringify([t.status, t.round, t.maxRounds, t.pauseAfter, t.error]);
    if (secs.head.key !== hk) {
      secs.head.key = hk;
      head.innerHTML = '';
      const st = el('div', 'tmStatus ' + t.status, `${STATUS_TEXT[t.status] || t.status}${t.status !== 'done' && t.round ? `  (round ${Math.min(t.round, t.maxRounds)} of ${t.maxRounds})` : ''}`);
      head.appendChild(st);
      const task = el('div', 'tmTaskText', t.task); task.title = t.task;
      head.appendChild(task);
      if (t.error) head.appendChild(el('div', 'tmBad', t.error));
      const row = el('div', 'tmBtns');
      if (live()) {
        row.appendChild(btn('Stop', () => run(call('stop')), 'primary', 'Stop all members now. The board is kept and you can resume.'));
        const p = btn(t.pauseAfter ? 'Pausing after this round' : 'Pause after this round', () => run(call('pause', !t.pauseAfter)), t.pauseAfter ? 'on' : '');
        row.appendChild(p);
      } else {
        if (t.status !== 'done') row.appendChild(btn(t.status === 'limit' ? 'Continue 2 more rounds' : 'Resume', () => run(call('resume', 2)), 'primary'));
        row.appendChild(btn('New team', () => run(call('reset')), ''));
        row.appendChild(btn('Close member agents', () => run(call('closeMembers')), '', 'Closes the member tabs. The board stays.'));
      }
      row.appendChild(btn('Show as panes', () => F.panes.show(t.members.map((m) => m.sid), t.members.length > 3 ? 'grid' : 'columns'), '', 'Put every member in its own split pane'));
      head.appendChild(row);
    }
    // members
    const mk = JSON.stringify(t.members.map((m) => [m.name, m.role, m.status, m.finished, m.last, m.exists]));
    if (secs.mem.key !== mk) {
      secs.mem.key = mk;
      const box = secs.mem.box;
      box.innerHTML = '';
      for (const m of t.members) {
        const r = el('div', 'tmLive');
        r.append(el('i', 'adot ' + (m.status === 'working' ? 'working' : m.status === 'error' || m.status === 'timeout' ? 'error' : '')), el('b', '', m.name), el('span', 'tmRole', m.role), el('span', 'tmMemSt', m.status === 'idle' && m.finished ? 'finished' : m.status));
        const go = btn('Open', () => F.chat.switchTo(m.sid), 'ghost');
        go.disabled = !m.exists;
        r.appendChild(go);
        if (m.last) r.appendChild(el('div', 'tmLast', m.last));
        box.appendChild(r);
      }
    }
    // selects
    for (const id of ['tmOwner', 'tmMsgTo']) {
      const s = document.getElementById(id);
      if (!s) continue;
      const names = t.members.map((m) => m.name);
      const want = (id === 'tmMsgTo' ? ['all'] : ['(no owner)']).concat(names).join('|');
      if (s.dataset.k !== want) {
        const cur = s.value;
        s.innerHTML = '';
        s.dataset.k = want;
        if (id === 'tmOwner') s.appendChild(Object.assign(el('option', '', '(no owner)'), { value: '' })); else s.appendChild(Object.assign(el('option', '', 'all'), { value: 'all' }));
        for (const n of names) s.appendChild(Object.assign(el('option', '', n), { value: n }));
        if ([...s.options].some((o) => o.value === cur)) s.value = cur;
      }
    }
    const b = t.board;
    setSec('summary', t.summary ? 'Summary' : 'Summary (when finished)', t.summary, (body) => { body.appendChild(el('div', 'tmSummary', t.summary || 'The lead writes this when the team is done.')); });
    const done = b.tasks.filter((x) => x.status === 'done').length;
    setSec('tasks', `Tasks (${done} of ${b.tasks.length} done)`, b.tasks, (body) => {
      if (!b.tasks.length) body.appendChild(el('div', 'tmHint', 'No tasks yet. The lead adds them first.'));
      for (const k of b.tasks) {
        const r = el('div', 'tmTaskRow');
        r.append(el('span', 'tmChip ' + k.status, k.status), el('span', 'tmTaskTitle', k.title), el('span', 'tmOwnerTag', k.owner || 'unassigned'));
        if (k.result) r.appendChild(el('div', 'tmLast', k.result));
        body.appendChild(r);
      }
    });
    setSec('claims', `File claims (${b.claims.length})`, b.claims, (body) => {
      if (!b.claims.length) body.appendChild(el('div', 'tmHint', 'No files are claimed. A file is claimed by whoever edits it first.'));
      for (const c of b.claims) {
        const r = el('div', 'tmClaim');
        r.append(el('span', 'tmPath', c.path), el('span', 'tmOwnerTag', c.owner), btn('Release', () => run(call('releaseClaim', c.full)), 'ghost', 'Free this file for everyone'));
        body.appendChild(r);
      }
    });
    setSec('notes', `Notes (${b.notes.length})`, b.notes, (body) => { for (const n of [...b.notes].reverse()) { const r = el('div', 'tmNote'); r.append(el('b', '', n.by + ': '), document.createTextNode(n.text)); body.appendChild(r); } });
    setSec('msgs', `Messages (${b.messages.length})`, b.messages, (body) => { for (const m of [...b.messages].reverse()) { const r = el('div', 'tmNote'); r.append(el('b', '', `${m.from} to ${m.to}: `), document.createTextNode(m.text)); body.appendChild(r); } });
    setSec('cps', `Checkpoints (${t.checkpoints.length})`, [t.checkpoints, live()], (body) => {
      body.appendChild(el('div', 'tmHint', 'A checkpoint is the board at the end of a step. Restoring one rolls back the board and the round counter only. It does not undo changes already made to files.'));
      for (const c of t.checkpoints) {
        const r = el('div', 'tmClaim');
        r.append(el('span', 'tmPath', `${c.label}  (${c.done}/${c.total} tasks, ${ago(c.at)})`));
        const rb = btn('Restore', () => run(call('restore', c.i)), 'ghost');
        rb.disabled = live();
        r.appendChild(rb);
        body.appendChild(r);
      }
    });
  }

  /* ---------- tab ---------- */
  let raf = 0;
  function paint() {
    if (raf || !pane) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const has = !!S;
      setupBox.hidden = has;
      runBox.hidden = !has;
      if (has) { if (!secs.tasks || !runBox.firstChild) buildRun(); paintRun(); } else { secs.head = null; runBox.innerHTML = ''; }
      if (F.setBadge) F.setBadge('team', live() ? S.members.filter((m) => m.status === 'working').length || 1 : 0);
      if (!has && !setupBox.firstChild) paintSetup();
    });
  }
  F.addSideTab({
    id: 'team', title: 'Team',
    render(root) {
      pane = root;
      root.classList.add('tm');
      setupBox = el('div', 'tmSetup'); runBox = el('div', 'tmRun');
      runBox.hidden = true;
      root.append(setupBox, runBox);
      paintSetup();
      paint();
    },
    onShow() { refresh(); },
  });
  async function refresh() { try { S = (await call('state')).team; } catch { return; } if (!S && setupBox) { setupBox.innerHTML = ''; paintSetup(); } paint(); }
  F.on(NS + 'state', (s) => { const was = S; S = s.team; if (!S && was && setupBox) { setupBox.innerHTML = ''; paintSetup(); } paint(); });
  F.onReady(refresh);

  F.addCommand('team', 'stop|resume', 'Open the Team tab, or stop / resume the team', async (a) => {
    a = (a || '').trim().toLowerCase();
    if (a === 'stop') return run(call('stop'));
    if (a === 'resume') return run(call('resume', 2));
    F.showSideTab('team');
  });
  F.addMenuItem('Agents', { id: 'agents.team', label: 'Team...', separatorBefore: true, action: () => F.showSideTab('team') });
});
