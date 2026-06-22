const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path');
const os = require('os');

const agents = require('./services/agents');
const tokens = require('./services/tokens');
const models = require('./services/models');
const junk = require('./services/junk');
const activity = require('./services/activity');
const optimization = require('./services/optimization');
const apps = require('./services/apps');
const protection = require('./services/protection');
const cloud = require('./services/cloud');
const duplicates = require('./services/duplicates');
const spacelens = require('./services/spacelens');
const tools = require('./services/tools');
const extensions = require('./services/extensions');
const drives = require('./services/drives');

// ---- Safety guards for renderer-supplied values ----
// Even though the renderer is our own local code behind a strict CSP, validate
// every path/pid that crosses IPC so a compromised renderer can't trash a
// system root or signal arbitrary processes.
const HOMEDIR = os.homedir();
const PROTECTED_PATHS = new Set([
  '/', '/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/private',
  '/Library', '/Applications', '/opt', '/cores', '/Volumes',
  HOMEDIR, path.join(HOMEDIR, 'Library'),
]);
function isStr(p) { return typeof p === 'string' && p.trim().length > 0; }
function safeDiskId(id) { return typeof id === 'string' && /^disk\d+(?:s\d+)?$/i.test(id.trim()); }
function safeDriveMountPoint(p) {
  if (!isStr(p) || !path.isAbsolute(p)) return false;
  const resolved = path.resolve(p);
  return resolved.startsWith('/Volumes/') && resolved.length > '/Volumes/'.length;
}
function safeTrashTarget(p) {
  if (p === '__bulk__') return true;            // junk.clean handles its own bulkFiles
  if (!isStr(p) || !path.isAbsolute(p)) return false;
  return !PROTECTED_PATHS.has(path.resolve(p)); // never trash a top-level/system root
}

let mainWindow;
let stderrAvailable = true;

// Electron apps can outlive the terminal/launcher that started them. If that
// parent closes its stderr pipe, direct process.stderr.write() calls throw/emit
// EPIPE and crash the app. Treat stderr logging as best-effort only.
process.stderr.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    stderrAvailable = false;
    return;
  }
  throw err;
});

function logToStderr(message) {
  if (!stderrAvailable || !process.stderr.writable) return;
  try {
    process.stderr.write(message);
  } catch (err) {
    if (err && err.code === 'EPIPE') {
      stderrAvailable = false;
      return;
    }
    throw err;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0f14',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // ---- Window/navigation hardening ----
  // Never open child windows in-app; route real web links to the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The UI is a single local file — block any attempt to navigate elsewhere.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  // Forward renderer console output to main stderr (covers old + new signatures)
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron 32: (event) with event.level/.message/.sourceId
    // Older: (event, level, message, line, source)
    const e = args[0];
    if (e && typeof e === 'object' && 'message' in e) {
      logToStderr(`[renderer ${e.level}] ${e.sourceId || ''}:${e.lineNumber || ''} ${e.message}\n`);
    } else {
      const [, level, message, line, source] = args;
      const tag = ['LOG','WARN','ERR'][level] || 'LOG';
      logToStderr(`[renderer ${tag}] ${source || ''}:${line || ''} ${message}\n`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logToStderr(`[renderer crashed] ${JSON.stringify(details)}\n`);
  });

  // Auto-open devtools in dev mode (when launched via `npm start`, not the packaged app)
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  // Deny every renderer permission request (camera, mic, geolocation, etc.) —
  // this is a local system utility and needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ===== Agents =====
ipcMain.handle('agents:list', () => agents.list());
ipcMain.handle('agents:kill', (_e, pid) => agents.kill(pid));

// ===== Tokens =====
ipcMain.handle('tokens:stats', () => tokens.stats());
ipcMain.handle('tokens:setLimit', (_e, limit) => tokens.setLimit(limit));

// ===== Models =====
ipcMain.handle('models:list', () => models.list());
ipcMain.handle('models:launch', (_e, { provider, name }) => models.launch(provider, name));
ipcMain.handle('models:stop', (_e, { provider, name }) => models.stop(provider, name));
ipcMain.handle('models:openFolder', (_e, p) => {
  if (!isStr(p)) return { ok: false, error: 'Invalid path' };
  shell.openPath(p);
  return { ok: true };
});

// ===== Junk =====
ipcMain.handle('junk:scan', () => junk.scan());
ipcMain.handle('junk:clean', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths.filter(i => i && safeTrashTarget(i.path)) : [];
  if (list.length === 0) return { ok: false, error: 'Nothing valid to clean' };
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Clean'],
    defaultId: 0,
    cancelId: 0,
    message: `Delete ${list.length} items?`,
    detail: 'These files will be moved to the Trash where possible. This cannot be undone for system items.',
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return junk.clean(list);
});

// ===== Activity =====
ipcMain.handle('activity:snapshot', () => activity.snapshot());
ipcMain.handle('activity:kill', (_e, { pid, force }) => activity.killProcess(pid, !!force));

// ===== System =====
ipcMain.handle('system:stats', () => {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    memTotal: total,
    memFree: free,
    memUsedPct: ((total - free) / total) * 100,
    uptime: os.uptime(),
    hostname: os.hostname(),
    user: os.userInfo().username,
  };
});

// ===== Speed / Optimization =====
ipcMain.handle('optimization:scan', () => optimization.scan());
ipcMain.handle('optimization:setLoginItem', (_e, { name, enabled }) => optimization.setLoginItem(name, enabled));
ipcMain.handle('optimization:toggleLaunchAgent', (_e, { path: p, disable }) => optimization.toggleLaunchAgent(p, disable));
ipcMain.handle('optimization:freeMemory', () => optimization.freeMemory());

// ===== Applications =====
ipcMain.handle('apps:list', () => apps.list());
ipcMain.handle('apps:leftovers', (_e, appPath) => apps.leftovers(appPath));

// Browser extensions (Chromium-family + Firefox removable, Safari informational)
ipcMain.handle('apps:listExtensions', () => extensions.list());

// Background tools & CLI installs that aren't .app bundles (e.g. ~/.hermes)
ipcMain.handle('apps:listTools', () => tools.list());
ipcMain.handle('tools:uninstall', async (_e, tool) => {
  if (!tool || !isStr(tool.path)) return { ok: false, error: 'Invalid tool' };
  const raw = (Array.isArray(tool.trashPaths) && tool.trashPaths.length) ? tool.trashPaths : [tool.path];
  // Only allow paths inside the user's home or launchd dirs, and never a root.
  const trashPaths = raw.filter(p => safeTrashTarget(p) &&
    (p.startsWith(HOMEDIR + path.sep) || p.includes('/LaunchAgents/') || p.includes('/LaunchDaemons/')));
  if (trashPaths.length === 0) return { ok: false, error: 'Nothing valid to remove' };
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0,
    message: `Uninstall “${tool.name}”?`,
    detail: `This stops the tool, removes its login items, and moves these to the Trash (you can restore them):\n\n${trashPaths.join('\n')}`,
  });
  if (response !== 1) return { ok: false, cancelled: true };
  await tools.stop(tool.pids || [], (tool.agents || []).map(a => a.path));
  // Give launchd/processes a moment to release files, then trash everything.
  await new Promise(r => setTimeout(r, 600));
  return junk.clean(trashPaths.map(p => ({ path: p })));
});

// ===== Protection / Malware =====
ipcMain.handle('protection:scan', (_e, level) => protection.scan(level));

// ===== Cloud =====
ipcMain.handle('cloud:scan', () => cloud.scan());

// ===== Duplicates =====
ipcMain.handle('duplicates:scan', (_e, dir) => duplicates.scan(dir));

// ===== Space Lens =====
ipcMain.handle('spacelens:scan', (_e, dir) => spacelens.scan(dir));

// ===== Storage Drives =====
ipcMain.handle('drives:list', () => drives.listDrives());
ipcMain.handle('drives:mount', (_e, payload) => {
  const diskId = payload && typeof payload === 'object' ? payload.diskId : payload;
  const admin = Boolean(payload && typeof payload === 'object' && payload.admin);
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.mountDrive(diskId.trim(), { admin });
});
ipcMain.handle('drives:unmount', (_e, payload) => {
  const { diskId, force } = payload && typeof payload === 'object' ? payload : {};
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.unmountDrive(diskId.trim(), !!force);
});
ipcMain.handle('drives:eject', (_e, diskId) => {
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.ejectDrive(diskId.trim());
});
ipcMain.handle('drives:locks', (_e, mountPoint) => {
  if (!safeDriveMountPoint(mountPoint)) return { ok: false, processes: [], error: 'Invalid mount point' };
  return drives.getLockingProcesses(mountPoint);
});
ipcMain.handle('drives:verify', (_e, diskId) => {
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.verifyVolume(diskId.trim());
});
ipcMain.handle('drives:repair', (_e, diskId) => {
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.repairVolume(diskId.trim());
});
ipcMain.handle('drives:formatTypes', () => drives._private.getFormatTypes());
ipcMain.handle('drives:format', (_e, payload) => {
  const { diskId, formatType, name } = payload && typeof payload === 'object' ? payload : {};
  if (!safeDiskId(diskId)) return { ok: false, error: 'Invalid disk identifier' };
  return drives.formatDrive(diskId.trim(), formatType, name);
});

// ===== Shared: trash, folder picker, reveal =====
ipcMain.handle('trash:items', async (_e, items) => {
  const list = Array.isArray(items) ? items.filter(i => i && safeTrashTarget(i.path)) : [];
  if (list.length === 0) return { ok: false, error: 'Nothing valid to remove' };
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 0,
    cancelId: 0,
    message: `Move ${list.length} item${list.length === 1 ? '' : 's'} to the Trash?`,
    detail: 'Items are moved to the Trash so you can restore them. Emptying the Trash is permanent.',
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return junk.clean(list);
});

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('shell:reveal', (_e, p) => {
  if (!isStr(p)) return { ok: false, error: 'Invalid path' };
  try { shell.showItemInFolder(p); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
