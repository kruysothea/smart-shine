// ===== Speed (Performance) view =====
// Mac-cleaner-style flow (landing → scan orb → category rows) on the
// cyberpunk CMAC component layer. Audits startup items + heavy background
// apps and frees inactive RAM.
// Registers itself as window.CM_VIEWS['speed'].
(function () {
  'use strict';

  const VIEW_ID = 'speed';
  let busy = false;   // guards overlapping scans (idempotent re-entry)
  let ctl = null;     // orb controller for the current stage
  let scanned = false; // whether we already have results on screen

  function el() { return document.getElementById('view-' + VIEW_ID); }
  function H() { return window.CM; } // shared helpers (escapeHtml, humanSize, toast…)

  // ---------- landing / stage ----------
  // Idempotent: only (re)builds the stage shell when missing.
  function ensureStage() {
    const root = el();
    if (!root) return;
    if (root.querySelector('[data-cmac-orb]')) return; // already mounted

    const C = window.CMAC;
    root.innerHTML = `<div class="cmac-page">
      ${C.stage({
        eyebrow: 'PERFORMANCE',
        orb: C.orbHTML({ color: 'green' }),
        title: 'Speed up your Mac',
        sub: 'Disable startup items and free memory to keep things snappy.',
      })}
      <div id="spd-results" class="spd-results"></div>
    </div>`;

    ctl = C.orbControl(root.querySelector('[data-cmac-orb]'));
    ctl.button('Scan', run, 'green');
    scanned = false;
  }

  // ---------- scan ----------
  async function run() {
    if (busy) return;
    busy = true;

    ensureStage();
    const root = el();
    const results = root && root.querySelector('#spd-results');
    if (ctl) ctl.scanning(true);
    if (results) results.innerHTML = window.CMAC.loading('Auditing startup items & background apps…');

    let data = null;
    try {
      data = await window.api.scanOptimization();
    } catch (e) {
      if (ctl) ctl.scanning(false);
      if (results) {
        results.innerHTML = window.CMAC.empty({
          icon: 'alert',
          title: 'Could not read performance data',
          sub: (e && e.message) || 'An unexpected error occurred while scanning.',
        });
      }
      busy = false;
      return;
    }

    render(data || {});
    busy = false;
  }

  // ---------- results ----------
  function render(data) {
    const root = el();
    if (!root) return;
    const results = root.querySelector('#spd-results');
    if (!results) return;

    const loginItems = Array.isArray(data.loginItems) ? data.loginItems : [];
    const launchAgents = Array.isArray(data.launchAgents) ? data.launchAgents : [];
    const heavyApps = Array.isArray(data.heavyApps) ? data.heavyApps : [];
    const mem = data.memory || { total: 0, used: 0, free: 0, usedPct: 0 };
    const memPct = Math.max(0, Math.min(100, Number(mem.usedPct) || 0));

    if (ctl) {
      ctl.scanning(false);
      ctl.setProgress(memPct);
      ctl.color(memPct >= 85 ? 'red' : memPct >= 65 ? 'amber' : 'green');
      ctl.stat(memPct, '%', 'Memory in use', { format: (n) => Math.round(n) });
    }
    scanned = true;

    results.innerHTML = `
      ${ramSection(mem)}
      ${section('Login Items', `${loginItems.length} item${loginItems.length === 1 ? '' : 's'}`, loginRows(loginItems))}
      ${section('Launch Agents', 'background helpers', agentRows(launchAgents))}
      ${section('Heavy background apps', `top ${heavyApps.length} by CPU + memory`, heavyRows(heavyApps))}
    `;

    wire();
  }

  function section(title, count, inner) {
    const cm = H();
    return `<div class="spd-section">
      <div class="cmac-section-head">
        <div class="cmac-section-title">${cm.escapeHtml(title)}</div>
        <div class="cmac-count">${cm.escapeHtml(count)}</div>
      </div>
      ${inner}
    </div>`;
  }

  // ----- Free Up RAM (prominent action) -----
  function ramSection(mem) {
    const cm = H();
    const used = cm.humanSize(mem.used || 0);
    const total = cm.humanSize(mem.total || 0);
    const free = cm.humanSize(mem.free || 0);
    return `<div class="spd-section">
      <div class="cmac-section-head">
        <div class="cmac-section-title">Free Up Memory</div>
        <div class="cmac-count">${cm.escapeHtml(used)} of ${cm.escapeHtml(total)} · ${cm.escapeHtml(free)} free</div>
      </div>
      <div class="spd-ram">
        <div class="spd-ram-body">
          <div class="spd-ram-ico">${window.CMAC.svg('ram', 22)}</div>
          <div>
            <div class="spd-ram-title">Flush inactive memory</div>
            <div class="spd-ram-sub">Releases cached pages so active apps get fresh headroom.</div>
          </div>
        </div>
        <button class="cmac-cta green" id="spd-free">Free Up RAM</button>
      </div>
    </div>`;
  }

  // ----- Login Items -----
  function loginRows(items) {
    const cm = H();
    const C = window.CMAC;
    if (!items.length) {
      return C.empty({
        icon: 'check',
        title: 'No login items',
        sub: 'Nothing extra opens automatically when you log in. Nice and lean.',
      });
    }
    const rows = items.map((it) => C.row({
      icon: 'power',
      iconColor: 'amber',
      name: it.name,
      sub: it.hidden ? 'Opens hidden at login' : 'Launches at login',
      control: `<button class="cmac-cta ghost spd-mini" data-remove="${cm.escapeAttr(it.name)}">Remove</button>`,
    })).join('');
    return `<div class="cmac-list cmac-stagger">${rows}</div>`;
  }

  // ----- Launch Agents -----
  function agentRows(items) {
    const cm = H();
    const C = window.CMAC;
    if (!items.length) {
      return C.empty({
        icon: 'plug',
        title: 'No launch agents',
        sub: 'No third-party background helpers are registered in your LaunchAgents folders.',
      });
    }
    const rows = items.map((a) => {
      const title = a.label || a.name || 'agent';
      const program = a.program || a.path || '';
      let control;
      let sub;
      if (a.scope === 'user') {
        const attrs = `data-toggle="${cm.escapeAttr(a.path)}" data-disabled="${a.disabled ? '1' : '0'}"`;
        control = C.toggle(!a.disabled, attrs);
        sub = (a.disabled ? 'Disabled · ' : 'Active · ') + program;
      } else {
        control = `<button class="cmac-cta ghost spd-mini" data-reveal="${cm.escapeAttr(a.path)}">Reveal</button>`;
        sub = (a.disabled ? 'Disabled · ' : 'System · ') + program;
      }
      return C.row({
        icon: 'plug',
        iconColor: a.scope === 'system' ? 'magenta' : '',
        name: title,
        sub,
        control,
      });
    }).join('');
    return `<div class="cmac-list cmac-stagger">${rows}</div>`;
  }

  // ----- Heavy background apps -----
  function heavyRows(items) {
    const cm = H();
    const C = window.CMAC;
    if (!items.length) {
      return C.empty({
        icon: 'cpu',
        title: 'Nothing hogging resources',
        sub: 'No heavy background apps detected. Your Mac has headroom to spare.',
      });
    }
    const rows = items.map((p) => {
      const cpu = Number(p.cpu) || 0;
      const color = cpu >= 80 ? 'red' : cpu >= 30 ? 'amber' : '';
      return C.row({
        icon: 'cpu',
        iconColor: color,
        name: p.name || 'process',
        sub: cpu.toFixed(1) + '% CPU · pid ' + p.pid,
        value: cm.humanSize(p.memBytes || 0),
        valueSub: 'memory',
        control: `<button class="cmac-cta danger spd-mini" data-quit="${cm.escapeAttr(String(p.pid))}" data-name="${cm.escapeAttr(p.name || '')}">Quit</button>`,
        dataset: { pid: String(p.pid) },
      });
    }).join('');
    return `<div class="cmac-list cmac-stagger">${rows}</div>`;
  }

  // ---------- events ----------
  function wire() {
    const cm = H();
    const root = el();
    if (!root) return;

    // Free Up RAM
    const freeBtn = root.querySelector('#spd-free');
    if (freeBtn) {
      freeBtn.addEventListener('click', async () => {
        freeBtn.disabled = true;
        const orig = freeBtn.textContent;
        freeBtn.innerHTML = '<span class="spin"></span> Freeing…';
        try {
          const res = await window.api.freeMemory();
          if (res && res.ok) {
            const gained = Math.max(0, (res.after || 0) - (res.before || 0));
            cm.toast(gained > 0 ? `Freed ${cm.humanSize(gained)} of inactive memory` : 'Memory flushed', 'success');
            run();
          } else if (res && res.needsSudo) {
            cm.toast(res.error || 'Run `sudo purge` in Terminal for a deep flush', 'error');
            freeBtn.disabled = false;
            freeBtn.textContent = orig;
          } else {
            cm.toast('Could not free memory' + (res && res.error ? ': ' + res.error : ''), 'error');
            freeBtn.disabled = false;
            freeBtn.textContent = orig;
          }
        } catch (e) {
          cm.toast('Could not free memory', 'error');
          freeBtn.disabled = false;
          freeBtn.textContent = orig;
        }
      });
    }

    // Login item remove
    root.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        const name = b.dataset.remove;
        b.disabled = true; b.textContent = '…';
        try {
          const res = await window.api.setLoginItem(name, false);
          if (res && res.ok) {
            cm.toast(`Removed ${name} from login items`, 'success');
            run();
          } else {
            cm.toast('Failed: ' + (res && res.error ? res.error : 'unknown'), 'error');
            b.disabled = false; b.textContent = 'Remove';
          }
        } catch (e) {
          cm.toast('Failed to remove login item', 'error');
          b.disabled = false; b.textContent = 'Remove';
        }
      });
    });

    // Launch agent toggle (user scope)
    root.querySelectorAll('[data-toggle]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const p = cb.dataset.toggle;
        const currentlyDisabled = cb.dataset.disabled === '1';
        const disable = !currentlyDisabled; // active → disable, disabled → enable
        cb.disabled = true;
        try {
          const res = await window.api.toggleLaunchAgent(p, disable);
          if (res && res.ok) {
            cm.toast(disable ? 'Launch agent disabled' : 'Launch agent enabled', 'success');
            run();
          } else {
            cm.toast(res && res.error ? res.error : 'Failed to toggle launch agent', 'error');
            cb.checked = !cb.checked; // revert
            cb.disabled = false;
          }
        } catch (e) {
          cm.toast('Failed to toggle launch agent', 'error');
          cb.checked = !cb.checked; // revert
          cb.disabled = false;
        }
      });
    });

    // Launch agent reveal (system scope)
    root.querySelectorAll('[data-reveal]').forEach((b) => {
      b.addEventListener('click', async () => {
        try { await window.api.revealPath(b.dataset.reveal); }
        catch (e) { cm.toast('Could not reveal in Finder', 'error'); }
      });
    });

    // Heavy app quit
    root.querySelectorAll('[data-quit]').forEach((b) => {
      b.addEventListener('click', async () => {
        const pid = Number(b.dataset.quit);
        const name = b.dataset.name || pid;
        b.disabled = true; b.textContent = '…';
        try {
          const res = await window.api.killProcess(pid);
          if (res && res.ok) {
            cm.toast(`Sent quit signal to ${name}`, 'success');
            setTimeout(() => run(), 800);
          } else {
            cm.toast('Failed: ' + (res && res.error ? res.error : 'unknown'), 'error');
            b.disabled = false; b.textContent = 'Quit';
          }
        } catch (e) {
          cm.toast('Failed to quit process', 'error');
          b.disabled = false; b.textContent = 'Quit';
        }
      });
    });
  }

  // ---------- load ----------
  async function load() {
    const root = el();
    if (!root) return;
    ensureStage();
    // Auto-run the first scan so the page is never blank beyond the landing.
    if (!scanned && !busy) run();
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS[VIEW_ID] = { load };
})();
