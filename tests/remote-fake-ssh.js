// Fake "ssh" for tests. Records its arguments and plays the part of an sshd whose login shell is Git's sh.
// Host names choose behaviour: unreachable.test, denied.test, hostkey.test, hostchanged.test, anything else = works.
// Env: FAKE_REMOTE_HOME (the remote user's home dir), FAKE_SSH_LOG, FAKE_SSH_PIDFILE, FAKE_OLLAMA_PORT, FAKE_SH.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const opts = [], flags = [];
let dest = null, command = null, L = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (dest === null) {
    if (a === '--') { dest = argv[++i]; command = argv.slice(i + 1).join(' ') || null; break; }
    if (['-o', '-i', '-p', '-L'].includes(a)) { const v = argv[++i]; opts.push([a, v]); if (a === '-L') L = v; } else flags.push(a);
  }
}
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ argv, dest, command, opts, flags }) + '\n');
if (process.env.FAKE_SSH_PIDFILE) fs.writeFileSync(process.env.FAKE_SSH_PIDFILE, String(process.pid));

const host = String(dest || '').split('@')[1] || '';
const die = (msg, code = 255) => { process.stderr.write(msg + '\n'); process.exit(code); };
if (host === 'unreachable.test') die(`ssh: connect to host ${host} port 22: Connection timed out`);
if (host === 'denied.test') die(`${dest}: Permission denied (publickey).`);
if (host === 'hostkey.test') die('Host key verification failed.');
if (host === 'hostchanged.test') die('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.');
if (process.env.FAKE_HOSTKEY_STRICT && !opts.some(([k, v]) => k === '-o' && v === 'StrictHostKeyChecking=accept-new') && host === 'newhost.test') die('Host key verification failed.');

if (flags.includes('-N')) {   // port forward
  const [lh, lp, , rp] = (L || '').split(':');
  const srv = net.createServer((c) => {
    const u = net.connect(Number(process.env.FAKE_OLLAMA_PORT), '127.0.0.1');
    c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
  });
  srv.listen(Number(lp), lh, () => {});
  setInterval(() => {}, 1000);
  return;
}

const tty = flags.includes('-tt');
const sh = process.env.FAKE_SH || 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';
const usr = path.dirname(sh);
const child = spawn(sh, ['-c', command || 'true'], {
  cwd: process.env.FAKE_REMOTE_HOME, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HOME: process.env.FAKE_REMOTE_HOME, SHELL: sh, PATH: usr + path.delimiter + process.env.PATH, MSYS: 'winsymlinks:nativestrict' },
});
const conv = (b) => (tty ? Buffer.from(b.toString('latin1').replace(/\n/g, '\r\n'), 'latin1') : b);
child.stdout.on('data', (d) => process.stdout.write(conv(d)));
child.stderr.on('data', (d) => process.stdout.write(conv(d)));   // a pty merges stderr into stdout
if (!tty) child.stderr.removeAllListeners('data'), child.stderr.on('data', (d) => process.stderr.write(d));
const killTree = () => { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
process.stdin.on('data', (d) => {
  if (tty && d.includes(0x03)) { if (process.env.FAKE_IGNORE_CTRLC !== '1') { killTree(); setTimeout(() => process.exit(130), 50); } return; }
  try { child.stdin.write(d); } catch { /* closed */ }
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* closed */ } });
child.stdin.on('error', () => {});
child.on('close', (code) => process.exit(code === null ? 255 : code));
process.on('SIGTERM', () => { killTree(); process.exit(143); });
process.on('exit', killTree);
