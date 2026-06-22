const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

const USER_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const SYSTEM_AGENTS_DIR = '/Library/LaunchAgents';

// ---------- Login items (System Events) ----------
async function readLoginItems() {
  const out = [];
  try {
    const { stdout } = await execFileP(
      'osascript',
      ['-e', 'tell application "System Events" to get the name of every login item'],
      { timeout: 8000, maxBuffer: 1 << 20 }
    );
    const names = stdout.trim();
    if (!names) return out;
    // osascript returns a comma+space separated list on one line.
    const list = names.split(',').map(s => s.trim()).filter(Boolean);
    // Best-effort hidden state — query in one shot, fall back to false.
    let hiddenList = [];
    try {
      const { stdout: hs } = await execFileP(
        'osascript',
        ['-e', 'tell application "System Events" to get the hidden of every login item'],
        { timeout: 8000, maxBuffer: 1 << 20 }
      );
      hiddenList = hs.trim().split(',').map(s => /true/i.test(s.trim()));
    } catch { hiddenList = []; }
    list.forEach((name, i) => out.push({ name, hidden: hiddenList[i] === true }));
  } catch {
    return [];
  }
  return out.slice(0, 60);
}

// ---------- Launch agents (~/Library + /Library) ----------
async function readPlistMeta(plistPathNoExt) {
  // plistPathNoExt is the path WITHOUT the trailing .plist (what `defaults` wants).
  const meta = { label: '', program: '' };
  try {
    const { stdout } = await execFileP('defaults', ['read', plistPathNoExt, 'Label'], { timeout: 4000, maxBuffer: 1 << 18 });
    meta.label = stdout.trim();
  } catch { /* leave blank */ }
  // Program may live under "Program" or the first element of "ProgramArguments".
  try {
    const { stdout } = await execFileP('defaults', ['read', plistPathNoExt, 'Program'], { timeout: 4000, maxBuffer: 1 << 18 });
    meta.program = stdout.trim();
  } catch { /* try ProgramArguments below */ }
  if (!meta.program) {
    try {
      const { stdout } = await execFileP('defaults', ['read', plistPathNoExt, 'ProgramArguments'], { timeout: 4000, maxBuffer: 1 << 18 });
      // `defaults` prints an array as:  (\n    "first/arg",\n    "next",\n)
      // Grab the first element after the opening paren (quoted or bare).
      const first = stdout
        .replace(/^\s*\(\s*/, '')           // drop opening "(\n"
        .split('\n')[0]                     // first element line
        .replace(/^\s*"?/, '')              // leading quote/space
        .replace(/"?\s*,?\s*$/, '')         // trailing quote/comma
        .trim();
      if (first && first !== '(' && first !== ')') meta.program = first;
    } catch { /* leave blank */ }
  }
  return meta;
}

async function readAgentsFromDir(dir, scope) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const name = e.name;
    const isPlist = name.endsWith('.plist');
    const isDisabled = name.endsWith('.plist.disabled');
    if (!isPlist && !isDisabled) continue;
    const full = path.join(dir, name);
    // strip a single trailing extension for `defaults read`
    const noExt = isDisabled ? full.replace(/\.plist\.disabled$/, '.plist').replace(/\.plist$/, '')
                             : full.replace(/\.plist$/, '');
    const meta = await readPlistMeta(noExt);
    out.push({
      name,
      path: full,
      label: meta.label || '',
      program: meta.program || '',
      disabled: isDisabled,
      scope,
    });
  }
  return out;
}

async function readLaunchAgents() {
  const [user, system] = await Promise.all([
    readAgentsFromDir(USER_AGENTS_DIR, 'user'),
    readAgentsFromDir(SYSTEM_AGENTS_DIR, 'system'),
  ]);
  return [...user, ...system].slice(0, 120);
}

// ---------- Heavy apps (ps) ----------
function appNameFromCommand(cmd) {
  const m = cmd.match(/\/([^\/]+)\.app\/Contents\/MacOS\//);
  if (m) return m[1];
  const first = cmd.trim().split(/\s+/)[0] || cmd;
  return first.split('/').pop() || cmd;
}

async function readHeavyApps() {
  try {
    const { stdout } = await execFileP(
      'ps',
      ['-axwwo', 'pid=,pcpu=,rss=,comm=,command='],
      { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }
    );
    const rows = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      // pid pcpu rss comm command...  — comm is a single token, command is the rest
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cpu = Number(m[2]);
      const memBytes = Number(m[3]) * 1024; // rss is in KB
      const command = m[5];
      if (pid <= 1) continue;
      const isApp = /\.app\/Contents\/MacOS\//.test(command);
      rows.push({
        pid,
        cpu,
        memBytes,
        command,
        isApp,
        name: isApp ? appNameFromCommand(command) : appNameFromCommand(m[4] || command),
      });
    }
    // Rank by combined cpu + memory pressure, preferring GUI .app bundles.
    const memTotal = os.totalmem() || 1;
    const score = (p) => p.cpu + (p.memBytes / memTotal) * 100 + (p.isApp ? 20 : 0);
    rows.sort((a, b) => score(b) - score(a));
    return rows.slice(0, 12).map(({ isApp, ...rest }) => rest);
  } catch {
    return [];
  }
}

// ---------- Memory ----------
function readMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    used,
    free,
    usedPct: total ? (used / total) * 100 : 0,
  };
}

// ---------- scan ----------
async function scan() {
  const [loginItems, launchAgents, heavyApps] = await Promise.all([
    readLoginItems().catch(() => []),
    readLaunchAgents().catch(() => []),
    readHeavyApps().catch(() => []),
  ]);
  return {
    loginItems,
    launchAgents,
    heavyApps,
    memory: readMemory(),
  };
}

// ---------- setLoginItem (disable/remove only) ----------
async function setLoginItem(name, enabled) {
  if (enabled === true) {
    return { ok: false, error: 'Re-enabling must be done from the app itself' };
  }
  if (!name) return { ok: false, error: 'Missing login item name' };
  // `name` is interpolated inside the AppleScript string literal's double
  // quotes. execFile removes the shell, but a `"` or `\` could still break out
  // of the AppleScript string — reject those rather than try to escape them.
  if (/["\\]/.test(name)) {
    return { ok: false, error: 'Unsupported login item name' };
  }
  try {
    await execFileP(
      'osascript',
      ['-e', `tell application "System Events" to delete login item "${name}"`],
      { timeout: 8000, maxBuffer: 1 << 18 }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- toggleLaunchAgent (user scope only) ----------
async function toggleLaunchAgent(plistPath, disable) {
  if (!plistPath) return { ok: false, error: 'Missing plist path' };
  const resolved = path.resolve(plistPath);
  const dir = path.dirname(resolved) + path.sep;
  // Only operate within the user's ~/Library/LaunchAgents — system agents need admin.
  if (!resolved.startsWith(USER_AGENTS_DIR + path.sep)) {
    return { ok: false, error: 'Requires admin — open in Finder instead' };
  }
  // guard against path-traversal escaping the user dir
  if (!dir.startsWith(USER_AGENTS_DIR + path.sep)) {
    return { ok: false, error: 'Requires admin — open in Finder instead' };
  }
  try {
    if (disable) {
      if (!resolved.endsWith('.plist')) {
        return { ok: false, error: 'Already disabled' };
      }
      const target = resolved + '.disabled';
      await fsp.rename(resolved, target);
      // launchctl unload may legitimately fail (not loaded) — ignore.
      try {
        await execFileP('launchctl', ['unload', resolved], { timeout: 6000 });
      } catch { /* ignore unload errors */ }
      return { ok: true };
    } else {
      if (!resolved.endsWith('.plist.disabled')) {
        return { ok: false, error: 'Already enabled' };
      }
      const target = resolved.replace(/\.disabled$/, '');
      await fsp.rename(resolved, target);
      try {
        await execFileP('launchctl', ['load', target], { timeout: 6000 });
      } catch { /* load may warn but the file is enabled */ }
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- freeMemory (purge) ----------
async function freeMemory() {
  const before = os.freemem();
  try {
    await execFileP('/usr/sbin/purge', [], { timeout: 30000, maxBuffer: 1 << 18 });
    const after = os.freemem();
    return { ok: true, before, after };
  } catch (e) {
    // purge typically requires root on modern macOS.
    return { ok: false, needsSudo: true, error: 'Run `sudo purge` in Terminal for a deep flush' };
  }
}

module.exports = { scan, setLoginItem, toggleLaunchAgent, freeMemory };
