const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.cyber-monitor.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

async function walk(dir, results = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, results);
    else if (e.isFile() && e.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

const DAY = 86400 * 1000;
function emptyBuckets() {
  return {
    today: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 },
    week:  { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 },
    month: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 },
    all:   { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 },
  };
}
function billable(b) { return b.input + b.cacheCreate + b.output; }

function addEvent(buckets, hourly, now, ts, ev) {
  const apply = (b) => {
    b.input += ev.input;
    b.cacheCreate += ev.cacheCreate;
    b.cacheRead += ev.cacheRead;
    b.output += ev.output;
    b.messages++;
  };
  apply(buckets.all);
  if (!ts) return;
  const age = now - ts;
  if (age < DAY) {
    apply(buckets.today);
    const hourAgo = Math.floor(age / 3600000);
    if (hourAgo >= 0 && hourAgo < 24 && hourly) hourly[23 - hourAgo] += ev.input + ev.cacheCreate + ev.output;
  }
  if (age < 7 * DAY) apply(buckets.week);
  if (age < 30 * DAY) apply(buckets.month);
}

// ===== Claude Code =====
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;
const CLAUDE_FIELD_RE = /"(input_tokens|cache_creation_input_tokens|cache_read_input_tokens|output_tokens)"\s*:\s*(\d+)/g;
const MODEL_RE = /"model"\s*:\s*"([^"]+)"/;

async function parseClaude(now, hourly) {
  const buckets = emptyBuckets();
  const sessions = [];
  const models = new Set();
  const files = await walk(CLAUDE_PROJECTS);
  for (const f of files) {
    let data;
    try { data = await fsp.readFile(f, 'utf8'); } catch { continue; }
    const sess = { provider: 'Claude Code', vendor: 'Anthropic', file: f, name: path.basename(f, '.jsonl'), input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0, lastTs: 0, model: '' };
    for (const line of data.split('\n')) {
      if (!line.includes('"usage"')) continue;
      const ts = (line.match(TS_RE) || [])[1];
      const tsMs = ts ? Date.parse(ts) : 0;
      const usage = line.match(/"usage"\s*:\s*\{[^}]*\}/);
      if (!usage) continue;
      const fields = {};
      let m;
      const re = new RegExp(CLAUDE_FIELD_RE.source, 'g');
      while ((m = re.exec(usage[0])) !== null) fields[m[1]] = Number(m[2]);
      const model = (line.match(MODEL_RE) || [])[1];
      if (model) { models.add(model); sess.model = model; }
      const ev = {
        input: fields.input_tokens || 0,
        cacheCreate: fields.cache_creation_input_tokens || 0,
        cacheRead: fields.cache_read_input_tokens || 0,
        output: fields.output_tokens || 0,
      };
      sess.input += ev.input; sess.cacheCreate += ev.cacheCreate; sess.cacheRead += ev.cacheRead; sess.output += ev.output; sess.messages++;
      if (tsMs > sess.lastTs) sess.lastTs = tsMs;
      addEvent(buckets, hourly, now, tsMs, ev);
    }
    if (sess.messages > 0) sessions.push(sess);
  }
  return {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    icon: 'C',
    color: '#cc785c',
    models: Array.from(models),
    buckets,
    sessions,
    monthBillable: billable(buckets.month),
  };
}

// ===== Codex (OpenAI) =====
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CODEX_FIELD_RE = /"(input_tokens|cached_input_tokens|output_tokens|reasoning_output_tokens)"\s*:\s*(\d+)/g;

async function parseCodex(now, hourly) {
  const buckets = emptyBuckets();
  const sessions = [];
  const models = new Set();
  const files = await walk(CODEX_SESSIONS);
  for (const f of files) {
    let data;
    try { data = await fsp.readFile(f, 'utf8'); } catch { continue; }
    const sess = { provider: 'Codex', vendor: 'OpenAI', file: f, name: path.basename(f, '.jsonl').replace(/^rollout-/, '').slice(0, 24), input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0, lastTs: 0, model: '' };
    // Pull model info from session_meta header
    const metaModelName = (data.match(/"model":"([^"]+)"/) || [])[1];
    if (metaModelName) { models.add(metaModelName); sess.model = metaModelName; }

    // Codex emits a token_count event each turn with `last_token_usage` (the
    // delta for that turn) and `total_token_usage` (running total). We sum
    // last_token_usage so each turn lands in the correct time bucket.
    for (const line of data.split('\n')) {
      if (!line.includes('last_token_usage')) continue;
      const ts = (line.match(TS_RE) || [])[1];
      const tsMs = ts ? Date.parse(ts) : 0;
      const usage = line.match(/"last_token_usage"\s*:\s*\{[^}]+\}/);
      if (!usage) continue;
      const fields = {};
      let m;
      const re = new RegExp(CODEX_FIELD_RE.source, 'g');
      while ((m = re.exec(usage[0])) !== null) fields[m[1]] = Number(m[2]);
      const cacheRead = fields.cached_input_tokens || 0;
      // Codex sums cached into total input_tokens; subtract so cache is shown separately
      const inputUncached = Math.max(0, (fields.input_tokens || 0) - cacheRead);
      const output = (fields.output_tokens || 0); // includes reasoning
      const ev = { input: inputUncached, cacheCreate: 0, cacheRead, output };
      sess.input += ev.input; sess.cacheRead += ev.cacheRead; sess.output += ev.output; sess.messages++;
      if (tsMs > sess.lastTs) sess.lastTs = tsMs;
      addEvent(buckets, hourly, now, tsMs, ev);
    }
    if (sess.messages > 0) sessions.push(sess);
  }
  return {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    icon: '◇',
    color: '#10a37f',
    models: Array.from(models),
    buckets,
    sessions,
    monthBillable: billable(buckets.month),
  };
}

// ===== Public =====
async function stats() {
  const settings = loadSettings();
  const limit = settings.tokenLimit || 0;
  const now = Date.now();
  const hourly = new Array(24).fill(0);

  const providers = [];
  const c = await parseClaude(now, hourly);
  if (c.sessions.length > 0) providers.push(c);
  const x = await parseCodex(now, hourly);
  if (x.sessions.length > 0) providers.push(x);

  // Aggregate buckets across providers
  const buckets = emptyBuckets();
  for (const p of providers) {
    for (const k of Object.keys(buckets)) {
      buckets[k].input += p.buckets[k].input;
      buckets[k].cacheCreate += p.buckets[k].cacheCreate;
      buckets[k].cacheRead += p.buckets[k].cacheRead;
      buckets[k].output += p.buckets[k].output;
      buckets[k].messages += p.buckets[k].messages;
    }
  }
  const monthBillable = billable(buckets.month);

  // Top 25 sessions across all providers, sorted by recency
  const sessions = []
    .concat(...providers.map(p => p.sessions))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 25);

  // Provider summaries (strip sessions for transport)
  const providerSummaries = providers.map(p => ({
    id: p.id, name: p.name, vendor: p.vendor, icon: p.icon, color: p.color,
    models: p.models, buckets: p.buckets, monthBillable: p.monthBillable,
  }));

  return {
    providers: providerSummaries,
    buckets,
    hourly,
    sessions,
    limit,
    monthBillable,
    remaining: limit > 0 ? Math.max(0, limit - monthBillable) : null,
    pctUsed: limit > 0 ? Math.min(100, (monthBillable / limit) * 100) : null,
  };
}

function setLimit(limit) {
  const s = loadSettings();
  s.tokenLimit = Number(limit) || 0;
  saveSettings(s);
  return { ok: true };
}

module.exports = { stats, setLimit };
