// Duplicate Files Finder — finds exact-content (hash-verified) duplicates and
// lets the user move extra copies to Trash, keeping the newest copy by default.
// Restyled to the CMAC CleanMyMac-style flow (cyberpunk skin).
(function () {
  'use strict';

  const root = document.getElementById('view-duplicates');
  if (!root) return;

  const CM = window.CM;
  const HOME_DOWNLOADS = '~/Downloads';

  // currentDir = null means "use service default (~/Downloads)".
  let currentDir = null;
  let scanning = false;
  let lastScan = null;

  // Live controller for the scan orb (re-created on every render()).
  let orb = null;

  const esc = (s) => CM.escapeHtml(s);
  const escA = (s) => CM.escapeAttr(s);

  function dirLabel() {
    return currentDir ? currentDir : HOME_DOWNLOADS;
  }

  // --------------------------------------------------------------
  // Top-level render: landing stage (orb + folder toolbar) + result slot.
  // --------------------------------------------------------------
  function render() {
    root.innerHTML = `
      <div class="cmac-page dup-page">
        ${window.CMAC.stage({
          eyebrow: 'CLEANUP',
          orb: window.CMAC.orbHTML({ size: 300 }),
          title: 'Find duplicate files',
          sub: 'Matches files with identical content (hash-verified).',
          actions: `
            <div class="cmac-toolbar dup-folderbar">
              <div class="dup-folder">
                <span class="dup-folder-label">Folder</span>
                <span class="dup-folder-path" id="dup-folder-path">${esc(dirLabel())}</span>
              </div>
              <button class="cmac-cta ghost" id="dup-pick" type="button">Choose Folder…</button>
            </div>`,
        })}
        <div id="dup-result" class="dup-result"></div>
      </div>
    `;

    orb = window.CMAC.orbControl(root.querySelector('[data-cmac-orb]'));
    CM.$('dup-pick').addEventListener('click', onPick);

    if (scanning) {
      enterScanningOrb();
      renderScanning();
    } else if (lastScan) {
      renderResult(lastScan);
    } else {
      // Idle: big round Scan button in the orb center.
      orb.button('Scan', onScan);
    }
  }

  async function onPick() {
    try {
      const picked = await window.api.pickFolder();
      if (picked) {
        currentDir = picked;
        const el = CM.$('dup-folder-path');
        if (el) el.textContent = picked;
      }
    } catch (e) {
      CM.toast('Could not open folder picker', 'error');
    }
  }

  function enterScanningOrb() {
    if (!orb) return;
    orb.color('');
    orb.scanning(true);
    orb.center('<div class="cmac-orb-status">Hashing files…</div>');
  }

  async function onScan() {
    if (scanning) return;
    scanning = true;
    enterScanningOrb();
    renderScanning();

    try {
      const data = await window.api.scanDuplicates(currentDir);
      lastScan = data || { dir: dirLabel(), scanned: 0, groups: [], totalReclaimable: 0 };
      // Adopt the resolved dir the service used (so re-scan targets the same folder).
      if (lastScan.dir) currentDir = lastScan.dir;
    } catch (e) {
      lastScan = { dir: dirLabel(), scanned: 0, groups: [], totalReclaimable: 0, error: e && e.message };
    }

    scanning = false;
    if (orb) orb.scanning(false);
    const pathEl = CM.$('dup-folder-path');
    if (pathEl) pathEl.textContent = dirLabel();
    renderResult(lastScan);
  }

  function renderScanning() {
    const out = CM.$('dup-result');
    if (!out) return;
    out.innerHTML = window.CMAC.loading('Hashing files…');
  }

  // --------------------------------------------------------------
  // Results: headline stat in the orb, group cards, sticky trash CTA.
  // --------------------------------------------------------------
  function renderResult(data) {
    const out = CM.$('dup-result');
    if (!out) return;

    const groups = (data && data.groups) || [];
    const scanned = (data && data.scanned) || 0;
    const totalReclaimable = (data && data.totalReclaimable) || 0;

    if (data && data.error) {
      if (orb) { orb.color('red'); orb.scanning(false); orb.button('Rescan', onScan); }
      out.innerHTML = window.CMAC.empty({
        icon: 'alert',
        title: 'Scan failed',
        sub: data.error,
      });
      return;
    }

    if (groups.length === 0) {
      if (orb) { orb.color('green'); orb.scanning(false); orb.button('Rescan', onScan); }
      out.innerHTML = window.CMAC.empty({
        icon: 'check',
        title: 'No duplicate files found',
        sub: `Every file in ${dirLabel()} has unique content.`,
      });
      return;
    }

    // Orb shows reclaimable bytes formatted as human size (e.g. "1.2 GB").
    if (orb) {
      orb.color('');
      orb.scanning(false);
      orb.stat(totalReclaimable, '', 'reclaimable', { format: (n) => CM.humanSize(n) });
    }

    const countLine = `Scanned ${CM.humanNum(scanned)} files · ${CM.humanNum(groups.length)} duplicate ${groups.length === 1 ? 'group' : 'groups'}`;

    const cards = groups.map((g, gi) => {
      // files[] arrives newest-first; index 0 is the copy we keep by default.
      const rows = g.files.map((f, fi) => {
        const kept = fi === 0;
        const subParts = ['modified ' + CM.ago(f.mtimeMs)];
        if (kept) subParts.push('KEEP');
        const control = kept
          ? `<span class="dup-keep-tag">KEEP</span>`
          : window.CMAC.check(
              `class="cmac-check red dup-cb" data-g="${gi}" data-f="${fi}" data-path="${escA(f.path)}" checked`
            );
        return window.CMAC.row({
          icon: 'file',
          iconColor: kept ? 'green' : '',
          name: f.path,
          sub: subParts.join(' · '),
          control: `${control}<button class="cmac-cta ghost dup-reveal" type="button" data-reveal="${escA(f.path)}">Reveal</button>`,
          selected: !kept,
          dataset: { g: gi },
        });
      }).join('');

      const head = `
        <div class="cmac-section-head dup-group-head">
          <div class="cmac-section-title">${esc(g.name || g.files[0].name)}</div>
          <div class="cmac-count">
            ${esc(CM.humanSize(g.size))} each · ${CM.humanNum(g.count)} copies · ${esc(CM.humanSize(g.reclaimable))} reclaimable
          </div>
        </div>`;

      return `
        <div class="dup-group" id="dup-group-${gi}">
          ${head}
          <div class="cmac-list cmac-stagger dup-files">${rows}</div>
        </div>`;
    }).join('');

    out.innerHTML = `
      <div class="cmac-section-head dup-result-head">
        <div class="cmac-count" id="dup-selinfo"></div>
        <button class="cmac-cta danger" id="dup-trash" type="button">Move selected to Trash</button>
      </div>
      <div class="dup-groups">${cards}</div>
    `;

    out.querySelectorAll('[data-reveal]').forEach((b) => {
      b.addEventListener('click', () => window.api.revealPath(b.dataset.reveal));
    });
    out.querySelectorAll('.dup-cb').forEach((cb) => {
      cb.addEventListener('change', updateSelInfo);
    });
    CM.$('dup-trash').addEventListener('click', onTrash);
    updateSelInfo();
  }

  function collectSelected() {
    const out = CM.$('dup-result');
    if (!out || !lastScan) return [];
    const items = [];
    out.querySelectorAll('.dup-cb:checked').forEach((cb) => {
      const gi = Number(cb.dataset.g);
      const group = lastScan.groups[gi];
      items.push({ path: cb.dataset.path, size: group ? group.size : 0 });
    });
    return items;
  }

  function updateSelInfo() {
    const info = CM.$('dup-selinfo');
    const trashBtn = CM.$('dup-trash');
    if (!info) return;
    const items = collectSelected();
    const bytes = items.reduce((s, i) => s + (i.size || 0), 0);
    info.textContent = items.length
      ? `${items.length} selected · ${CM.humanSize(bytes)} to free`
      : 'Nothing selected — newest copy of each group is kept.';
    if (trashBtn) trashBtn.disabled = items.length === 0;
  }

  async function onTrash() {
    const items = collectSelected();
    if (items.length === 0) { CM.toast('Nothing selected', 'error'); return; }
    const btn = CM.$('dup-trash');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Moving…'; }
    try {
      const res = await window.api.trashItems(items);
      if (res && res.cancelled) {
        if (btn) { btn.disabled = false; btn.textContent = 'Move selected to Trash'; }
        return;
      }
      if (res && res.ok) {
        const failNote = res.failed ? ` · ${res.failed} couldn't be moved` : '';
        CM.toast(`Freed ${CM.humanSize(res.freed)}${failNote}`, res.failed ? 'error' : 'success');
        showResultThenRescan(res.freed);
      } else {
        CM.toast('Move to Trash failed', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Move selected to Trash'; }
      }
    } catch (e) {
      CM.toast('Move to Trash failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Move selected to Trash'; }
    }
  }

  // Brief celebration block, then re-scan the same folder to refresh the list.
  function showResultThenRescan(freed) {
    const out = CM.$('dup-result');
    if (orb) { orb.color('green'); orb.scanning(false); }
    if (out) {
      out.innerHTML = window.CMAC.result({
        stat: CM.humanSize(freed),
        title: 'Duplicates removed',
      });
    }
    setTimeout(() => { onScan(); }, 1100);
  }

  async function load() {
    // Idempotent: rebuild the stage; preserve last scan results across nav/Refresh.
    render();
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS['duplicates'] = { load };
})();
