const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// Heuristic signature list — curated name/bundle-id fragments of well-known
// macOS adware / PUPs / malware families. This is a NAME-MATCH scanner, NOT a
// real antivirus engine (no byte-signature DB, no behavioral analysis). The UI
// states this clearly. Matching is case-insensitive against file/dir names and
// bundle ids. Keep fragments specific enough to avoid obvious false positives.
const SIGNATURES = [
  'Genieo', 'geneio', 'com.genieo',
  'MacKeeper', 'com.mackeeper',
  'Pirrit',
  'VSearch',
  'Conduit',
  'Spigot',
  'Bundlore',
  'AdLoad',
  'Mughthesec',
  'MacDefender',
  'InstallMac',
  'MPlayerX',
  'Vidx',
  'SearchProtect',
  'Advanced Mac Cleaner',
  'MacAdware',
  'crossrider',
  'Vsearch',
  'OperatorMac',
  'IronCore',
  'TuneupMyMac',
  'MacCleanup',
  'Shlayer',
  'Cimpli',
  'Yontoo',
];

// Suspicious patterns in a launch agent/daemon's Program / ProgramArguments
// that warrant a manual review even without a signature hit.
const SUSPICIOUS_PROGRAM_RX = /(^|\/)(tmp|private\/tmp|var\/tmp)\//i;
const SUSPICIOUS_ARG_RX = /(curl\b|wget\b|base64\b|bash\s+-c|sh\s+-c|osascript\b|\beval\b|python\s+-c)/i;
const HIDDEN_DOTFOLDER_RX = /\/\.[^/]+\//;

const MAX_THREATS = 200;
const MAX_AGENTS = 100;
const MAX_EXTENSIONS = 200;

async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1024 * 1024, timeout: 8000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch { return 0; }
}

// Returns the first signature fragment that matches the given string, or null.
function matchSignature(s) {
  if (!s) return null;
  const low = String(s).toLowerCase();
  for (const sig of SIGNATURES) {
    if (low.includes(sig.toLowerCase())) return sig;
  }
  return null;
}

// Read an app bundle's CFBundleIdentifier (best effort).
async function bundleId(appPath) {
  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const { stdout } = await execFileP('defaults', ['read', plist, 'CFBundleIdentifier'], { maxBuffer: 1 << 18, timeout: 4000 });
    return stdout.trim();
  } catch { return ''; }
}

// ---- App bundle scan (quick tier) -----------------------------------------
async function scanApps(state) {
  const threats = [];
  const dirs = ['/Applications', path.join(HOME, 'Applications')];
  for (const dir of dirs) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith('.app')) continue;
      state.scannedCount++;
      const full = path.join(dir, e.name);
      let sig = matchSignature(e.name);
      if (!sig) sig = matchSignature(await bundleId(full));
      if (sig) {
        const size = await pathSize(full);
        threats.push({
          path: full,
          name: e.name,
          reason: `Matches known adware/PUP signature "${sig}"`,
          severity: 'high',
          size,
        });
        if (threats.length >= MAX_THREATS) return threats;
      }
    }
  }
  return threats;
}

// ---- Launch agents / daemons scan (quick tier) ----------------------------
async function readPlistProgram(plistPath) {
  // Returns { program, args } as best-effort strings. Uses defaults read which
  // tolerates both XML and binary plists.
  let program = '';
  let args = '';
  try {
    const { stdout } = await execFileP('defaults', ['read', plistPath, 'Program'], { maxBuffer: 1 << 18, timeout: 4000 });
    program = stdout.trim();
  } catch {}
  try {
    const { stdout } = await execFileP('defaults', ['read', plistPath, 'ProgramArguments'], { maxBuffer: 1 << 18, timeout: 4000 });
    args = stdout.trim();
  } catch {}
  return { program, args };
}

async function scanLaunchItems(state) {
  const threats = [];
  const suspiciousAgents = [];
  const dirs = [
    path.join(HOME, 'Library', 'LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
  ];
  for (const dir of dirs) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.name.endsWith('.plist')) continue;
      state.scannedCount++;
      const full = path.join(dir, e.name);
      const label = e.name.replace(/\.plist$/i, '');
      const { program, args } = await readPlistProgram(full);
      const haystack = `${e.name} ${program} ${args}`;

      // 1) Signature match → treat as a threat (medium — it's a config file).
      const sig = matchSignature(haystack);
      if (sig) {
        const size = await pathSize(full);
        threats.push({
          path: full,
          name: e.name,
          reason: `Launch item matches known signature "${sig}"`,
          severity: 'medium',
          size,
        });
        if (threats.length >= MAX_THREATS) break;
        continue;
      }

      // 2) Suspicious execution pattern → review (medium).
      const reasons = [];
      const progLine = `${program} ${args}`;
      if (SUSPICIOUS_PROGRAM_RX.test(progLine)) reasons.push('runs a program from a temp directory');
      if (HIDDEN_DOTFOLDER_RX.test(progLine)) reasons.push('runs from a hidden dot-folder');
      if (SUSPICIOUS_ARG_RX.test(progLine)) reasons.push('uses a download/scripting command (curl/wget/base64/bash -c/osascript)');
      if (reasons.length) {
        suspiciousAgents.push({
          path: full,
          label,
          program: (program || args || '').slice(0, 240),
          reason: reasons.join('; '),
        });
        if (suspiciousAgents.length >= MAX_AGENTS) break;
      }
    }
  }
  return { threats, suspiciousAgents };
}

// ---- Support / cache top-level scan (normal tier) -------------------------
async function scanSupportDirs(state) {
  const threats = [];
  const dirs = [
    path.join(HOME, 'Library', 'Application Support'),
    path.join(HOME, 'Library', 'Caches'),
  ];
  for (const dir of dirs) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      state.scannedCount++;
      const sig = matchSignature(e.name);
      if (sig) {
        const full = path.join(dir, e.name);
        const size = await pathSize(full);
        threats.push({
          path: full,
          name: e.name,
          reason: `Support/cache item matches known signature "${sig}"`,
          severity: 'medium',
          size,
        });
        if (threats.length >= MAX_THREATS) return threats;
      }
    }
  }
  return threats;
}

// ---- Browser extensions (normal tier, informational) ----------------------
async function listChromeExtensions(state) {
  const out = [];
  const base = path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome');
  let profiles;
  try { profiles = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const prof of profiles) {
    if (!prof.isDirectory()) continue;
    const extDir = path.join(base, prof.name, 'Extensions');
    let exts;
    try { exts = await fsp.readdir(extDir, { withFileTypes: true }); } catch { continue; }
    for (const ext of exts) {
      if (!ext.isDirectory()) continue;
      state.scannedCount++;
      const extPath = path.join(extDir, ext.name);
      // Try to surface a human name from the newest version's manifest.
      let name = ext.name;
      try {
        const versions = (await fsp.readdir(extPath, { withFileTypes: true })).filter(v => v.isDirectory());
        if (versions.length) {
          const manifest = path.join(extPath, versions[versions.length - 1].name, 'manifest.json');
          const raw = await fsp.readFile(manifest, 'utf8');
          const json = JSON.parse(raw);
          if (json && typeof json.name === 'string' && !json.name.startsWith('__MSG')) name = json.name;
        }
      } catch {}
      out.push({ browser: `Chrome (${prof.name})`, name, path: extPath });
      if (out.length >= MAX_EXTENSIONS) return out;
    }
  }
  return out;
}

async function listSafariExtensions(state) {
  const out = [];
  const dirs = [
    path.join(HOME, 'Library', 'Containers'),
    path.join(HOME, 'Library', 'Safari', 'Extensions'),
  ];
  // App Extensions live inside app containers; only the legacy .safariextz dir
  // is reliably enumerable without entitlements. Best-effort, guarded.
  const legacy = dirs[1];
  let entries;
  try { entries = await fsp.readdir(legacy, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.name.toLowerCase().endsWith('.safariextz')) continue;
    state.scannedCount++;
    out.push({ browser: 'Safari', name: e.name.replace(/\.safariextz$/i, ''), path: path.join(legacy, e.name) });
    if (out.length >= MAX_EXTENSIONS) return out;
  }
  return out;
}

async function listFirefoxExtensions(state) {
  const out = [];
  const base = path.join(HOME, 'Library', 'Application Support', 'Firefox', 'Profiles');
  let profiles;
  try { profiles = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const prof of profiles) {
    if (!prof.isDirectory()) continue;
    const extDir = path.join(base, prof.name, 'extensions');
    let exts;
    try { exts = await fsp.readdir(extDir, { withFileTypes: true }); } catch { continue; }
    for (const ext of exts) {
      if (ext.name.startsWith('.')) continue;
      state.scannedCount++;
      out.push({
        browser: `Firefox (${prof.name})`,
        name: ext.name.replace(/\.xpi$/i, ''),
        path: path.join(extDir, ext.name),
      });
      if (out.length >= MAX_EXTENSIONS) return out;
    }
  }
  return out;
}

async function listBrowserExtensions(state) {
  const out = [];
  out.push(...await listChromeExtensions(state));
  out.push(...await listSafariExtensions(state));
  out.push(...await listFirefoxExtensions(state));
  return out.slice(0, MAX_EXTENSIONS);
}

// ---- Deep filesystem sweep (deep tier) ------------------------------------
async function deepSweep(state) {
  const threats = [];
  const seen = new Set();
  const deadline = Date.now() + 25000; // overall ~25s budget
  for (const sig of SIGNATURES) {
    if (Date.now() > deadline) break;
    if (threats.length >= MAX_THREATS) break;
    const remaining = Math.max(2000, deadline - Date.now());
    // -iname needs glob wildcards; the pattern is a single argv element, so
    // `find` (not the shell) expands it. find errors are silenced via try/catch.
    const pattern = `*${sig}*`;
    let stdout = '';
    try {
      const res = await execFileP(
        'find',
        [HOME, '-maxdepth', '6', '-iname', pattern],
        { maxBuffer: 4 * 1024 * 1024, timeout: Math.min(remaining, 15000) }
      );
      stdout = res.stdout;
    } catch (e) {
      // timeout/partial — keep whatever we got via stdout on the error object
      stdout = (e && e.stdout) || '';
    }
    // `| head -40` is now a JS slice of the non-empty lines.
    const hits = stdout.split('\n').filter(Boolean).slice(0, 40);
    for (const hit of hits) {
      if (seen.has(hit)) continue;
      seen.add(hit);
      state.scannedCount++;
      const size = await pathSize(hit);
      threats.push({
        path: hit,
        name: path.basename(hit),
        reason: `Deep-scan name match for signature "${sig}"`,
        severity: 'medium',
        size,
      });
      if (threats.length >= MAX_THREATS) break;
    }
  }
  return threats;
}

// De-dupe threats by path, keeping the highest severity.
function dedupeThreats(list) {
  const rank = { high: 3, medium: 2, low: 1 };
  const byPath = new Map();
  for (const t of list) {
    const prev = byPath.get(t.path);
    if (!prev || (rank[t.severity] || 0) > (rank[prev.severity] || 0)) byPath.set(t.path, t);
  }
  const out = [...byPath.values()];
  out.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || (b.size || 0) - (a.size || 0));
  return out.slice(0, MAX_THREATS);
}

/**
 * Heuristic signature scan for known macOS adware / PUPs / malware.
 * @param {('quick'|'normal'|'deep')} level
 * @returns {Promise<{level:string, scannedCount:number, durationMs:number,
 *   threats:Array<{path:string,name:string,reason:string,severity:('high'|'medium'|'low'),size:number}>,
 *   suspiciousAgents:Array<{path:string,label:string,program:string,reason:string}>,
 *   browserExtensions:Array<{browser:string,name:string,path:string}>,
 *   error?:string}>}
 */
async function scan(level) {
  const lvl = ['quick', 'normal', 'deep'].includes(level) ? level : 'quick';
  const start = Date.now();
  const state = { scannedCount: 0 };
  let threats = [];
  let suspiciousAgents = [];
  let browserExtensions = [];
  let error;

  try {
    // quick tier — always runs
    threats.push(...await scanApps(state));
    const launch = await scanLaunchItems(state);
    threats.push(...launch.threats);
    suspiciousAgents = launch.suspiciousAgents;

    // normal tier — quick + support dirs + browser extensions
    if (lvl === 'normal' || lvl === 'deep') {
      threats.push(...await scanSupportDirs(state));
      browserExtensions = await listBrowserExtensions(state);
    }

    // deep tier — normal + bounded HOME sweep
    if (lvl === 'deep') {
      threats.push(...await deepSweep(state));
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  threats = dedupeThreats(threats);
  suspiciousAgents = suspiciousAgents.slice(0, MAX_AGENTS);
  browserExtensions = browserExtensions.slice(0, MAX_EXTENSIONS);

  const result = {
    level: lvl,
    scannedCount: state.scannedCount,
    durationMs: Date.now() - start,
    threats,
    suspiciousAgents,
    browserExtensions,
  };
  if (error) result.error = error;
  return result;
}

module.exports = { scan };
