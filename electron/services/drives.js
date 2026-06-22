const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileP = promisify(execFile);
const DISKUTIL = '/usr/sbin/diskutil';
const PLUTIL = '/usr/bin/plutil';
const LSOF = '/usr/sbin/lsof';
const OSASCRIPT = '/usr/bin/osascript';
const DISK_ID_RE = /^disk\d+(?:s\d+)?$/i;
const MAX_BUFFER = 8 * 1024 * 1024;
const TIMEOUT = 30000;
const FORMAT_TYPES = Object.freeze({
  exfat: Object.freeze({
    id: 'exfat',
    label: 'ExFAT (iOS + Windows)',
    filesystem: 'ExFAT',
    scheme: 'MBRFormat',
    description: 'Best for external drives shared with iPhone/iPad, Mac, and Windows.',
  }),
  fat32: Object.freeze({
    id: 'fat32',
    label: 'MS-DOS (FAT32 legacy)',
    filesystem: 'MS-DOS FAT32',
    scheme: 'MBRFormat',
    description: 'Legacy compatibility for small drives; ExFAT is recommended for modern iOS and Windows.',
  }),
});

function okDiskId(diskId) {
  return typeof diskId === 'string' && DISK_ID_RE.test(diskId.trim());
}

function assertDiskId(diskId) {
  if (!okDiskId(diskId)) throw new Error('Invalid disk identifier');
  return diskId.trim();
}

function safeMountPoint(mountPoint) {
  if (typeof mountPoint !== 'string' || mountPoint.trim() === '') return false;
  const p = path.resolve(mountPoint);
  // Lock scanning is only intended for ejectable user-mounted volumes. Avoid
  // accidental lsof walks over / or macOS system volumes.
  return p.startsWith('/Volumes/') && p.length > '/Volumes/'.length;
}

function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, {
    maxBuffer: opts.maxBuffer || MAX_BUFFER,
    timeout: opts.timeout || TIMEOUT,
    env: { ...process.env, PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' },
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildDiskutilAdminScript(args) {
  if (!Array.isArray(args) || !args.length) throw new Error('Invalid diskutil args');
  const command = [DISKUTIL, ...args.map(String)].map(shellQuote).join(' ');
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}

function safeVolumeMountName(name) {
  return sanitizeVolumeName(name)
    .replace(/^\.+/, '')
    .replace(/[\\]/g, '')
    .trim() || 'UNTITLED';
}

function buildDirectExfatMountScript(diskId, name, readOnly = false) {
  const id = assertDiskId(diskId);
  const mountPoint = path.join('/Volumes', safeVolumeMountName(name));
  if (!safeMountPoint(mountPoint)) throw new Error('Invalid ExFAT mount point');
  const options = readOnly ? 'rdonly,noowners' : 'noowners';
  const blockMountArgs = ['/sbin/mount_exfat', '-o', options, `/dev/${id}`, mountPoint];
  const rawMountArgs = ['/sbin/mount_exfat', '-o', options, `/dev/r${id}`, mountPoint];
  const command = [shellQuote('/bin/mkdir'), shellQuote('-p'), shellQuote(mountPoint)].join(' ') +
    ' && ( ' + blockMountArgs.map(shellQuote).join(' ') +
    ' || ' + rawMountArgs.map(shellQuote).join(' ') + ' )';
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}

function runDiskutilAsAdmin(args, opts = {}) {
  return run(OSASCRIPT, ['-e', buildDiskutilAdminScript(args)], { timeout: opts.timeout || 120000, maxBuffer: opts.maxBuffer || MAX_BUFFER });
}

function runDirectExfatMountAsAdmin(diskId, name, readOnly = false) {
  return run(OSASCRIPT, ['-e', buildDirectExfatMountScript(diskId, name, readOnly)], { timeout: 120000, maxBuffer: MAX_BUFFER });
}

function execFileInput(cmd, args, input, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      maxBuffer: opts.maxBuffer || MAX_BUFFER,
      timeout: opts.timeout || TIMEOUT,
      env: { ...process.env, PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input || '');
  });
}

async function plistCommand(cmd, args) {
  const { stdout: plist } = await run(cmd, args);
  const { stdout: json } = await execFileInput(PLUTIL, ['-convert', 'json', '-o', '-', '-'], plist);
  return JSON.parse(json || '{}');
}

async function diskInfo(identifier) {
  const diskId = assertDiskId(identifier);
  return plistCommand(DISKUTIL, ['info', '-plist', diskId]);
}

function collectDiskIds(listPlist) {
  const ids = new Set();
  for (const disk of listPlist.AllDisksAndPartitions || []) {
    if (okDiskId(disk.DeviceIdentifier)) ids.add(disk.DeviceIdentifier);
    for (const store of disk.APFSPhysicalStores || []) {
      const id = store.DeviceIdentifier || store.APFSPhysicalStore;
      if (okDiskId(id)) ids.add(id);
    }
    for (const part of disk.Partitions || []) {
      if (okDiskId(part.DeviceIdentifier)) ids.add(part.DeviceIdentifier);
    }
    for (const vol of disk.APFSVolumes || []) {
      if (okDiskId(vol.DeviceIdentifier)) ids.add(vol.DeviceIdentifier);
    }
  }
  return [...ids];
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function volumeName(info) {
  return info.VolumeName || info.MediaName || info.IORegistryEntryName || info.DeviceNode || info.DeviceIdentifier || 'Unknown Volume';
}

function getFormatTypes() {
  return Object.fromEntries(Object.entries(FORMAT_TYPES).map(([key, value]) => [key, { ...value }]));
}

function sanitizeVolumeName(name) {
  const cleaned = String(name || '')
    .replace(/[\0/:]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 32);
  return cleaned || 'UNTITLED';
}

function buildFormatDriveArgs(diskId, formatType = 'exfat', volumeNameInput = 'UNTITLED') {
  const id = assertDiskId(diskId);
  if (/s\d+$/i.test(id)) throw new Error('Formatting requires a whole disk identifier, not a partition');
  const type = FORMAT_TYPES[String(formatType || '').toLowerCase()];
  if (!type) throw new Error('Unsupported format type');
  return ['eraseDisk', type.filesystem, sanitizeVolumeName(volumeNameInput), type.scheme, id];
}

function hasMountableFilesystem(info) {
  return Boolean(info && (info.FilesystemName || info.FilesystemType || info.FilesystemUserVisibleName || info.MountPoint || info.VolumeName));
}

function isPartitionMap(info) {
  return /^(GUID_partition_scheme|FDisk_partition_scheme|Apple_partition_scheme)$/i.test(String((info && info.Content) || ''));
}

function buildMountDriveArgs(diskId, info = {}) {
  const id = assertDiskId(diskId);
  if (info.DeviceIdentifier && assertDiskId(info.DeviceIdentifier) !== id) throw new Error('Disk info does not match mount target');
  if (info.WholeDisk === true && (!hasMountableFilesystem(info) || isPartitionMap(info))) return ['mountDisk', id];
  return ['mount', id];
}

function buildReadOnlyMountArgs(diskId) {
  return ['mount', 'readOnly', assertDiskId(diskId)];
}

function shouldRetryMountReadOnly(error, args) {
  if (!Array.isArray(args) || args[0] !== 'mount') return false;
  const text = `${(error && error.stderr) || ''}\n${(error && error.stdout) || ''}\n${(error && error.message) || ''}`;
  return /readOnly|read-only|damaged|dirty|failed to mount/i.test(text);
}

function isExfatVolume(info) {
  return Boolean(info && /exfat/i.test(`${info.FilesystemName || ''} ${info.FilesystemType || ''} ${info.FilesystemUserVisibleName || ''}`));
}

function shouldTryDirectExfatMount(error, info) {
  if (!isExfatVolume(info)) return false;
  const text = `${(error && error.stderr) || ''}\n${(error && error.stdout) || ''}\n${(error && error.message) || ''}`;
  if (/User canceled|user cancelled|\(-128\)/i.test(text)) return false;
  return /failed to mount|readOnly|read-only|NSPOSIXErrorDomain Code=1|Permission denied|Command failed:\s*\/usr\/bin\/osascript/i.test(text);
}

function isMountedInfo(info) {
  return Boolean(info && info.MountPoint);
}

async function assertMountedAfterSuccess(id, result, attemptedArgs) {
  const after = await diskInfo(id);
  if (isMountedInfo(after)) return after;
  const err = new Error(`Mount command reported success, but ${id} is still not mounted. macOS Disk Arbitration returned a false success.`);
  err.stdout = result && result.stdout || '';
  err.stderr = result && result.stderr || '';
  err.attemptedArgs = attemptedArgs;
  throw err;
}

function isExternalServicePartition(v) {
  if (!v || !v.external) return false;
  const content = String(v.content || '').trim();
  const name = String(v.name || '').trim();
  return /^(EFI|Microsoft Reserved|Windows Recovery|Apple_Boot|Apple_Recovery|Apple_APFS_ISC|Apple_APFS_Recovery)$/i.test(content) ||
    /^(EFI|NO NAME|Recovery|Windows RE|Microsoft Reserved)$/i.test(name) && /EFI|Reserved|Recovery/i.test(content);
}

function apfsStoreIds(info) {
  return (info.APFSPhysicalStores || [])
    .map((s) => s.DeviceIdentifier || s.APFSPhysicalStore)
    .filter(okDiskId);
}

function parentPhysicalDisk(info, infoMap) {
  const stores = apfsStoreIds(info);
  for (const storeId of stores) {
    const store = infoMap.get(storeId);
    if (store && okDiskId(store.ParentWholeDisk)) return store.ParentWholeDisk;
    if (okDiskId(storeId) && !/s\d+$/i.test(storeId)) return storeId;
  }
  if (okDiskId(info.ParentWholeDisk) && info.ParentWholeDisk !== info.DeviceIdentifier) {
    const parent = infoMap.get(info.ParentWholeDisk);
    if (parent && parent.VirtualOrPhysical === 'Virtual') return parentPhysicalDisk(parent, infoMap);
    return info.ParentWholeDisk;
  }
  return info.DeviceIdentifier;
}

function inferKind(info) {
  if ((info.FilesystemName || info.FilesystemUserVisibleName || info.MountPoint || info.VolumeName) && !(info.WholeDisk && info.VirtualOrPhysical === 'Virtual')) return 'volume';
  if (info.WholeDisk && info.VirtualOrPhysical === 'Physical') return 'physical';
  if (info.WholeDisk && info.VirtualOrPhysical === 'Virtual') return 'container';
  if (info.Content === 'Apple_APFS' && info.APFSContainerReference && !info.FilesystemName && !info.MountPoint) return 'apfs-store';
  if (info.APFSContainerReference && info.WholeDisk) return 'container';
  return 'partition';
}

function normalizeInfo(info, infoMap) {
  const id = info.DeviceIdentifier || '';
  const totalSize = numberOrNull(info.TotalSize ?? info.DiskSize ?? info.Size ?? info.APFSContainerSize);
  const capacityInUse = numberOrNull(info.CapacityInUse ?? info.VolumeUsedSpace);
  const mountPoint = info.MountPoint || null;
  const fsName = info.FilesystemName || info.FilesystemType || '';
  const fsVisible = info.FilesystemUserVisibleName || fsName || '';
  const smart = info.SMARTStatus || info.SmartStatus || 'Not Supported';
  const explicitInternal = info.Internal === true || info.OSInternal === true || info.OSInternalMedia === true;
  const removableOrExternal = info.RemovableMediaOrExternalDevice === true;
  const ejectable = info.Ejectable === true;
  const physicalWholeDiskId = parentPhysicalDisk(info, infoMap);
  const physicalInfo = infoMap.get(physicalWholeDiskId) || info;
  const busProtocol = info.BusProtocol || physicalInfo.BusProtocol || (explicitInternal ? 'Internal' : 'Unknown');
  const internal = explicitInternal || physicalInfo.Internal === true || physicalInfo.OSInternal === true || physicalInfo.OSInternalMedia === true;
  const external = removableOrExternal || ejectable || physicalInfo.RemovableMediaOrExternalDevice === true || physicalInfo.Ejectable === true || /USB|Thunderbolt|FireWire|SD|PCI-External/i.test(busProtocol);
  const kind = inferKind(info);
  const isFilesystem = Boolean(fsName || fsVisible || mountPoint || (kind === 'volume' && info.VolumeName));
  const ejectTarget = external && okDiskId(physicalWholeDiskId) ? physicalWholeDiskId : (ejectable ? id : null);

  return {
    id,
    kind,
    isFilesystem,
    deviceNode: info.DeviceNode || (id ? `/dev/${id}` : ''),
    name: volumeName(info),
    filesystemName: fsName,
    filesystemUserVisibleName: fsVisible,
    internal,
    external,
    removableOrExternal,
    mountPoint,
    mounted: Boolean(mountPoint),
    writable: info.Writable === true || info.WritableVolume === true,
    busProtocol,
    solidState: info.SolidState === true || physicalInfo.SolidState === true,
    smartStatus: smart,
    totalSize,
    capacityInUse,
    capacityFree: totalSize != null && capacityInUse != null ? Math.max(0, totalSize - capacityInUse) : null,
    content: info.Content || '',
    volumeUUID: info.VolumeUUID || '',
    diskUUID: info.DiskUUID || '',
    mediaName: info.MediaName || physicalInfo.MediaName || '',
    parentWholeDisk: info.ParentWholeDisk || '',
    physicalWholeDiskId,
    apfsContainerId: info.APFSContainerReference || '',
    apfsPhysicalStores: apfsStoreIds(info),
    mountTarget: isFilesystem ? id : null,
    unmountTarget: isFilesystem ? id : null,
    ejectTarget,
    verifyTarget: isFilesystem ? id : null,
    repairTarget: isFilesystem ? id : null,
    ejectable: Boolean(ejectTarget),
  };
}

function shouldShowVolume(v) {
  // Show real, actionable filesystems. Hide APFS physical stores and virtual
  // containers that made external APFS drives appear as broken duplicate rows.
  if (!v.isFilesystem) return false;
  if (v.kind === 'apfs-store' || v.kind === 'container') return false;
  if (v.kind === 'physical' && !v.mountTarget) return false;
  if (isExternalServicePartition(v)) return false;
  // Internal service volumes clutter the UI and expose unsafe controls. Keep the
  // main Data/root-visible volume for internal storage metrics; skip Preboot/VM/etc.
  if (v.internal && /^\/System\/Volumes\/(?!Data$)/.test(v.mountPoint || '')) return false;
  if (v.internal && /^(Preboot|Recovery|VM|Update|xART|Hardware|iSCPreboot)$/i.test(v.name || '')) return false;
  return true;
}

async function listDrives() {
  try {
    const list = await plistCommand(DISKUTIL, ['list', '-plist']);
    const ids = collectDiskIds(list);
    const settled = await Promise.allSettled(ids.map(async (id) => [id, await diskInfo(id)]));
    const infoMap = new Map(settled.filter((r) => r.status === 'fulfilled').map((r) => r.value));
    const all = [...infoMap.values()].map((info) => normalizeInfo(info, infoMap));
    const volumes = all
      .filter(shouldShowVolume)
      .sort((a, b) => Number(a.internal) - Number(b.internal) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const externalDevices = [...new Map(all
      .filter((v) => v.external && v.ejectTarget)
      .map((v) => [v.ejectTarget, {
        id: v.ejectTarget,
        name: (infoMap.get(v.ejectTarget) && volumeName(infoMap.get(v.ejectTarget))) || v.mediaName || v.name,
        busProtocol: v.busProtocol,
        solidState: v.solidState,
        smartStatus: v.smartStatus,
        totalSize: (infoMap.get(v.ejectTarget) && numberOrNull(infoMap.get(v.ejectTarget).TotalSize)) || v.totalSize,
      }])).values()];

    return {
      ok: true,
      volumes,
      devices: externalDevices,
      disks: list.AllDisksAndPartitions || [],
      errors: settled.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
    };
  } catch (e) {
    return { ok: false, volumes: [], devices: [], disks: [], error: e.stderr || e.message || String(e) };
  }
}

async function mountDrive(diskId, options = {}) {
  let infoForError = null;
  try {
    const id = assertDiskId(diskId);
    const info = await diskInfo(id);
    infoForError = info;
    const args = buildMountDriveArgs(id, info);
    if (options.admin && args[0] === 'mount' && shouldTryDirectExfatMount({ message: 'Command failed: /usr/bin/osascript' }, info)) {
      const result = await runDirectExfatMountAsAdmin(id, volumeName(info), false);
      const { stdout, stderr } = result;
      await assertMountedAfterSuccess(id, result, ['mount_exfat', 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))]);
      return {
        ok: true,
        command: OSASCRIPT,
        args: ['mount_exfat', 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))],
        stdout,
        stderr,
        readOnly: false,
        admin: true,
        warning: 'Mounted using the direct ExFAT fallback because macOS diskutil/FSKit could not mount this drive.',
      };
    }
    const runMount = options.admin ? runDiskutilAsAdmin : run;
    try {
      const result = await runMount(options.admin ? args : DISKUTIL, options.admin ? undefined : args);
      const { stdout, stderr } = result;
      await assertMountedAfterSuccess(id, result, args);
      return { ok: true, command: options.admin ? OSASCRIPT : DISKUTIL, args, stdout, stderr, readOnly: false, admin: Boolean(options.admin) };
    } catch (mountError) {
      if (!shouldRetryMountReadOnly(mountError, args)) {
        if (options.admin && shouldTryDirectExfatMount(mountError, info)) {
          const result = await runDirectExfatMountAsAdmin(id, volumeName(info), false);
          const { stdout, stderr } = result;
          await assertMountedAfterSuccess(id, result, ['mount_exfat', 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))]);
          return {
            ok: true,
            command: OSASCRIPT,
            args: ['mount_exfat', 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))],
            stdout,
            stderr,
            readOnly: false,
            admin: true,
            warning: 'Mounted using the direct ExFAT fallback because macOS diskutil/FSKit could not mount this drive.',
            originalError: mountError.stderr || mountError.message || String(mountError),
          };
        }
        throw mountError;
      }
      const readOnlyArgs = buildReadOnlyMountArgs(id);
      try {
        const result = await runMount(options.admin ? readOnlyArgs : DISKUTIL, options.admin ? undefined : readOnlyArgs);
        const { stdout, stderr } = result;
        await assertMountedAfterSuccess(id, result, readOnlyArgs);
        return {
          ok: true,
          command: options.admin ? OSASCRIPT : DISKUTIL,
          args: readOnlyArgs,
          stdout,
          stderr,
          readOnly: true,
          admin: Boolean(options.admin),
          warning: 'Mounted read-only because normal mounting failed. Back up the drive and repair or reformat it when possible.',
          originalError: mountError.stderr || mountError.message || String(mountError),
        };
      } catch (readOnlyError) {
        if (!options.admin || !shouldTryDirectExfatMount(readOnlyError, info)) throw readOnlyError;
        const directReadOnly = shouldTryDirectExfatMount(mountError, info);
        const result = await runDirectExfatMountAsAdmin(id, volumeName(info), directReadOnly);
        const { stdout, stderr } = result;
        await assertMountedAfterSuccess(id, result, ['mount_exfat', directReadOnly ? 'rdonly,noowners' : 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))]);
        return {
          ok: true,
          command: OSASCRIPT,
          args: ['mount_exfat', directReadOnly ? 'rdonly,noowners' : 'noowners', `/dev/${id}`, `/dev/r${id}`, path.join('/Volumes', safeVolumeMountName(volumeName(info)))],
          stdout,
          stderr,
          readOnly: directReadOnly,
          admin: true,
          warning: 'Mounted using the direct ExFAT fallback because macOS diskutil/FSKit could not mount this drive.',
          originalError: readOnlyError.stderr || readOnlyError.message || String(readOnlyError),
        };
      }
    }
  } catch (e) {
    const rawError = e.stderr || e.message || String(e);
    const fullDiskAccessHint = Boolean(options.admin && infoForError &&
      /exfat/i.test(`${infoForError.FilesystemName || ''} ${infoForError.FilesystemType || ''} ${infoForError.FilesystemUserVisibleName || ''}`) &&
      /mount_exfat|Operation not permitted|not permitted|Permission denied|deny\(1\)|file-read-data/i.test(`${rawError}\n${e.stdout || ''}`));
    const error = fullDiskAccessHint
      ? `${rawError}\n\nmacOS blocked direct ExFAT device access. Open System Settings > Privacy & Security > Full Disk Access, enable SmartShine, relaunch the app, then try Mount with Admin again.`
      : rawError;
    return {
      ok: false,
      error,
      stdout: e.stdout || '',
      code: e.code || null,
      needsAdmin: !options.admin && /failed to mount|permission|not permitted|authorization|readOnly|read-only/i.test(`${e.stderr || ''}\n${e.stdout || ''}\n${e.message || ''}`),
      needsFullDiskAccess: fullDiskAccessHint,
    };
  }
}

async function unmountDrive(diskId, force = false) {
  try {
    const id = assertDiskId(diskId);
    const args = /s\d+$/i.test(id) ? ['unmount'] : ['unmountDisk'];
    if (force) args.push('force');
    args.push(id);
    const { stdout, stderr } = await run(DISKUTIL, args);
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

async function ejectDrive(diskId) {
  try {
    const id = assertDiskId(diskId);
    const { stdout, stderr } = await run(DISKUTIL, ['eject', id]);
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

function parseLsof(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const byPid = new Map();
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const command = cols[0];
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = cols.slice(8).join(' ');
    const current = byPid.get(pid) || { pid, command, files: [] };
    if (name) current.files.push(name);
    byPid.set(pid, current);
  }
  return [...byPid.values()].map((p) => ({ ...p, files: [...new Set(p.files)].slice(0, 5), count: p.files.length }));
}

async function getLockingProcesses(mountPoint) {
  try {
    if (!safeMountPoint(mountPoint)) throw new Error('Invalid mount point');
    const real = fs.existsSync(mountPoint) ? fs.realpathSync(mountPoint) : path.resolve(mountPoint);
    if (!safeMountPoint(real)) throw new Error('Mount point is outside allowed volumes');
    const { stdout, stderr } = await run(LSOF, ['-nP', '+D', real], { timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, processes: parseLsof(stdout), stdout, stderr };
  } catch (e) {
    // lsof exits 1 when it finds no open files. Treat that as an empty result.
    const text = `${e.stdout || ''}${e.stderr || ''}`;
    if (e.code === 1 && !text.trim()) return { ok: true, processes: [] };
    if (e.code === 1 && e.stdout) return { ok: true, processes: parseLsof(e.stdout), stdout: e.stdout, stderr: e.stderr || '' };
    return { ok: false, processes: [], error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

async function verifyVolume(diskId) {
  try {
    const id = assertDiskId(diskId);
    const { stdout, stderr } = await run(DISKUTIL, ['verifyVolume', id], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

async function repairVolume(diskId) {
  try {
    const id = assertDiskId(diskId);
    const { stdout, stderr } = await run(DISKUTIL, ['repairVolume', id], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

async function formatDrive(diskId, formatType = 'exfat', name = 'UNTITLED') {
  try {
    const id = assertDiskId(diskId);
    if (/s\d+$/i.test(id)) throw new Error('Formatting requires selecting the whole external disk');
    const info = await diskInfo(id);
    const external = info.RemovableMediaOrExternalDevice === true || info.Ejectable === true || /USB|Thunderbolt|FireWire|SD|PCI-External/i.test(info.BusProtocol || '');
    const internal = info.Internal === true || info.OSInternal === true || info.OSInternalMedia === true;
    if (!info.WholeDisk) throw new Error('Formatting requires a whole disk identifier');
    if (internal || !external) throw new Error('Only external removable drives can be formatted');
    const args = buildFormatDriveArgs(id, formatType, name);
    const { stdout, stderr } = await run(DISKUTIL, args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message || String(e), stdout: e.stdout || '' };
  }
}

module.exports = {
  listDrives,
  mountDrive,
  unmountDrive,
  ejectDrive,
  getLockingProcesses,
  verifyVolume,
  repairVolume,
  formatDrive,
  _private: { okDiskId, safeMountPoint, parseLsof, shouldShowVolume, getFormatTypes, sanitizeVolumeName, buildFormatDriveArgs, buildMountDriveArgs, buildReadOnlyMountArgs, shouldRetryMountReadOnly, shouldTryDirectExfatMount, buildDiskutilAdminScript, buildDirectExfatMountScript, isExternalServicePartition },
};
