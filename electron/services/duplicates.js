const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// Caps keep the scan fast and bounded — never block forever, never blow memory.
const MAX_FILES = 8000;     // candidate files we'll even consider
const MAX_GROUPS = 200;     // duplicate groups returned to the UI
const FIND_TIMEOUT = 25000; // ms for the initial find
const BATCH = 200;          // files per stat/hash batch

// List candidate files (>4k, excluding noisy dirs). macOS BSD find has no -printf,
// so we just get the paths here and stat them in batches below.
async function listCandidates(dir) {
  // Each flag/path is its own argv element (no shell). `| head -n N` becomes a
  // JS slice; the `2>/dev/null` redirect is unneeded since stderr is separate.
  const args = [dir, '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-size', '+4k'];
  try {
    const { stdout } = await execFileP('find', args, { maxBuffer: 16 * 1024 * 1024, timeout: FIND_TIMEOUT });
    return stdout.split('\n').filter(Boolean).slice(0, MAX_FILES);
  } catch (e) {
    // Even on timeout, execFile gives us whatever was buffered on stdout.
    if (e && typeof e.stdout === 'string') return e.stdout.split('\n').filter(Boolean).slice(0, MAX_FILES);
    return [];
  }
}

// `stat -f '%z|%N'` per file → size + path. Batched so the arg list stays sane.
// Returns Map<size, string[paths]>.
async function sizeGroups(files) {
  const bySize = new Map();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    try {
      const { stdout } = await execFileP('stat', ['-f', '%z|%N', ...batch], { maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const size = Number(line.slice(0, sep));
        const p = line.slice(sep + 1);
        if (!Number.isFinite(size) || size <= 0 || !p) continue;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(p);
      }
    } catch { /* skip this batch, keep going */ }
  }
  return bySize;
}

// shasum -a 1 per file, batched. Output lines: "<hash>  <path>".
// Returns Map<path, hash>.
async function hashFiles(files) {
  const byPath = new Map();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    try {
      const { stdout } = await execFileP('shasum', ['-a', '1', ...batch], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        // shasum format: 40-hex-hash, two spaces, path (path may contain spaces).
        const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (!m) continue;
        byPath.set(m[2], m[1]);
      }
    } catch { /* skip this batch */ }
  }
  return byPath;
}

async function fileMeta(p) {
  try {
    const st = await fsp.stat(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch { return { mtimeMs: 0, size: 0 }; }
}

async function scan(dir) {
  const target = dir || path.join(HOME, 'Downloads');
  try {
    const candidates = await listCandidates(target);
    const scanned = candidates.length;
    if (scanned === 0) {
      return { dir: target, scanned: 0, groups: [], totalReclaimable: 0 };
    }

    // 1) Group by size — only same-size files can be byte-identical.
    const bySize = await sizeGroups(candidates);

    // 2) Only hash files whose size collides with another file.
    const toHash = [];
    const sizeOf = new Map();
    for (const [size, paths] of bySize) {
      if (paths.length < 2) continue;
      for (const p of paths) { toHash.push(p); sizeOf.set(p, size); }
    }
    if (toHash.length === 0) {
      return { dir: target, scanned, groups: [], totalReclaimable: 0 };
    }

    // 3) Hash the size-collision set, group by hash.
    const byPath = await hashFiles(toHash);
    const byHash = new Map();
    for (const [p, hash] of byPath) {
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(p);
    }

    // 4) Build groups (count >= 2) with per-file metadata.
    let groups = [];
    for (const [hash, paths] of byHash) {
      if (paths.length < 2) continue;
      const size = sizeOf.get(paths[0]) || 0;
      const files = [];
      for (const p of paths) {
        const meta = await fileMeta(p);
        files.push({ path: p, name: path.basename(p), mtimeMs: meta.mtimeMs });
      }
      // Newest first so the UI can default-keep the newest copy.
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const count = files.length;
      groups.push({ hash, size, count, reclaimable: size * (count - 1), files });
    }

    groups.sort((a, b) => b.reclaimable - a.reclaimable);
    groups = groups.slice(0, MAX_GROUPS);
    const totalReclaimable = groups.reduce((s, g) => s + g.reclaimable, 0);

    return { dir: target, scanned, groups, totalReclaimable };
  } catch (e) {
    return { dir: target, scanned: 0, groups: [], totalReclaimable: 0, error: e.message };
  }
}

module.exports = { scan };
