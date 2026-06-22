// App Manager (Uninstaller) — lists installed applications and removes an app
// together with its leftover support files via a reviewed Move-to-Trash flow.
// Restyled to the CleanMyMac-style CMAC layer (cyberpunk skin). The window.api
// calls and data shapes are unchanged from the original.
(function () {
  'use strict';

  const CM = window.CM;
  const root = document.getElementById('view-apps');
  if (!root) return;

  let apps = [];
  let tools = [];        // background / CLI tools that aren't .app bundles
  let toolsLoaded = false;
  let extensions = [];   // browser extensions
  let extsLoaded = false;
  let loadError = '';
  let filter = '';
  let sortMode = 'size'; // 'size' | 'name' | 'used'

  // --- helpers -------------------------------------------------------------
  function totalBytes(rows) {
    return rows.reduce((s, a) => s + (a.sizeBytes || 0), 0);
  }

  function sortApps(rows) {
    const out = rows.slice();
    if (sortMode === 'name') {
      out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sortMode === 'used') {
      // Most-recently used first; never-used apps sink to the bottom.
      out.sort((a, b) => (b.lastUsedTs || 0) - (a.lastUsedTs || 0));
    } else {
      out.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
    }
    return out;
  }

  function visibleApps() {
    let rows = apps;
    if (filter) {
      const q = filter.toLowerCase();
      rows = rows.filter((a) => (a.name || '').toLowerCase().includes(q));
    }
    return sortApps(rows);
  }

  function appSub(a) {
    const ver = a.version ? 'v' + a.version : 'no version';
    const used = a.lastUsedTs ? 'used ' + CM.ago(a.lastUsedTs) : 'never used';
    return ver + ' · ' + used;
  }

  // --- main render ---------------------------------------------------------
  function render() {
    const count = apps.length;
    const totBytes = totalBytes(apps);

    root.innerHTML = `
      <div class="cmac-page apps-page">
        <div class="cmac-section-head apps-head">
          <div class="apps-head-stats">
            <div class="apps-stat">
              <span class="apps-stat-num" data-count-apps>0</span>
              <span class="apps-stat-label">apps installed</span>
            </div>
            <div class="apps-stat-sep"></div>
            <div class="apps-stat">
              <span class="apps-stat-num apps-stat-size" data-count-size>—</span>
              <span class="apps-stat-label">total on disk</span>
            </div>
          </div>
        </div>
        <div class="cmac-sub apps-honest">Update checking isn’t available offline — versions shown are the installed ones.</div>

        ${loadError ? `<div class="apps-warn">${CM.escapeHtml(loadError)}</div>` : ''}

        ${count === 0
          ? CMAC.empty({
              icon: 'apps',
              title: 'No applications found',
              sub: 'Nothing was detected in /Applications, /Applications/Utilities or ~/Applications.',
            })
          : `
            <div class="cmac-toolbar apps-toolbar">
              <input id="apps-search" class="cmac-input" type="text" placeholder="Search applications…" value="${CM.escapeAttr(filter)}" autocomplete="off" spellcheck="false" />
              <div class="apps-sorts">
                <button class="cmac-cta ghost apps-sort ${sortMode === 'size' ? 'is-active' : ''}" data-sort="size">Size</button>
                <button class="cmac-cta ghost apps-sort ${sortMode === 'name' ? 'is-active' : ''}" data-sort="name">Name</button>
                <button class="cmac-cta ghost apps-sort ${sortMode === 'used' ? 'is-active' : ''}" data-sort="used">Last used</button>
              </div>
            </div>
            <div class="apps-list-wrap" id="apps-rows"></div>
          `}

        <div id="apps-tools"></div>
        <div id="apps-exts"></div>
      </div>
    `;

    // Count-up the headline numbers.
    const cApps = root.querySelector('[data-count-apps]');
    if (cApps) CMAC.countUp(cApps, count, { duration: 800 });
    const cSize = root.querySelector('[data-count-size]');
    if (cSize) cSize.textContent = CM.humanSize(totBytes);

    if (count > 0) renderRows();
    renderTools();
    renderExtensions();
    wireHeader();
  }

  // --- background tools & CLI (not .app) ----------------------------------
  function renderTools() {
    const wrap = document.getElementById('apps-tools');
    if (!wrap) return;
    const header = `
      <div class="cmac-section-head apps-tools-head">
        <div class="cmac-section-title">Background Tools &amp; CLI</div>
        <span class="cmac-count">${toolsLoaded ? tools.length + ' not shown as apps' : 'scanning…'}</span>
      </div>`;
    if (!toolsLoaded) {
      wrap.innerHTML = header + CMAC.loading('Scanning background tools & CLI installs…');
      return;
    }
    if (!tools.length) {
      wrap.innerHTML = header + CMAC.empty({ icon: 'check', title: 'No background tools found', sub: 'No CLI tools or background agents were detected in your hidden home folders.' });
      return;
    }
    const rows = tools.map((t, i) => {
      const running = t.pids && t.pids.length ? ` · running (${t.pids.length})` : '';
      const via = t.installMethod ? ` · via ${t.installMethod}` : '';
      return CMAC.row({
        icon: t.kind === 'agent' ? 'plug' : 'cpu',
        iconColor: t.kind === 'agent' ? 'amber' : 'magenta',
        name: t.name,
        sub: `${t.note}${running}${via} · ${t.path}`,
        value: CM.humanSize(t.sizeBytes),
        valueSub: t.kind === 'agent' ? 'agent' : 'cli',
        danger: true,
        dataset: { tool: String(i) },
        control: `<button class="cmac-cta ghost apps-uninstall-tool" data-tool="${i}">Uninstall</button>`,
      });
    }).join('');
    wrap.innerHTML = header + `
      <div class="apps-review-note">
        ${CMAC.svg('alert', 16)}
        <span>CLI tools &amp; background agents installed in hidden home folders (e.g. <code>~/.hermes</code>). Uninstall stops the tool, removes its login items, and moves it to the Trash — review each one.</span>
      </div>
      <div class="cmac-list cmac-stagger">${rows}</div>`;
    wrap.querySelectorAll('.apps-uninstall-tool').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = tools[Number(b.dataset.tool)];
        if (t) uninstallTool(t, b);
      });
    });
  }

  async function uninstallTool(tool, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Removing…';
    let res;
    try { res = await window.api.uninstallTool(tool); }
    catch (e) { res = { ok: false, error: e && e.message }; }
    if (res && res.cancelled) { btn.disabled = false; btn.textContent = 'Uninstall'; return; }
    if (res && res.ok) {
      const failNote = res.failed ? ` · ${res.failed} item(s) needed permission` : '';
      CM.toast(`Uninstalled ${tool.name} · freed ${CM.humanSize(res.freed || 0)}${failNote}`, res.failed ? 'error' : 'success');
      await load();
    } else {
      CM.toast('Uninstall failed' + (res && res.error ? ': ' + res.error : ''), 'error');
      btn.disabled = false; btn.textContent = 'Uninstall';
    }
  }

  function rowsHtml(rows) {
    return rows.map((a) => {
      const letter = (a.name || '?').trim().charAt(0).toUpperCase() || '?';
      return CMAC.row({
        iconText: letter,
        iconColor: a.source === 'user' ? 'magenta' : '',
        name: a.name,
        sub: appSub(a),
        value: CM.humanSize(a.sizeBytes),
        valueSub: a.source === 'user' ? 'user' : 'system',
        dataset: { path: a.path },
        control: `<button class="cmac-cta ghost apps-uninstall" data-uninstall="${CM.escapeAttr(a.path)}">Uninstall</button>`,
      });
    }).join('');
  }

  function renderRows() {
    const wrap = document.getElementById('apps-rows');
    if (!wrap) return;
    const rows = visibleApps();
    wrap.innerHTML = rows.length === 0
      ? `<div class="apps-norows">No apps match “${CM.escapeHtml(filter)}”.</div>`
      : `<div class="cmac-list cmac-stagger">${rowsHtml(rows)}</div>`;
    wireRows();
  }

  function wireHeader() {
    const input = document.getElementById('apps-search');
    if (input) {
      input.addEventListener('input', () => {
        filter = input.value || '';
        renderRows(); // re-render rows only so the input keeps focus
      });
    }
    root.querySelectorAll('.apps-sort').forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.dataset.sort;
        if (mode === sortMode) return;
        sortMode = mode;
        root.querySelectorAll('.apps-sort').forEach((x) => x.classList.toggle('is-active', x.dataset.sort === sortMode));
        renderRows();
      });
    });
  }

  function wireRows() {
    root.querySelectorAll('[data-uninstall]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = b.dataset.uninstall;
        const app = apps.find((a) => a.path === p);
        if (app) openUninstallPanel(app);
      });
    });
  }

  // --- uninstall panel -----------------------------------------------------
  async function openUninstallPanel(app) {
    closePanel();

    const overlay = document.createElement('div');
    overlay.className = 'apps-overlay';
    overlay.id = 'apps-overlay';
    overlay.innerHTML = `
      <div class="apps-panel" role="dialog" aria-modal="true">
        <div class="apps-panel-head">
          <div class="apps-panel-eyebrow">Uninstall</div>
          <div class="apps-panel-title">${CM.escapeHtml(app.name)}</div>
          <button class="apps-panel-x" id="apps-panel-x" aria-label="Close">${CMAC.svg('chevron', 16)}</button>
        </div>
        <div class="apps-panel-body" id="apps-panel-body">
          ${CMAC.loading('Searching for leftover files…')}
        </div>
      </div>
    `;
    root.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
    const x = document.getElementById('apps-panel-x');
    if (x) x.addEventListener('click', closePanel);

    let extra = [];
    try {
      extra = await window.api.appLeftovers(app.path);
    } catch {
      extra = [];
    }
    if (!Array.isArray(extra)) extra = [];

    // Panel may have been closed while awaiting; bail if so.
    if (!document.getElementById('apps-overlay')) return;
    renderPanelBody(app, extra);
  }

  function renderPanelBody(app, extra) {
    const body = document.getElementById('apps-panel-body');
    if (!body) return;

    const leftoverTotal = extra.reduce((s, l) => s + (l.size || 0), 0);
    const grandTotal = (app.sizeBytes || 0) + leftoverTotal;

    const bundleRow = CMAC.row({
      icon: 'apps',
      iconColor: 'red',
      name: app.name + '.app',
      sub: 'Application bundle · always removed',
      value: CM.humanSize(app.sizeBytes),
      control: `<input type="checkbox" class="cmac-check red" checked disabled aria-label="Application bundle (required)" />`,
    });

    const leftoverRows = extra.map((l, i) => CMAC.row({
      icon: l.kind && /cache/i.test(l.kind) ? 'broom' : 'file',
      name: l.path,
      sub: l.kind || 'Support file',
      value: CM.humanSize(l.size),
      control: CMAC.check(`class="cmac-check red apps-leftover-cb" data-idx="${i}" checked`),
    })).join('');

    body.innerHTML = `
      <div class="apps-review-note">
        ${CMAC.svg('alert', 16)}
        <span>Review before removing — checked items go to the Trash.</span>
      </div>
      <div class="cmac-list cmac-stagger apps-rm-list">
        ${bundleRow}
        ${extra.length === 0
          ? `<div class="apps-rm-empty">No leftover support files detected.</div>`
          : leftoverRows}
      </div>
      <div class="apps-panel-foot">
        <div class="apps-total">
          <span class="apps-total-label">Total to free</span>
          <span class="apps-total-val" id="apps-total-val">${CM.escapeHtml(CM.humanSize(grandTotal))}</span>
        </div>
        <div class="apps-panel-actions">
          <button class="cmac-cta ghost" id="apps-cancel">Cancel</button>
          <button class="cmac-cta danger" id="apps-confirm">${CMAC.svg('trash', 16)} Move to Trash</button>
        </div>
      </div>
    `;

    const recompute = () => {
      let t = app.sizeBytes || 0;
      body.querySelectorAll('.apps-leftover-cb:checked').forEach((cb) => {
        const l = extra[Number(cb.dataset.idx)];
        if (l) t += l.size || 0;
      });
      const el = document.getElementById('apps-total-val');
      if (el) el.textContent = CM.humanSize(t);
    };
    body.querySelectorAll('.apps-leftover-cb').forEach((cb) => cb.addEventListener('change', recompute));

    const cancel = document.getElementById('apps-cancel');
    if (cancel) cancel.addEventListener('click', closePanel);

    const confirm = document.getElementById('apps-confirm');
    if (confirm) confirm.addEventListener('click', () => doTrash(app, extra, confirm));
  }

  async function doTrash(app, extra, btn) {
    const body = document.getElementById('apps-panel-body');
    const items = [{ path: app.path, size: app.sizeBytes }];
    if (body) {
      body.querySelectorAll('.apps-leftover-cb:checked').forEach((cb) => {
        const l = extra[Number(cb.dataset.idx)];
        if (l) items.push({ path: l.path, size: l.size });
      });
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Removing…';
    let res;
    try {
      res = await window.api.trashItems(items);
    } catch (e) {
      res = { ok: false, error: e && e.message };
    }

    if (res && res.cancelled) {
      btn.disabled = false;
      btn.innerHTML = `${CMAC.svg('trash', 16)} Move to Trash`;
      return;
    }
    if (res && res.ok) {
      showPanelResult(res.freed || 0);
      // Brief celebration, then close + reload the list.
      setTimeout(async () => {
        closePanel();
        await load();
      }, 1400);
    } else {
      CM.toast('Uninstall failed' + (res && res.error ? ': ' + res.error : ''), 'error');
      btn.disabled = false;
      btn.innerHTML = `${CMAC.svg('trash', 16)} Move to Trash`;
    }
  }

  function showPanelResult(freed) {
    const body = document.getElementById('apps-panel-body');
    if (!body) return;
    body.innerHTML = CMAC.result({
      stat: CM.humanSize(freed),
      title: 'App removed',
      sub: 'Moved to Trash. You can restore it from the Trash if needed.',
    });
  }

  function closePanel() {
    const o = document.getElementById('apps-overlay');
    if (o) o.remove();
  }

  // --- load ----------------------------------------------------------------
  async function load() {
    root.innerHTML = `<div class="cmac-page apps-page">${CMAC.loading('Reading applications…')}</div>`;
    loadError = '';
    let data;
    try {
      data = await window.api.listApps();
    } catch (e) {
      data = [];
      loadError = 'Could not read applications' + (e && e.message ? ': ' + e.message : '.');
    }
    // Service may return an array, or { apps, error } on partial failure.
    if (Array.isArray(data)) {
      apps = data;
    } else if (data && Array.isArray(data.apps)) {
      apps = data.apps;
      if (data.error) loadError = 'Some folders could not be read: ' + String(data.error);
    } else {
      apps = [];
    }
    render();
    loadTools();      // async — the tools scan (du over big folders) shouldn't block the app list
    loadExtensions(); // async — browser extension scan
  }

  async function loadExtensions() {
    extsLoaded = false;
    renderExtensions();
    try { const d = await window.api.listExtensions(); extensions = Array.isArray(d) ? d : []; }
    catch { extensions = []; }
    extsLoaded = true;
    renderExtensions();
  }

  function renderExtensions() {
    const wrap = document.getElementById('apps-exts');
    if (!wrap) return;
    const header = `
      <div class="cmac-section-head apps-tools-head">
        <div class="cmac-section-title">Browser Extensions</div>
        <span class="cmac-count">${extsLoaded ? extensions.length + ' found' : 'scanning…'}</span>
      </div>`;
    if (!extsLoaded) { wrap.innerHTML = header + CMAC.loading('Scanning browser extensions…'); return; }
    if (!extensions.length) {
      wrap.innerHTML = header + CMAC.empty({ icon: 'grid', title: 'No browser extensions found', sub: 'Nothing detected in Chrome, Brave, Edge, Vivaldi, Arc or Firefox profiles.' });
      return;
    }
    const rows = extensions.map((x, i) => {
      const removable = x.removable !== false;
      const where = `${x.browser}${x.profile ? ' · ' + x.profile : ''}${x.version ? ' · v' + x.version : ''}`;
      const control = removable
        ? `<button class="cmac-cta ghost apps-rm-ext" data-ext="${i}">Remove</button>`
        : `<span class="apps-ext-managed">Manage in Safari</span>`;
      return CMAC.row({
        icon: 'grid',
        iconColor: removable ? '' : 'amber',
        name: x.name,
        sub: where,
        value: x.size ? CM.humanSize(x.size) : '',
        valueSub: 'extension',
        danger: removable,
        dataset: { ext: String(i) },
        control,
      });
    }).join('');
    wrap.innerHTML = header + `
      <div class="apps-review-note">
        ${CMAC.svg('alert', 16)}
        <span>Removing a Chromium/Firefox extension moves its files to the Trash. Quit the browser first for a clean removal. Safari extensions are bundled in their app — manage those in Safari.</span>
      </div>
      <div class="cmac-list cmac-stagger">${rows}</div>`;
    wrap.querySelectorAll('.apps-rm-ext').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const x = extensions[Number(b.dataset.ext)];
        if (x) removeExtension(x, b);
      });
    });
  }

  async function removeExtension(ext, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Removing…';
    let res;
    try { res = await window.api.trashItems([{ path: ext.path, size: ext.size }]); }
    catch (e) { res = { ok: false, error: e && e.message }; }
    if (res && res.cancelled) { btn.disabled = false; btn.textContent = 'Remove'; return; }
    if (res && res.ok) {
      CM.toast(`Removed “${ext.name}” · freed ${CM.humanSize(res.freed || 0)}`, res.failed ? 'error' : 'success');
      await loadExtensions();
    } else {
      CM.toast('Remove failed' + (res && res.error ? ': ' + res.error : ''), 'error');
      btn.disabled = false; btn.textContent = 'Remove';
    }
  }

  // Background / CLI tools that aren't .app bundles. Scanned separately so the
  // app list paints immediately while du runs over large folders.
  async function loadTools() {
    toolsLoaded = false;
    renderTools(); // show the "scanning…" state
    try { const td = await window.api.listTools(); tools = Array.isArray(td) ? td : []; }
    catch { tools = []; }
    toolsLoaded = true;
    renderTools();
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS['apps'] = { load };
})();
