// Cloud Cleanup view — INSPECT + REVEAL ONLY (CleanMyMac-style flow, cyberpunk skin).
// Deleting a file inside a synced folder deletes it from the cloud everywhere,
// so this view never deletes/trashes anything. It only shows what is stored
// LOCALLY in cloud-synced folders and lets the user open items in Finder.
(function () {
  const CM = window.CM;
  const root = CM.$('view-cloud');
  if (!root) return;

  // Per-provider accent colors for the proportional bars.
  const PROVIDER_COLORS = {
    'iCloud Drive': 'var(--cyan)',
    'Dropbox': 'var(--magenta)',
    'Google Drive': 'var(--green)',
    'OneDrive': 'var(--amber)',
  };

  const HERO_SUB =
    'Shows what is stored locally in your cloud-synced folders. Deleting cloud ' +
    'files removes them everywhere — so this view is inspect-only; open items ' +
    'in Finder to manage them.';

  function colorFor(provider) {
    return PROVIDER_COLORS[provider] || 'var(--cyan)';
  }

  // ---- Reveal helper (shared by provider headers + folder rows) ----
  async function reveal(p) {
    if (!p) return;
    try {
      const res = await window.api.revealPath(p);
      if (res && res.ok === false) CM.toast('Could not reveal in Finder', 'error');
    } catch (e) {
      CM.toast('Could not reveal in Finder', 'error');
    }
  }

  function revealBtnHtml(path, label) {
    return `<button class="cmac-cta ghost cloud-reveal" data-reveal="${CM.escapeAttr(path)}">${CM.escapeHtml(label)}</button>`;
  }

  // ---- Results: one section per provider ----
  function providerSectionHtml(p) {
    const color = colorFor(p.provider);
    const top = Array.isArray(p.top) ? p.top : [];
    const maxSize = top.reduce((m, c) => Math.max(m, c.size || 0), 0) || 1;

    const head = `
      <div class="cmac-section-head cloud-section-head" style="--cloud-accent:${color}">
        <div class="cmac-section-title">
          ${CM.escapeHtml(p.provider)}
          ${p.account ? `<span class="cloud-account">${CM.escapeHtml(p.account)}</span>` : ''}
        </div>
        <div class="cloud-head-right">
          <span class="cmac-count cloud-total">${CM.escapeHtml(CM.humanSize(p.totalSize))}</span>
          ${revealBtnHtml(p.path, 'Reveal folder')}
        </div>
      </div>`;

    if (top.length === 0) {
      return `<div class="cloud-section">${head}
        <div class="cloud-noitems">No measurable local content in this folder.</div>
      </div>`;
    }

    const rows = top.map((c) => {
      const path = c.path || c.name || '';
      const pct = Math.max(2, Math.round(((c.size || 0) / maxSize) * 100));
      const bar = `
        <div class="cloud-bar" aria-hidden="true">
          <div class="cloud-bar-fill" style="width:${pct}%;background:${color};box-shadow:0 0 8px ${color}"></div>
        </div>`;
      const rowHtml = CMAC.row({
        icon: 'folder',
        name: c.name || path,
        sub: path,
        value: CM.humanSize(c.size),
        control: revealBtnHtml(path, 'Reveal'),
        dataset: { 'cloud-bar': pct },
      });
      // Inject the proportional bar under the row inside a wrapper so it spans full width.
      return `<div class="cloud-rowwrap" style="--cloud-accent:${color}">${rowHtml}${bar}</div>`;
    }).join('');

    return `<div class="cloud-section">${head}
      <div class="cmac-list cmac-stagger cloud-list">${rows}</div>
    </div>`;
  }

  function landingHtml(orbHtml) {
    return CMAC.stage({
      eyebrow: 'CLOUD',
      orb: orbHtml,
      title: 'Cloud storage',
      sub: HERO_SUB,
    });
  }

  function wireReveal() {
    root.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.addEventListener('click', () => reveal(btn.dataset.reveal));
    });
  }

  // ---- Scan + render ----
  async function run(ctl) {
    ctl.scanning(true);
    let providers = [];
    try {
      providers = await window.api.scanCloud();
    } catch (e) {
      providers = [];
    }
    ctl.scanning(false);

    if (!Array.isArray(providers) || providers.length === 0) {
      // Keep the orb (offer a re-scan) and show an honest empty state below.
      ctl.button('Scan', () => run(ctl));
      const results = root.querySelector('[data-cloud-results]');
      if (results) {
        results.innerHTML = CMAC.empty({
          icon: 'cloud',
          title: 'No cloud-sync folders detected',
          sub: 'iCloud Drive, Dropbox, Google Drive, OneDrive',
        });
      }
      return;
    }

    const sorted = providers.slice().sort((a, b) => (b.totalSize || 0) - (a.totalSize || 0));
    const grandTotal = sorted.reduce((sum, p) => sum + (p.totalSize || 0), 0);
    const n = sorted.length;

    // Headline number in the orb center: total local cloud footprint.
    ctl.color('green');
    ctl.stat(grandTotal, '', `across ${n} cloud${n === 1 ? '' : 's'}`, {
      format: (v) => CM.humanSize(v),
    });

    const results = root.querySelector('[data-cloud-results]');
    if (results) {
      results.innerHTML = sorted.map(providerSectionHtml).join('');
    }
    wireReveal();
  }

  async function load() {
    // Idempotent landing: orb with a center Scan button + an empty results region.
    root.innerHTML = `<div class="cmac-page cloud-page">
      ${landingHtml(CMAC.orbHTML())}
      <div class="cloud-results" data-cloud-results></div>
    </div>`;

    const orbEl = root.querySelector('[data-cmac-orb]');
    const ctl = CMAC.orbControl(orbEl);
    ctl.button('Scan', () => run(ctl));
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS['cloud'] = { load };
})();
