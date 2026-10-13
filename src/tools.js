// Tools the model can call + the shared shell runner (also used by the terminal drawer).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUT = 20000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build']);

const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s);

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

function runShell(command, cwd, onData, timeoutMs = 120000) {
  const win = process.platform === 'win32';
  const child = spawn(
    win ? 'powershell.exe' : 'bash',
    win ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command],
    { cwd, windowsHide: true },
  );
  child.stdin.end();
  let out = '';
  const push = (d) => { const s = d.toString(); out += s; if (onData) onData(s); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => { push('\n[timed out]\n'); killTree(child); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: out + String(e) }); });
  });
  return { promise, kill: () => killTree(child) };
}

// Resolve a model-supplied path. With sandbox on, it must stay inside the workspace.
function resolvePath(ctx, p) {
  const abs = path.resolve(ctx.workspace, String(p || '.'));
  if (ctx.sandbox) {
    const rel = path.relative(ctx.workspace, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path is outside the workspace (${ctx.workspace}). Open a different folder to work there.`);
    }
  }
  return abs;
}

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && visit(path.join(dir, e.name), true) !== false) walk(path.join(dir, e.name), visit);
    } else if (visit(path.join(dir, e.name), false) === false) return;
  }
}

const schemas = [
  fn('read_file', 'Read a text file. Returns numbered lines.', {
    path: str('File path'), offset: num('1-based start line (optional)'), limit: num('Max lines (optional)'),
  }, ['path']),
  fn('write_file', 'Create or overwrite a file with the given content.', {
    path: str('File path'), content: str('Full file content'),
  }, ['path', 'content']),
  fn('edit_file', 'Replace one exact occurrence of old_string with new_string in a file. old_string must be unique.', {
    path: str('File path'), old_string: str('Exact text to find'), new_string: str('Replacement text'),
  }, ['path', 'old_string', 'new_string']),
  fn('list_dir', 'List files and folders in a directory.', { path: str('Directory (default: workspace root)') }, []),
  fn('search_files', 'Regex search over file contents, recursively.', {
    pattern: str('JavaScript regex'), path: str('Directory (default: workspace root)'),
  }, ['pattern']),
  fn('run_command', 'Run a shell command (PowerShell on Windows, bash elsewhere).', {
    command: str('Command to run'), cwd: str('Working directory (optional, default: workspace)'),
    timeout_sec: num('Timeout in seconds (default 120)'),
  }, ['command']),
];
function str(description) { return { type: 'string', description }; }
function num(description) { return { type: 'number', description }; }
function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const impl = {
  async read_file(a, ctx) {
    const lines = fs.readFileSync(resolvePath(ctx, a.path), 'utf8').split('\n');
    const start = Math.max(1, Number(a.offset) || 1);
    const end = Math.min(lines.length, start - 1 + (Number(a.limit) || 2000));
    return clip(lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n')) || '(empty file)';
  },

  async write_file(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    const exists = fs.existsSync(abs);
    const preview = String(a.content).split('\n').slice(0, 30).join('\n');
    if (!(await ctx.approve('edit', `${exists ? 'Overwrite' : 'Create'} ${abs}`, preview))) throw new Error('User denied this action.');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, a.content);
    if (ctx.changed) ctx.changed(abs);
    return `${exists ? 'Overwrote' : 'Created'} ${abs} (${a.content.length} chars)`;
  },

  async edit_file(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    const text = fs.readFileSync(abs, 'utf8');
    const count = text.split(a.old_string).length - 1;
    if (count === 0) throw new Error('old_string not found. Re-read the file and match it exactly.');
    if (count > 1) throw new Error(`old_string matches ${count} places. Include more surrounding context.`);
    const diff = a.old_string.split('\n').map((l) => `- ${l}`).concat(a.new_string.split('\n').map((l) => `+ ${l}`)).join('\n');
    if (!(await ctx.approve('edit', `Edit ${abs}`, diff))) throw new Error('User denied this action.');
    fs.writeFileSync(abs, text.replace(a.old_string, () => a.new_string));
    if (ctx.changed) ctx.changed(abs);
    return `Edited ${abs}`;
  },

  async list_dir(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    return fs.readdirSync(abs, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') || '(empty)';
  },

  async search_files(a, ctx) {
    const re = new RegExp(a.pattern);
    const hits = [];
    walk(resolvePath(ctx, a.path), (p, isDir) => {
      if (isDir) return true;
      try {
        if (fs.statSync(p).size > 1_000_000) return true;
        fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
          if (hits.length < 100 && re.test(l)) hits.push(`${path.relative(ctx.workspace, p)}:${i + 1}: ${l.trim().slice(0, 200)}`);
        });
      } catch { /* binary or unreadable */ }
      return hits.length < 100;
    });
    return hits.join('\n') || 'No matches.';
  },

  async run_command(a, ctx) {
    const cwd = a.cwd ? resolvePath(ctx, a.cwd) : ctx.workspace;
    if (ctx.mode !== 'auto' && !(await ctx.approve('command', `Run command in ${cwd}`, a.command))) throw new Error('User denied this action.');
    const job = runShell(a.command, cwd, ctx.onOutput, (Number(a.timeout_sec) || 120) * 1000);
    ctx.setKill(job.kill);
    const { code, output } = await job.promise;
    return clip(`${output}\n[exit code ${code}]`);
  },
};

async function execute(name, args, ctx) {
  if (!impl[name]) throw new Error(`Unknown tool: ${name}`);
  if (typeof args === 'string') args = JSON.parse(args);
  return impl[name](args || {}, ctx);
}

// Lets features add AI tools. schema = fn(...) result; impl = async (args, ctx) => string.
function registerTool(schema, toolImpl) {
  schemas.push(schema);
  impl[schema.function.name] = toolImpl;
}

module.exports = { schemas, execute, runShell, killTree, registerTool, helpers: { fn, str, num } };
