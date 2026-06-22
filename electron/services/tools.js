// Detect & help uninstall "apps" that are NOT .app bundles — CLI tools and
// background agents installed in hidden home folders (e.g. ~/.hermes) or wired
// up via LaunchAgents (e.g. ~/.mlx-venv). The App Manager only sees .app
// bundles; this fills the gap. Nothing is deleted here — the main process moves
// the collected paths to the Trash after a confirmation dialog.
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// Hidden home dirs that are config / cache / credentials / runtimes — NEVER
// offered for uninstall (removing them loses settings or breaks toolchains).
const SKIP = new Set([
  '.Trash', '.Trashes', '.cache', '.config', '.local', '.ssh', '.gnupg', '.gpg',
  '.aws', '.kube', '.docker', '.npm', '.yarn', '.pnpm', '.nvm', '.rbenv', '.pyenv',
  '.cargo', '.rustup', '.gradle', '.m2', '.gem', '.bundle', '.cocoapods', '.android',
  '.dotnet', '.net', '.nuget', '.aspnet', '.dart-tool', '.dartServer', '.expo',
  '.vscode', '.vscode-insiders', '.vim', '.oh-my-zsh', '.zsh_sessions',
  '.bash_sessions', '.CFUserTextEncoding', '.DS_Store', '.mcp-auth', '.Trash',
]);

const AGENT_DIRS = [
  { dir: path.join(HOME, 'Library', 'LaunchAgents'), scope: 'user' },
  { dir: '/Library/LaunchAgents', scope: 'system' },
  { dir: '/Library/LaunchDaemons', scope: 'system' },
];

async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1 << 20, timeout: 8000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}

// Parse a launchd plist → { label, program, args }.
async function readAgent(p) {
  try {
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', p], { maxBuffer: 1 << 20, timeout: 4000 });
    const j = JSON.parse(stdout);
    let program = j.Program || '';
    let args = [];
    if (Array.isArray(j.ProgramArguments)) { args = j.ProgramArguments; if (!program) program = j.ProgramArguments[0] || ''; }
    return { label: j.Label || '', program, args };
  } catch { return { label: '', program: '', args: [] }; }
}

// The hidden home dir a program lives in, e.g.
// /Users/x/.hermes/agent/venv/bin/python → { root:/Users/x/.hermes, seg:.hermes }
function homeToolRoot(program) {
  if (!program || !program.startsWith(HOME + path.sep)) return null;
  const seg = program.slice(HOME.length + 1).split(path.sep)[0];
  if (!seg || !seg.startsWith('.')) return null; // only hidden-dir installs
  return { root: path.join(HOME, seg), seg };
}

// Running pids whose command line references a string (e.g. the tool dir).
async function pidsFor(match) {
  try {
    const { stdout } = await execFileP('pgrep', ['-fl', match], { timeout: 3000, maxBuffer: 1 << 20 });
    return stdout.split('\n').filter(Boolean)
      .map(l => Number(l.trim().split(/\s+/)[0]))
      .filter(n => Number.isFinite(n) && n !== process.pid);
  } catch { return []; }
}

// Does a hidden dir look like an installed tool (vs plain config/data)?
async function looksLikeTool(root) {
  try {
    const names = await fsp.readdir(root);
    const set = new Set(names.map(n => n.toLowerCase()));
    if (set.has('bin') || set.has('venv') || set.has('.venv') || set.has('node_modules')
      || set.has('.install_method') || set.has('install.sh') || set.has('cli')
      || set.has('pyvenv.cfg')) return true;
    if (names.some(n => /-(agent|cli|server|daemon)$/i.test(n))) return true;
  } catch { return false; }
  return false;
}

async function firstLine(p) {
  try { const t = await fsp.readFile(p, 'utf8'); return t.split('\n')[0].trim().slice(0, 40); } catch { return ''; }
}

async function list() {
  const tools = new Map(); // root path → tool

  // 1) Background agents whose program points into a hidden home dir.
  for (const { dir } of AGENT_DIRS) {
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.plist') && !n.endsWith('.disabled')) continue;
      const ap = path.join(dir, n);
      const { label, program } = await readAgent(ap);
      const tr = homeToolRoot(program);
      if (!tr || SKIP.has(tr.seg)) continue;
      let t = tools.get(tr.root);
      if (!t) { t = { id: tr.root, name: tr.seg.replace(/^\./, ''), path: tr.root, kind: 'agent', agents: [], pids: [], sizeBytes: 0 }; tools.set(tr.root, t); }
      t.agents.push({ path: ap, label: label || n, disabled: n.endsWith('.disabled') });
    }
  }

  // 2) Hidden-folder tools in HOME (with or without an agent).
  let entries;
  try { entries = await fsp.readdir(HOME, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const root = path.join(HOME, e.name);
    if (tools.has(root)) continue;                 // already found via an agent
    if (!(await looksLikeTool(root))) continue;
    tools.set(root, { id: root, name: e.name.replace(/^\./, ''), path: root, kind: 'cli', agents: [], pids: [], sizeBytes: 0 });
  }

  // 3) Enrich (size, running pids, install method, what to trash).
  const out = Array.from(tools.values());
  for (const t of out) {
    t.sizeBytes = await pathSize(t.path);
    t.pids = await pidsFor(t.path);
    t.installMethod = await firstLine(path.join(t.path, '.install_method'));
    t.trashPaths = [t.path, ...t.agents.map(a => a.path)];
    t.note = t.kind === 'agent'
      ? `Background agent · ${t.agents.length} login item${t.agents.length === 1 ? '' : 's'}`
      : 'CLI / hidden-folder tool';
  }
  out.sort((a, b) => (b.agents.length - a.agents.length) || (b.sizeBytes - a.sizeBytes));
  return out.slice(0, 80);
}

// Stop a tool before its files are trashed: unload its launch agents and
// terminate running processes so nothing recreates the folder.
async function stop(pids = [], agentPaths = []) {
  // Validate inputs: only signal real (>1) pids and only unload plausible plists.
  pids = (Array.isArray(pids) ? pids : []).filter(p => Number.isInteger(p) && p > 1);
  agentPaths = (Array.isArray(agentPaths) ? agentPaths : []).filter(p => typeof p === 'string' && /\.(plist|disabled)$/.test(p));
  for (const p of agentPaths) {
    await execFileP('launchctl', ['unload', p], { timeout: 4000 }).catch(() => {});
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  // Escalate any survivors shortly after.
  if (pids.length) {
    setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} } }, 1500);
  }
  return { ok: true };
}

module.exports = { list, stop };
