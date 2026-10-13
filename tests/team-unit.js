// Team board logic: tasks, messages, file claims (folder + file), prompts. Plain Node.
const path = require('path');
const T = require('../src/team-lib');
let pass = 0, fail = 0;
const check = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const R = (p) => path.resolve('/proj', p);

const b = new T.Board();
const t1 = b.addTask({ title: 'Write parser', owner: 'Coder', by: 'Lead' });
const t2 = b.addTask({ title: 'Review parser', owner: 'Reviewer', by: 'Lead' });
check('tasks get sequential ids and start as todo', t1.id === 't1' && t2.id === 't2' && t1.status === 'todo');
check('empty title rejected', !!throws(() => b.addTask({ title: '  ' })));
b.updateTask('t1', { status: 'doing' });
check('status updated', b.task('t1').status === 'doing');
check('bad status rejected', /Status must be/.test(throws(() => b.updateTask('t1', { status: 'finished' }))));
check('unknown task id gives a helpful error', /No task "t9"/.test(throws(() => b.task('t9'))));
check('open() lists unfinished tasks per owner', b.open('Coder').length === 1 && b.open('Nobody').length === 0);
b.updateTask('t1', { status: 'done', result: 'parser.js written' });
check('done tasks are no longer open', b.open('Coder').length === 0 && b.open().length === 1);

// messages
b.addMessage('Coder', 'Reviewer', 'parser.js is ready');
b.addMessage('Lead', 'all', 'ship it by friday');
const inbox = b.inbox('Reviewer');
check('inbox has direct + broadcast messages', inbox.length === 2);
check('inbox marks as read', b.inbox('Reviewer').length === 0);
check('sender never receives own broadcast', b.inbox('Lead').length === 0);
check('other members still get the broadcast', b.inbox('Coder').length === 1);
check('empty message rejected', !!throws(() => b.addMessage('a', 'b', ' ')));

// claims
let r = b.claim('Coder', [R('src/parser.js')]);
check('claim a file', r.ok.length === 1 && r.denied.length === 0);
r = b.claim('Reviewer', [R('src/parser.js')]);
check('second member is denied and told who holds it', r.ok.length === 0 && r.denied[0].by === 'Coder', r);
check('same owner can re-claim', b.claim('Coder', [R('src/parser.js')]).ok.length === 1);
b.claim('Coder', [R('src/lib')]);
check('folder claim covers files below it', b.ownerOf(R('src/lib/deep/x.js')) === 'Coder');
check('sibling folder not covered', b.ownerOf(R('src/library/x.js')) === null, b.ownerOf(R('src/library/x.js')));
check('another member cannot claim inside a claimed folder', b.claim('Reviewer', [R('src/lib/y.js')]).denied.length === 1);
b.claim('Reviewer', [R('docs/a.md')]);
check('folder claim refused when it would swallow another member\'s file', b.claim('Coder', [R('docs')]).denied.length === 1);
check('release frees a path', b.release('Coder', [R('src/parser.js')]).length === 1 && b.ownerOf(R('src/parser.js')) === null);
check('release all frees every claim of one owner only', b.release('Coder', 'all').length === 1 && b.ownerOf(R('docs/a.md')) === 'Reviewer');

// persistence + summary
const c = new T.Board(JSON.parse(JSON.stringify(b)));
check('board survives JSON round trip', c.tasks.length === 2 && c.claimsList().length === 1 && c.seq === b.seq);
b.addNote('Coder', 'using strict mode');
const sum = b.summary((p) => path.relative('/proj', p));
check('summary mentions tasks, claims and notes', /t2 \[todo\]/.test(sum) && /docs[\\/]a\.md\s+->\s+Reviewer/.test(sum) && /strict mode/.test(sum), sum);

// prompts
const members = [{ name: 'Lead', role: 'lead' }, { name: 'Coder', role: 'coder' }, { name: 'Reviewer', role: 'reviewer' }];
check('system prompt names the member, team and rules', /"Coder", the coder/.test(T.memberSystem(members[1], members, 'do x')) && /finish_work/.test(T.memberSystem(members[1], members, 'do x')));
check('plan prompt lists owners but not the lead', /Coder \(coder\), Reviewer \(reviewer\)/.test(T.planPrompt('do x', members)) && !/owner from:.*Lead/.test(T.planPrompt('do x', members)));
const rp = T.roundPrompt(2, 4, b, members[2], [{ from: 'Coder', to: 'Reviewer', text: 'ready' }], (p) => p);
check('round prompt has round, messages and open tasks', /Round 2 of at most 4/.test(rp) && /from Coder: ready/.test(rp) && /Your open tasks: t2/.test(rp), rp);
check('fallback summary counts done tasks', /1 of 2 tasks done/.test(T.fallbackSummary('x', b, (p) => p)));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
