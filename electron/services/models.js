const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const execp = promisify(exec);
const execFileP = promisify(execFile);
const HOME = os.homedir();

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function dirSize(p) {
  try {
    const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 1024 * 1024, timeout: 5000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isNaN(kb) ? 0 : kb * 1024;
  } catch { return 0; }
}

async function ollama() {
  const out = { provider: 'Ollama', installed: false, running: false, models: [], folder: path.join(HOME, '.ollama', 'models') };
  try {
    await execFileP('which', ['ollama']);
    out.installed = true;
  } catch { /* not installed */ }
  if (!out.installed && !(await exists(out.folder))) return out;

  if (out.installed) {
    try {
      const { stdout } = await execp('ollama list', { timeout: 5000 });
      const lines = stdout.split('\n').slice(1).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s{2,}/);
        if (parts.length < 3) continue;
        out.models.push({
          name: parts[0],
          id: parts[1],
          size: parts[2],
          modified: parts[3] || '',
          running: false,
          path: out.folder,
        });
      }
    } catch {}
    try {
      const { stdout } = await execp('ollama ps', { timeout: 3000 });
      const lines = stdout.split('\n').slice(1).filter(Boolean);
      const runningNames = lines.map(l => l.split(/\s+/)[0]);
      for (const m of out.models) if (runningNames.includes(m.name)) { m.running = true; out.running = true; }
    } catch {}
  }
  return out;
}

async function lmstudio() {
  const out = { provider: 'LM Studio', installed: false, running: false, models: [], folder: path.join(HOME, '.lmstudio', 'models') };
  if (!(await exists(out.folder))) {
    const alt = path.join(HOME, '.cache', 'lm-studio', 'models');
    if (await exists(alt)) out.folder = alt;
    else return out;
  }
  out.installed = true;
  // Scan vendor/model/file structure
  try {
    const vendors = await fsp.readdir(out.folder, { withFileTypes: true });
    for (const v of vendors) {
      if (!v.isDirectory()) continue;
      const vendorDir = path.join(out.folder, v.name);
      let modelDirs;
      try { modelDirs = await fsp.readdir(vendorDir, { withFileTypes: true }); } catch { continue; }
      for (const m of modelDirs) {
        if (!m.isDirectory()) continue;
        const modelPath = path.join(vendorDir, m.name);
        const size = await dirSize(modelPath);
        out.models.push({
          name: `${v.name}/${m.name}`,
          id: '',
          size: humanSize(size),
          sizeBytes: size,
          path: modelPath,
          running: false,
        });
      }
    }
  } catch {}

  // Check for running LM Studio server
  try {
    const { stdout } = await execp("pgrep -fl 'LM Studio' || pgrep -fl 'lms server'", { timeout: 2000 });
    if (stdout.trim()) out.running = true;
  } catch {}
  return out;
}

async function huggingface() {
  const folder = path.join(HOME, '.cache', 'huggingface', 'hub');
  const out = { provider: 'HuggingFace Cache', installed: false, running: false, models: [], folder };
  if (!(await exists(folder))) return out;
  out.installed = true;
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('models--')) continue;
      const modelPath = path.join(folder, e.name);
      const size = await dirSize(modelPath);
      out.models.push({
        name: e.name.replace(/^models--/, '').replace(/--/g, '/'),
        id: '',
        size: humanSize(size),
        sizeBytes: size,
        path: modelPath,
        running: false,
      });
    }
  } catch {}
  return out;
}

async function ggufScan() {
  const out = { provider: 'GGUF files', installed: false, running: false, models: [], folder: HOME };
  const candidates = [
    path.join(HOME, 'Documents', 'models'),
    path.join(HOME, 'Downloads'),
    path.join(HOME, 'models'),
  ];
  for (const dir of candidates) {
    if (!(await exists(dir))) continue;
    try {
      const { stdout } = await execFileP('find', [dir, '-maxdepth', '3', '-name', '*.gguf', '-type', 'f'], { maxBuffer: 1024 * 1024, timeout: 8000 });
      const files = stdout.split('\n').filter(Boolean).slice(0, 50);
      for (const f of files) {
        const stat = await fsp.stat(f).catch(() => null);
        if (!stat) continue;
        out.installed = true;
        out.models.push({
          name: path.basename(f),
          id: '',
          size: humanSize(stat.size),
          sizeBytes: stat.size,
          path: f,
          running: false,
        });
      }
    } catch {}
  }
  return out;
}

function humanSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function list() {
  const [o, l, h, g] = await Promise.all([ollama(), lmstudio(), huggingface(), ggufScan()]);
  return [o, l, h, g].filter(p => p.installed || p.models.length > 0);
}

async function launch(provider, name) {
  try {
    if (provider === 'Ollama') {
      spawn('ollama', ['run', name], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, message: `Launched ${name}` };
    }
    if (provider === 'LM Studio') {
      spawn('open', ['-a', 'LM Studio'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, message: 'Opened LM Studio' };
    }
    if (provider === 'GGUF files') {
      // Try to launch with llama.cpp if available
      try {
        await execFileP('which', ['llama-server']);
        spawn('llama-server', ['-m', name, '-p', '8080'], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, message: `llama-server started on :8080 with ${path.basename(name)}` };
      } catch {
        return { ok: false, error: 'llama-server not installed. Install llama.cpp.' };
      }
    }
    return { ok: false, error: `Cannot launch from ${provider}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function stop(provider, name) {
  try {
    if (provider === 'Ollama') {
      await execFileP('ollama', ['stop', name]).catch(() => {});
      return { ok: true };
    }
    if (provider === 'LM Studio') {
      await execp(`pkill -f 'LM Studio'`).catch(() => {});
      return { ok: true };
    }
    if (provider === 'GGUF files') {
      await execp(`pkill -f 'llama-server'`).catch(() => {});
      return { ok: true };
    }
    return { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { list, launch, stop };
