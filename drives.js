// Storage Drives view — diskutil-backed drive management and troubleshooting.
(function () {
  const CM = window.CM;
  const root = CM.$('view-drives');
  if (!root) return;

  let state = { volumes: [], selectedId: null, locks: {}, logs: {}, busy: {}, formatTypes: {} };

  const pctUsed = (v) => (v.totalSize && v.capacityInUse != null) ? Math.round((v.capacityInUse / v.totalSize) * 100) : 0;
  const fmtFs = (v) => v.filesystemUserVisibleName || v.filesystemName || 'Unknown FS';
  const isNtfs = (v) => /ntfs/i.test(`${v.filesystemName} ${v.filesystemUserVisibleName}`);
  const isExternal = (v) => v.external || v.removableOrExternal || v.ejectable;
  const canLockScan = (v) => Boolean(v.mountPoint && v.mountPoint.startsWith('/Volumes/'));
  const mountedBadge = (v) => `<span class="drive-badge ${v.mounted ? 'green' : 'muted'}">${v.mounted ? 'Mounted' : 'Unmounted'}</span>`;
  const healthClass = (s) => /verified|passing/i.test(s || '') ? 'green' : /fail|error|fatal/i.test(s || '') ? 'red' : 'muted';
  const busyText = (res) => `${res && (res.error || res.stderr || res.stdout || '')}`;
  const looksBusy = (res) => /busy|resource|in use|couldn't unmount|failed to unmount/i.test(busyText(res));

  function pickHero(volumes) {
    return volumes.find((v) => v.internal && v.mountPoint === '/') ||
      volumes.find((v) => v.internal && v.mountPoint === '/System/Volumes/Data') ||
      volumes.find((v) => isExternal(v) && v.mounted) ||
      volumes.find((v) => v.mounted) || volumes[0];
  }

  function metric(v, label, val) {
    return `<div class="drive-metric"><div>${CM.escapeHtml(label)}</div><strong>${CM.escapeHtml(val || '—')}</strong></div>`;
  }

  function heroHtml() {
    const hero = state.selectedId ? state.volumes.find((v) => v.id === state.selectedId) : pickHero(state.volumes);
    const pct = hero ? pctUsed(hero) : 0;
    const color = pct > 90 ? 'red' : pct > 75 ? 'amber' : 'green';
    const subtitle = hero ? `${hero.name} · ${fmtFs(hero)} · ${hero.mountPoint || 'not mounted'}` : 'No drives detected';
    return CMAC.stage({
      eyebrow: 'STORAGE DRIVES',
      orb: CMAC.orbHTML({ color }),
      title: hero ? `${pct}% used` : 'Storage inventory',
      sub: subtitle,
      actions: '<button class="cmac-cta ghost" data-refresh-drives>Refresh drives</button>',
    });
  }

  function summaryHtml() {
    const external = [...new Set(state.volumes.filter(isExternal).map((v) => v.ejectTarget || v.physicalWholeDiskId || v.id))].length;
    const mounted = state.volumes.filter((v) => v.mounted);
    const writable = state.volumes.filter((v) => v.writable);
    const badSmart = state.volumes.filter((v) => /fail|error|fatal/i.test(v.smartStatus || ''));
    return `<div class="drive-summary">
      ${metric(null, 'Connected external', String(external))}
      ${metric(null, 'Mounted volumes', String(mounted.length))}
      ${metric(null, 'Writable', String(writable.length))}
      ${metric(null, 'Health alerts', badSmart.length ? String(badSmart.length) : 'None')}
    </div>`;
  }

  function driveRow(v) {
    const used = v.capacityInUse != null ? CM.humanSize(v.capacityInUse) : '—';
    const total = v.totalSize != null ? CM.humanSize(v.totalSize) : '—';
    const pct = pctUsed(v);
    const smart = v.smartStatus || 'Not Supported';
    const mountLabel = v.mounted ? 'Unmount' : 'Mount';
    const external = isExternal(v);
    const writable = v.writable ? 'Writable' : (isNtfs(v) ? 'Read-only (NTFS)' : 'Read-only');
    const mountTarget = v.mountTarget || v.id;
    const unmountTarget = v.unmountTarget || v.id;
    const ejectTarget = v.ejectTarget || v.physicalWholeDiskId || v.id;
    const actionTarget = v.mounted ? unmountTarget : mountTarget;
    return `<div class="drive-row ${state.selectedId === v.id ? 'selected' : ''}" data-drive="${CM.escapeAttr(v.id)}">
      <div class="drive-row-main">
        <div class="cmac-row-ico ${external ? 'cyan' : 'green'}">${CMAC.svg(external ? 'plug' : 'harddrive')}</div>
        <div class="drive-nameblock">
          <div class="drive-name">${CM.escapeHtml(v.name || v.id)} <span class="drive-id">${CM.escapeHtml(v.id)}</span></div>
          <div class="drive-sub">${CM.escapeHtml(fmtFs(v))} · ${CM.escapeHtml(v.busProtocol || 'Unknown bus')} · ${v.solidState ? 'SSD' : 'HDD/Media'} · ${CM.escapeHtml(writable)}</div>
          <div class="drive-path">${CM.escapeHtml(v.mountPoint || 'No mount point')}</div>
        </div>
        <div class="drive-size">
          <strong>${CM.escapeHtml(used)} / ${CM.escapeHtml(total)}</strong>
          <div class="drive-bar"><span style="width:${Math.max(1, pct)}%"></span></div>
        </div>
        <div class="drive-health ${healthClass(smart)}">${CM.escapeHtml(smart)}</div>
        <div class="drive-state">${mountedBadge(v)}</div>
      </div>
      <div class="drive-controls">
        ${external ? `<button class="cmac-cta ghost" data-action="mount-toggle" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(actionTarget)}">${mountLabel}</button>` : ''}
        ${external && ejectTarget ? `<button class="cmac-cta ghost" data-action="eject" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(ejectTarget)}">Safe Eject</button>` : ''}
        <button class="cmac-cta" data-action="trouble" data-id="${CM.escapeAttr(v.id)}">Troubleshoot</button>
      </div>
      ${state.selectedId === v.id ? troubleHtml(v) : ''}
    </div>`;
  }

  function groupHtml(title, vols) {
    return `<section class="drive-section">
      <div class="cmac-section-head"><div class="cmac-section-title">${CM.escapeHtml(title)}</div><span class="cmac-count">${vols.length}</span></div>
      <div class="drive-list">${vols.length ? vols.map(driveRow).join('') : CMAC.empty({ icon: 'harddrive', title: `No ${title.toLowerCase()}`, sub: 'Connect a drive and refresh.' })}</div>
    </section>`;
  }

  function troubleHtml(v) {
    const log = state.logs[v.id];
    const locks = state.locks[v.id];
    const busy = state.busy[v.id];
    return `<div class="drive-trouble">
      <div class="drive-trouble-head">
        <div><strong>Troubleshooting</strong><span>${CM.escapeHtml(v.name || v.id)}</span></div>
        <button class="tiny" data-action="close-trouble" data-id="${CM.escapeAttr(v.id)}">Close</button>
      </div>
      ${isNtfs(v) ? `<div class="drive-note">NTFS detected: macOS includes native read-only NTFS support. For full write support, back up the data and reformat as APFS for Mac-only use or ExFAT for Mac/Windows compatibility.</div>` : ''}
      ${busy ? `<div class="drive-warning">The last drive operation needs attention. If mounting failed, use Mount with Admin and approve the macOS password prompt. If ejecting failed, review locking processes below.</div>` : ''}
      <div class="drive-trouble-actions">
        <button class="cmac-cta ghost" data-action="verify" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(v.verifyTarget || v.id)}">Run First Aid (Verify)</button>
        ${isExternal(v) && !v.mounted ? `<button class="cmac-cta ghost" data-action="mount-admin" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(v.mountTarget || v.id)}">Mount with Admin</button>` : ''}
        ${isExternal(v) ? `<button class="cmac-cta ghost" data-action="repair" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(v.repairTarget || v.id)}">Repair File System</button>` : ''}
        ${canLockScan(v) ? `<button class="cmac-cta ghost" data-action="locks" data-id="${CM.escapeAttr(v.id)}">Find Locking Processes</button>` : ''}
      </div>
      ${formatHtml(v)}
      ${locksHtml(v, locks)}
      ${log ? `<pre class="drive-log">${CM.escapeHtml(log)}</pre>` : ''}
    </div>`;
  }

  function formatHtml(v) {
    if (!isExternal(v)) return '';
    const types = Object.values(state.formatTypes || {});
    const target = v.ejectTarget || v.physicalWholeDiskId || v.id;
    const defaultName = (v.name || 'UNTITLED').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 32) || 'UNTITLED';
    const options = types.length ? types.map((t) => `<option value="${CM.escapeAttr(t.id)}" ${t.id === 'exfat' ? 'selected' : ''}>${CM.escapeHtml(t.label)}</option>`).join('') : '<option value="exfat">ExFAT (iOS + Windows)</option>';
    const selectedType = (state.formatTypes && state.formatTypes.exfat) || { description: 'Best for external drives shared with iPhone/iPad, Mac, and Windows.' };
    return `<div class="drive-format">
      <div class="drive-warning"><strong>Format drive</strong> permanently erases the whole external device ${CM.escapeHtml(target)}. Back up anything important first.</div>
      <div class="drive-format-row">
        <label>Type <select data-format-type="${CM.escapeAttr(v.id)}">${options}</select></label>
        <label>Name <input data-format-name="${CM.escapeAttr(v.id)}" value="${CM.escapeAttr(defaultName)}" maxlength="32"></label>
        <button class="cmac-cta red" data-action="format-drive" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(target)}">Format Drive</button>
      </div>
      <div class="drive-note">${CM.escapeHtml(selectedType.description || 'ExFAT is recommended for iOS and Windows compatibility.')}</div>
    </div>`;
  }

  function locksHtml(v, locks) {
    if (!locks) return '';
    if (!locks.ok) return `<div class="drive-warning">Could not inspect locks: ${CM.escapeHtml(locks.error || 'unknown error')}</div>`;
    const procs = locks.processes || [];
    if (!procs.length) return '<div class="drive-ok">No locking processes found by lsof.</div>';
    return `<div class="drive-locks">
      <div class="drive-locks-head"><strong>Locking processes</strong><button class="cmac-cta red" data-action="terminate-eject" data-id="${CM.escapeAttr(v.id)}" data-target="${CM.escapeAttr(v.ejectTarget || v.physicalWholeDiskId || v.id)}">Terminate & Eject</button></div>
      ${procs.map((p) => `<div class="drive-lock"><div><strong>${CM.escapeHtml(p.command)}</strong><span>PID ${p.pid} · ${p.count || 0} file(s)</span></div><button class="tiny red" data-action="kill-one" data-pid="${p.pid}" data-id="${CM.escapeAttr(v.id)}">Terminate</button></div>`).join('')}
    </div>`;
  }

  function render() {
    const external = state.volumes.filter(isExternal);
    const internal = state.volumes.filter((v) => !isExternal(v));
    root.innerHTML = `<div class="cmac-page drives-page">
      ${heroHtml()}
      ${summaryHtml()}
      ${groupHtml('External Devices', external)}
      ${groupHtml('Internal Storage', internal)}
    </div>`;
    const ctl = CMAC.orbControl(root.querySelector('[data-cmac-orb]'));
    const hero = state.selectedId ? state.volumes.find((v) => v.id === state.selectedId) : pickHero(state.volumes);
    ctl.setProgress(hero ? pctUsed(hero) : 0);
    ctl.center(`<div><span class="cmac-orb-num">${hero ? pctUsed(hero) : 0}</span><span class="cmac-orb-unit">%</span></div><div class="cmac-orb-label">used</div>`);
    wire();
  }

  async function refresh() {
    root.innerHTML = `<div class="cmac-page">${CMAC.loading('Reading diskutil inventory…')}</div>`;
    let res;
    try {
      if (window.api.getDriveFormatTypes) {
        try { state.formatTypes = await window.api.getDriveFormatTypes(); }
        catch (_e) { state.formatTypes = state.formatTypes || {}; }
      }
      res = await window.api.listDrives();
    } catch (e) {
      res = { ok: false, error: e.message || String(e) };
    }
    if (!res || res.ok === false) {
      root.innerHTML = `<div class="cmac-page">${CMAC.empty({ icon: 'alert', title: 'Could not read drives', sub: res && res.error ? res.error : 'diskutil failed' })}</div>`;
      return;
    }
    state.volumes = Array.isArray(res.volumes) ? res.volumes : [];
    if (state.selectedId && !state.volumes.some((v) => v.id === state.selectedId)) state.selectedId = null;
    render();
  }

  async function runAction(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || 'Working…';
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  async function safeUnmountOrEject(v, mode, btn) {
    const target = btn.dataset.target || (mode === 'eject' ? (v.ejectTarget || v.physicalWholeDiskId || v.id) : (v.unmountTarget || v.id));
    const res = await runAction(btn, mode === 'eject' ? 'Ejecting…' : 'Unmounting…', () =>
      mode === 'eject' ? window.api.ejectDrive(target) : window.api.unmountDrive(target, false));
    if (res && res.ok) {
      CM.toast(mode === 'eject' ? 'Drive ejected' : 'Drive unmounted', 'success');
      await refresh();
      return;
    }
    if (looksBusy(res) && v.mountPoint) {
      state.selectedId = v.id;
      state.busy[v.id] = true;
      state.logs[v.id] = busyText(res).trim();
      state.locks[v.id] = canLockScan(v) ? await window.api.getLockingProcesses(v.mountPoint) : { ok: false, processes: [], error: 'Volume is not mounted under /Volumes' };
      render();
      CM.toast('Drive is busy — locking processes shown', 'error');
      return;
    }
    CM.toast((res && res.error) || 'Operation failed', 'error');
  }

  async function wireAction(btn) {
    const id = btn.dataset.id;
    const v = state.volumes.find((x) => x.id === id);
    if (!v) return;
    const action = btn.dataset.action;
    if (action === 'mount-toggle') {
      if (v.mounted) return safeUnmountOrEject(v, 'unmount', btn);
      const res = await runAction(btn, 'Mounting…', () => window.api.mountDrive(btn.dataset.target || v.mountTarget || v.id));
      const mountedMsg = res && res.readOnly ? 'Drive mounted read-only' : 'Drive mounted';
      CM.toast(res && res.ok ? mountedMsg : ((res && res.error) || 'Mount failed'), res && res.ok ? 'success' : 'error');
      if (!res || !res.ok) {
        if (res && res.needsAdmin && confirm('macOS could not mount this drive normally. Try mounting it with administrator privileges?')) {
          const adminRes = await runAction(btn, 'Mounting…', () => window.api.mountDrive(btn.dataset.target || v.mountTarget || v.id, true));
          const adminMsg = adminRes && adminRes.readOnly ? 'Drive mounted read-only with admin' : 'Drive mounted with admin';
          CM.toast(adminRes && adminRes.ok ? adminMsg : ((adminRes && adminRes.error) || 'Admin mount failed'), adminRes && adminRes.ok ? 'success' : 'error');
          state.logs[id] = (adminRes && (adminRes.warning || adminRes.stdout || adminRes.error || '')).trim();
          if (adminRes && adminRes.ok) { await refresh(); return; }
        }
        state.selectedId = id;
        state.logs[id] = (res && (res.error || res.stdout)) || 'Mount failed';
        if (res && res.needsAdmin) state.busy[id] = true;
        render();
        return;
      }
      await refresh();
    } else if (action === 'eject') {
      return safeUnmountOrEject(v, 'eject', btn);
    } else if (action === 'trouble') {
      state.selectedId = state.selectedId === id ? null : id; render();
    } else if (action === 'close-trouble') {
      state.selectedId = null; render();
    } else if (action === 'verify') {
      const res = await runAction(btn, 'Verifying…', () => window.api.verifyVolume(btn.dataset.target || v.verifyTarget || v.id));
      state.logs[id] = (res.stdout || res.error || '').trim(); render();
    } else if (action === 'repair') {
      const res = await runAction(btn, 'Repairing…', () => window.api.repairVolume(btn.dataset.target || v.repairTarget || v.id));
      state.logs[id] = (res.stdout || res.error || '').trim(); render();
    } else if (action === 'mount-admin') {
      if (!confirm('Mount this external drive with administrator privileges? macOS may ask for your password.')) return;
      const res = await runAction(btn, 'Mounting…', () => window.api.mountDrive(btn.dataset.target || v.mountTarget || v.id, true));
      const mountedMsg = res && res.readOnly ? 'Drive mounted read-only with admin' : 'Drive mounted with admin';
      CM.toast(res && res.ok ? mountedMsg : ((res && res.error) || 'Admin mount failed'), res && res.ok ? 'success' : 'error');
      state.logs[id] = (res && (res.warning || res.stdout || res.error || '')).trim();
      if (res && res.ok) await refresh();
      else render();
    } else if (action === 'format-drive') {
      const target = btn.dataset.target || v.ejectTarget || v.physicalWholeDiskId || v.id;
      const typeEl = root.querySelector(`[data-format-type="${CSS.escape(id)}"]`);
      const nameEl = root.querySelector(`[data-format-name="${CSS.escape(id)}"]`);
      const formatType = typeEl ? typeEl.value : 'exfat';
      const name = nameEl ? nameEl.value : 'UNTITLED';
      const typeLabel = (state.formatTypes[formatType] && state.formatTypes[formatType].label) || formatType;
      if (!confirm(`Erase and format the whole external drive ${target} as ${typeLabel}?\n\nAll data on this drive will be permanently deleted.`)) return;
      const res = await runAction(btn, 'Formatting…', () => window.api.formatDrive(target, formatType, name));
      state.logs[id] = (res.stdout || res.error || '').trim();
      CM.toast(res && res.ok ? 'Drive formatted' : ((res && res.error) || 'Format failed'), res && res.ok ? 'success' : 'error');
      if (res && res.ok) await refresh();
      else render();
    } else if (action === 'locks') {
      if (!canLockScan(v)) { CM.toast('Volume is not mounted under /Volumes', 'error'); return; }
      state.locks[id] = await runAction(btn, 'Inspecting…', () => window.api.getLockingProcesses(v.mountPoint)); render();
    } else if (action === 'kill-one') {
      const res = await runAction(btn, 'Killing…', () => window.api.killProcess(Number(btn.dataset.pid), false));
      CM.toast(res && res.ok ? 'Process terminated' : ((res && res.error) || 'Terminate failed'), res && res.ok ? 'success' : 'error');
      if (canLockScan(v)) state.locks[id] = await window.api.getLockingProcesses(v.mountPoint);
      render();
    } else if (action === 'terminate-eject') {
      const procs = (state.locks[id] && state.locks[id].processes) || [];
      if (!confirm(`Terminate ${procs.length} locking process${procs.length === 1 ? '' : 'es'} and eject this external drive?`)) return;
      for (const p of procs) await window.api.killProcess(p.pid, false);
      await new Promise((r) => setTimeout(r, 700));
      const res = await window.api.ejectDrive(btn.dataset.target || v.ejectTarget || v.physicalWholeDiskId || v.id);
      CM.toast(res && res.ok ? 'Drive ejected' : ((res && res.error) || 'Eject failed'), res && res.ok ? 'success' : 'error');
      await refresh();
    }
  }

  function wire() {
    root.querySelectorAll('[data-refresh-drives]').forEach((b) => b.addEventListener('click', refresh));
    root.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => wireAction(b)));
    root.querySelectorAll('.drive-row[data-drive]').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.selectedId = row.dataset.drive;
      render();
    }));
  }

  async function load(force) {
    await refresh();
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS.drives = { load };
})();
