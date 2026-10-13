/* feature: orchestra (renderer). The Orchestra tab has two modes.
   CHAT (default): talk to the orchestrator. "Create 4 agents", "add a reviewer", "build a snake game": it makes the agents, shows
   the team, runs tasks with it and reports progress in the conversation. TASK FORM: the classic form, one task, four fixed roles,
   you pick the models. Either way every message between the agents appears in the Trace panel, word for word.
   Main side: src/features/orchestra.js, src/orchestrator-chat.js, src/orchestrator.js. */
Faber.register('orchestra', (F) => {
  const { el } = F;
  const NS = 'feat:orchestra:';
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const call = (m, ...a) => F.call(NS + m, ...a);
  const fail = (e) => F.error('Orchestra: ' + clean(e));
  const ROLE_LABEL = { conductor: 'Conductor', coder: 'Coder', reviewer: 'Reviewer', fast: 'Fast helper' };
  const ROLE_HELP = { conductor: 'plans the work and writes the final answer', coder: 'edits files and runs commands', reviewer: 'independent read-only check (a different model than the coder is best)', fast: 'small and quick: summaries and simple jobs' };
  const GB = 1073741824;
  let R = null;                 // roster info from the main process
  let S = { running: false, phase: 'idle', result: null, approvals: [] };
  const choice = {};            // role -> model chosen by the user ('' = automatic)
  const opts = { mode: 'edits', concurrency: 1, maxRework: 1, timeout: 900, task: '' };
  let pane = null, setupBox = null, runBox = null, rosterBox = null, chatBox = null, modeBar = null;
  let viewMode = 'chat';          // 'chat' | 'form'
  let C = { team: [], conductor: '', busy: false, concurrency: 1, mode: 'edits', pendingTask: '', history: [] };

  const gb = (n) => (n ? (n / GB).toFixed(1) + ' GB' : '?');
  const btn = (label, onClick, cls, title) => { const b = el('button', cls || '', label); if (title) b.title = title; b.onclick = onClick; return b; };

  /* ---------- roster + suggestions ---------- */
  function paintRoster() {
    if (!rosterBox) return;
    rosterBox.innerHTML = '';
    if (!R) { rosterBox.appendChild(el('div', 'orHint', 'Loading models...')); return; }
    if (!R.ok) { rosterBox.appendChild(el('div', 'orBad', 'Cannot reach Ollama. Start it, then reopen this tab.')); return; }
    for (const role of ['conductor', 'coder', 'reviewer', 'fast']) {
      const auto = R.roster.find((r) => r.role === role);
      const row = el('div', 'orRole');
      row.append(el('b', '', ROLE_LABEL[role]), el('span', 'orHint', ROLE_HELP[role]));
      const sel = el('select');
      sel.appendChild(Object.assign(el('option', '', `Automatic: ${auto ? auto.model : R.primary}`), { value: '' }));
      for (const m of R.installed) sel.appendChild(Object.assign(el('option', '', `${m.name}  (${gb(m.size)})`), { value: m.name }));
      sel.value = choice[role] || '';
      sel.onchange = () => { choice[role] = sel.value; };
      row.appendChild(sel);
      if (auto && !choice[role]) row.appendChild(el('div', 'orHint', auto.note));
      rosterBox.appendChild(row);
    }
    if (R.suggestions.length) {
      rosterBox.appendChild(el('b', 'orSugHead', 'Specialist models you could add'));
      rosterBox.appendChild(el('div', 'orHint', 'Optional. Smaller specialists make the helper roles faster on a CPU. Sizes are approximate; names come from the Ollama library and may change. Downloading needs internet once.'));
      for (const s of R.suggestions) rosterBox.appendChild(suggestion(s));
    }
  }
  function suggestion(s) {
    const row = el('div', 'orSug');
    const head = el('div', 'orSugTop');
    head.append(el('b', '', s.model), el('span', 'orHint', `${s.role}, about ${s.sizeGB} GB`));
    const prog = el('div', 'orHint');
    const dl = btn('Download', async () => {
      dl.disabled = true; prog.textContent = 'Starting (this goes online once)...';
      const onP = (ev) => { const pct = ev.total ? Math.floor(((ev.completed || 0) / ev.total) * 100) : null; prog.textContent = ev.status + (pct !== null ? ` ${pct}%` : ''); };
      window.api.onPull(onP);
      try { await window.api.pullModel(s.model); prog.textContent = 'Downloaded.'; await loadRoster(); } catch (e) { prog.textContent = clean(e); dl.disabled = false; }
    }, '', `Downloads ${s.model} through your local Ollama (online, one time)`);
    const cp = btn('Copy command', () => { try { navigator.clipboard.writeText('ollama pull ' + s.model).then(() => F.toast('Copied: ollama pull ' + s.model)); } catch { F.toast('ollama pull ' + s.model); } }, 'ghost');
    head.append(dl, cp);
    row.append(head, el('div', 'orHint', s.why), prog);
    return row;
  }
  async function loadRoster() { try { R = await call('roster'); } catch (e) { R = { ok: false, installed: [], roster: [], suggestions: [] }; } paintRoster(); }

  /* ---------- setup form ---------- */
  function buildSetup() {
    setupBox.innerHTML = '';
    setupBox.appendChild(el('div', 'orHint', 'A conductor model plans your task and hands each step to a specialist agent. Each agent can run on a different model. Everything they say to each other appears in the Trace panel, word for word.'));
    const task = el('textarea', 'orTask');
    task.rows = 4; task.placeholder = 'The task. Be specific, for example: "Add input validation to signup.js, write tests for it, and update the README."';
    task.value = opts.task;
    task.oninput = () => { opts.task = task.value; };
    setupBox.append(el('b', '', 'Task'), task, el('b', '', 'Who runs on which model'));
    rosterBox = el('div', 'orRoster');
    setupBox.appendChild(rosterBox);
    const grid = el('div', 'orOpts');
    const num = (label, key, min, max, hint) => { const l = el('label', 'orOpt'); l.append(el('span', '', label)); const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.value = opts[key]; i.title = hint; i.oninput = () => { opts[key] = Number(i.value); }; l.appendChild(i); grid.appendChild(l); };
    num('Agents at once', 'concurrency', 1, 4, 'On a CPU, models take turns (1). More only helps if every model fits in RAM at the same time.');
    num('Rework rounds', 'maxRework', 0, 3, 'How many times a reviewer may send work back to its author');
    num('Step timeout (s)', 'timeout', 30, 7200, 'A step that takes longer is stopped');
    const ml = el('label', 'orOpt'); ml.appendChild(el('span', '', 'Permissions'));
    const ms = el('select');
    for (const [v, t] of [['edits', 'Auto-edit files, ask for commands'], ['ask', 'Ask for everything'], ['auto', 'Auto-approve all']]) ms.appendChild(Object.assign(el('option', '', t), { value: v }));
    ms.value = opts.mode; ms.onchange = () => { opts.mode = ms.value; };
    ml.appendChild(ms); grid.appendChild(ml);
    setupBox.appendChild(grid);
    setupBox.appendChild(el('div', 'orHint', 'Agents can only read and change files inside the open folder. Reviewers and the conductor are read-only. Questions about edits or commands appear here and are written to the trace together with your answer.'));
    const go = btn('Run', async () => {
      if (!F.folder()) return F.error('Open a project folder first: the agents work on its files.');
      go.disabled = true;
      try {
        const models = {};
        for (const k of Object.keys(choice)) if (choice[k]) models[k] = choice[k];
        await call('run', { task: opts.task, models, mode: opts.mode, concurrency: opts.concurrency, maxRework: opts.maxRework, stepTimeoutSec: opts.timeout });
        if (F.openTrace && !Dock.visible('trace')) F.openTrace();
      } catch (e) { fail(e); }
      go.disabled = false;
    }, 'primary');
    setupBox.append(go, btn('Open trace', () => F.openTrace && F.openTrace(), '', 'Show every message between the agents'));
    paintRoster();
  }

  /* ---------- chat with the orchestrator ---------- */
  let chatLog = null, teamBox = null, chatInput = null, sendBtn = null, stopBtn = null, chipsBox = null, approvalsBox = null, busyLine = null;
  const shown = new Set();
  const KIND_LABEL = { coder: 'coder', reviewer: 'reviewer', researcher: 'researcher', fast: 'fast helper' };
  function nearBottom() { return !chatLog || chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60; }
  function paintTeam() {
    if (!teamBox) return;
    teamBox.innerHTML = '';
    const head = el('div', 'orTeamHead');
    head.appendChild(el('b', '', C.team.length ? `Team (${C.team.length})` : 'Team'));
    teamBox.appendChild(head);
    if (!C.team.length) { teamBox.appendChild(el('div', 'orHint', 'No agents yet. Tell the orchestrator how many you want, for example "create 4 agents".')); return; }
    const grid = el('div', 'orAgents');
    for (const a of C.team) {
      const card = el('div', 'orAgent');
      card.title = `${a.name}: ${a.focus ? 'coder, ' + a.focus : (KIND_LABEL[a.role] || a.role)}\nmodel: ${a.model || '(none)'}`;
      card.append(el('b', '', a.name), el('span', 'orHint', a.focus ? 'tester/writer' : (KIND_LABEL[a.role] || a.role)), btn('x', () => send('remove ' + a.name), 'ghost orX', `Remove ${a.name}`));
      grid.appendChild(card);
    }
    teamBox.appendChild(grid);
    const by = new Map();
    for (const a of C.team) { if (!by.has(a.model)) by.set(a.model, []); by.get(a.model).push(a.name); }
    teamBox.appendChild(el('div', 'orHint orModelsLine', [...by.entries()].map(([m, n]) => `${m || '(no model)'}: ${n.join(', ')}`).join('  |  ') + `   (${C.concurrency === 1 ? 'one at a time' : C.concurrency + ' at a time'}, permissions: ${C.mode})`));
  }
  function paintMessages() {
    if (!chatLog) return;
    const stick = nearBottom();
    for (const m of C.history) {
      if (shown.has(m.id)) continue;
      shown.add(m.id);
      const d = el('div', 'orMsg ' + (m.from === 'you' ? 'you' : 'bot') + (m.kind ? ' k-' + m.kind : ''));
      d.appendChild(el('div', 'orMsgWho', m.from === 'you' ? 'You' : 'Orchestrator'));
      d.appendChild(el('div', 'orMsgText', m.text));
      chatLog.appendChild(d);
    }
    if (!C.history.length && !chatLog.firstChild) {
      const d = el('div', 'orMsg bot');
      d.appendChild(el('div', 'orMsgWho', 'Orchestrator'));
      d.appendChild(el('div', 'orMsgText', 'Hello. Tell me how many agents you want and I will create them, for example:\n  create 4 agents\n  I want 2 coders, a tester and a reviewer\nThen tell me what to build. Say "help" to see everything I understand.'));
      d.dataset.hello = '1';
      chatLog.appendChild(d);
    } else if (C.history.length) { const h = chatLog.querySelector('[data-hello]'); if (h) h.remove(); }
    if (stick) chatLog.scrollTop = chatLog.scrollHeight;
  }
  function paintChatState() {
    if (!chatBox) return;
    paintTeam(); paintMessages();
    const running = C.busy || S.running;
    sendBtn.disabled = false;
    stopBtn.hidden = !running;
    busyLine.hidden = !running;
    busyLine.textContent = running ? (S.running && PHASE[S.phase] ? PHASE[S.phase] + '...' : 'Working...') : '';
    chipsBox.innerHTML = '';
    const sugg = C.team.length ? ['Show the team', 'Add a reviewer', 'Add 2 more coders', 'Help'] : ['Create 3 agents', 'Create 2 coders and a reviewer', 'Help'];
    for (const t of sugg) chipsBox.appendChild(btn(t, () => send(t), 'orChip2'));
    approvalsBox.innerHTML = '';
    for (const a of S.approvals || []) {
      const card = el('div', 'orApproval');
      card.append(el('b', '', a.title), el('pre', 'orPre', a.detail || ''));
      const bs = el('div', 'orBtns');
      bs.append(btn('Allow', () => call('approve', a.id, true).catch(fail), 'primary'), btn('Deny', () => call('approve', a.id, false).catch(fail)));
      card.appendChild(bs);
      approvalsBox.appendChild(card);
    }
  }
  async function send(text) {
    text = String(text == null ? chatInput.value : text).trim();
    if (!text) return;
    if (chatInput.value.trim() === text) chatInput.value = '';
    try { await call('chat-send', text); } catch (e) { fail(e); }
    chatInput.focus();
  }
  function buildChat() {
    chatBox.innerHTML = '';
    teamBox = el('div', 'orTeam');
    chatLog = el('div', 'orLog');
    approvalsBox = el('div', 'orApprovals');
    busyLine = el('div', 'orBusy'); busyLine.hidden = true;
    chipsBox = el('div', 'orChips');
    chatInput = el('textarea', 'orInput');
    chatInput.rows = 2; chatInput.placeholder = 'Talk to the orchestrator...';
    chatInput.title = 'For example: "create 4 agents", "I want 2 coders and a reviewer", "build a snake game in snake.js". Enter sends, Shift+Enter starts a new line.';
    chatInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
    sendBtn = btn('Send', () => send(), 'primary');
    stopBtn = btn('Stop', () => call('stop').catch(fail), '', 'Stop the agents'); stopBtn.hidden = true;
    const row = el('div', 'orInputRow');
    const btns = el('div', 'orSendRow');
    btns.append(btn('Trace', () => F.openTrace && F.openTrace(), 'ghost', 'Show every message between the agents'), stopBtn, sendBtn);
    row.append(chatInput, btns);
    chatBox.append(teamBox, chatLog, approvalsBox, busyLine, chipsBox, row);
    shown.clear();
    paintChatState();
  }
  async function loadChat() { try { C = await call('chat-state'); } catch { /* feature missing */ } if (chatBox) { if (!chatLog) buildChat(); else paintChatState(); } }

  /* ---------- run view ---------- */
  const PHASE = { planning: 'The conductor is planning', running: 'Agents are working', finishing: 'The conductor is writing the final answer', done: 'Finished', idle: 'Idle', starting: 'Starting' };
  const STATUS_CLASS = { done: 'done', running: 'doing', failed: 'bad', skipped: 'bad', stopped: 'bad', pending: '' };
  let lastKey = '';
  function paintRun() {
    const key = JSON.stringify([S.running, S.phase, S.result, S.approvals]);
    if (key === lastKey) return;
    lastKey = key;
    runBox.innerHTML = '';
    const r = S.result || {};
    runBox.appendChild(el('div', 'orStatus ' + (S.running ? 'run' : r.status === 'done' ? 'ok' : 'bad'), S.running ? (PHASE[S.phase] || S.phase) : `Finished: ${r.status || 'done'}`));
    if (S.task) runBox.appendChild(el('div', 'orHint orTaskText', S.task));
    const row = el('div', 'orBtns');
    if (S.running) row.appendChild(btn('Stop', () => call('stop').catch(fail), 'primary'));
    row.appendChild(btn('Open trace', () => F.openTrace && F.openTrace()));
    if (!S.running) row.appendChild(btn('New task', () => { lastKey = ''; S = { ...S, result: null, task: '' }; show(); }));
    runBox.appendChild(row);
    for (const a of S.approvals || []) {
      const card = el('div', 'orApproval');
      card.append(el('b', '', a.title), el('pre', 'orPre', a.detail || ''));
      const bs = el('div', 'orBtns');
      bs.append(btn('Allow', () => call('approve', a.id, true).catch(fail), 'primary'), btn('Deny', () => call('approve', a.id, false).catch(fail)));
      card.appendChild(bs);
      runBox.appendChild(card);
    }
    if (r.steps && r.steps.length) {
      runBox.appendChild(el('b', '', 'Steps'));
      for (const s of r.steps) {
        const d = el('div', 'orStep');
        const top = el('div', 'orStepTop');
        top.append(el('span', 'orChip ' + (STATUS_CLASS[s.status] || ''), s.status), el('b', '', `${s.id} ${s.agent}`), s.verdict && s.verdict !== 'none' ? el('span', 'orChip ' + (s.verdict === 'approved' ? 'done' : 'bad'), s.verdict) : el('span'));
        d.append(top, el('div', 'orHint', s.instruction));
        if (s.error) d.appendChild(el('div', 'orBad', s.error));
        runBox.appendChild(d);
      }
    }
    if (r.final) { runBox.appendChild(el('b', '', 'Final answer')); runBox.appendChild(el('div', 'orFinal', r.final)); }
    if (r.error) runBox.appendChild(el('div', 'orBad', r.error));
  }
  function show() {
    if (modeBar) for (const b of modeBar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === viewMode);
    pane && pane.classList.toggle('orChatMode', viewMode === 'chat');
    chatBox.hidden = viewMode !== 'chat';
    if (viewMode === 'chat') { setupBox.hidden = true; runBox.hidden = true; if (!chatLog) buildChat(); else paintChatState(); return; }
    const showRun = S.running || (S.result && S.task);
    setupBox.hidden = !!showRun;
    runBox.hidden = !showRun;
    if (showRun) paintRun(); else { if (!setupBox.firstChild) buildSetup(); }
  }

  F.addSideTab({
    id: 'orchestra', title: 'Orchestra',
    render(root) {
      pane = root; root.classList.add('or');
      modeBar = el('div', 'orModes');
      for (const [id, label] of [['chat', 'Chat'], ['form', 'Task form']]) { const b = btn(label, () => { viewMode = id; show(); if (id === 'form') loadRoster(); }, 'orMode'); b.dataset.mode = id; modeBar.appendChild(b); }
      chatBox = el('div', 'orChatBox'); setupBox = el('div', 'orSetup'); runBox = el('div', 'orRun');
      root.append(modeBar, chatBox, setupBox, runBox);
      buildSetup(); show(); loadRoster(); loadChat();
    },
    onShow() { if (!S.running) loadRoster(); loadChat(); },
  });
  F.on(NS + 'state', (s) => { S = s; if (pane) show(); if (F.setBadge) F.setBadge('orchestra', s.running ? 1 : 0); });
  F.on(NS + 'chat', (c) => { C = { ...C, ...c }; if (pane && chatLog) paintChatState(); });
  F.onReady(async () => { try { S = await call('state'); if (pane) show(); } catch { /* feature missing */ } });
  F.addCommand('orchestra', 'stop', 'Open the Orchestra tab (or stop the run)', (a) => { if ((a || '').trim() === 'stop') return call('stop').catch(fail); F.showSideTab('orchestra'); });
  F.addMenuItem('Agents', { id: 'agents.orchestra', label: 'Orchestra...', action: () => F.showSideTab('orchestra') });
});
