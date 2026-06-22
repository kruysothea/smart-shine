// Space Lens — interactive disk-visualization. One directory level is drawn as
// a flowing BUBBLE MAP (area ∝ size, sqrt-scaled); folders drill in. A live
// breadcrumb toolbar drives navigation and a synced list mirrors the bubbles.
(function () {
  'use strict';

  const CM = window.CM;
  const root = CM.$('view-spacelens');
  if (!root) return;

  // Module state. currentDir starts unset → service defaults to HOME.
  let currentDir = null;
  let loading = false;

  // Cap how many bubbles we paint so the map stays readable; the rest collapse
  // into a single "+N more" disc.
  const MAX_BUBBLES = 40;

  // Items we never offer a Trash button for — too easy to break the account/OS.
  function isProtected(p) {
    if (!p) return true;
    const segs = p.split('/').filter(Boolean);
    const PROTECTED_TOP = ['System', 'Library', 'usr', 'bin', 'sbin', 'etc', 'var', 'private', 'cores', 'opt', 'Applications'];
    if (segs.length <= 1) return true;                 // '/', '/Users', etc.
    if (PROTECTED_TOP.includes(segs[0])) return true;  // /System, /Library, ...
    if (segs[0] === 'Users' && segs.length <= 2) return true; // a whole home dir
    if (segs[0] === 'Users' && segs[2] === 'Library') return true; // ~/Library
    return false;
  }

  // Color tier by share of the level. Larger consumers glow hotter.
  // hot = red/amber (biggest), mid = cyan, small = magenta.
  function tier(pct) {
    if (pct >= 30) return 'hot';
    if (pct >= 12) return 'warm';
    if (pct >= 3) return 'mid';
    return 'cool';
  }

  // ---- Toolbar: clickable breadcrumb + Up / Choose Root + big total ----
  function breadcrumb(p) {
    if (!p) return '<button class="sl-crumb sl-crumb-cur" disabled>~</button>';
    const segs = p.split('/');
    const parts = [`<button class="sl-crumb" data-go="/">/</button>`];
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!s) continue;
      acc += '/' + s;
      const isLast = i === segs.length - 1;
      if (isLast) {
        parts.push(`<span class="sl-sep">/</span><button class="sl-crumb sl-crumb-cur" disabled>${CM.escapeHtml(s)}</button>`);
      } else {
        parts.push(`<span class="sl-sep">/</span><button class="sl-crumb" data-go="${CM.escapeAttr(acc)}">${CM.escapeHtml(s)}</button>`);
      }
    }
    return parts.join('');
  }

  function toolbar(data) {
    const upDisabled = data && data.parent ? '' : 'disabled';
    return `<div class="cmac-toolbar sl-toolbar">
      <div class="sl-crumbs">${breadcrumb(data ? data.path : currentDir)}</div>
      <button class="cmac-cta ghost sl-up" id="sl-up" ${upDisabled}>Up</button>
      <button class="cmac-cta ghost" id="sl-pick">Choose Root…</button>
      <div class="sl-total">
        <span class="sl-total-num" id="sl-total" data-total="${data ? data.totalSize : 0}">0 B</span>
        <span class="sl-total-cap">total · ${data ? data.children.length : 0} items</span>
      </div>
    </div>`;
  }

  // ---- The bubble map. Area ∝ size (sqrt of bytes → radius). ----
  function bubbleMap(data) {
    const children = (data && data.children) ? data.children.slice() : [];
    if (children.length === 0) return '';

    children.sort((a, b) => b.size - a.size);
    const shown = children.slice(0, MAX_BUBBLES);
    const hidden = children.slice(MAX_BUBBLES);

    // sqrt scaling so circle AREA tracks byte size. Map biggest → max diameter.
    const maxSize = Math.max(1, shown[0].size);
    const MIN_D = 58;   // smallest readable bubble
    const MAX_D = 188;  // largest bubble
    const sqrtMax = Math.sqrt(maxSize);

    const bubbles = shown.map((c, idx) => {
      const ratio = sqrtMax > 0 ? Math.sqrt(Math.max(0, c.size)) / sqrtMax : 0;
      const d = Math.round(MIN_D + (MAX_D - MIN_D) * ratio);
      const t = tier(c.pct);
      const isDir = !!c.isDir;
      const drill = isDir ? ` data-drill="${CM.escapeAttr(c.path)}"` : '';
      const showLabel = d >= 84; // only label bubbles big enough to read
      const tip = `${c.name} — ${CM.humanSize(c.size)} (${c.pct.toFixed(1)}%)`;
      const label = showLabel
        ? `<span class="sl-bub-label">
             <span class="sl-bub-name">${CM.escapeHtml(c.name)}</span>
             <span class="sl-bub-size">${CM.escapeHtml(CM.humanSize(c.size))}</span>
           </span>`
        : '';
      return `<button class="sl-bub sl-${t} ${isDir ? 'sl-dir' : 'sl-file'}"
          style="--d:${d}px;--i:${idx}"
          ${drill} ${isDir ? '' : 'disabled'}
          title="${CM.escapeAttr(tip)}"
          data-idx="${idx}">
          <span class="sl-bub-glow"></span>
          <span class="sl-bub-ring"></span>
          <span class="sl-bub-core">
            <span class="sl-bub-icn">${isDir ? '▸' : '·'}</span>
            ${label}
          </span>
        </button>`;
    }).join('');

    let moreDisc = '';
    if (hidden.length) {
      const moreBytes = hidden.reduce((s, h) => s + (h.size || 0), 0);
      moreDisc = `<div class="sl-bub sl-more" style="--d:${MIN_D + 6}px;--i:${shown.length}" title="${CM.escapeAttr(hidden.length + ' smaller items — ' + CM.humanSize(moreBytes))}">
        <span class="sl-bub-core">
          <span class="sl-bub-name">+${hidden.length}</span>
          <span class="sl-bub-size">more</span>
        </span>
      </div>`;
    }

    return `<div class="sl-map cmac-stagger">${bubbles}${moreDisc}</div>`;
  }

  // ---- Synced list mirroring the same children ----
  function listBlock(data) {
    const children = (data && data.children) ? data.children.slice() : [];
    if (children.length === 0) return '';
    children.sort((a, b) => b.size - a.size);

    const head = `<div class="cmac-section-head">
      <div class="cmac-section-title">Breakdown</div>
      <div class="cmac-count">${children.length} items</div>
    </div>`;

    const rows = children.map((c) => {
      const isDir = !!c.isDir;
      const t = tier(c.pct);
      const iconColor = t === 'hot' ? 'red' : t === 'warm' ? 'amber' : t === 'mid' ? '' : 'magenta';
      const reveal = `<button class="cmac-cta ghost sl-mini" data-reveal="${CM.escapeAttr(c.path)}">Reveal</button>`;
      const trash = isProtected(c.path)
        ? ''
        : `<button class="cmac-cta danger sl-mini" data-trash="${CM.escapeAttr(c.path)}" data-size="${c.size}">Trash</button>`;
      const control = `<div class="sl-row-ctl">${reveal}${trash}</div>`;
      return CMAC.row({
        icon: isDir ? 'folder' : 'file',
        iconColor,
        name: c.name,
        value: CM.humanSize(c.size),
        valueSub: c.pct.toFixed(0) + '%',
        control,
        dataset: isDir ? { drill: c.path } : {},
      });
    }).join('');

    return `${head}<div class="cmac-list cmac-stagger sl-list">${rows}</div>`;
  }

  // ---- Wire interactions for the freshly rendered level ----
  function wire(data) {
    const pick = CM.$('sl-pick');
    if (pick) pick.addEventListener('click', async () => {
      try {
        const folder = await window.api.pickFolder();
        if (folder) render(folder);
      } catch (e) {
        CM.toast('Could not open folder picker', 'error');
      }
    });

    const up = CM.$('sl-up');
    if (up) up.addEventListener('click', () => {
      if (data && data.parent) render(data.parent);
    });

    root.querySelectorAll('[data-go]').forEach((el) => {
      el.addEventListener('click', () => render(el.dataset.go));
    });

    // Bubbles (data-drill) AND list rows (data-drill via dataset) drill in.
    root.querySelectorAll('[data-drill]').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Don't drill when a Reveal/Trash button inside a row is clicked.
        if (e.target.closest('[data-reveal],[data-trash]')) return;
        render(el.dataset.drill);
      });
    });

    root.querySelectorAll('[data-reveal]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        window.api.revealPath(b.dataset.reveal);
      });
    });

    root.querySelectorAll('[data-trash]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const p = b.dataset.trash;
        const size = Number(b.dataset.size) || 0;
        b.disabled = true;
        const prev = b.textContent;
        b.innerHTML = '<span class="spin"></span>';
        try {
          const res = await window.api.trashItems([{ path: p, size }]);
          if (res && res.cancelled) { b.disabled = false; b.textContent = prev; return; }
          if (res && res.ok) {
            CM.toast('Freed ' + CM.humanSize(res.freed), 'success');
            render(currentDir);
          } else {
            CM.toast('Could not move to Trash', 'error');
            b.disabled = false; b.textContent = prev;
          }
        } catch (err) {
          CM.toast('Could not move to Trash', 'error');
          b.disabled = false; b.textContent = prev;
        }
      });
    });

    // Animate the headline total on each level.
    const totalEl = CM.$('sl-total');
    if (totalEl) {
      const to = Number(totalEl.dataset.total) || 0;
      CMAC.countUp(totalEl, to, { duration: 900, format: (n) => CM.humanSize(n) });
    }
  }

  // ---- Scan + draw a directory level. dir null/undefined → HOME default. ----
  async function render(dir) {
    if (loading) return;
    loading = true;
    root.innerHTML = toolbar(null) + `<div class="sl-stage">${CMAC.loading('Mapping disk…')}</div>`;

    let data;
    try {
      data = await window.api.spaceLens(dir);
    } catch (e) {
      data = { path: dir || null, parent: null, totalSize: 0, children: [], error: e && e.message };
    }
    currentDir = data && data.path ? data.path : (dir || null);
    loading = false;

    if (!data || data.error || !data.children || data.children.length === 0) {
      root.innerHTML = toolbar(data || null) + `<div class="sl-stage">${CMAC.empty({
        icon: 'lens',
        title: (data && data.error) ? 'Could not read this folder' : 'Nothing to map here',
        sub: (data && data.error)
          ? 'It may be protected or require permission. Try Up, or choose a different root.'
          : 'This folder is empty or its contents are protected. Try Up or choose another root.',
      })}</div>`;
      wire(data || null);
      return;
    }

    root.innerHTML =
      toolbar(data) +
      `<div class="sl-mapwrap card">${bubbleMap(data)}</div>` +
      `<div class="sl-listwrap">${listBlock(data)}</div>`;
    wire(data);
  }

  async function load() {
    await render(currentDir);
  }

  window.CM_VIEWS = window.CM_VIEWS || {};
  window.CM_VIEWS['spacelens'] = { load };
})();
