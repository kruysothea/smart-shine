const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// Directories we scan for *.app bundles. 'system' = shared installs,
// 'user' = the per-user ~/Applications folder.
const APP_DIRS = [
  { dir: '/Applications', source: 'system' },
  { dir: '/Applications/Utilities', source: 'system' },
  { dir: path.join(HOME, 'Applications'), source: 'user' },
];

// Where macOS apps leave support files behind after the bundle is removed.
// kind = the parent Library subfolder name shown in the UI.
const LEFTOVER_DIRS = [
  { dir: path.join(HOME, 'Library', 'Application Support'), kind: 'Application Support' },
  { dir: path.join(HOME, 'Library', 'Caches'), kind: 'Caches' },
  { dir: path.join(HOME, 'Library', 'Preferences'), kind: 'Preferences' },
  { dir: path.join(HOME, 'Library', 'Logs'), kind: 'Logs' },
  { dir: path.join(HOME, 'Library', 'Containers'), kind: 'Containers' },
  { dir: path.join(HOME, 'Library', 'Saved Application State'), kind: 'Saved Application State' },
  { dir: path.join(HOME, 'Library', 'HTTPStorages'), kind: 'HTTPStorages' },
  { dir: path.join(HOME, 'Library', 'LaunchAgents'), kind: 'LaunchAgents' },
  { dir: path.join(HOME, 'Library', 'WebKit'), kind: 'WebKit' },
  { dir: path.join(HOME, 'Library', 'Group Containers'), kind: 'Group Containers' },
];

const MAX_APPS = 300;
const MAX_LEFTOVERS = 60;

// du -sk → bytes. Returns 0 on any failure (contract helper).
async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1024 * 1024, timeout: 8000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}

// Read a single Info.plist key via `defaults read`. Falls back to '' on error.
async function plistValue(appPath, key) {
  try {
    const infoBase = path.join(appPath, 'Contents', 'Info');
    const { stdout } = await execFileP('defaults', ['read', infoBase, key], { maxBuffer: 1 << 20, timeout: 5000 });
    const v = stdout.trim();
    return v || '';
  } catch { return ''; }
}

// kMDItemLastUsedDate via mdls → ms epoch. 0 when null/unavailable.
async function lastUsedMs(appPath) {
  try {
    const { stdout } = await execFileP('mdls', ['-raw', '-name', 'kMDItemLastUsedDate', appPath], { maxBuffer: 1 << 16, timeout: 5000 });
    const raw = stdout.trim();
    if (!raw || raw === '(null)' || raw === 'null') return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  } catch { return 0; }
}

// Run jobs with a concurrency cap so 50+ apps are inspected in parallel
// batches instead of one slow `du`/`mdls` chain at a time.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Build the descriptor for one .app bundle. Never throws.
async function inspectApp(appPath, source) {
  const base = path.basename(appPath).replace(/\.app$/i, '');
  const [sizeBytes, version, bundleId, lastUsedTs] = await Promise.all([
    pathSize(appPath),
    plistValue(appPath, 'CFBundleShortVersionString'),
    plistValue(appPath, 'CFBundleIdentifier'),
    lastUsedMs(appPath),
  ]);
  return {
    name: base,
    path: appPath,
    sizeBytes,
    version,
    bundleId,
    lastUsedTs,
    source,
  };
}

// Scan all known app dirs, return descriptors sorted by size desc, capped.
async function list() {
  // 1) Collect all .app bundle paths first (cheap readdir only).
  const targets = [];
  const seen = new Set();
  for (const { dir, source } of APP_DIRS) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.toLowerCase().endsWith('.app')) continue;
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;
      seen.add(full);
      targets.push({ full, source });
      if (targets.length >= MAX_APPS) break;
    }
    if (targets.length >= MAX_APPS) break;
  }

  // 2) Inspect them in parallel batches — the slow part (du/mdls/defaults).
  let apps = [];
  try {
    apps = (await mapPool(targets, 12, ({ full, source }) =>
      inspectApp(full, source).catch(() => null)
    )).filter(Boolean);
  } catch (e) {
    apps.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { apps: apps.slice(0, MAX_APPS), error: e.message };
  }
  apps.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return apps.slice(0, MAX_APPS);
}

// Find support files left behind by the app at appPath. Heuristic, never throws.
async function leftovers(appPath) {
  const results = [];
  try {
    const base = path.basename(appPath).replace(/\.app$/i, '');
    const bundleId = await plistValue(appPath, 'CFBundleIdentifier');
    const idTail = bundleId ? bundleId.split('.').pop() : '';

    // Lower-cased match needles, deduped, length>=4 to avoid false positives.
    const needles = [];
    const pushNeedle = (s) => {
      if (!s) return;
      const v = String(s).toLowerCase();
      if (v.length >= 4 && !needles.includes(v)) needles.push(v);
    };
    pushNeedle(bundleId);
    pushNeedle(idTail);
    pushNeedle(base);
    if (needles.length === 0) return [];

    const appPathNorm = path.resolve(appPath);

    for (const { dir, kind } of LEFTOVER_DIRS) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const lname = e.name.toLowerCase();
        const matched = needles.some((n) => lname.includes(n));
        if (!matched) continue;
        const full = path.join(dir, e.name);
        // Never include the app bundle itself.
        if (path.resolve(full) === appPathNorm) continue;
        const size = await pathSize(full);
        results.push({ path: full, size, kind });
        if (results.length >= MAX_LEFTOVERS * 2) break;
      }
      if (results.length >= MAX_LEFTOVERS * 2) break;
    }
  } catch {
    return results.sort((a, b) => b.size - a.size).slice(0, MAX_LEFTOVERS);
  }
  results.sort((a, b) => b.size - a.size);
  return results.slice(0, MAX_LEFTOVERS);
}

module.exports = { list, leftovers };
