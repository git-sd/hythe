// Team mode through the real main process: plan -> rounds -> summary, claims, stop/resume/checkpoints. Fake Ollama scripts each member.
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('../fake-ollama-chat');
const { launch, checker, sleep } = require('./harness');

(async () => {
  const check = checker();
  const fake = await startFake({ models: ['qwen3.5:9b'] });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'faber-team-'));
  const log = [];
  // who: member name from the system prompt; step: how many tool results came after the last user message
  fake.script = async (body) => {
    const sys = body.messages[0].content;
    const m = /You are "([^"]+)"/.exec(sys);
    const name = m ? m[1] : 'x';
    const msgs = body.messages;
    let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
    const prompt = msgs[li].content;
    const n = msgs.slice(li + 1).filter((x) => x.role === 'tool').length;
    const call = (name2, args) => ({ calls: [{ name: name2, args }] });
    log.push(`${name}#${n}:${prompt.slice(0, 18).replace(/\n/g, ' ')}`);
    if (/final summary/.test(prompt)) return { content: 'SUMMARY: hello.txt and shared.txt created.' };
    if (name === 'Lead') {
      if (/Plan it now/.test(prompt)) return [call('board_add_task', { title: 'Create hello.txt', owner: 'Coder' }), call('board_add_task', { title: 'Create shared.txt', owner: 'Coder2' }), call('board_add_task', { title: 'Review hello.txt', owner: 'Reviewer' }), call('finish_work', { result: 'planned' }), { content: 'plan done' }][n];
      return [call('finish_work', { result: 'nothing to do' }), { content: 'ok' }][n];
    }
    if (name === 'Coder') return [call('write_file', { path: 'hello.txt', content: 'HELLO' }), call('write_file', { path: 'shared.txt', content: 'FROM-CODER' }), call('board_update_task', { id: 't1', status: 'done', result: 'created hello.txt' }), call('finish_work', { result: 'done' }), { content: 'coded' }][n];
    if (name === 'Coder2') return [call('write_file', { path: 'shared.txt', content: 'FROM-CODER2' }), call('board_message', { to: 'Coder', text: 'shared.txt please' }), call('write_file', { path: 'other.txt', content: 'OTHER' }), call('board_update_task', { id: 't2', status: 'done', result: 'created other.txt instead' }), call('finish_work', { result: 'done' }), { content: 'coded2' }][n];
    if (name === 'Reviewer') return [call('read_file', { path: 'hello.txt' }), call('board_update_task', { id: 't3', status: 'done', result: 'looks fine' }), call('finish_work', { result: 'reviewed' }), { content: 'reviewed' }][n];
    return { content: 'ok' };
  };
  // allow arrays from script (one entry per step)
  const orig = fake.script;
  fake.script = async (b, r) => { const o = await orig(b, r); return o; };

  const h = await launch({ ollama: fake.url, workspace: proj });
  const I = h.invoke;
  const waitStatus = async (want, ms = 40000) => { const t0 = Date.now(); for (;;) { const s = (await I('feat:team:state')).team; if (s && want.includes(s.status)) return s; if (Date.now() - t0 > ms) return s; await sleep(150); } };
  try {
    await h.open(); await sleep(500);
    const members = [{ name: 'Lead', role: 'lead' }, { name: 'Coder', role: 'coder' }, { name: 'Coder2', role: 'coder' }, { name: 'Reviewer', role: 'reviewer' }];

    // validation
    for (const [p, why] of [[{ task: '', members }, 'empty task'], [{ task: 'x', members: members.slice(0, 1) }, 'one member'], [{ task: 'x', members: [{ name: 'A', role: 'lead' }, { name: 'B', role: 'reviewer' }] }, 'no coder'], [{ task: 'x', members: [{ name: 'A', role: 'coder' }, { name: 'a', role: 'coder' }] }, 'duplicate names'], [{ task: 'x', members: [{ name: '../x', role: 'coder' }, { name: 'B', role: 'coder' }] }, 'bad name'], [{ task: 'x', members: [{ name: 'A', role: 'lead' }, { name: 'B', role: 'lead' }, { name: 'C', role: 'coder' }] }, 'two leads'], [{ task: 'x', members: [{ name: 'A', role: 'wizard' }, { name: 'B', role: 'coder' }] }, 'bad role']]) {
      const e = await I('feat:team:start', p).then(() => null, (er) => er.message);
      check('start rejects ' + why, !!e, e);
    }
    const before = (await I('feat:agents:state')).sessions.length;
    check('rejected starts created no agents', before === 1, before);

    const st0 = await I('feat:team:start', { task: 'Create the files', members, mode: 'auto', maxRounds: 4 });
    check('team created with one agent per member', st0.team.members.length === 4 && (await I('feat:agents:state')).sessions.length === 5);
    const sessions = (await I('feat:agents:state')).sessions;
    check('member agents are tagged with the team', sessions.filter((s) => s.team === st0.team.id).length === 4);
    const second = await I('feat:team:start', { task: 'again', members, mode: 'auto' }).then(() => null, (e) => e.message);
    check('cannot start a second team while one is active', /already running/.test(second || ''), second);

    const fin = await waitStatus(['done', 'limit', 'error', 'stopped']);
    console.log('  order of turns:', log.filter((x) => /#0/.test(x)).join(' | '));
    check('team finished as done', fin.status === 'done', { s: fin.status, round: fin.round, err: fin.error, tasks: fin.board.tasks.map((t) => t.id + ':' + t.status), members: fin.members.map((m) => m.name + ':' + m.status + ':' + m.finished) });
    check('lead planned first (plan prompt before any round prompt)', log[0].startsWith('Lead#0:The team'), log.slice(0, 3));
    check('three tasks on the board, all done', fin.board.tasks.length === 3 && fin.board.tasks.every((t) => t.status === 'done'));
    check('files were written', fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8') === 'HELLO' && fs.existsSync(path.join(proj, 'other.txt')));
    const shared = fs.readFileSync(path.join(proj, 'shared.txt'), 'utf8');
    const winner = shared === 'FROM-CODER' ? 'Coder' : 'Coder2', loser = winner === 'Coder' ? 'Coder2' : 'Coder';
    check('conflict: whoever wrote shared.txt first kept it', shared === 'FROM-CODER' || shared === 'FROM-CODER2', shared);
    const loserLog = JSON.stringify(await I('feat:agents:log', sessions.find((s) => s.name === loser).id));
    check(`the other writer (${loser}) got a clear "claimed by ${winner}" error`, new RegExp('shared\\.txt is claimed by ' + winner).test(loserLog), loserLog.slice(0, 300));
    check('message to a member was stored on the board', fin.board.messages.some((m) => m.from === 'Coder2' && m.to === 'Coder'));
    check('reviewer ran after the coders (second wave)', log.findIndex((x) => x.startsWith('Reviewer')) > log.findIndex((x) => x.startsWith('Coder2')));
    check('final summary written by the lead', /SUMMARY: hello\.txt/.test(fin.summary), fin.summary);
    check('claims released when done', fin.board.claims.length === 0, fin.board.claims);
    check('checkpoints taken (plan, round, summary)', fin.checkpoints.length >= 3 && fin.checkpoints[0].label === 'plan', fin.checkpoints);

    // ---- transparency: team mode talks through the same communication line ----
    const tr = await I('feat:trace:list', 0, 5000);
    const TE = tr.entries;
    const taskTexts = new Set(TE.filter((e) => e.kind === 'task').map((e) => e.text));
    const toolTexts = new Set(TE.filter((e) => e.kind === 'tool-result').map((e) => e.text));
    let missPrompts = 0, missTools = 0, nPrompts = 0, nTools = 0;
    for (const r of fake.requests) for (const m of r.messages) {
      if (m.role === 'user') { nPrompts++; if (!taskTexts.has(m.content)) missPrompts++; }
      if (m.role === 'tool') { nTools++; if (!toolTexts.has(m.content)) missTools++; }
    }
    check('team: EVERY prompt a member model received is in the trace, word for word', nPrompts > 5 && missPrompts === 0, { nPrompts, missPrompts });
    check('team: EVERY tool result a member received is in the trace', nTools > 5 && missTools === 0, { nTools, missTools });
    check('team: prompts are logged as team -> member tasks with the member\'s model', TE.some((e) => e.kind === 'task' && e.from === 'team' && e.to === 'Coder' && e.model === 'qwen3.5:9b'));
    check('team: board actions (tasks, messages, finish) are on the line', ['board_add_task', 'board_message', 'finish_work', 'board_update_task'].every((n) => TE.some((e) => e.kind === 'board' && e.text.startsWith(n))));
    check('team: the board message shows sender, receiver and text', TE.some((e) => e.kind === 'board' && e.from === 'Coder2' && e.to === 'Coder' && /shared\.txt please/.test(e.text)));
    check('team: the final summary is on the line as FINAL', TE.some((e) => e.kind === 'final' && /SUMMARY: hello\.txt/.test(e.text)));
    check('team: a denied/claimed write shows up as a tool result', TE.some((e) => e.kind === 'tool-result' && /is claimed by/.test(e.text)));
    check('team: the whole trace verifies (memory and file)', (await I('feat:trace:verify')).memory.ok && (await I('feat:trace:verify')).file.ok);

    // tools not offered to non-members
    const normal = fake.requests.filter((r) => /Faber, an offline/.test(r.system || '') && !/TEAM MODE/.test(r.system || ''));
    check('board tools are NOT offered to ordinary agents', normal.every((r) => !r.tools.includes('board_read')) );
    const coderReq = fake.requests.find((r) => /"Coder", the coder/.test(r.system || ''));
    const revReq = fake.requests.find((r) => /"Reviewer", the reviewer/.test(r.system || ''));
    check('coder has write tools + board tools', coderReq.tools.includes('write_file') && coderReq.tools.includes('finish_work'), coderReq.tools);
    check('reviewer has NO write or run tools', !revReq.tools.includes('write_file') && !revReq.tools.includes('run_command') && revReq.tools.includes('read_file'), revReq.tools);
    check('lead cannot write files either', !fake.requests.find((r) => /"Lead", the lead/.test(r.system || '')).tools.includes('write_file'));

    // after done: reset + persistence
    await sleep(600);
    check('team state persisted to disk', fs.existsSync(path.join(h.userData, 'teams', 'current.json')));
    await I('feat:team:reset');
    check('reset clears the team', (await I('feat:team:state')).team === null);

    // ---- stop + resume + restore ----
    log.length = 0;
    fake.script = async (body) => {
      const sys = body.messages[0].content;
      const name = (/You are "([^"]+)"/.exec(sys) || [])[1];
      const msgs = body.messages;
      let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
      const prompt = msgs[li].content;
      const n = msgs.slice(li + 1).filter((x) => x.role === 'tool').length;
      const call = (a, b) => ({ calls: [{ name: a, args: b }] });
      if (/final summary/.test(prompt)) return { content: 'SUMMARY-2' };
      if (name === 'Lead') return /Plan it now/.test(prompt) ? [call('board_add_task', { title: 'Slow job', owner: 'Coder' }), call('finish_work', {}), { content: 'planned' }][n] : [call('finish_work', {}), { content: 'ok' }][n];
      if (name === 'Coder') { if (/Round 1/.test(prompt)) return { content: Array.from({ length: 200 }, (_, i) => `w${i} `).join(''), delay: 60 }; return [call('board_update_task', { id: 't1', status: 'done' }), call('finish_work', {}), { content: 'ok' }][n]; }
      return [call('finish_work', {}), { content: 'ok' }][n];
    };
    const m2 = [{ name: 'Lead', role: 'lead' }, { name: 'Coder', role: 'coder' }];
    await I('feat:team:start', { task: 'slow', members: m2, mode: 'auto', maxRounds: 3 });
    for (let i = 0; i < 60; i++) { const s = (await I('feat:team:state')).team; if (s.round === 1 && s.members.find((m) => m.name === 'Coder').status === 'working') break; await sleep(100); }
    const t0 = Date.now();
    await I('feat:team:stop');
    const stopped = await waitStatus(['stopped'], 8000);
    check('stop ends the run quickly and cleanly', stopped.status === 'stopped' && Date.now() - t0 < 6000, { s: stopped.status, ms: Date.now() - t0 });
    check('stopped run has a checkpoint and a fallback summary', stopped.checkpoints.some((c) => c.label === 'stopped') && /tasks done/.test(stopped.summary), stopped.summary);
    check('no model request still in flight after stop', await (async () => { await sleep(500); return fake.inflight === 0; })(), fake.inflight);
    // restore to the plan checkpoint, then resume to completion
    await I('feat:team:restore', 0);
    const rs = (await I('feat:team:state')).team;
    check('restore rolls the board back to the plan', rs.board.tasks.length === 1 && rs.board.tasks[0].status === 'todo' && rs.status === 'stopped');
    // second round of the coder finishes quickly
    fake.script = async (body) => {
      const sys = body.messages[0].content;
      const name = (/You are "([^"]+)"/.exec(sys) || [])[1];
      const msgs = body.messages; let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
      const n = msgs.slice(li + 1).filter((x) => x.role === 'tool').length;
      const call = (a, b) => ({ calls: [{ name: a, args: b }] });
      if (/final summary/.test(msgs[li].content)) return { content: 'SUMMARY-3' };
      if (name === 'Coder') return [call('board_update_task', { id: 't1', status: 'done', result: 'quick' }), call('finish_work', {}), { content: 'ok' }][n];
      return [call('finish_work', {}), { content: 'ok' }][n];
    };
    await I('feat:team:resume');
    const done = await waitStatus(['done', 'limit', 'error'], 30000);
    check('resume after restore completes the team', done.status === 'done' && /SUMMARY-3/.test(done.summary), { s: done.status, sum: done.summary, err: done.error });
    // round limit
    await I('feat:team:reset');
    fake.script = async (body) => {
      const sys = body.messages[0].content;
      const name = (/You are "([^"]+)"/.exec(sys) || [])[1];
      const msgs = body.messages; let li = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { li = i; break; }
      const n = msgs.slice(li + 1).filter((x) => x.role === 'tool').length;
      const call = (a, b) => ({ calls: [{ name: a, args: b }] });
      if (/final summary/.test(msgs[li].content)) return { content: 'SUMMARY-LIMIT' };
      if (name === 'Lead' && /Plan it now/.test(msgs[li].content)) return [call('board_add_task', { title: 'Never ends', owner: 'Coder' }), call('finish_work', {}), { content: 'ok' }][n];
      if (name === 'Coder') return [call('board_note', { text: 'still working' }), { content: 'ok' }][n];   // never finishes
      return [call('finish_work', {}), { content: 'ok' }][n];
    };
    await I('feat:team:start', { task: 'endless', members: m2, mode: 'auto', maxRounds: 2 });
    const lim = await waitStatus(['done', 'limit', 'error'], 30000);
    check('round limit stops the team with status "limit" and a summary', lim.status === 'limit' && lim.round > 2 && /SUMMARY-LIMIT/.test(lim.summary), { s: lim.status, r: lim.round });
    check('exactly 2 rounds of coder turns', log.length >= 0 && fake.requests.filter((r) => /"Coder", the coder/.test(r.system || '') && JSON.stringify(r.messages).includes('Round ')).length >= 2);
    check('no page errors', h.errors.length === 0, h.errors);
  } catch (e) { check('harness ran: ' + e.stack, false); }
  await h.close(); await fake.close();
  process.exit(check.done() ? 1 : 0);
})();
