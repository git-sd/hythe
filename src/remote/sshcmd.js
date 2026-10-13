// Pure helpers for SSH: validation, safe quoting, argument/command builders, error classification.
// No process is started here, so it is easy to unit test.
'use strict';
const path = require('path');

const STAMP = '.faber-sync-stamp';
const DEFAULT_EXCLUDE_DIRS = ['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.next', '.cache', '.idea', '.faber-backup'];
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|pfx|p12|ppk)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;

// POSIX single-quote: safe for any string.
const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// '~' and '~/x' keep working (tilde is expanded outside the quotes).
function remotePath(p) {
  p = String(p);
  if (p === '~') return '~';
  if (p.startsWith('~/')) return '~/' + quote(p.slice(2));
  return quote(p);
}

const toShell = (script) => 'sh -c ' + quote(script);

// Run the user's command in the remote login shell, in the project directory.
function runCommand(remoteDir, userCmd) {
  return toShell(`cd ${remotePath(remoteDir)} && exec "\${SHELL:-sh}" -c ${quote(userCmd)}`);
}
const syncCommand = (remoteDir) => toShell(`mkdir -p ${remotePath(remoteDir)} && cd ${remotePath(remoteDir)} && tar -xmf - && touch ${STAMP}`);
// For fetching results we keep out/dist/build (that is where results usually land) and skip only VCS and caches.
const FETCH_EXCLUDE_DIRS = DEFAULT_EXCLUDE_DIRS.filter((d) => !['dist', 'build', 'out'].includes(d));
function listChangedCommand(remoteDir, dirs = FETCH_EXCLUDE_DIRS) {
  const prune = dirs.map((d) => `-name ${quote(d)}`).join(' -o ');
  return toShell(`cd ${remotePath(remoteDir)} && test -f ${STAMP} || { echo NOSTAMP >&2; exit 3; }; find . \\( ${prune} \\) -prune -o -type f -newer ${STAMP} ! -name ${STAMP} -exec wc -c {} +`);
}
const fetchCommand = (remoteDir) => toShell(`cd ${remotePath(remoteDir)} && tar -cf - -T -`);

function validateProfile(p) {
  const o = {
    id: p.id, name: String(p.name || '').trim(), user: String(p.user || '').trim(), host: String(p.host || '').trim(),
    port: p.port === '' || p.port == null ? 22 : Number(p.port), keyFile: String(p.keyFile || '').trim(),
    remoteDir: String(p.remoteDir || '').trim(), acceptNew: !!p.acceptNew,
    maxFileMB: Number(p.maxFileMB) > 0 ? Number(p.maxFileMB) : 25, maxTotalMB: Number(p.maxTotalMB) > 0 ? Number(p.maxTotalMB) : 200,
  };
  if (!o.name || o.name.length > 60 || /[\x00-\x1f]/.test(o.name)) throw new Error('Give the profile a short name.');
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(o.user)) throw new Error('User name: letters, digits, dot, underscore and dash only.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/.test(o.host)) throw new Error('Host: a name or IP address (letters, digits, dot, colon, dash).');
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('Port must be 1 to 65535.');
  if (o.keyFile && (/[\x00-\x1f"]/.test(o.keyFile) || o.keyFile.startsWith('-'))) throw new Error('The key file path contains characters that are not allowed.');
  if (/[\x00-\x1f]/.test(o.remoteDir)) throw new Error('The remote directory contains control characters.');
  if (o.remoteDir && !/^(~|\/|~\/)/.test(o.remoteDir)) throw new Error('The remote directory must start with / or ~/ (example: ~/faber-work/myproject).');
  return o;
}

const safeDirName = (s) => String(s).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|_+$/g, '').slice(0, 60) || 'project';
const remoteDirFor = (profile, localFolder) => profile.remoteDir || '~/faber-work/' + safeDirName(path.basename(localFolder || 'project'));

// Arguments for ssh. Key auth only: BatchMode never asks for a password. Host keys are checked normally
// unless the user ticked "accept-new" (which still refuses CHANGED keys).
function sshArgs(p, { tty = 'no', connectTimeout = 8, extra = [], interactive = false } = {}) {
  const a = [];
  if (!interactive) a.push('-o', 'BatchMode=yes');
  else a.push('-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no');
  a.push('-o', `ConnectTimeout=${connectTimeout}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4');
  if (p.acceptNew) a.push('-o', 'StrictHostKeyChecking=accept-new');
  if (p.keyFile) a.push('-i', p.keyFile, '-o', 'IdentitiesOnly=yes');
  if (p.port && Number(p.port) !== 22) a.push('-p', String(p.port));
  a.push(tty === 'force' ? '-tt' : tty === 'yes' ? '-t' : '-T');
  a.push(...extra, '--', `${p.user}@${p.host}`);
  return a;
}
const forwardArgs = (p, localPort, remotePort) => sshArgs(p, { tty: 'no', extra: ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`] });

// PowerShell single-quoted literal.
const psQuote = (s) => (/^[A-Za-z0-9_.:\\/@=,+-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "''") + "'");
// The line typed into the Faber terminal (PowerShell). Interactive: you can type a key passphrase there.
function terminalLine(p, localFolderDir, bin = 'ssh') {
  const a = ['-t', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ServerAliveInterval=30'];
  if (p.acceptNew) a.push('-o', 'StrictHostKeyChecking=accept-new');
  if (p.keyFile) a.push('-i', p.keyFile, '-o', 'IdentitiesOnly=yes');
  if (p.port && Number(p.port) !== 22) a.push('-p', String(p.port));
  a.push('--', `${p.user}@${p.host}`);
  const dir = p.remoteDir || (localFolderDir ? remoteDirFor(p, localFolderDir) : '');
  if (dir) a.push(`cd ${remotePath(dir)} 2>/dev/null; exec $SHELL -l`);
  return [bin, ...a].map(psQuote).join(' ');
}

// Turn ssh's stderr into something a person can act on.
function classifyError(stderr, code) {
  const s = String(stderr || '');
  const has = (re) => re.test(s);
  if (has(/REMOTE HOST IDENTIFICATION HAS CHANGED/i)) return { kind: 'hostkey-changed', message: 'The server\'s host key CHANGED since you last connected. This can mean the server was reinstalled, or that someone is intercepting the connection. Faber will not connect. If you are sure it is the same server, remove the old key with: ssh-keygen -R <host>' };
  if (has(/Host key verification failed|No .* host key is known|authenticity of host/i)) return { kind: 'hostkey', message: 'This server\'s host key is not trusted yet. Click "Open SSH terminal" once and answer yes to the fingerprint question (check it against the server first), or tick "Trust new host keys automatically" on the profile (it still refuses a key that changes later).' };
  if (has(/Permission denied/i)) return { kind: 'auth', message: 'The server rejected the key (Permission denied, publickey). Check the user name and key file. If the key has a passphrase, load it into the ssh-agent first (ssh-add), because Faber never asks for passwords. Password login is not supported.' };
  if (has(/UNPROTECTED PRIVATE KEY|bad permissions|Permissions .* too open/i)) return { kind: 'keyperm', message: 'Windows says the key file is readable by other users. Remove other users from its permissions (Properties > Security, or icacls).' };
  if (has(/no such identity|Identity file .* not accessible|Load key .*: (No such file|invalid format)/i)) return { kind: 'key', message: 'The key file was not found or is not a valid private key.' };
  if (has(/Could not resolve hostname|Name or service not known|No such host/i)) return { kind: 'dns', message: 'The host name cannot be found. Check the spelling or use the IP address.' };
  if (has(/Connection timed out|Operation timed out|timed out/i)) return { kind: 'timeout', message: 'Connection timed out. The host is offline, the port is blocked, or the address is wrong.' };
  if (has(/Connection refused/i)) return { kind: 'refused', message: 'Connection refused. No SSH server is listening on that host and port.' };
  if (has(/No route to host|Network is unreachable/i)) return { kind: 'network', message: 'No route to the host. Check your network or VPN.' };
  if (has(/Connection closed by|kex_exchange_identification|Connection reset|banner exchange/i)) return { kind: 'closed', message: 'The server closed the connection during login (wrong port, a firewall, or too many attempts).' };
  if (has(/command not found|tar: .*not found/i)) return { kind: 'remote', message: 'The server is missing a required program (tar). ' + s.trim().split('\n').pop() };
  return { kind: 'other', message: (s.trim().split('\n').slice(-3).join(' ') || `ssh exited with code ${code}`) };
}

module.exports = {
  STAMP, DEFAULT_EXCLUDE_DIRS, SECRET_NAME, quote, remotePath, toShell, runCommand, syncCommand, listChangedCommand, fetchCommand,
  validateProfile, safeDirName, remoteDirFor, sshArgs, forwardArgs, psQuote, terminalLine, classifyError,
};
