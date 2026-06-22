// Protection (Malware Scan) view — heuristic signature scanner UI.
// CleanMyMac-style flow rendered with the shared CMAC components (cyberpunk skin).
// Registers into window.CM_VIEWS['protection']. No auto-scan on load.
// Keeps EXACT window.api calls + data handling: scanMalware(level), trashItems, revealPath.
(function () {
  const CM = window.CM;
  const VIEW = 'view-protection';

  let lastResult = null;   // last scan result payload
  let lastLevel = 'normal'; // currently selected level (also re-scan level)
  let scanning = false;

  // Scan levels — honest one-liners about speed vs. thoroughness.
  const LEVELS = [
    { id: 'quick', label: 'Quick', hint: 'Apps + launch agents — fast' },
    { id: 'normal', label: 'Normal', hint: '+ support dirs + browser extensions' },
    { id: 'deep', label: 'Deep', hint: '+ full home sweep — thorough, slower' },
  ];

  function levelHint(id) {
    const l = LEVELS.find(x => x.id === id);
    return l ? l.hint : '';
  }

  function sevColor(sev) {
    return sev === 'high' ? 'red' : (sev === 'medium' ? 'amber' : '');
  }
  function sevLabel(sev) {
    return sev === 'high' ? 'HIGH' : (sev === 'medium' ? 'MEDIUM' : 'LOW');
  }
  function secs(ms) {
    return ((Number(ms) || 0) / 1000).toFixed(1) + 's';
  }

  // ---- Render the landing stage: shield orb + level selector + Scan button. ----
  function renderLanding() {
    const root = CM.$(VIEW);
    if (!root) return;

    const orb = CMAC.orbHTML({ color: 'green' });
    const chips = LEVELS.map(l =>
      `<button class="cmac-cta ghost mal-level ${l.id === lastLevel ? 'active' : ''}" data-level="${CM.escapeAttr(l.id)}">${CM.escapeHtml(l.label)}</button>`
    ).join('');

    const selector = `
      <div class="mal-levels" role="group" aria-label="Scan level">${chips}</div>
      <div class="mal-level-hint" id="mal-level-hint">${CM.escapeHtml(levelHint(lastLevel))}</div>`;

    root.innerHTML = `<div class="cmac-page">${CMAC.stage({
      eyebrow: 'PROTECTION',
      orb,
      title: 'Scan for malware',
      sub: 'Heuristic signature scan for known Mac adware/PUPs — not a full antivirus engine.',
      actions: selector,
    })}<div id="mal-results"></div></div>`;

    // Orb controller — Scan button drives the currently selected level.
    const orbEl = root.querySelector('[data-cmac-orb]');
    const ctl = CMAC.orbControl(orbEl);
    ctl.button('Scan', () => runScan(lastLevel), 'green');
    root._malOrb = ctl;

    wireLevelSelector();

    // Re-render existing results if we already scanned this session.
    if (lastResult) renderResults(lastResult);
  }

  function wireLevelSelector() {
    const root = CM.$(VIEW);
    if (!root) return;
    root.querySelectorAll('.mal-level').forEach(btn => {
      btn.addEventListener('click', () => {
        if (scanning) return;
        lastLevel = btn.dataset.level;
        root.querySelectorAll('.mal-level').forEach(b =>
          b.classList.toggle('active', b.dataset.level === lastLevel));
        const hint = CM.$('mal-level-hint');
        if (hint) hint.textContent = levelHint(lastLevel);
      });
    });
  }

  async function runScan(level) {
    const root = CM.$(VIEW);
    if (!root || scanning) return;
    const ctl = root._malOrb;
    if (!ctl) return;

    scanning = true;
    lastLevel = level;
    clearOrbRescan();

    // Lock the level chips, light up the active one.
    root.querySelectorAll('.mal-level').forEach(b => {
      b.disabled = true;
      b.classList.toggle('active', b.dataset.level === level);
    });

    // Orb: scanning state + status text in the center.
    ctl.color('');
    ctl.scanning(true);
    ctl.center(`<div class="cmac-orb-status">Scanning…</div>
      <div class="cmac-orb-label">${CM.escapeHtml(level)} scan</div>`);

    const results = CM.$('mal-results');
    if (results) results.innerHTML = CMAC.loading('Scanning ' + level + ' for known threats…');

    let data;
    try {
      data = await window.api.scanMalware(level);
    } catch (e) {
      scanning = false;
      ctl.scanning(false);
      ctl.color('amber');
      ctl.center(`<div class="cmac-orb-status">Scan failed</div>`);
      root.querySelectorAll('.mal-level').forEach(b => { b.disabled = false; });
      if (results) {
        results.innerHTML = CMAC.empty({
          icon: 'alert',
          title: 'Scan failed',
          sub: (e && e.message ? e.message : String(e)),
        });
      }
      // Restore the Scan button so the user can retry.
      restoreScanButton();
      return;
    }

    ctl.scanning(false);
    scanning = false;
    lastResult = data || {};
    root.querySelectorAll('.mal-level').forEach(b => { b.disabled = false; });
    renderResults(lastResult);
  }

  // Put the Scan button back in the orb center (used after an error/retry).
  function restoreScanButton() {
    const root = CM.$(VIEW);
    const ctl = root && root._malOrb;
    if (ctl) ctl.button('Scan', () => runScan(lastLevel), 'green');
  }

  // After results, let the user click the orb (now showing the stat) to re-scan.
  function makeOrbRescannable() {
    const root = CM.$(VIEW);
    const ctl = root && root._malOrb;
    if (!ctl || !ctl.el) return;
    ctl.el.classList.add('mal-rescan');
    ctl.el.title = 'Click to scan again';
    if (ctl.el._malRescanHandler) ctl.el.removeEventListener('click', ctl.el._malRescanHandler);
    const handler = () => { if (!scanning) runScan(lastLevel); };
    ctl.el._malRescanHandler = handler;
    ctl.el.addEventListener('click', handler);
  }

  // Stop the orb acting as a re-scan target (while it holds the Scan button).
  function clearOrbRescan() {
    const root = CM.$(VIEW);
    const ctl = root && root._malOrb;
    if (!ctl || !ctl.el) return;
    ctl.el.classList.remove('mal-rescan');
    ctl.el.removeAttribute('title');
    if (ctl.el._malRescanHandler) {
      ctl.el.removeEventListener('click', ctl.el._malRescanHandler);
      ctl.el._malRescanHandler = null;
    }
  }

  function renderResults(data) {
    const root = CM.$(VIEW);
    const results = CM.$('mal-results');
    const ctl = root && root._malOrb;
    if (!results || !ctl) return;

    const threats = Array.isArray(data.threats) ? data.threats : [];
    const agents = Array.isArray(data.suspiciousAgents) ? data.suspiciousAgents : [];
    const exts = Array.isArray(data.browserExtensions) ? data.browserExtensions : [];
    const issues = threats.length;
    const scanned = Number(data.scannedCount) || 0;
    const dur = secs(data.durationMs);
    const level = data.level || lastLevel || '';

    // Orb headline number. Clicking the orb re-scans at the selected level.
    if (issues === 0) {
      ctl.color('green');
      ctl.stat(0, '', 'threats');
    } else {
      ctl.color('red');
      ctl.stat(issues, '', issues === 1 ? 'threat found' : 'threats found');
    }
    makeOrbRescannable();

    let html = '';

    // ---- Clean state ----
    if (issues === 0) {
      html += CMAC.result({
        stat: '0',
        title: 'No known threats',
        sub: `Scanned ${CM.humanNum(scanned)} items in ${dur}. Heuristic match against the bundled Mac adware/PUP list — stay cautious with downloads.`,
      });
    } else {
      // ---- Threats section ----
      html += `<div class="cmac-section-head">
        <div class="cmac-section-title">Threats</div>
        <div class="cmac-count">${issues} ${issues === 1 ? 'match' : 'matches'}</div>
      </div>`;
      html += '<div class="cmac-list cmac-stagger">';
      threats.forEach((t, idx) => {
        const attrs = `checked data-threat="${idx}" data-path="${CM.escapeAttr(t.path || '')}" data-size="${CM.escapeAttr(String(t.size || 0))}"`;
        html += CMAC.row({
          icon: 'alert',
          iconColor: sevColor(t.severity),
          name: t.name || (t.path || 'Unknown'),
          sub: `${sevLabel(t.severity)} · ${t.reason || ''}`,
          value: CM.humanSize(t.size || 0),
          control: CMAC.check(attrs),
          danger: t.severity === 'high',
          dataset: { path: t.path || '' },
        });
      });
      html += '</div>';
      html += `<div class="cmac-actions mal-act">
        <button class="cmac-cta danger" id="mal-quarantine">Quarantine selected</button>
        <span class="mal-note">Selected items move to Trash — reversible.</span>
      </div>`;
    }

    // ---- Suspicious launch agents section ----
    html += `<div class="cmac-section-head mal-sec">
      <div class="cmac-section-title">Suspicious launch agents</div>
      <div class="cmac-count">${agents.length} flagged</div>
    </div>`;
    if (agents.length === 0) {
      html += CMAC.empty({
        icon: 'check',
        title: 'No suspicious launch agents',
        sub: 'No launch agents/daemons used temp paths, hidden folders, or download/scripting commands.',
      });
    } else {
      html += '<div class="cmac-list cmac-stagger">';
      agents.forEach((a, idx) => {
        const sub = [a.reason, a.program].filter(Boolean).join(' · ');
        html += CMAC.row({
          icon: 'plug',
          iconColor: 'amber',
          name: a.label || a.path || 'Launch agent',
          sub: sub,
          control: `<button class="cmac-cta ghost mal-reveal" data-agent="${idx}">Reveal</button>`,
          dataset: { path: a.path || '' },
        });
      });
      html += '</div>';
    }

    // ---- Browser extensions (review) section — informational only ----
    html += `<div class="cmac-section-head mal-sec">
      <div class="cmac-section-title">Browser extensions (review)</div>
      <div class="cmac-count">${exts.length} · informational</div>
    </div>`;
    if (exts.length === 0) {
      html += CMAC.empty({
        icon: 'grid',
        title: 'No readable browser extensions',
        sub: 'Chrome, Safari, and Firefox extension folders were empty or not readable.',
      });
    } else {
      html += '<div class="cmac-list cmac-stagger">';
      exts.forEach(x => {
        html += CMAC.row({
          icon: 'grid',
          iconColor: 'magenta',
          name: x.name || 'Extension',
          sub: `${x.browser || ''} · ${x.path || ''}`,
          value: x.browser || '',
        });
      });
      html += '</div>';
      html += '<div class="mal-note mal-ext-note">Listed for your review only — not flagged as threats.</div>';
    }

    // ---- Footer count ----
    html += `<div class="cmac-count mal-foot">Scanned ${CM.humanNum(scanned)} items · ${dur} · ${CM.escapeHtml(level)} scan</div>`;

    results.innerHTML = html;
    wireResultEvents(threats, agents);
  }

  function wireResultEvents(threats, agents) {
    const results = CM.$('mal-results');
    if (!results) return;

    // Reveal launch agents in Finder.
    results.querySelectorAll('.mal-reveal').forEach(b => {
      b.addEventListener('click', () => {
        const a = agents[Number(b.dataset.agent)];
        if (a && a.path) window.api.revealPath(a.path);
      });
    });

    // Quarantine selected threats.
    const qBtn = CM.$('mal-quarantine');
    if (qBtn) {
      qBtn.addEventListener('click', async () => {
        const items = [];
        results.querySelectorAll('.cmac-check:checked').forEach(cb => {
          const path = cb.getAttribute('data-path');
          const size = Number(cb.getAttribute('data-size')) || 0;
          if (path) items.push({ path, size });
        });
        if (items.length === 0) { CM.toast('Nothing selected', 'error'); return; }

        qBtn.disabled = true;
        const origText = qBtn.textContent;
        qBtn.innerHTML = '<span class="spin"></span> Quarantining…';

        let res;
        try {
          res = await window.api.trashItems(items);
        } catch (e) {
          CM.toast('Quarantine failed', 'error');
          qBtn.disabled = false; qBtn.textContent = origText;
          return;
        }
        if (res && res.cancelled) {
          qBtn.disabled = false; qBtn.textContent = origText;
          CM.toast('Cancelled');
          return;
        }
        if (res && res.ok) {
          const failNote = res.failed ? ` · ${res.failed} couldn't be moved` : '';
          CM.toast(`Quarantined ${res.removed || items.length} item(s) · freed ${CM.humanSize(res.freed || 0)}${failNote}`, res.failed ? 'error' : 'success');

          // Brief success celebration, then re-scan at the same level to refresh.
          results.innerHTML = CMAC.result({
            stat: String(res.removed || items.length),
            title: 'Quarantined',
            sub: `Moved to Trash · freed ${CM.humanSize(res.freed || 0)}${failNote}. Re-scanning…`,
          });
          setTimeout(() => runScan(lastLevel || 'quick'), 700);
        } else {
          CM.toast('Quarantine failed', 'error');
          qBtn.disabled = false; qBtn.textContent = origText;
        }
      });
    }
  }

  // Called on nav + Refresh. Idempotent: rebuild the landing; renderLanding()
  // re-renders prior results if a scan already ran this session.
  async function load() {
    renderLanding();
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS['protection'] = { load };
})();
