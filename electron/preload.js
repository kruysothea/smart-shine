const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Agents
  listAgents: () => ipcRenderer.invoke('agents:list'),
  killAgent: (pid) => ipcRenderer.invoke('agents:kill', pid),

  // Tokens
  getTokenStats: () => ipcRenderer.invoke('tokens:stats'),
  setTokenLimit: (limit) => ipcRenderer.invoke('tokens:setLimit', limit),

  // Models
  listModels: () => ipcRenderer.invoke('models:list'),
  launchModel: (provider, name) => ipcRenderer.invoke('models:launch', { provider, name }),
  stopModel: (provider, name) => ipcRenderer.invoke('models:stop', { provider, name }),
  openModelFolder: (path) => ipcRenderer.invoke('models:openFolder', path),

  // Junk
  scanJunk: () => ipcRenderer.invoke('junk:scan'),
  cleanJunk: (paths) => ipcRenderer.invoke('junk:clean', paths),

  // Activity
  getActivity: () => ipcRenderer.invoke('activity:snapshot'),
  killProcess: (pid, force=false) => ipcRenderer.invoke('activity:kill', { pid, force }),

  // System
  systemStats: () => ipcRenderer.invoke('system:stats'),

  // ===== CleanMyMac-style features =====
  // Speed / Optimization
  scanOptimization: () => ipcRenderer.invoke('optimization:scan'),
  setLoginItem: (name, enabled) => ipcRenderer.invoke('optimization:setLoginItem', { name, enabled }),
  toggleLaunchAgent: (path, disable) => ipcRenderer.invoke('optimization:toggleLaunchAgent', { path, disable }),
  freeMemory: () => ipcRenderer.invoke('optimization:freeMemory'),

  // Applications
  listApps: () => ipcRenderer.invoke('apps:list'),
  appLeftovers: (appPath) => ipcRenderer.invoke('apps:leftovers', appPath),
  listTools: () => ipcRenderer.invoke('apps:listTools'),
  uninstallTool: (tool) => ipcRenderer.invoke('tools:uninstall', tool),
  listExtensions: () => ipcRenderer.invoke('apps:listExtensions'),

  // Protection / Malware
  scanMalware: (level) => ipcRenderer.invoke('protection:scan', level),

  // Cloud
  scanCloud: () => ipcRenderer.invoke('cloud:scan'),

  // Duplicates
  scanDuplicates: (dir) => ipcRenderer.invoke('duplicates:scan', dir),

  // Space Lens
  spaceLens: (dir) => ipcRenderer.invoke('spacelens:scan', dir),

  // Storage Drives
  listDrives: () => ipcRenderer.invoke('drives:list'),
  mountDrive: (diskId, admin=false) => ipcRenderer.invoke('drives:mount', { diskId, admin }),
  unmountDrive: (diskId, force=false) => ipcRenderer.invoke('drives:unmount', { diskId, force }),
  ejectDrive: (diskId) => ipcRenderer.invoke('drives:eject', diskId),
  getLockingProcesses: (mountPoint) => ipcRenderer.invoke('drives:locks', mountPoint),
  verifyVolume: (diskId) => ipcRenderer.invoke('drives:verify', diskId),
  repairVolume: (diskId) => ipcRenderer.invoke('drives:repair', diskId),
  getDriveFormatTypes: () => ipcRenderer.invoke('drives:formatTypes'),
  formatDrive: (diskId, formatType, name) => ipcRenderer.invoke('drives:format', { diskId, formatType, name }),

  // Shared helpers used by the new views
  trashItems: (items) => ipcRenderer.invoke('trash:items', items),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  revealPath: (p) => ipcRenderer.invoke('shell:reveal', p),
});
