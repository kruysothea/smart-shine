const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// IMPORTANT SAFETY MODEL: deleting a file inside a cloud-synced folder also
// deletes it from the cloud (and every other device). So this service is
// INSPECT-ONLY — it reads sizes of locally-stored synced content. It never
// trashes, unlinks, or moves anything.

// Size of a path in bytes via `du -sk` (kilobytes). Returns 0 on any failure.
async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1024 * 1024, timeout: 8000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch { return 0; }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Top ~15 immediate children of a folder by size (files + dirs).
async function topChildren(dir, limit = 15) {
  const items = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    if (e.name === '.DS_Store') continue;
    const full = path.join(dir, e.name);
    const size = await pathSize(full);
    if (size > 0) items.push({ name: e.name, path: full, size });
  }
  return items.sort((a, b) => b.size - a.size).slice(0, limit);
}

// Build a full provider record (existence already confirmed by caller).
async function buildProvider(provider, p, account) {
  const rec = { provider, path: p, exists: true, totalSize: 0, top: [] };
  try {
    if (account) rec.account = account;
    rec.totalSize = await pathSize(p);
    rec.top = await topChildren(p);
  } catch { /* keep safe defaults */ }
  return rec;
}

// Read ~/Library/CloudStorage and return entries whose name starts with prefix.
// CloudStorage folders are named like "GoogleDrive-name@gmail.com",
// "OneDrive-Personal", "Dropbox", etc. The suffix after the first '-' is the
// account label, surfaced as a friendly `account` field.
async function cloudStorageMatches(prefix) {
  const base = path.join(HOME, 'Library', 'CloudStorage');
  const out = [];
  let entries;
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const full = path.join(base, e.name);
    const dash = e.name.indexOf('-');
    const account = dash >= 0 ? e.name.slice(dash + 1) : '';
    out.push({ path: full, account });
  }
  return out;
}

// Detect cloud-sync provider folders that exist locally and summarize their
// locally-stored content. Returns [] on total failure; never throws.
async function scan() {
  try {
    const results = [];
    const seen = new Set();

    const add = async (provider, p, account) => {
      if (!p || seen.has(p)) return;
      if (!(await exists(p))) return;
      seen.add(p);
      results.push(await buildProvider(provider, p, account));
    };

    // iCloud Drive — single well-known path.
    await add('iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));

    // Dropbox — legacy ~/Dropbox plus any modern CloudStorage entries.
    await add('Dropbox', path.join(HOME, 'Dropbox'));
    for (const m of await cloudStorageMatches('Dropbox')) {
      await add('Dropbox', m.path, m.account);
    }

    // Google Drive — modern CloudStorage entries plus legacy ~/Google Drive.
    for (const m of await cloudStorageMatches('GoogleDrive')) {
      await add('Google Drive', m.path, m.account);
    }
    await add('Google Drive', path.join(HOME, 'Google Drive'));

    // OneDrive — modern CloudStorage entries plus legacy ~/OneDrive.
    for (const m of await cloudStorageMatches('OneDrive')) {
      await add('OneDrive', m.path, m.account);
    }
    await add('OneDrive', path.join(HOME, 'OneDrive'));

    return results;
  } catch {
    return [];
  }
}

module.exports = { scan };
