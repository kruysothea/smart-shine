const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// How many immediate children we will measure (du is the slow part).
const MAX_CHILDREN = 200;
// How many rows we return to the renderer for drawing.
const MAX_ROWS = 60;
// Per-`du` call timeout. Many small calls in parallel keep total well under ~25s.
const DU_TIMEOUT = 6000;
// How many child `du` calls to run at once. Higher overlap = faster wall-time
// when several children are large (the common case for HOME / project roots).
const CONCURRENCY = 16;

// Directory size in bytes via `du -sk`. Guarded; returns 0 on any failure.
async function dirSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], {
      maxBuffer: 1024 * 1024,
      timeout: DU_TIMEOUT,
    });
    // `du -sk` prints "<kb>\t<path>"; take the first whitespace-delimited field.
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}

// Size of a single immediate child. Directories use du; files use stat.
async function childSize(full, isDir) {
  if (isDir) return dirSize(full);
  try {
    const st = await fsp.stat(full);
    return st.isDirectory() ? dirSize(full) : st.size;
  } catch { return 0; }
}

// Run jobs with a small concurrency cap so we don't spawn 200 du's at once.
async function mapLimit(items, limit, fn) {
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

// Compute the parent path for "Up" navigation. null at the user HOME root or '/'.
function parentOf(dir) {
  if (dir === HOME || dir === '/') return null;
  const up = path.dirname(dir);
  if (up === dir) return null;
  return up;
}

// Scan ONE directory level for the interactive drill-down map.
async function scan(dir) {
  const target = dir || HOME;
  try {
    let entries;
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (e) {
      return { path: target, parent: null, totalSize: 0, children: [], error: e.message };
    }

    // Skip noise; cap how many children we measure.
    const picked = entries
      .filter((e) => e.name !== '.DS_Store')
      .slice(0, MAX_CHILDREN);

    const sized = await mapLimit(picked, CONCURRENCY, async (e) => {
      const full = path.join(target, e.name);
      const isDir = e.isDirectory();
      const size = await childSize(full, isDir);
      return { name: e.name, path: full, size, isDir };
    });

    const children = sized
      .filter((c) => c.size > 0)
      .sort((a, b) => b.size - a.size);

    const totalSize = children.reduce((s, c) => s + c.size, 0);

    const rows = children.slice(0, MAX_ROWS).map((c) => ({
      name: c.name,
      path: c.path,
      size: c.size,
      isDir: c.isDir,
      pct: totalSize > 0 ? (c.size / totalSize) * 100 : 0,
    }));

    return { path: target, parent: parentOf(target), totalSize, children: rows };
  } catch (e) {
    return { path: target, parent: null, totalSize: 0, children: [], error: e.message };
  }
}

module.exports = { scan };
