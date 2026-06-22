// List installed BROWSER EXTENSIONS so they can be removed. The App Manager
// handles .app bundles; tools.js handles CLI/background installs; this covers
// extensions, which live inside each browser's profile. Removal is done by the
// main process moving the extension's folder to the Trash (reversible) — this
// service only reads. Chromium-family + Firefox are removable; Safari web
// extensions are bundled inside their container app (managed in Safari), so we
// surface them as informational only.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const HOME = os.homedir();
const AS = path.join(HOME, 'Library', 'Application Support');

// Chromium-family browsers and the base dir that holds their profile folders.
const CHROMIUM = [
  ['Chrome', path.join(AS, 'Google', 'Chrome')],
  ['Chrome Canary', path.join(AS, 'Google', 'Chrome Canary')],
  ['Brave', path.join(AS, 'BraveSoftware', 'Brave-Browser')],
  ['Edge', path.join(AS, 'Microsoft Edge')],
  ['Vivaldi', path.join(AS, 'Vivaldi')],
  ['Chromium', path.join(AS, 'Chromium')],
  ['Opera', path.join(AS, 'com.operasoftware.Opera')],
  ['Arc', path.join(AS, 'Arc', 'User Data')],
];

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
async function pathSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1 << 20, timeout: 5000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch { return 0; }
}
async function readJSON(p) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } }

// Resolve a Chrome manifest name, following __MSG_xxx__ localisation.
async function chromeName(verDir, manifest) {
  let name = (manifest && manifest.name) || '';
  const m = /^__MSG_(.+?)__$/.exec(name);
  if (m) {
    const key = m[1];
    const locales = [manifest.default_locale, 'en', 'en_US'].filter(Boolean);
    for (const loc of locales) {
      const msgs = await readJSON(path.join(verDir, '_locales', loc, 'messages.json'));
      if (msgs) {
        const hit = msgs[key] || msgs[key.toLowerCase()] || Object.entries(msgs).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
        if (hit && hit.message) { name = hit.message; break; }
      }
    }
  }
  return name;
}

async function scanChromium(browser, base, out) {
  let profiles;
  try { profiles = await fsp.readdir(base, { withFileTypes: true }); } catch { return; }
  for (const pr of profiles) {
    if (!pr.isDirectory()) continue;
    const extDir = path.join(base, pr.name, 'Extensions');
    let ids;
    try { ids = await fsp.readdir(extDir, { withFileTypes: true }); } catch { continue; }
    for (const id of ids) {
      if (!id.isDirectory() || id.name === 'Temp') continue;
      const idDir = path.join(extDir, id.name);
      let vers;
      try { vers = await fsp.readdir(idDir, { withFileTypes: true }); } catch { continue; }
      const ver = vers.filter(v => v.isDirectory()).map(v => v.name).sort().pop();
      if (!ver) continue;
      const verDir = path.join(idDir, ver);
      const manifest = await readJSON(path.join(verDir, 'manifest.json'));
      if (!manifest) continue;
      const name = (await chromeName(verDir, manifest)) || id.name;
      out.push({
        browser, profile: pr.name, name, id: id.name,
        version: manifest.version || ver, path: idDir, size: await pathSize(idDir),
        removable: true,
      });
    }
  }
}

async function scanFirefox(out) {
  const base = path.join(AS, 'Firefox', 'Profiles');
  let profiles;
  try { profiles = await fsp.readdir(base, { withFileTypes: true }); } catch { return; }
  for (const pr of profiles) {
    if (!pr.isDirectory()) continue;
    const data = await readJSON(path.join(base, pr.name, 'extensions.json'));
    if (!data || !Array.isArray(data.addons)) continue;
    for (const a of data.addons) {
      if (a.type !== 'extension') continue;
      const loc = a.location || '';
      if (!/profile/i.test(loc)) continue;            // skip built-in/system add-ons
      if (a.id && a.id.endsWith('@mozilla.org')) continue;
      if (!a.path) continue;
      const name = (a.defaultLocale && a.defaultLocale.name) || a.id;
      out.push({
        browser: 'Firefox', profile: pr.name, name, id: a.id || '',
        version: a.version || '', path: a.path, size: await pathSize(a.path),
        removable: true,
      });
    }
  }
}

// Safari web extensions ship inside a container app — list for awareness only.
async function scanSafari(out) {
  try {
    const { stdout } = await execFileP('pluginkit', ['-mAvvv', '-p', 'com.apple.Safari.web-extension'], { timeout: 4000, maxBuffer: 1 << 20 });
    const seen = new Set();
    for (const line of stdout.split('\n')) {
      const m = line.match(/\b([\w.\-]+\.[\w.\-]+)\([\d.]+\)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue; seen.add(id);
      out.push({ browser: 'Safari', profile: '', name: id, id, version: '', path: '', size: 0, removable: false });
    }
  } catch { /* pluginkit unavailable */ }
}

async function list() {
  const out = [];
  for (const [browser, base] of CHROMIUM) {
    if (await exists(base)) await scanChromium(browser, base, out);
  }
  await scanFirefox(out);
  await scanSafari(out);
  out.sort((a, b) => (a.browser).localeCompare(b.browser) || (b.size - a.size));
  return out.slice(0, 200);
}

module.exports = { list };
