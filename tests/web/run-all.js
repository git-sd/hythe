// Runs every browser-harness test and unit test, one process each (the harness can only launch once per process).
//   NODE_PATH=$(npm root -g) node tests/web/run-all.js
const { spawnSync } = require('child_process');
const path = require('path');
const list = [
  'tests/claude-unit.js', 'tests/team-unit.js', 'tests/resources-unit.js',
  'tests/web/boot-smoke.js', 'tests/web/features-smoke.js', 'tests/web/editor-regress.js', 'tests/web/layout-regress.js',
  'tests/web/dock-gui.js', 'tests/web/panes-gui.js', 'tests/web/team-main.js', 'tests/web/team-gui.js',
  'tests/web/claude-gui.js', 'tests/web/resources-gui.js',
];
let bad = 0;
for (const f of list) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', f)], { encoding: 'utf8', timeout: 240000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const sum = (out.match(/(\d+)\/(\d+) passed/) || [])[0] || 'no result';
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${f}  ${sum}`);
  for (const l of fails) console.log('       ' + l.slice(0, 200));
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad} file(s) failed` : '\nall passed');
process.exit(bad ? 1 : 0);
