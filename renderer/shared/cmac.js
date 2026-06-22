// ============================================================
// CMAC — shared CleanMyMac-style UI helpers (cyberpunk skin)
// Exposes window.CMAC used by every feature view. Depends on
// window.CM (helpers from app.js) being available at call time.
// ============================================================
(function () {
  const esc = (s) => (window.CM ? window.CM.escapeHtml(s) : String(s ?? ''));
  const escA = (s) => (window.CM ? window.CM.escapeAttr(s) : String(s ?? ''));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  // --- Animated number count-up. format(n) -> string. ---
  function countUp(el, to, opts = {}) {
    if (!el) return;
    const { from = 0, duration = 900, format = (n) => String(Math.round(n)) } = opts;
    const start = performance.now();
    const delta = to - from;
    function frame(now) {
      const p = Math.min(1, (now - start) / duration);
      el.textContent = format(from + delta * easeOut(p));
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = format(to);
    }
    requestAnimationFrame(frame);
  }

  // --- Monoline inline SVG icon set (stroke = currentColor) ---
  const ICONS = {
    bolt: "<path d='M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z'/>",
    shield: "<path d='M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'/><path d='M9 12l2 2 4-4'/>",
    broom: "<path d='M19 5l-7 7'/><path d='M14 7l3 3'/><path d='M11 10l-5 5c-1 1-1 3 0 4s3 1 4 0l5-5'/>",
    lens: "<circle cx='11' cy='11' r='7'/><path d='M16 16l5 5'/>",
    copy: "<rect x='8' y='8' width='12' height='12' rx='1'/><path d='M4 16V5a1 1 0 0 1 1-1h11'/>",
    cloud: "<path d='M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 18 18z'/>",
    apps: "<rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/>",
    trash: "<path d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/>",
    folder: "<path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>",
    file: "<path d='M6 2h8l4 4v16H6z'/><path d='M14 2v4h4'/>",
    cpu: "<rect x='6' y='6' width='12' height='12' rx='1'/><path d='M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3'/>",
    ram: "<rect x='3' y='7' width='18' height='10' rx='1'/><path d='M7 17v3M12 17v3M17 17v3'/>",
    power: "<path d='M12 3v9'/><path d='M7 6a8 8 0 1 0 10 0'/>",
    rocket: "<path d='M5 15c-1 3 0 4 0 4s1 1 4 0'/><path d='M9 15l-3-3 6-7c3-3 7-3 7-3s0 4-3 7l-7 6z'/><circle cx='14.5' cy='9.5' r='1.2'/>",
    check: "<path d='M5 13l4 4L19 7'/>",
    alert: "<path d='M12 3l9 16H3z'/><path d='M12 10v4M12 17v.5'/>",
    plug: "<path d='M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0z'/><path d='M12 16v6'/>",
    harddrive: "<rect x='2' y='2' width='20' height='20' rx='2' ry='2'/><path d='M2 14h20M6 18h.01M10 18h.01'/>",
    grid: "<rect x='3' y='3' width='8' height='8'/><rect x='13' y='3' width='8' height='8'/><rect x='3' y='13' width='8' height='8'/><rect x='13' y='13' width='8' height='8'/>",
    chevron: "<path d='M9 6l6 6-6 6'/>",
  };
  function svg(name, size = 19) {
    const body = ICONS[name] || ICONS.file;
    return `<svg viewBox='0 0 24 24' width='${size}' height='${size}' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  }

  // --- Big scan orb. orbHTML() -> string; control(el) -> controller. ---
  function orbHTML(opts = {}) {
    const { size = 300, color = '' } = opts; // color: '' | 'green' | 'amber' | 'red'
    const r = 0.435 * size, cx = size / 2;
    const circ = (2 * Math.PI * r).toFixed(1);
    return `<div class="cmac-orb ${color}" style="--orb:${size}px;--circ:${circ}" data-cmac-orb>
      <svg viewBox="0 0 ${size} ${size}">
        <circle class="cmac-ring-track" cx="${cx}" cy="${cx}" r="${r}"/>
        <circle class="cmac-ring-dash"  cx="${cx}" cy="${cx}" r="${(r - 14).toFixed(1)}"/>
        <circle class="cmac-ring-dash2" cx="${cx}" cy="${cx}" r="${(r + 10).toFixed(1)}"/>
        <circle class="cmac-ring-prog"  cx="${cx}" cy="${cx}" r="${r}" style="stroke-dasharray:${circ};stroke-dashoffset:${circ}"/>
      </svg>
      <div class="cmac-orb-sweep"></div>
      <div class="cmac-orb-particle"></div>
      <div class="cmac-orb-center" data-cmac-center></div>
    </div>`;
  }
  function orbControl(orbEl) {
    const prog = orbEl.querySelector('.cmac-ring-prog');
    const center = orbEl.querySelector('[data-cmac-center]');
    const circ = parseFloat(orbEl.style.getPropertyValue('--circ')) || 760;
    return {
      el: orbEl,
      scanning(on) { orbEl.classList.toggle('scanning', !!on); },
      color(cls) { orbEl.classList.remove('green', 'amber', 'red'); if (cls) orbEl.classList.add(cls); },
      setProgress(pct) {
        const p = Math.max(0, Math.min(100, pct));
        prog.style.strokeDashoffset = (circ - (p / 100) * circ).toFixed(1);
      },
      center(html) { center.innerHTML = html; return center; },
      // Big button in the center. cb fired on click.
      button(label, cb, btnClass = '') {
        center.innerHTML = `<button class="cmac-scan-btn ${btnClass}">${esc(label)}</button>`;
        const b = center.querySelector('button');
        b.addEventListener('click', cb);
        return b;
      },
      // Big number + unit + label, with count-up animation.
      stat(value, unit, label, opts = {}) {
        center.innerHTML = `<div><span class="cmac-orb-num" data-n>0</span><span class="cmac-orb-unit">${esc(unit || '')}</span></div>
          <div class="cmac-orb-label">${esc(label || '')}</div>`;
        countUp(center.querySelector('[data-n]'), value, opts);
      },
    };
  }

  // --- Row builder for category/uninstaller/etc. lists ---
  // o: { icon (svg name) | iconText, iconColor, name, sub, value, valueSub, control(html), selected, danger, dataset:{} }
  function row(o = {}) {
    const ds = Object.entries(o.dataset || {}).map(([k, v]) => `data-${k}="${escA(v)}"`).join(' ');
    const icoInner = o.icon ? svg(o.icon) : esc(o.iconText || '');
    const ico = `<div class="cmac-row-ico ${o.iconColor || ''}">${icoInner}</div>`;
    const body = `<div class="cmac-row-body">
        <div class="cmac-row-name">${esc(o.name || '')}</div>
        ${o.sub ? `<div class="cmac-row-sub">${esc(o.sub)}</div>` : ''}
      </div>`;
    const val = o.value != null
      ? `<div class="cmac-row-val">${esc(o.value)}${o.valueSub ? `<small>${esc(o.valueSub)}</small>` : ''}</div>`
      : '<div></div>';
    const ctl = `<div class="cmac-row-ctl">${o.control || ''}</div>`;
    const cls = ['cmac-row', o.danger ? 'danger' : '', o.selected ? 'selected' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" ${ds}>${ico}${body}${val}${ctl}</div>`;
  }

  const check = (attrs = '') => `<input type="checkbox" class="cmac-check ${/\bred\b/.test(attrs) ? 'red' : ''}" ${attrs}>`;
  const toggle = (checked, attrs = '') =>
    `<label class="cmac-toggle"><input type="checkbox" ${checked ? 'checked' : ''} ${attrs}><span class="cmac-track"><span class="cmac-knob"></span></span></label>`;

  function result(o = {}) {
    return `<div class="cmac-result">
      <div class="cmac-result-badge">${svg('check', 52)}</div>
      ${o.stat != null ? `<div class="cmac-result-stat">${esc(o.stat)}</div>` : ''}
      <div class="cmac-result-title">${esc(o.title || 'Done')}</div>
      ${o.sub ? `<div class="cmac-result-sub">${esc(o.sub)}</div>` : ''}
    </div>`;
  }

  function empty(o = {}) {
    return `<div class="cmac-empty">
      <div class="cmac-empty-ico">${svg(o.icon || 'check', 60)}</div>
      <div class="cmac-empty-title">${esc(o.title || 'Nothing here')}</div>
      ${o.sub ? `<div class="cmac-empty-sub">${esc(o.sub)}</div>` : ''}
    </div>`;
  }
  const loading = (text = 'Scanning…') => `<div class="cmac-loading"><span class="spin"></span><div>${esc(text)}</div></div>`;

  // stage wrapper string
  function stage(o = {}) {
    return `<div class="cmac-stage">
      ${o.eyebrow ? `<div class="cmac-eyebrow">${esc(o.eyebrow)}</div>` : ''}
      ${o.orb || ''}
      ${o.title ? `<div class="cmac-title">${esc(o.title)}</div>` : ''}
      ${o.sub ? `<div class="cmac-sub">${esc(o.sub)}</div>` : ''}
      ${o.actions ? `<div class="cmac-actions">${o.actions}</div>` : ''}
    </div>`;
  }

  window.CMAC = { countUp, svg, icons: ICONS, orbHTML, orbControl, row, check, toggle, result, empty, loading, stage };
})();
