const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

// Surface any uncaught error visibly so we never get a "silent broken" screen
function showFatal(msg) {
  let bar = document.getElementById('fatal-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a1620;color:#ffb3c1;padding:10px 16px;font:12px/1.4 -apple-system;border-bottom:1px solid rgba(255,94,125,0.4);white-space:pre-wrap;max-height:30vh;overflow:auto';
    document.body.appendChild(bar);
  }
  bar.textContent = (bar.textContent ? bar.textContent + '\n' : '') + msg;
}
window.addEventListener('error', (e) => showFatal(`JS error: ${e.message}  @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => showFatal(`Promise: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));

function humanSize(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function humanNum(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}
function rateString(bytesPerSec) {
  if (!bytesPerSec) return '0 B/s';
  return humanSize(bytesPerSec) + '/s';
}
function humanTime(s) {
  if (!s) return '—';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  if (h > 24) return `${Math.floor(h/24)}d ${h%24}h`;
  return `${h}h ${m}m`;
}
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function toast(msg, kind='') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2600);
}

function setRing(elId, pct) {
  const el = $(elId);
  if (!el) return;
  const circumference = 2 * Math.PI * Number(el.getAttribute('r'));
  const offset = circumference - (Math.min(100, Math.max(0, pct)) / 100) * circumference;
  el.style.strokeDasharray = circumference;
  el.style.strokeDashoffset = offset;
}

// ===== Shared helpers exposed to view modules (renderer/views/*.js) =====
// View modules are loaded as separate <script> files and reuse these so the
// look & feel stays consistent. They register themselves in window.CM_VIEWS.
window.CM = { $, fmt, humanSize, humanNum, rateString, humanTime, ago, toast, setRing, escapeHtml, escapeAttr };
window.CM_VIEWS = window.CM_VIEWS || {};

// ===== Navigation =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    const view = item.dataset.view;
    $(`view-${view}`).classList.add('active');
    const label = item.querySelector('span').textContent.trim();
    $('page-title').textContent = label;
    loadView(view);
  });
});

$('refresh-btn').addEventListener('click', () => {
  const active = document.querySelector('.nav-item.active').dataset.view;
  loadView(active, true);
});

// ===== Dashboard · Smart Scan =====
let dashOrb = null;
let dashJunkTotal = null;     // reclaimable bytes from the last Smart Scan / Cleanup scan
let dashStats = { memPct: 0, agents: 0, tokens: 0, models: 0, externalDrives: 0, driveHealth: 'Unknown' };

function navTo(view) { const el = document.querySelector(`.nav-item[data-view="${view}"]`); if (el) el.click(); }

async function loadDashboard() {
  const sys = await window.api.systemStats();
  $('foot-user').textContent = sys.user;
  $('foot-host').textContent = sys.hostname;

  // System card
  const usedMem = sys.memTotal - sys.memFree;
  const sysCpu = $('sys-cpu'); if (sysCpu) sysCpu.textContent = `${sys.cpus} cores`;
  $('sys-list').innerHTML = `
    <div class="kv-row"><div class="kv-label">CPU</div><div class="kv-value">${escapeHtml(sys.cpuModel)}</div></div>
    <div class="kv-row"><div class="kv-label">Cores</div><div class="kv-value">${sys.cpus}</div></div>
    <div class="kv-row"><div class="kv-label">Memory</div><div class="kv-value">${humanSize(usedMem)} / ${humanSize(sys.memTotal)}</div></div>
    <div class="kv-row"><div class="kv-label">Free</div><div class="kv-value">${humanSize(sys.memFree)}</div></div>
    <div class="kv-row"><div class="kv-label">Uptime</div><div class="kv-value">${humanTime(sys.uptime)}</div></div>
    <div class="kv-row"><div class="kv-label">Architecture</div><div class="kv-value">${sys.arch}</div></div>
  `;

  // Smart Scan stage (build the orb once, then keep it across refreshes)
  const stageEl = $('dash-stage');
  if (!stageEl.querySelector('[data-cmac-orb]')) {
    stageEl.innerHTML = window.CMAC.stage({
      eyebrow: 'SMART SCAN',
      orb: window.CMAC.orbHTML({ color: '' }),
      title: 'Your Mac at a glance',
      sub: `${sys.cpuModel} · ${sys.cpus} cores · uptime ${humanTime(sys.uptime)}`,
      actions: '<div class="cmac-actions" id="dash-actions"></div>',
    });
    dashOrb = window.CMAC.orbControl(stageEl.querySelector('[data-cmac-orb]'));
  }
  dashOrb.setProgress(sys.memUsedPct);
  if (dashJunkTotal == null) {
    dashOrb.button('Smart Scan', runSmartScan);
    $('dash-actions').innerHTML = '';
  }

  // Quick stats + cards
  const [agents, tok, models, drivesRes] = await Promise.all([
    window.api.listAgents(), window.api.getTokenStats(), window.api.listModels(),
    window.api.listDrives().catch(() => ({ ok: false, volumes: [] })),
  ]);
  const totalModels = models.reduce((s, p) => s + p.models.length, 0);
  const volumes = Array.isArray(drivesRes && drivesRes.volumes) ? drivesRes.volumes : [];
  const externalDrives = Array.isArray(drivesRes && drivesRes.devices)
    ? drivesRes.devices.length
    : [...new Set(volumes.filter(v => v.external || v.removableOrExternal || v.ejectable).map(v => v.ejectTarget || v.physicalWholeDiskId || v.id))].length;
  const healthAlerts = volumes.filter(v => /fail|error|fatal/i.test(v.smartStatus || '')).length;
  const driveHealth = drivesRes && drivesRes.ok === false ? 'Unavailable' : (healthAlerts ? `${healthAlerts} alert${healthAlerts === 1 ? '' : 's'}` : 'Healthy');
  $('badge-agents').textContent = agents.length;
  $('badge-models').textContent = totalModels;
  dashStats = { memPct: sys.memUsedPct, agents: agents.length, tokens: tok.monthBillable, models: totalModels, externalDrives, driveHealth };
  renderDashCards();

  // Token spark
  const spark = $('spark-tokens');
  const max = Math.max(...tok.hourly, 1);
  spark.innerHTML = tok.hourly.map(v => {
    const h = (v / max) * 100;
    return `<div class="spark-bar ${v === 0 ? 'empty' : ''}" style="height:${Math.max(4, h)}%" title="${humanNum(v)} tokens"></div>`;
  }).join('');
}

function renderDashCards() {
  const el = $('dash-cards');
  if (!el) return;
  const card = (icon, color, name, statHtml, desc, view, cta) => `
    <div class="cmac-task">
      <div class="cmac-task-head"><div class="cmac-row-ico ${color}">${window.CMAC.svg(icon)}</div>
        <div class="cmac-task-name">${name}</div></div>
      <div class="cmac-task-desc">${desc}</div>
      <div class="cmac-task-foot"><div class="cmac-task-stat">${statHtml}</div>
        <button class="cmac-cta ghost" data-go="${view}">${cta}</button></div>
    </div>`;
  el.innerHTML = [
    card('broom', '', 'Cleanup', dashJunkTotal == null ? '—' : humanSize(dashJunkTotal),
      dashJunkTotal == null ? 'Run a Smart Scan to find reclaimable junk.' : 'Reclaimable junk found on this Mac.', 'cleaner', 'Clean'),
    card('bolt', 'green', 'Performance', Math.round(dashStats.memPct) + '%',
      'Memory in use right now — free it up or trim startup items.', 'speed', 'Optimize'),
    card('cpu', 'magenta', 'AI Processes', String(dashStats.agents),
      'Live AI agents & local models detected on your Mac.', 'agents', 'Review'),
    card('grid', 'amber', 'Token Usage', humanNum(dashStats.tokens),
      'Billable AI tokens consumed this month.', 'tokens', 'Details'),
    card('harddrive', 'cyan', 'Storage Drives', String(dashStats.externalDrives),
      `External devices connected · ${escapeHtml(dashStats.driveHealth)} health status.`, 'drives', 'Manage'),
  ].join('');
  el.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => navTo(b.dataset.go)));
}

async function runSmartScan() {
  if (!dashOrb) return;
  dashOrb.color('');
  dashOrb.scanning(true);
  dashOrb.center('<div class="cmac-orb-status">Scanning your Mac…</div>');
  let p = 0; const tick = setInterval(() => { p = Math.min(92, p + 7); dashOrb.setProgress(p); }, 180);
  const data = await window.api.scanJunk();
  clearInterval(tick);
  const total = data.reduce((s, c) => s + c.totalSize, 0);
  dashJunkTotal = total;
  lastJunkScan = data; // share the result with the Cleanup view
  dashOrb.scanning(false);
  dashOrb.color('green');
  dashOrb.setProgress(Math.min(100, (total / (10 * 1024 * 1024 * 1024)) * 100));
  dashOrb.stat(total, '', 'reclaimable', { format: n => humanSize(n) });
  $('dash-actions').innerHTML =
    `<button class="cmac-cta green" id="dash-review">Review in Cleanup</button>
     <button class="cmac-cta ghost" id="dash-rescan">Rescan</button>`;
  $('dash-review').addEventListener('click', () => navTo('cleaner'));
  $('dash-rescan').addEventListener('click', runSmartScan);
  renderDashCards();
  toast(`Smart Scan complete · ${humanSize(total)} reclaimable`, 'success');
}

// ===== Agents =====
async function loadAgents() {
  const rows = $('agents-rows');
  rows.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3)"><span class="spin"></span> Scanning processes…</div>';
  const list = await window.api.listAgents();
  $('agents-count').textContent = list.length === 0 ? 'No agents found' : `${list.length} active`;
  $('badge-agents').textContent = list.length;
  if (list.length === 0) {
    $('agents-empty').classList.remove('hidden');
    rows.innerHTML = '';
    return;
  }
  $('agents-empty').classList.add('hidden');
  rows.innerHTML = list.map(a => `
    <div class="row" data-pid="${a.pid}">
      <div>
        <div class="agent-name"><span class="agent-dot"></span><div><div>${a.name}</div><div class="agent-meta">${a.vendor} · ${escapeHtml(a.command.slice(0, 80))}</div></div></div>
      </div>
      <div>${a.pid}</div>
      <div>${a.cpu.toFixed(1)}%</div>
      <div>${humanSize(a.rssBytes)}</div>
      <div>${a.etime}</div>
      <div style="text-align:right">
        <button class="tiny red" data-kill="${a.pid}">Terminate</button>
      </div>
    </div>
  `).join('');
  rows.querySelectorAll('[data-kill]').forEach(b => {
    b.addEventListener('click', async () => {
      const pid = Number(b.dataset.kill);
      b.textContent = '…'; b.disabled = true;
      const res = await window.api.killAgent(pid);
      if (res.ok) {
        toast('Process terminated', 'success');
        setTimeout(loadAgents, 600);
      } else {
        toast('Failed: ' + (res.error || 'unknown'), 'error');
        b.textContent = 'Terminate'; b.disabled = false;
      }
    });
  });
}

// ===== Tokens =====
async function loadTokens() {
  const tok = await window.api.getTokenStats();
  // Ring
  if (tok.limit > 0) {
    $('tok-pct').textContent = tok.pctUsed.toFixed(1) + '%';
    $('tok-sub').textContent = `${humanNum(tok.monthBillable)} / ${humanNum(tok.limit)}`;
    setRing('tok-ring', tok.pctUsed);
    $('tok-remaining').innerHTML = `<strong>${humanNum(tok.remaining)}</strong> tokens remaining this month`;
    $('limit-input').value = tok.limit;
  } else {
    $('tok-pct').textContent = humanNum(tok.monthBillable);
    $('tok-sub').textContent = 'used this month · set a limit';
    setRing('tok-ring', 0);
    $('tok-remaining').innerHTML = 'Set a monthly limit to see remaining tokens.';
  }

  // Buckets
  const bl = $('bucket-list');
  const total = tok.buckets.all.input + tok.buckets.all.cacheCreate + tok.buckets.all.cacheRead + tok.buckets.all.output || 1;
  const buckets = [
    ['today', 'Today', tok.buckets.today],
    ['week', 'Last 7 days', tok.buckets.week],
    ['month', 'Last 30 days', tok.buckets.month],
    ['all', 'All time', tok.buckets.all],
  ];
  bl.innerHTML = buckets.map(([k, label, b]) => {
    const t = b.input + b.cacheCreate + b.cacheRead + b.output;
    const pct = (t / total) * 100;
    return `<div class="bucket">
      <div><div class="bucket-label">${label}</div><div class="bucket-sub muted">${b.messages} msgs</div></div>
      <div class="bucket-bar"><div class="bucket-bar-fill" style="width:${pct}%"></div></div>
      <div class="bucket-value">${humanNum(t)}<div class="bucket-sub">in ${humanNum(b.input)} · cache ${humanNum(b.cacheRead)} · out ${humanNum(b.output)}</div></div>
    </div>`;
  }).join('');

  // Per-agent breakdown
  const pCards = $('provider-cards');
  $('agents-month-total').textContent = `${humanNum(tok.monthBillable)} tokens · ${tok.providers.length} ${tok.providers.length === 1 ? 'agent' : 'agents'}`;
  if (tok.providers.length === 0) {
    pCards.innerHTML = '<div class="muted" style="padding:16px">No AI agent token data found on this Mac yet.</div>';
  } else {
    const totalMonth = tok.providers.reduce((s, p) => s + p.monthBillable, 0) || 1;
    pCards.innerHTML = tok.providers
      .slice()
      .sort((a, b) => b.monthBillable - a.monthBillable)
      .map(p => {
        const pct = (p.monthBillable / totalMonth) * 100;
        const today = p.buckets.today.input + p.buckets.today.cacheCreate + p.buckets.today.output;
        return `<div class="pcard" style="--pc-color:${p.color}">
          <div class="pcard-head">
            <div class="pcard-icon" style="background:${p.color}22;color:${p.color}">${escapeHtml(p.icon)}</div>
            <div class="pcard-meta">
              <div class="pcard-name">${escapeHtml(p.name)}</div>
              <div class="pcard-vendor">${escapeHtml(p.vendor)}${p.models.length ? ' · ' + escapeHtml(p.models.join(', ')) : ''}</div>
            </div>
            <div class="pcard-share">${pct.toFixed(0)}%</div>
          </div>
          <div class="pcard-num">${humanNum(p.monthBillable)}</div>
          <div class="pcard-sub">tokens this month · ${humanNum(today)} today</div>
          <div class="pcard-bar"><div class="pcard-fill" style="width:${pct}%;background:${p.color}"></div></div>
        </div>`;
      }).join('');
  }

  // Sessions
  const rows = $('sessions-rows');
  if (tok.sessions.length === 0) {
    rows.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3)">No AI agent sessions found yet.</div>';
  } else {
    const colorFor = (vendor) => {
      if (vendor === 'Anthropic') return '#cc785c';
      if (vendor === 'OpenAI') return '#10a37f';
      return '#5ad6ff';
    };
    rows.innerHTML = tok.sessions.map(s => {
      const billable = s.input + s.cacheCreate + s.output;
      return `<div class="row">
        <div><div class="agent-name"><span class="agent-dot" style="background:${colorFor(s.vendor)};box-shadow:0 0 8px ${colorFor(s.vendor)}"></span>${escapeHtml(s.provider)}</div><div class="agent-meta">${escapeHtml(s.vendor)}</div></div>
        <div>${escapeHtml(s.model || '—')}</div>
        <div>${s.messages}</div>
        <div>${humanNum(billable)}</div>
        <div>${humanNum(s.cacheRead)}</div>
        <div>${ago(s.lastTs)}</div>
      </div>`;
    }).join('');
  }
}

$('limit-save').addEventListener('click', async () => {
  const v = Number($('limit-input').value) || 0;
  await window.api.setTokenLimit(v);
  toast('Limit saved', 'success');
  loadTokens();
});
document.querySelectorAll('.presets button').forEach(b => {
  b.addEventListener('click', async () => {
    const v = Number(b.dataset.l);
    $('limit-input').value = v;
    await window.api.setTokenLimit(v);
    toast(v === 0 ? 'Limit cleared' : 'Limit set', 'success');
    loadTokens();
  });
});

// ===== Models =====
async function loadModels() {
  const list = $('models-list');
  list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-3)"><span class="spin"></span> Scanning local models…</div>';
  const providers = await window.api.listModels();
  if (providers.length === 0) {
    list.innerHTML = '';
    $('models-empty').classList.remove('hidden');
    $('badge-models').textContent = 0;
    return;
  }
  $('models-empty').classList.add('hidden');
  const totalModels = providers.reduce((s, p) => s + p.models.length, 0);
  $('badge-models').textContent = totalModels;

  list.innerHTML = providers.map(p => {
    return `<div class="provider">
      <div class="provider-head">
        <div class="provider-title">
          <div class="provider-name">${escapeHtml(p.provider)}</div>
          <span class="provider-status ${p.running ? '' : 'idle'}"><span class="dot"></span>${p.running ? 'Running' : 'Idle'}</span>
        </div>
        <button class="tiny" data-folder="${escapeAttr(p.folder)}">Open folder</button>
      </div>
      ${p.models.length === 0
        ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">No models installed in this provider.</div>`
        : p.models.map(m => `
          <div class="model-row">
            <div>
              <div class="model-name">${escapeHtml(m.name)}</div>
              <div class="model-sub">${escapeHtml(m.path || '')}</div>
            </div>
            <div class="model-size">${escapeHtml(String(m.size || ''))}</div>
            <div class="model-status">${m.running ? '<span style="color:var(--green)">● running</span>' : '<span style="color:var(--text-3)">○ stopped</span>'}</div>
            <div class="model-actions">
              <button class="tiny ${m.running ? 'red' : 'green'}" data-action="${m.running ? 'stop' : 'launch'}" data-provider="${escapeAttr(p.provider)}" data-name="${escapeAttr(m.name === p.provider ? m.path : m.name)}">${m.running ? 'Stop' : 'Launch'}</button>
              <button class="tiny" data-folder="${escapeAttr(m.path || p.folder)}">Folder</button>
            </div>
          </div>
        `).join('')
      }
    </div>`;
  }).join('');

  list.querySelectorAll('[data-folder]').forEach(b => {
    b.addEventListener('click', () => window.api.openModelFolder(b.dataset.folder));
  });
  list.querySelectorAll('[data-action]').forEach(b => {
    b.addEventListener('click', async () => {
      const { action, provider, name } = b.dataset;
      b.disabled = true; b.textContent = '…';
      const res = action === 'launch'
        ? await window.api.launchModel(provider, name)
        : await window.api.stopModel(provider, name);
      if (res.ok) toast(res.message || 'Done', 'success');
      else toast(res.error || 'Failed', 'error');
      setTimeout(loadModels, 800);
    });
  });
}

// ===== Cleanup (junk) =====
let lastJunkScan = null;
let junkOrb = null;

function loadCleaner() {
  const stageEl = $('junk-stage');
  if (!stageEl.querySelector('[data-cmac-orb]')) {
    stageEl.innerHTML = window.CMAC.stage({
      eyebrow: 'CLEANUP',
      orb: window.CMAC.orbHTML({ color: 'green' }),
      title: 'Find junk slowing your Mac down',
      sub: 'Scans caches, logs, Xcode & dev caches, .DS_Store and old Downloads. Everything moves to the Trash first — Xcode Archives, the pnpm store and iCloud / HomeKit / Siri caches are never touched.',
    });
    junkOrb = window.CMAC.orbControl(stageEl.querySelector('[data-cmac-orb]'));
    junkOrb.button('Scan', runJunkScan, 'green');
  }
  if (lastJunkScan) renderJunk(lastJunkScan);
}

async function runJunkScan() {
  if (!junkOrb) return;
  junkOrb.scanning(true);
  junkOrb.center('<div class="cmac-orb-status">Scanning junk…</div>');
  let p = 0; const tick = setInterval(() => { p = Math.min(92, p + 8); junkOrb.setProgress(p); }, 160);
  const data = await window.api.scanJunk();
  clearInterval(tick);
  lastJunkScan = data;
  dashJunkTotal = data.reduce((s, c) => s + c.totalSize, 0); // keep dashboard in sync
  junkOrb.scanning(false);
  renderJunk(data);
}

const SAFETY_LABEL = { caution: 'Caution · quit app first', review: 'Review each item', safe: 'Safe — regenerates' };
const SAFETY_ICON = { caution: 'amber', review: 'red', safe: 'green' };
const CAT_ICON = { 'user-caches': 'broom', 'system-logs': 'file', 'trash': 'trash', 'xcode': 'cpu', 'npm': 'apps', 'pip': 'apps', 'browser': 'cloud', 'node_modules': 'folder', 'ds-store': 'file', 'downloads-old': 'folder' };

function renderJunk(categories) {
  const total = categories.reduce((s, c) => s + c.totalSize, 0);
  if (junkOrb) {
    junkOrb.color('green');
    junkOrb.setProgress(Math.min(100, (total / (10 * 1024 * 1024 * 1024)) * 100));
    junkOrb.stat(total, '', 'reclaimable', { format: n => humanSize(n) });
  }

  const wrap = $('junk-results');
  const rows = categories.map((c, idx) => {
    const catChecked = c.defaultChecked && c.totalSize > 0;
    const safety = c.safety || 'safe';
    const items = c.items.map(i => `
      <div class="junk-item">
        <input type="checkbox" class="cmac-check" data-item="${c.id}|${idx}|${escapeAttr(i.path)}" ${catChecked ? 'checked' : ''}/>
        <div class="junk-item-path">${escapeHtml(i.name || i.path)}${i.ageDays ? ` · ${i.ageDays}d old` : ''}</div>
        <div class="junk-item-sz">${humanSize(i.size)}</div>
      </div>`).join('');
    return `
    <div class="junk-cat" data-cat="${c.id}">
      <div class="cmac-row ${catChecked ? 'selected' : ''}">
        <div class="cmac-row-ico ${SAFETY_ICON[safety]}">${window.CMAC.svg(CAT_ICON[c.id] || 'broom')}</div>
        <div class="cmac-row-body junk-expand" data-expand>
          <div class="cmac-row-name">${escapeHtml(c.name)} <span class="safety ${safety}">${SAFETY_LABEL[safety]}</span></div>
          <div class="cmac-row-sub">${escapeHtml(c.description)} · ${c.items.length} items · click to review</div>
        </div>
        <div class="cmac-row-val">${humanSize(c.totalSize)}</div>
        <div class="cmac-row-ctl"><input type="checkbox" class="cmac-check" data-cat-cb="${c.id}" ${catChecked ? 'checked' : ''} ${c.totalSize === 0 ? 'disabled' : ''}/></div>
      </div>
      <div class="junk-items">${items || '<div class="junk-item-empty">No items</div>'}</div>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="cmac-section-head">
      <div class="cmac-section-title">Reclaimable junk</div>
      <button class="cmac-cta green" id="junk-clean" ${total === 0 ? 'disabled' : ''}>Clean Selected</button>
    </div>
    <div class="cmac-list cmac-stagger">${rows}</div>`;

  wrap.querySelectorAll('[data-expand]').forEach(h => {
    h.addEventListener('click', () => h.closest('.junk-cat').classList.toggle('open'));
  });
  wrap.querySelectorAll('[data-cat-cb]').forEach(cb => {
    cb.addEventListener('change', () => {
      const catEl = cb.closest('.junk-cat');
      catEl.querySelector('.cmac-row').classList.toggle('selected', cb.checked);
      catEl.querySelectorAll('[data-item]').forEach(x => x.checked = cb.checked);
    });
  });
  const cleanBtn = $('junk-clean');
  if (cleanBtn) cleanBtn.addEventListener('click', runJunkClean);
}

async function runJunkClean() {
  if (!lastJunkScan) return;
  const picks = [];
  $('junk-results').querySelectorAll('[data-item]:checked').forEach(cb => {
    const [catId, _idx, ...pathParts] = cb.dataset.item.split('|');
    const fullPath = pathParts.join('|');
    const cat = lastJunkScan.find(c => c.id === catId);
    if (!cat) return;
    const item = cat.items.find(i => i.path === fullPath);
    if (!item) return;
    if (item.bulk && item.path === '__bulk__') picks.push({ path: '__bulk__', size: item.size, bulkFiles: item.bulk });
    else picks.push({ path: item.path, size: item.size });
  });
  if (picks.length === 0) { toast('Nothing selected', 'error'); return; }

  const btn = $('junk-clean');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Cleaning…';
  const res = await window.api.cleanJunk(picks);
  if (res.cancelled) { toast('Cancelled'); btn.disabled = false; btn.textContent = 'Clean Selected'; return; }
  if (res.ok) {
    const failNote = res.failed ? ` · ${res.failed} couldn't be moved to Trash` : '';
    toast(`Freed ${humanSize(res.freed)} · ${res.removed} items in Trash${failNote}`, res.failed ? 'error' : 'success');
    $('junk-results').innerHTML = window.CMAC.result({ stat: humanSize(res.freed), title: 'Cleanup complete', sub: `${res.removed} items moved to Trash` });
    setTimeout(runJunkScan, 1400);
  } else {
    toast('Clean failed', 'error');
    btn.disabled = false; btn.textContent = 'Clean Selected';
  }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ===== Activity Monitor =====
const activityState = { sort: 'cpu', appsOnly: false, lastSnap: null };

async function loadActivity() {
  const snap = await window.api.getActivity();
  activityState.lastSnap = snap;
  renderActivity();
}

function renderActivity() {
  const s = activityState.lastSnap;
  if (!s) return;

  // KPI cards
  $('m-cpu-val').textContent = s.cpu.used.toFixed(1) + '%';
  $('m-cpu-fill').style.width = Math.min(100, s.cpu.used) + '%';
  $('m-cpu-sub').textContent = `${s.cpu.user.toFixed(1)}% user · ${s.cpu.sys.toFixed(1)}% sys · ${s.cpu.cores} cores · load ${s.cpu.loadAvg.map(x => x.toFixed(2)).join(', ')}`;

  $('m-mem-val').textContent = s.memory.usedPct.toFixed(0) + '%';
  $('m-mem-fill').style.width = Math.min(100, s.memory.usedPct) + '%';
  $('m-mem-sub').textContent = `${humanSize(s.memory.used)} of ${humanSize(s.memory.total)} · ${humanSize(s.memory.wired)} wired · ${humanSize(s.memory.unused)} free`;

  // Energy: scale 0-200 (anything over ~80 is "heavy" on a Mac)
  $('m-energy-val').textContent = s.energy.totalImpact.toFixed(0);
  $('m-energy-fill').style.width = Math.min(100, (s.energy.totalImpact / 200) * 100) + '%';
  $('m-energy-sub').textContent = `${s.processes.filter(p => p.power > 1).length} processes drawing power`;

  $('m-net-val').textContent = rateString(s.network.inRate + s.network.outRate);
  const netMax = 50 * 1024 * 1024; // 50 MB/s = full bar
  $('m-net-fill').style.width = Math.min(100, ((s.network.inRate + s.network.outRate) / netMax) * 100) + '%';
  $('m-net-sub').textContent = `↓ ${rateString(s.network.inRate)} · ↑ ${rateString(s.network.outRate)} · session ${humanSize(s.network.totalIn + s.network.totalOut)}`;

  $('m-disk-val').textContent = rateString(s.disk.readRate + s.disk.writeRate);
  $('m-disk-fill').style.width = Math.min(100, ((s.disk.readRate + s.disk.writeRate) / (200 * 1024 * 1024)) * 100) + '%';
  $('m-disk-sub').textContent = `read ${rateString(s.disk.readRate)} · write ${rateString(s.disk.writeRate)} · session r ${humanSize(s.disk.totalRead)} / w ${humanSize(s.disk.totalWrite)}`;

  // Process rows
  const sortKey = activityState.sort;
  let procs = s.processes.slice();
  if (activityState.appsOnly) procs = procs.filter(p => p.isApp);
  const cmp = sortKey === 'mem' ? (a,b) => b.memBytes - a.memBytes
            : sortKey === 'power' ? (a,b) => b.power - a.power
            : sortKey === 'threads' ? (a,b) => b.threads - a.threads
            : (a,b) => b.cpu - a.cpu;
  procs.sort(cmp);
  procs = procs.slice(0, 80);

  const rows = $('proc-rows');
  rows.innerHTML = procs.map(p => {
    const cpuCls = p.cpu >= 80 ? 'val-red' : p.cpu >= 40 ? 'val-amber' : p.cpu < 1 ? 'val-dim' : '';
    const memCls = p.memBytes >= 1024**3 ? 'val-bright' : p.memBytes < 1024 * 200 ? 'val-dim' : '';
    const powCls = p.power >= 50 ? 'val-red' : p.power >= 10 ? 'val-amber' : p.power < 0.5 ? 'val-dim' : '';
    const thrCls = p.threads >= 50 ? 'val-amber' : p.threads < 2 ? 'val-dim' : '';
    return `<div class="row proc-row" data-pid="${p.pid}">
      <div class="proc-cell">
        <span class="proc-kind ${p.isApp ? 'app' : 'sys'}" title="${p.isApp ? 'GUI Application' : 'System / background process'}"></span>
        <span class="proc-name-text" title="${escapeAttr(p.fullCommand || p.command)}">${escapeHtml(p.appName || p.command)}</span>
      </div>
      <div class="num ${cpuCls}">${p.cpu.toFixed(1)}</div>
      <div class="num ${memCls}">${humanSize(p.memBytes)}</div>
      <div class="num ${powCls}">${p.power > 0 ? p.power.toFixed(1) : '—'}</div>
      <div class="num ${thrCls}">${p.threads}</div>
      <div class="num pid-cell">${p.pid}</div>
      <div class="user-cell" title="${escapeAttr(p.user)}">${escapeHtml(p.user)}</div>
      <div class="actions-cell">
        <button class="tiny red" data-kill="${p.pid}" data-name="${escapeAttr(p.appName)}">Quit</button>
      </div>
    </div>`;
  }).join('');

  rows.querySelectorAll('[data-kill]').forEach(b => {
    let lastClick = 0;
    b.addEventListener('click', async () => {
      const pid = Number(b.dataset.kill);
      const name = b.dataset.name;
      const now = Date.now();
      // Second click within 4s = Force quit
      const force = (now - lastClick) < 4000;
      lastClick = now;
      if (!force) {
        b.textContent = 'Force?';
        setTimeout(() => { if (b.textContent === 'Force?') b.textContent = 'Quit'; }, 4000);
      } else {
        b.textContent = '…';
        b.disabled = true;
      }
      const res = await window.api.killProcess(pid, force);
      if (res.ok) {
        if (force) toast(`Force-quit ${name} (${pid})`, 'success');
        else toast(`Sent quit signal to ${name} — click again within 4s to force`, '');
        setTimeout(loadActivity, 1200);
      } else {
        toast(`Failed: ${res.error}`, 'error');
        b.textContent = 'Quit'; b.disabled = false;
      }
    });
  });

  $('proc-meta').textContent = `${procs.length} shown · ${s.cpu.processCount} total processes on system · sampled ${new Date(s.timestamp).toLocaleTimeString()}`;
}

// Tab switching
document.querySelectorAll('#view-activity .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#view-activity .tab').forEach(t => t.removeAttribute('data-active'));
    tab.setAttribute('data-active', '1');
    activityState.sort = tab.dataset.sort;
    renderActivity();
  });
});
document.getElementById('apps-only').addEventListener('change', (e) => {
  activityState.appsOnly = e.target.checked;
  renderActivity();
});

// Auto-refresh activity every 3s while on the view
let activityTimer = null;
function startActivityAutoRefresh() {
  if (activityTimer) return;
  activityTimer = setInterval(() => {
    const active = document.querySelector('.nav-item.active');
    if (active && active.dataset.view === 'activity') loadActivity();
  }, 3000);
}

// ===== Dispatcher =====
async function loadView(view, force=false) {
  if (view === 'dashboard') return loadDashboard();
  if (view === 'activity') { startActivityAutoRefresh(); return loadActivity(); }
  if (view === 'agents') return loadAgents();
  if (view === 'tokens') return loadTokens();
  if (view === 'models') return loadModels();
  if (view === 'cleaner') return loadCleaner();
  // CleanMyMac-style feature views register themselves in window.CM_VIEWS.
  if (window.CM_VIEWS && window.CM_VIEWS[view]) return window.CM_VIEWS[view].load(force);
}

// Live clock in the topbar
function tickClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('topbar-clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
tickClock();
setInterval(tickClock, 1000);

// Initial load
loadDashboard();

// Diagnostic: confirm renderer booted and which feature views registered.
// (Forwarded to main stderr by the console-message hook in main.js.)
window.addEventListener('load', () => {
  console.log('renderer ready · views: ' + Object.keys(window.CM_VIEWS || {}).sort().join(', '));
});

// Auto-refresh agents every 5s if on agents view
setInterval(() => {
  const active = document.querySelector('.nav-item.active');
  if (active && active.dataset.view === 'agents') loadAgents();
}, 5000);
