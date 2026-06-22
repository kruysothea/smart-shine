const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { shell } = require('electron');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// Caches we deliberately never touch under ~/Library/Caches —
// these hold sync state, security data, or iCloud metadata. Deleting them
// triggers slow re-syncs or breaks app state in surprising ways.
const PROTECTED_USER_CACHE_DIRS = [
  'CloudKit',                       // iCloud / CloudKit sync state
  'com.apple.bird',                 // iCloud Drive daemon
  'com.apple.HomeKit',              // HomeKit accessories
  'com.apple.AMPLibraryAgent',      // Music library
  'com.apple.icloud.searchpartyd',  // Find My
  'com.apple.assistant.assistantd', // Siri
  'FamilyCircle',                   // Family Sharing
  // Browser caches are handled in their own category — exclude to prevent
  // double-deletion and to use the more specific subpath there.
  'Google', 'com.apple.Safari', 'Firefox', 'company.thebrowser.Browser',
  // pip cache is handled in the Python category
  'pip',
];

const CATEGORIES = [
  {
    id: 'user-caches',
    name: 'User Caches',
    icon: 'cache',
    description: 'Application caches under ~/Library/Caches. Apps regenerate them on next launch. Quit the app first for safest results.',
    paths: [path.join(HOME, 'Library', 'Caches')],
    childGlob: true,
    excludeChildren: PROTECTED_USER_CACHE_DIRS,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'system-logs',
    name: 'User Logs',
    icon: 'logs',
    description: 'Diagnostic logs under ~/Library/Logs. Apps create new ones as needed.',
    paths: [path.join(HOME, 'Library', 'Logs')],
    childGlob: true,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'trash',
    name: 'Trash',
    icon: 'trash',
    description: 'Items already in your Trash — this empties it permanently.',
    paths: [path.join(HOME, '.Trash')],
    childGlob: true,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'xcode',
    name: 'Xcode Derived Data',
    icon: 'xcode',
    description: 'Build artifacts and simulator caches. Rebuilds automatically on next compile. (Xcode Archives are NEVER touched — those contain shipped dSYMs.)',
    paths: [
      path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'),
      path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Caches'),
    ],
    childGlob: true,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'npm',
    name: 'npm / yarn cache',
    icon: 'package',
    description: 'JS package download caches. Re-downloads on next install. (pnpm store is NEVER touched — deleting it breaks every pnpm project.)',
    paths: [
      path.join(HOME, '.npm', '_cacache'),
      path.join(HOME, '.yarn', 'cache'),
    ],
    childGlob: true,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'pip',
    name: 'Python caches',
    icon: 'python',
    description: 'pip and uv download caches. Re-downloads on next install.',
    paths: [
      path.join(HOME, 'Library', 'Caches', 'pip'),
      path.join(HOME, '.cache', 'pip'),
      path.join(HOME, '.cache', 'uv'),
    ],
    childGlob: true,
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'browser',
    name: 'Browser Caches',
    icon: 'browser',
    description: 'Chrome, Safari, Firefox, Arc caches. Quit the browser first to avoid mid-session glitches.',
    paths: [
      path.join(HOME, 'Library', 'Caches', 'Google', 'Chrome'),
      path.join(HOME, 'Library', 'Caches', 'com.apple.Safari'),
      path.join(HOME, 'Library', 'Caches', 'Firefox'),
      path.join(HOME, 'Library', 'Caches', 'company.thebrowser.Browser'),
    ],
    childGlob: true,
    safety: 'caution',
    defaultChecked: true,
  },
  {
    id: 'node_modules',
    name: 'Stale node_modules',
    icon: 'package',
    description: 'node_modules in projects untouched 60+ days. Re-install with `npm install` if you return to them. Review before cleaning.',
    custom: 'staleNodeModules',
    safety: 'review',
    defaultChecked: false,
  },
  {
    id: 'ds-store',
    name: '.DS_Store files',
    icon: 'file',
    description: 'macOS Finder metadata. Regenerates instantly the next time you open a folder.',
    custom: 'dsStore',
    safety: 'safe',
    defaultChecked: true,
  },
  {
    id: 'downloads-old',
    name: 'Old Downloads — review first',
    icon: 'download',
    description: 'Files in ~/Downloads older than 90 days. This is your data — installers, receipts, photos may live here. Review every item before deleting.',
    custom: 'oldDownloads',
    safety: 'review',
    defaultChecked: false,
  },
];

async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1024 * 1024, timeout: 8000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch { return 0; }
}

async function scanChildren(dir, exclude = []) {
  const items = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    if (exclude.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    const size = await pathSize(full);
    if (size > 0) items.push({ path: full, size, name: e.name });
  }
  return items.sort((a, b) => b.size - a.size);
}

async function staleNodeModules() {
  const items = [];
  const roots = [HOME];
  for (const root of roots) {
    try {
      const { stdout } = await execFileP('find', [root, '-maxdepth', '6', '-type', 'd', '-name', 'node_modules', '-prune'], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
      const dirs = stdout.split('\n').filter(Boolean).slice(0, 200);
      for (const d of dirs) {
        const stat = await fsp.stat(d).catch(() => null);
        if (!stat) continue;
        const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
        if (ageDays < 60) continue;
        const size = await pathSize(d);
        if (size > 0) items.push({ path: d, size, name: path.relative(HOME, d), ageDays: Math.round(ageDays) });
      }
    } catch {}
  }
  return items.sort((a, b) => b.size - a.size).slice(0, 100);
}

async function dsStore() {
  try {
    const { stdout } = await execFileP('find', [HOME, '-name', '.DS_Store', '-type', 'f'], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
    const files = stdout.split('\n').filter(Boolean).slice(0, 2000);
    return [{ path: '__bulk__', size: files.length * 6144, name: `${files.length} .DS_Store files`, bulk: files }];
  } catch { return []; }
}

async function oldDownloads() {
  const dir = path.join(HOME, 'Downloads');
  const items = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
      if (ageDays < 90) continue;
      const size = await pathSize(full);
      if (size > 0) items.push({ path: full, size, name: e.name, ageDays: Math.round(ageDays) });
    }
  } catch {}
  return items.sort((a, b) => b.size - a.size);
}

async function scan() {
  const out = [];
  for (const cat of CATEGORIES) {
    let items = [];
    if (cat.custom) {
      if (cat.custom === 'staleNodeModules') items = await staleNodeModules();
      else if (cat.custom === 'dsStore') items = await dsStore();
      else if (cat.custom === 'oldDownloads') items = await oldDownloads();
    } else if (cat.childGlob) {
      for (const p of cat.paths) {
        const children = await scanChildren(p, cat.excludeChildren || []);
        items.push(...children);
      }
    }
    const totalSize = items.reduce((s, i) => s + i.size, 0);
    out.push({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      icon: cat.icon,
      safety: cat.safety || 'safe',
      defaultChecked: cat.defaultChecked !== false,
      totalSize,
      items: items.slice(0, 60),
    });
  }
  return out;
}

async function clean(targets) {
  let freed = 0;
  let removed = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      if (t.bulkFiles && Array.isArray(t.bulkFiles)) {
        for (const f of t.bulkFiles) {
          // .DS_Store files are 6KB metadata, always regenerated — unlink directly
          try { await fsp.unlink(f); removed++; } catch { failed++; }
        }
        freed += t.size || 0;
        continue;
      }
      const size = t.size || (await pathSize(t.path));
      // Always move to Trash — never rm -rf. If Trash fails, surface it to the user.
      const trashed = await shell.trashItem(t.path).then(() => true).catch(() => false);
      if (!trashed) { failed++; continue; }
      freed += size; removed++;
    } catch (e) { failed++; }
  }
  return { ok: true, freed, removed, failed };
}

module.exports = { scan, clean };
