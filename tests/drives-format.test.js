const test = require('node:test');
const assert = require('node:assert/strict');

const drives = require('../electron/services/drives');

const {
  buildFormatDriveArgs,
  buildMountDriveArgs,
  getFormatTypes,
  shouldShowVolume,
} = drives._private;

test('exFAT format type is available for iOS and Windows compatibility', () => {
  const types = getFormatTypes();
  assert.deepEqual(types.exfat, {
    id: 'exfat',
    label: 'ExFAT (iOS + Windows)',
    filesystem: 'ExFAT',
    scheme: 'MBRFormat',
    description: 'Best for external drives shared with iPhone/iPad, Mac, and Windows.',
  });
});

test('format command uses safe diskutil eraseDisk args for ExFAT', () => {
  assert.deepEqual(buildFormatDriveArgs('disk4', 'exfat', 'Travel Photos'), [
    'eraseDisk',
    'ExFAT',
    'Travel Photos',
    'MBRFormat',
    'disk4',
  ]);
});

test('format command sanitizes unsafe volume names', () => {
  assert.deepEqual(buildFormatDriveArgs('disk4', 'exfat', '../Bad/Name\0'), [
    'eraseDisk',
    'ExFAT',
    'BadName',
    'MBRFormat',
    'disk4',
  ]);
});

test('format command rejects partitions and unknown format types', () => {
  assert.throws(() => buildFormatDriveArgs('disk4s1', 'exfat', 'USB'), /whole disk/i);
  assert.throws(() => buildFormatDriveArgs('disk4', 'ntfs', 'USB'), /format type/i);
});

test('mount command uses mountDisk for partition-map whole external disks', () => {
  assert.deepEqual(buildMountDriveArgs('disk5', {
    DeviceIdentifier: 'disk5',
    WholeDisk: true,
    VirtualOrPhysical: 'Physical',
    Content: 'GUID_partition_scheme',
    FilesystemName: '',
  }), ['mountDisk', 'disk5']);
});

test('mount command uses mount for actual volume partitions and whole-disk filesystems', () => {
  assert.deepEqual(buildMountDriveArgs('disk5s3', {
    DeviceIdentifier: 'disk5s3',
    WholeDisk: false,
    ParentWholeDisk: 'disk5',
    Content: 'Microsoft Basic Data',
    FilesystemName: 'ExFAT',
  }), ['mount', 'disk5s3']);

  assert.deepEqual(buildMountDriveArgs('disk6', {
    DeviceIdentifier: 'disk6',
    WholeDisk: true,
    VirtualOrPhysical: 'Physical',
    Content: 'Microsoft Basic Data',
    FilesystemName: 'ExFAT',
  }), ['mount', 'disk6']);
});

test('external EFI/service partitions are hidden from normal mount rows', () => {
  assert.equal(shouldShowVolume({
    id: 'disk5s1',
    isFilesystem: true,
    kind: 'volume',
    internal: false,
    external: true,
    content: 'EFI',
    name: 'NO NAME',
    mountPoint: null,
  }), false);

  assert.equal(shouldShowVolume({
    id: 'disk5s3',
    isFilesystem: true,
    kind: 'volume',
    internal: false,
    external: true,
    content: 'Microsoft Basic Data',
    name: 'Untitled',
    mountPoint: null,
  }), true);
});

test('read-only mount fallback is selected for damaged-volume diskutil failures', () => {
  const { buildReadOnlyMountArgs, shouldRetryMountReadOnly } = drives._private;
  assert.equal(shouldRetryMountReadOnly({
    stderr: 'Volume on disk5s3 failed to mount\nIf you think the volume is supported but damaged, try the "readOnly" option\n',
  }, ['mount', 'disk5s3']), true);
  assert.deepEqual(buildReadOnlyMountArgs('disk5s3'), ['mount', 'readOnly', 'disk5s3']);
  assert.equal(shouldRetryMountReadOnly({ stderr: 'Volume failed' }, ['mountDisk', 'disk5']), false);
});

test('admin diskutil script safely wraps validated mount command', () => {
  const { buildDiskutilAdminScript } = drives._private;
  assert.equal(
    buildDiskutilAdminScript(['mount', 'disk5s3']),
    `do shell script "'/usr/sbin/diskutil' 'mount' 'disk5s3'" with administrator privileges`,
  );
});

test('direct ExFAT fallback script mounts to a safe /Volumes path and retries raw device', () => {
  const { buildDirectExfatMountScript } = drives._private;
  assert.equal(
    buildDirectExfatMountScript('disk5s1', 'My Photos'),
    `do shell script "'/bin/mkdir' '-p' '/Volumes/My Photos' && ( '/sbin/mount_exfat' '-o' 'noowners' '/dev/disk5s1' '/Volumes/My Photos' || '/sbin/mount_exfat' '-o' 'noowners' '/dev/rdisk5s1' '/Volumes/My Photos' )" with administrator privileges`,
  );
  assert.equal(
    buildDirectExfatMountScript('disk5s1', '../Bad/Name\0'),
    `do shell script "'/bin/mkdir' '-p' '/Volumes/BadName' && ( '/sbin/mount_exfat' '-o' 'noowners' '/dev/disk5s1' '/Volumes/BadName' || '/sbin/mount_exfat' '-o' 'noowners' '/dev/rdisk5s1' '/Volumes/BadName' )" with administrator privileges`,
  );
});

test('direct ExFAT fallback is selected for opaque admin diskutil failures but not user cancellation', () => {
  const { shouldTryDirectExfatMount } = drives._private;
  const exfatInfo = { FilesystemName: 'ExFAT', FilesystemType: 'exfat', FilesystemUserVisibleName: 'ExFAT' };
  assert.equal(shouldTryDirectExfatMount({
    message: 'Command failed: /usr/bin/osascript -e do shell script "\'/usr/sbin/diskutil\' \'mount\' \'disk5s1\'" with administrator privileges',
  }, exfatInfo), true);
  assert.equal(shouldTryDirectExfatMount({ message: 'User canceled. (-128)' }, exfatInfo), false);
  assert.equal(shouldTryDirectExfatMount({ message: 'Command failed: /usr/bin/osascript' }, { FilesystemName: 'APFS' }), false);
});
