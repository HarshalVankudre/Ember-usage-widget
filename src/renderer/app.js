'use strict';

/* ───────────────────────── state ─────────────────────────
   Buckets arrive pre-normalized from main.js with a `provider` tag
   ('claude' | 'codex') and unified token/cost fields. Models are keyed
   `provider|model` everywhere so the two providers never collide. */

const state = {
  buckets: [],
  generatedAt: 0,
  preset: 'all',
  customFrom: null,
  customTo: null,
  customFromTime: '00:00',
  customToTime: '23:59',
  customEndMode: 'now',
  selectedDay: null,
  selectionOrigin: null,
  selectedProviders: new Set(), // empty = both
  selectedModels: new Set(),    // keys `provider|model`; empty = all
  projectsExpanded: false,
  expandedProject: null,
  hiddenProjects: loadHiddenProjects(), // excluded from all totals, shown blurred
  selectedProjects: new Set(), // ticked for export; follows what the filters show
  archivedProjects: loadArchivedProjects(), // out of the list only — still in every total
  archivedExpanded: false,
  settings: { alwaysOnTop: false, launchAtStartup: true },
  limits: null, // { claude, codex }
  worstLimit: 0,
  lastView: null,
  quota: null,  // durable plan-meter history from the main process
  quotaRevision: 0,
  quotaScope: null,
  quotaMetric: 'cost',
  pricing: null,
  dataRevision: 0,
  usageRevision: null,
  usageGeneratedAt: null,
  hasRenderedUsage: false,
};

const PROVIDERS = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', color: '#38c98b' },
  zcode: { label: 'zcode', color: '#7c8cf8' },
};

// A provider the backend knows about but this build does not must degrade to a
// labelled grey row, never take the whole widget down with it.
const UNKNOWN_PROVIDER = { label: 'Other', color: '#8a8a8a' };
const pmeta = (p) => PROVIDERS[p] || UNKNOWN_PROVIDER;

const mkey = (b) => `${b.provider}|${b.model}`;

function loadHiddenProjects() {
  try {
    return new Set(JSON.parse(localStorage.getItem('hiddenProjects') || '[]'));
  } catch {
    return new Set();
  }
}

function saveHiddenProjects() {
  localStorage.setItem('hiddenProjects', JSON.stringify([...state.hiddenProjects]));
}

// Archiving is filing, not hiding: an archived project keeps feeding the hero,
// the chart and the model table, it just stops crowding the project list.
function loadArchivedProjects() {
  try {
    return new Set(JSON.parse(localStorage.getItem('archivedProjects') || '[]'));
  } catch {
    return new Set();
  }
}

function saveArchivedProjects() {
  localStorage.setItem('archivedProjects', JSON.stringify([...state.archivedProjects]));
}

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let APP_VERSION = '';

// Canvas text follows the widget's scalable type ramp: the stylesheet drives
// the root font size from the window width, and chart labels track it.
// Reading it is a forced style recalculation, so it is measured once per
// resize instead of once per label — a chart draws a dozen of those.
let rootRem = 0;
function remPx() {
  if (!rootRem) rootRem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  return rootRem;
}
window.addEventListener('resize', () => { rootRem = 0; }, { passive: true });

function chartFont(remSize, weight = '') {
  const px = Math.round(remSize * remPx() * 10) / 10;
  return `${weight ? `${weight} ` : ''}${px}px "Cascadia Mono", Consolas, "Segoe UI", sans-serif`;
}

/* Resizing a canvas reallocates its backing store and resets the context, so
   it is only done when the box actually changed size. Everything else is a
   clear-and-draw. */
function prepCanvas(canvas, W, H) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

/* ───────────────────────── helpers ───────────────────────── */

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtCost(c) {
  if (c >= 1000) return '$' + c.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (c >= 100) return '$' + c.toFixed(1);
  if (c >= 0.01 || c === 0) return '$' + c.toFixed(2);
  return '$' + c.toFixed(4);
}

// typographic money: raised small "$", dimmed decimals — `$ 1,139 .42`
function moneyHTML(v) {
  const a = Math.abs(v);
  let int, dec = '';
  if (a >= 1000) {
    int = Math.round(a).toLocaleString('en-US');
  } else if (a >= 0.01 || a === 0) {
    const f = a.toFixed(2);
    int = f.slice(0, -3);
    dec = f.slice(-3);
  } else {
    const f = a.toFixed(4);
    int = f.slice(0, -5);
    dec = f.slice(-5);
  }
  return `<span class="cur">${v < 0 ? '-' : ''}$</span>${int}${dec ? `<span class="dec">${dec}</span>` : ''}`;
}

// "3.64M" -> 3.64 + small unit span
function tokHTML(n) {
  const s = fmtTok(n);
  const m = s.match(/^([\d.,]+)([KMB]?)$/);
  return m ? `${m[1]}${m[2] ? `<span class="unit">${m[2]}</span>` : ''}` : s;
}

// tween a numeric value on an element; renderFn paints each frame
function animateValue(el, to, renderFn, dur = 650) {
  const from = el._val;
  el._val = to;
  if (reduceMotion.matches || from == null || !isFinite(from) || Math.abs(to - from) < 1e-9) {
    renderFn(el, to);
    return;
  }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    renderFn(el, from + (to - from) * ease(t));
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Direct interactions should settle immediately. Only newly-arrived live data
// uses the value tween, so filtering and date selection never feel delayed.
function updateValue(el, to, renderFn, animate) {
  if (animate) {
    animateValue(el, to, renderFn);
    return;
  }
  cancelAnimationFrame(el._raf);
  el._val = to;
  renderFn(el, to);
}

const paintMoney = (el, v) => { el.innerHTML = moneyHTML(v); };
const paintCost = (el, v) => { el.textContent = fmtCost(v); };
const paintTokens = (el, v) => { el.textContent = `${fmtTok(Math.max(0, v))} tokens`; };
const paintCalls = (el, v) => { el.textContent = `${Math.round(Math.max(0, v)).toLocaleString()} calls`; };

function dstr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function today() { return dstr(new Date()); }

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dstr(d);
}

function prettyDay(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function currentTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function minuteStamp(date, time) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time).split(':').map(Number);
  if (!year || !month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) return NaN;
  return Date.UTC(year, month - 1, day) / 60000 + hour * 60 + minute;
}

function resolveCustomBounds(source = state) {
  const fromDate = source.customFrom || daysAgo(13);
  const fromTime = source.customFromTime || '00:00';
  const toNow = source.customEndMode !== 'custom';
  const toDate = toNow ? today() : (source.customTo || today());
  const toTime = toNow ? currentTime() : (source.customToTime || '23:59');
  return {
    fromDate, fromTime, toDate, toTime,
    from: minuteStamp(fromDate, fromTime),
    to: minuteStamp(toDate, toTime),
  };
}

function rangeForPreset(source = state) {
  const t = today();
  switch (source.preset) {
    case 'today': return [t, t];
    case '7d': return [daysAgo(6), t];
    case '30d': return [daysAgo(29), t];
    case 'mtd': return [t.slice(0, 8) + '01', t];
    case 'custom': {
      const bounds = resolveCustomBounds(source);
      return [bounds.fromDate, bounds.toDate];
    }
    default: return ['0000', '9999'];
  }
}

function chartRangeForSelection() {
  return state.selectedDay && state.selectionOrigin
    ? state.selectionOrigin.range
    : rangeForPreset();
}

const RANGE_LABELS = {
  today: 'today', '7d': 'last 7 days', '30d': 'last 30 days',
  mtd: 'this month', all: 'all time', custom: 'custom range',
};

/* ───────────────────────── model names + colors ───────────────────────── */

// Claude: "claude-opus-4-8-20250915" -> "Opus 4.8"
function prettyClaudeModel(m) {
  const s = m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const match = s.match(/^([a-z]+)-?(\d+)?-?(\d+)?(.*)$/);
  if (!match) return s;
  const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const ver = match[2] ? (match[3] ? `${match[2]}.${match[3]}` : match[2]) : '';
  return (name + ' ' + ver + (match[4] || '')).trim();
}

// Codex: "gpt-5.6-sol" -> "GPT-5.6 Sol", "o4-mini" -> "O4 Mini"
function prettyCodexModel(m) {
  const parts = String(m).split('-');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    if (i === 0 && s.toLowerCase() === 'gpt') { out.push('GPT'); continue; }
    if (out.length === 1 && out[0] === 'GPT' && /^\d/.test(s)) { out[0] = 'GPT-' + s; continue; }
    out.push(s.charAt(0).toUpperCase() + s.slice(1));
  }
  return out.join(' ');
}

// zcode: "z-ai/glm-5.3-flash:makora" -> "GLM-5.3 Flash". The vendor prefix and
// the routing suffix say where the request went, not which model ran, so both
// are dropped — the coding plan's bare "GLM-5.3-Flash" then reads identically.
function prettyZcodeModel(m, source) {
  const raw = String(m);
  const colon = raw.indexOf(':');
  const base = colon === -1 ? raw : raw.slice(0, colon);
  // OpenRouter appends a routing variant (`:nitro`, `:makora`) and prefixes a
  // vendor. Both are separate rows with their own prices, so the label has to
  // carry them — dropping them printed two identical "GLM-5.3 Flash" lines.
  const variant = colon === -1 ? '' : raw.slice(colon + 1);
  const vendor = base.includes('/') ? base.slice(0, base.indexOf('/')) : '';
  const name = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  const pretty = name
    .split('-')
    .filter(Boolean)
    .map((s) => (/^(glm|gpt|qwen|kimi)$/i.test(s) ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ')
    .replace(/^(GLM|GPT|QWEN|KIMI) (\d)/i, '$1-$2');
  // The same GLM build is reachable through both imported providers, so the
  // model name alone is ambiguous — say which one served it. `source` comes
  // from zcode's own config; the slug shape is the fallback (only OpenRouter
  // ids carry a vendor prefix).
  const via = source || (vendor ? 'OpenRouter' : 'Z.ai coding plan');
  const route = [vendor, variant].filter(Boolean).join(' ');
  return route ? `${pretty} · ${via} (${route})` : `${pretty} · ${via}`;
}

function prettyModel(provider, model, source) {
  if (provider === 'codex') return prettyCodexModel(model);
  if (provider === 'zcode') return prettyZcodeModel(model, source);
  return prettyClaudeModel(model);
}

/* Family palettes — checked in order, first substring match wins. The values
   are token names rather than hexes so a model keeps its place in the
   hierarchy across every theme. */
const CLAUDE_FAMILY_TOKEN = {
  fable: 'fable', mythos: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  other: 'other',
};
const ZCODE_FAMILY_TOKEN = {
  flash: 'haiku',
  air: 'haiku',
  mini: 'haiku',
  glm: 'sonnet',
  qwen: 'gpt4',
  kimi: 'opus',
  other: 'other',
};
const CODEX_FAMILY_TOKEN = {
  pro: 'pro',
  mini: 'mini',
  nano: 'nano',
  'gpt-6': 'gpt5',
  'gpt-5': 'gpt5',
  codex: 'gpt5',
  'gpt-4': 'gpt4',
  'o4': 'o3',
  'o3': 'o3',
  other: 'other',
};

const modelColorCache = new Map();
function modelColor(provider, model) {
  const key = `${provider}|${model}`;
  if (modelColorCache.has(key)) return modelColorCache.get(key);
  const palette = provider === 'codex'
    ? CODEX_FAMILY_TOKEN
    : provider === 'zcode' ? ZCODE_FAMILY_TOKEN : CLAUDE_FAMILY_TOKEN;
  const lower = model.toLowerCase();
  let fam = 'other';
  for (const f of Object.keys(palette)) if (f !== 'other' && lower.includes(f)) { fam = f; break; }
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const base = window.EmberTheme.tokens()[palette[fam]];
  // shift lightness slightly per variant so e.g. Opus 4.7 vs 4.8 differ
  const shift = ((hash % 5) - 2) * 7;
  const c = shade(base, shift);
  modelColorCache.set(key, c);
  return c;
}

/* A theme swap invalidates every colour the renderer derived from it. */
function invalidateThemeColors() {
  modelColorCache.clear();
  PROVIDERS.claude.color = window.EmberTheme.tokens().claude;
  PROVIDERS.codex.color = window.EmberTheme.tokens().codex;
}

function shade(c, amt) {
  let r, g, b;
  if (c[0] === '#') {
    const n = parseInt(c.slice(1), 16);
    r = n >> 16; g = (n >> 8) & 0xff; b = n & 0xff;
  } else {
    const m = c.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
    if (!m) return c;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const cl = (x) => Math.max(0, Math.min(255, x + amt));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

/* ───────────────────────── filtering ───────────────────────── */

function passesLiveFilters(b) {
  if (state.selectedProviders.size > 0 && !state.selectedProviders.has(b.provider)) return false;
  if (state.selectedModels.size > 0 && !state.selectedModels.has(mkey(b))) return false;
  return true;
}

function passesProviderFilter(b) {
  return state.selectedProviders.size === 0 || state.selectedProviders.has(b.provider);
}

function visibleModelKeys() {
  return new Set(state.buckets.filter((b) => passesProviderFilter(b) && !isArchivedModel(b.model)).map(mkey));
}

function isArchivedModel(model) {
  return window.EmberFilterState.isArchivedModel(model);
}

function reconcileVisibleModelSelection() {
  state.selectedModels = window.EmberFilterState.reconcileModelSelection(
    state.selectedModels,
    visibleModelKeys(),
  );
}

function bucketMatchesRange(b, source, range, frozenBounds = null) {
  const [from, to] = range;
  if (b.date < from || b.date > to) return false;
  if (source.preset !== 'custom') return true;

  const bounds = frozenBounds || resolveCustomBounds(source);
  const hour = Number.isInteger(b.hour) ? b.hour : 0;
  const bucketStart = minuteStamp(b.date, `${String(hour).padStart(2, '0')}:00`);
  if (b.minute == null) {
    // Deleted-history records may only be recoverable to the hour. Include the
    // record whenever any part of that hour overlaps the requested interval.
    return bucketStart <= bounds.to && bucketStart + 60 > bounds.from;
  }
  const bucketTime = bucketStart + b.minute;
  return bucketTime >= bounds.from && bucketTime <= bounds.to;
}

function rangeFilteredBuckets() {
  const range = rangeForPreset();
  return state.buckets.filter((b) => {
    if (!bucketMatchesRange(b, state, range)) return false;
    return passesLiveFilters(b);
  });
}

function chartFilteredBuckets() {
  const source = state.selectedDay && state.selectionOrigin ? state.selectionOrigin : state;
  const range = chartRangeForSelection();
  const frozenBounds = source === state ? null : source.customBounds;
  return state.buckets.filter((b) => {
    if (!bucketMatchesRange(b, source, range, frozenBounds)) return false;
    return passesLiveFilters(b);
  });
}

function filteredBuckets() {
  const rows = rangeFilteredBuckets();
  return state.selectedDay ? rows.filter((b) => b.date === state.selectedDay) : rows;
}

// The Models table remains a stable filter control: it follows the active
// date/provider range, but deliberately ignores the model selection itself.
// That lets the non-selected rows stay visible (and blurred) while the rest of
// the dashboard is filtered to the chosen model.
function modelTableFilteredBuckets() {
  const range = rangeForPreset();
  return state.buckets.filter((b) => {
    if (!bucketMatchesRange(b, state, range)) return false;
    if (!passesProviderFilter(b)) return false;
    return !state.selectedDay || b.date === state.selectedDay;
  });
}

function dayTotals(rows) {
  const byDay = new Map();
  for (const b of rows) {
    if (state.hiddenProjects.has(b.project)) continue;
    const mk = mkey(b);
    let d = byDay.get(b.date);
    if (!d) { d = { total: 0, models: new Map() }; byDay.set(b.date, d); }
    d.total += b.cost;
    d.models.set(mk, (d.models.get(mk) || 0) + b.cost);
  }
  return byDay;
}

/* ───────────────────────── rendering ───────────────────────── */

const sectionRenderKeys = {
  providers: null,
  models: null,
  modelTable: null,
  projects: null,
  chart: null,
  quota: null,
};
let liveRenderFrame = 0;
let resetChartHover = () => {};

function setKey(value) {
  return [...value].sort().join(',');
}

function addModelBucket(byModel, b) {
  const mk = mkey(b);
  let m = byModel.get(mk);
  if (!m) {
    m = { provider: b.provider, model: b.model, source: b.source,
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costMin: 0, costMax: 0,
      estimated: false, pricedCalls: 0, unpricedCalls: 0, priced: b.priced };
    byModel.set(mk, m);
  }
  m.input += b.input;
  m.output += b.output;
  m.cacheRead += b.cacheRead;
  m.cacheWrite += b.cacheWrite;
  m.cost += b.cost;
  m.reasoning += b.reasoning || 0;
  m.costMin += b.costMin || 0;
  m.costMax += b.costMax || b.cost || 0;
  m.estimated = m.estimated || !!b.estimated;
  m.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
  m.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
  if (!b.priced) m.priced = false;
}

function scheduleLiveRender() {
  if (liveRenderFrame) return;
  liveRenderFrame = requestAnimationFrame(() => {
    liveRenderFrame = 0;
    render({ animate: true });
  });
}

function applyUsageData(data) {
  const revision = Number.isSafeInteger(data.revision) ? data.revision : null;
  const generatedAt = Number.isFinite(data.generatedAt) ? data.generatedAt : 0;
  if (revision != null) {
    if (state.usageRevision != null && revision <= state.usageRevision) return false;
  } else {
    // Compatibility with older payloads. Once a revisioned payload arrives,
    // an unversioned response can only be an older in-flight response.
    if (state.usageRevision != null) return false;
    if (state.usageGeneratedAt != null && generatedAt <= state.usageGeneratedAt) return false;
  }

  state.buckets = data.buckets;
  state.generatedAt = generatedAt;
  state.pricing = data.pricing;
  state.usageRevision = revision;
  state.usageGeneratedAt = generatedAt;
  state.dataRevision++;
  return true;
}

function render({ animate = false } = {}) {
  // A direct interaction supersedes a queued live paint and renders the newest
  // state synchronously instead.
  if (liveRenderFrame) {
    cancelAnimationFrame(liveRenderFrame);
    liveRenderFrame = 0;
  }
  state.hasRenderedUsage = true;
  reconcileVisibleModelSelection();

  const rows = filteredBuckets();
  const byDay = dayTotals(chartFilteredBuckets());
  const modelTableData = new Map();
  for (const b of modelTableFilteredBuckets()) {
    if (!state.hiddenProjects.has(b.project)) addModelBucket(modelTableData, b);
  }

  const tot = {
    cost: 0, costMin: 0, costMax: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    msgs: 0, pricedCalls: 0, unpricedCalls: 0, pricedTokens: 0, unpricedTokens: 0,
    saved: 0, cIn: 0, cOut: 0, cCr: 0, cCw: 0, cTool: 0,
    estimated: false, longContextCalls: 0,
  };
  const byModel = new Map();   // mkey -> totals
  const byProject = new Map(); // project name -> totals (providers merge)
  const sessions = new Set();
  const days = new Set();

  for (const b of rows) {
    const mk = mkey(b);

    let p = byProject.get(b.project);
    if (!p) {
      p = { cost: 0, costMin: 0, costMax: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0,
        pricedCalls: 0, unpricedCalls: 0, estimated: false,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, cTool: 0, live: false, models: new Map(),
        activeMs: 0, sessions: new Set(), days: new Set() };
      byProject.set(b.project, p);
    }
    // a project counts as deleted only when every source log is gone
    // (across both providers)
    if (!b.projectDeleted) p.live = true;
    p.cost += b.cost;
    p.costMin += b.costMin || 0;
    p.costMax += b.costMax || b.cost || 0;
    p.input += b.input;
    p.output += b.output;
    p.cacheRead += b.cacheRead;
    p.cacheWrite += b.cacheWrite;
    p.reasoning += b.reasoning;
    p.msgs += b.msgs;
    p.cIn += b.cIn || 0;
    p.cOut += b.cOut || 0;
    p.cCr += b.cCr || 0;
    p.cCw += b.cCw || 0;
    p.cRs += b.cRs || 0;
    p.cTool += b.cTool || 0;
    p.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
    p.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
    p.estimated = p.estimated || !!b.estimated;
    p.activeMs += b.activeMs || 0;
    p.sessions.add(`${b.provider}|${b.session}`);
    p.days.add(b.date);
    let pm = p.models.get(mk);
    if (!pm) {
      pm = { provider: b.provider, model: b.model, source: b.source, source: b.source,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, msgs: 0,
        costMin: 0, costMax: 0,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, cTool: 0,
        pricedCalls: 0, unpricedCalls: 0, estimated: false, priced: true, activeMs: 0 };
      p.models.set(mk, pm);
    }
    pm.input += b.input;
    pm.output += b.output;
    pm.cacheRead += b.cacheRead;
    pm.cacheWrite += b.cacheWrite;
    pm.reasoning += b.reasoning;
    pm.cost += b.cost;
    pm.costMin += b.costMin || 0;
    pm.costMax += b.costMax || b.cost || 0;
    pm.msgs += b.msgs;
    pm.cIn += b.cIn || 0;
    pm.cOut += b.cOut || 0;
    pm.cCr += b.cCr || 0;
    pm.cCw += b.cCw || 0;
    pm.cRs += b.cRs || 0;
    pm.cTool += b.cTool || 0;
    pm.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
    pm.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
    pm.estimated = pm.estimated || !!b.estimated;
    pm.activeMs += b.activeMs || 0;
    if (!b.priced) pm.priced = false;

    // hidden projects still render (blurred) but count toward nothing else
    if (state.hiddenProjects.has(b.project)) continue;

    tot.cost += b.cost;
    tot.costMin += b.costMin || 0;
    tot.costMax += b.costMax || b.cost || 0;
    tot.input += b.input;
    tot.output += b.output;
    tot.cacheRead += b.cacheRead;
    tot.cacheWrite += b.cacheWrite;
    tot.reasoning += b.reasoning;
    tot.msgs += b.msgs;
    tot.saved += b.cacheSavings;
    tot.cIn += b.cIn || 0;
    tot.cOut += b.cOut || 0;
    tot.cCr += b.cCr || 0;
    tot.cCw += b.cCw || 0;
    tot.cTool += b.cTool || 0;
    tot.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
    tot.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
    tot.estimated = tot.estimated || !!b.estimated;
    tot.longContextCalls += b.longContextCalls || 0;
    const bucketTokens = b.input + b.output + b.cacheRead + b.cacheWrite;
    if (b.priced) tot.pricedTokens += bucketTokens;
    else tot.unpricedTokens += bucketTokens;
    sessions.add(`${b.provider}|${b.session}`);
    days.add(b.date);

    addModelBucket(byModel, b);

  }

  // today's spend under the mascots (provider/model filters apply; date filter doesn't — it's live)
  const t = today();
  let todayCost = 0;
  for (const b of state.buckets) {
    if (state.hiddenProjects.has(b.project)) continue;
    if (b.date === t && passesLiveFilters(b)) todayCost += b.cost;
  }
  updateValue($('todayVal'), todayCost, paintCost, animate);

  // rolling windows: last 5 hours (hour resolution) and last 7 days.
  // Provider/model filters apply; the date filter intentionally doesn't — these are live.
  const now = Date.now();
  const cutoff5h = now - 5 * 3600 * 1000;
  const floor7 = daysAgo(6);
  const w5 = { cost: 0, tok: 0, msgs: 0 };
  const wk = { cost: 0, tok: 0, msgs: 0 };
  for (const b of state.buckets) {
    if (!passesLiveFilters(b)) continue;
    if (state.hiddenProjects.has(b.project)) continue;
    const tokens = b.input + b.output + b.cacheRead + b.cacheWrite;
    if (b.date >= floor7 && b.date <= t) {
      wk.cost += b.cost; wk.tok += tokens; wk.msgs += b.msgs;
    }
    const epoch = new Date(`${b.date}T${String(b.hour ?? 0).padStart(2, '0')}:00:00`).getTime();
    if (epoch >= cutoff5h && epoch <= now) {
      w5.cost += b.cost; w5.tok += tokens; w5.msgs += b.msgs;
    }
  }
  updateValue($('w5hCost'), w5.cost, paintMoney, animate);
  // Two lines, broken on purpose (the cell is white-space: pre-line): left to
  // wrap on its own, a third of the window orphans the word "calls".
  $('w5hTok').textContent = w5.msgs ? `${fmtTok(w5.tok)} tokens\n${w5.msgs.toLocaleString()} calls` : 'no activity';
  updateValue($('wkCost'), wk.cost, paintMoney, animate);
  $('wkTok').textContent = wk.msgs ? `${fmtTok(wk.tok)} tokens\n${wk.msgs.toLocaleString()} calls` : 'no activity';
  renderMonthProjection(animate);

  // hero: only officially priced usage contributes to the number. Unknown
  // model prices are called out separately instead of silently counting $0.
  const detailLabel = state.selectedDay ? prettyDay(state.selectedDay) : RANGE_LABELS[state.preset];
  $('heroLabel').textContent = (tot.unpricedCalls ? 'Priced API value · ' : 'API-equivalent value · ') + detailLabel;
  updateValue($('heroCost'), tot.cost, paintMoney, animate);
  const allTok = tot.input + tot.output + tot.cacheRead + tot.cacheWrite;
  updateValue($('heroTokens'), allTok, paintTokens, animate);
  updateValue($('heroMsgs'), tot.msgs, paintCalls, animate);
  renderPeriodDelta(tot.cost);
  renderPricingConfidence(tot, byModel);

  const providersKey = `${state.dataRevision}|${setKey(state.selectedProviders)}`;
  if (sectionRenderKeys.providers !== providersKey) {
    renderProviderChips();
    sectionRenderKeys.providers = providersKey;
  }

  const archiveKey = window.EmberFilterState.archiveCutoff();
  const modelsKey = `${providersKey}|${setKey(state.selectedModels)}|${archiveKey}`;
  if (sectionRenderKeys.models !== modelsKey) {
    renderModelChips();
    sectionRenderKeys.models = modelsKey;
    syncScrollerFades();
  }

  const hiddenKey = setKey(state.hiddenProjects);
  const detailKey = [
    state.dataRevision, state.preset, state.customFrom, state.customFromTime,
    state.customTo, state.customToTime, state.customEndMode,
    state.selectedDay, setKey(state.selectedProviders),
    setKey(state.selectedModels), hiddenKey, archiveKey,
  ].join('|');
  if (sectionRenderKeys.modelTable !== detailKey) {
    renderModelTable(modelTableData);
    sectionRenderKeys.modelTable = detailKey;
  }

  const projectsKey = [
    detailKey, state.projectsExpanded, state.expandedProject,
    setKey(state.selectedProjects), setKey(state.archivedProjects), state.archivedExpanded,
  ].join('|');
  if (sectionRenderKeys.projects !== projectsKey) {
    renderProjects(byProject);
    sectionRenderKeys.projects = projectsKey;
  }

  const originRange = state.selectionOrigin ? [
    state.selectionOrigin.range.join(':'), state.selectionOrigin.customFrom,
    state.selectionOrigin.customFromTime, state.selectionOrigin.customTo,
    state.selectionOrigin.customToTime, state.selectionOrigin.customEndMode,
    state.selectionOrigin.customBounds ? `${state.selectionOrigin.customBounds.from}:${state.selectionOrigin.customBounds.to}` : '',
  ].join(':') : '';
  const chartKey = `${detailKey}|${originRange}`;
  if (sectionRenderKeys.chart !== chartKey) {
    renderChart(byDay);
    sectionRenderKeys.chart = chartKey;
  }

  // Session burn answers a different question than the filters do, so it
  // tracks the raw data and the meter history rather than the active view.
  const quotaKey = [state.dataRevision, state.quotaRevision, state.quotaScope, state.quotaMetric].join('|');
  if (sectionRenderKeys.quota !== quotaKey) {
    renderQuota(animate);
    sectionRenderKeys.quota = quotaKey;
  }

  // Whatever the user is looking at is what export writes out.
  state.lastView = {
    tot, byModel, byProject, w5, wk, todayCost,
    dayCount: days.size, sessionCount: sessions.size,
  };
  renderMini();
}

/* ───────────────────────── period comparison ─────────────────────────
   A number alone says nothing about direction. Each bounded range is
   measured against the stretch of equal length immediately before it. */

function shiftRangeBack([from, to]) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (isNaN(start) || isNaN(end)) return null;
  const days = Math.round((end - start) / 86400000) + 1;
  if (!(days > 0)) return null;
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - days);
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  return { range: [dstr(prevStart), dstr(prevEnd)], days };
}

function renderPeriodDelta(currentCost) {
  const el = $('heroDelta');
  // "All time" has nothing before it, and a single chosen day is a slice of a
  // range rather than a period of its own.
  if (state.preset === 'all' || state.selectedDay) {
    el.hidden = true;
    return;
  }
  const previous = shiftRangeBack(rangeForPreset());
  if (!previous) {
    el.hidden = true;
    return;
  }
  const [from, to] = previous.range;
  let prevCost = 0;
  let prevCalls = 0;
  for (const b of state.buckets) {
    if (b.date < from || b.date > to) continue;
    if (state.hiddenProjects.has(b.project)) continue;
    if (!passesLiveFilters(b)) continue;
    prevCost += b.cost;
    prevCalls += b.msgs;
  }
  if (!prevCalls) {
    el.hidden = true;
    return;
  }
  const change = (currentCost - prevCost) / prevCost;
  const pct = Math.round(Math.abs(change) * 100);
  const label = previous.days === 1 ? 'yesterday' : `prev ${previous.days}d`;
  el.hidden = false;
  el.classList.toggle('up', change > 0.005);
  el.classList.toggle('down', change < -0.005);
  el.textContent = pct === 0
    ? `level vs ${label}`
    : `${change > 0 ? '+' : '−'}${pct}% vs ${label}`;
  el.title = `${fmtCost(prevCost)} over the ${previous.days === 1 ? 'previous day' : `previous ${previous.days} days`} (${from} to ${to}), under the same filters`;
}

/* ───────────────────────── month projection ─────────────────────────
   Month-to-date is live regardless of the chosen range, so the pace it
   implies is the one figure a monthly budget can actually be judged on. */

function renderMonthProjection(animate) {
  const now = new Date();
  const monthStart = dstr(new Date(now.getFullYear(), now.getMonth(), 1));
  const t = today();
  let cost = 0;
  let calls = 0;
  for (const b of state.buckets) {
    if (b.date < monthStart || b.date > t) continue;
    if (state.hiddenProjects.has(b.project)) continue;
    if (!passesLiveFilters(b)) continue;
    cost += b.cost;
    calls += b.msgs;
  }
  updateValue($('mtdCost'), cost, paintMoney, animate);
  const el = $('mtdProj');
  if (!calls) {
    el.textContent = 'no activity';
    el.title = '';
    return;
  }
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // Count today as the fraction already elapsed, so a projection made at
  // breakfast does not read the morning as a whole day of work.
  const elapsed = now.getDate() - 1 + (now.getHours() * 60 + now.getMinutes()) / 1440;
  const projected = elapsed > 0.2 ? (cost / elapsed) * daysInMonth : null;
  el.textContent = projected ? `≈${fmtCost(projected)}\nby month end` : `${calls.toLocaleString()} calls`;
  el.title = projected
    ? `At the pace set over the first ${elapsed.toFixed(1)} days of the month`
    : '';
}

function renderPricingConfidence(tot, byModel) {
  const box = $('pricingConfidence');
  const summary = $('pricingSummary');
  const range = $('pricingRange');
  box.classList.remove('estimated', 'partial');
  const copy = window.EmberPricingConfidence.describePricingConfidence(tot, [...byModel.values()]);
  if (copy.tone !== 'complete') box.classList.add(copy.tone);
  summary.textContent = copy.summary;
  box.title = copy.title;

  const spread = Math.max(0, tot.costMax - tot.costMin);
  range.textContent = spread >= 0.005 ? `lower ${fmtCost(tot.costMin)}` : '';
}

function renderProviderChips() {
  const present = [...new Set(state.buckets.map((b) => b.provider))];
  const wrap = $('providerChips');
  wrap.innerHTML = '';
  if (present.length < 2) return; // nothing to filter with a single provider
  for (const pv of ['claude', 'codex', 'zcode']) {
    if (!present.includes(pv)) continue;
    const btn = document.createElement('button');
    btn.className = 'chip model-chip provider-chip';
    const active = state.selectedProviders.size === 0 || state.selectedProviders.has(pv);
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.title = `Filter to ${pmeta(pv).label}`;
    btn.style.setProperty('--c', pmeta(pv).color);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    btn.append(swatch, document.createTextNode(pmeta(pv).label));
    btn.onclick = () => {
      if (state.selectedProviders.size === 0) {
        // everything was implicitly selected -> isolate this provider
        state.selectedProviders = new Set([pv]);
      } else if (state.selectedProviders.has(pv)) {
        state.selectedProviders.delete(pv);
      } else {
        state.selectedProviders.add(pv);
      }
      if (state.selectedProviders.size === 0 || state.selectedProviders.size === present.length) {
        state.selectedProviders = new Set(); // back to "all"
      }
      render();
    };
    wrap.appendChild(btn);
  }
}

function renderModelChips() {
  const seen = new Map(); // mkey -> { provider, model }
  for (const b of state.buckets) {
    if (isArchivedModel(b.model)) continue;
    if (state.selectedProviders.size > 0 && !state.selectedProviders.has(b.provider)) continue;
    if (!seen.has(mkey(b))) seen.set(mkey(b), { provider: b.provider, model: b.model, source: b.source });
  }
  const models = [...seen.entries()].sort((a, b) =>
    a[1].provider.localeCompare(b[1].provider) || a[1].model.localeCompare(b[1].model));
  const wrap = $('modelChips');
  wrap.innerHTML = '';
  for (const [key, { provider, model, source }] of models) {
    const btn = document.createElement('button');
    btn.className = 'chip model-chip';
    const active = state.selectedModels.size === 0 || state.selectedModels.has(key);
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.style.setProperty('--c', modelColor(provider, model));
    btn.title = `${pmeta(provider).label} · ${model}`;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    btn.append(swatch, document.createTextNode(prettyModel(provider, model, source)));
    btn.onclick = () => {
      if (state.selectedModels.size === 0) {
        // everything was implicitly selected -> isolate this model
        state.selectedModels = new Set([key]);
      } else if (state.selectedModels.has(key)) {
        state.selectedModels.delete(key);
        if (state.selectedModels.size === 0) state.selectedModels = new Set(); // back to "all"
      } else {
        state.selectedModels.add(key);
        if (state.selectedModels.size === models.length) state.selectedModels = new Set();
      }
      render();
    };
    wrap.appendChild(btn);
  }
}

function renderModelTable(byModel) {
  const tbody = $('modelTable').querySelector('tbody');
  tbody.innerHTML = '';
  const allEntries = [...byModel.values()];
  const entries = allEntries.filter((m) => !isArchivedModel(m.model)).sort((a, b) => b.cost - a.cost);
  const archived = allEntries.filter((m) => isArchivedModel(m.model));
  if (archived.length) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.colSpan = 5;
    label.textContent = `Archived models · ${archived.length} · included in totals`;
    const cost = document.createElement('td');
    cost.className = 'r';
    const value = archived.reduce((sum, m) => sum + m.cost, 0);
    const partial = archived.some((m) => !m.priced);
    cost.textContent = `${archived.some((m) => m.estimated) ? '≈' : ''}${fmtCost(value)}${partial ? ' + unpriced' : ''}`;
    tr.title = 'Models released more than two months ago. Projects and usage history are retained.';
    tr.append(label, cost);
    tbody.appendChild(tr);
  }
  if (!entries.length) {
    if (archived.length) return;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No usage in this range';
    td.appendChild(empty);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const m of entries) {
    const key = `${m.provider}|${m.model}`;
    const hasModelFilter = state.selectedModels.size > 0;
    const selected = state.selectedModels.has(key);
    const tr = document.createElement('tr');
    tr.className = 'model-filter-row';
    tr.dataset.modelKey = key;
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', String(selected));
    tr.setAttribute('aria-label', `${prettyModel(m.provider, m.model, m.source)}. ${selected ? 'Selected model filter; activate to clear.' : 'Activate to show only this model.'}`);
    if (selected) tr.classList.add('is-selected');
    else if (hasModelFilter) tr.classList.add('is-filtered-out');
    tr.title = selected ? 'Click again to clear the model filter' : `Show only ${prettyModel(m.provider, m.model, m.source)} usage`;
    const modelCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'mname';
    name.title = `${pmeta(m.provider).label} · ${m.model}`;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = modelColor(m.provider, m.model);
    const label = document.createElement('span');
    label.className = 'model-label';
    label.textContent = prettyModel(m.provider, m.model, m.source);
    name.append(swatch, label);
    modelCell.appendChild(name);
    tr.appendChild(modelCell);

    // Reasoning rides under the output figure rather than beside it. Inline, it
    // was the widest thing in the row by far — enough to push the whole table
    // past the panel and shove the cost column, the one number this panel is
    // for, off the right edge entirely.
    const values = [
      { text: fmtTok(m.input) },
      {
        text: fmtTok(m.output),
        sub: m.reasoning > 0 ? `R ${fmtTok(m.reasoning)}` : '',
        title: m.reasoning > 0
          ? `${fmtTok(m.output)} output tokens · ${fmtTok(m.reasoning)} reasoning tokens`
          : '',
      },
      { text: fmtTok(m.cacheRead) },
      { text: m.cacheWrite > 0 ? fmtTok(m.cacheWrite) : '—' },
    ];
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value.text;
      if (value.sub) {
        const sub = document.createElement('span');
        sub.className = 'tok-sub';
        sub.textContent = value.sub;
        td.appendChild(sub);
      }
      if (value.title) td.title = value.title;
      tr.appendChild(td);
    }
    const cost = document.createElement('td');
    cost.className = 'r';
    if (!m.priced) {
      cost.textContent = 'Unpriced';
      cost.classList.add('unpriced');
      cost.title = `${m.unpricedCalls.toLocaleString()} calls have no published official API price`;
    } else if (m.estimated) {
      cost.textContent = `≈${fmtCost(m.cost)}`;
      cost.classList.add('cost-est');
      cost.title = `Conservative estimate; lower bound ${fmtCost(m.costMin)}`;
    } else {
      cost.textContent = fmtCost(m.cost);
    }
    tr.appendChild(cost);
    const toggleModelFilter = () => {
      const clear = state.selectedModels.size === 1 && state.selectedModels.has(key);
      state.selectedModels = clear ? new Set() : new Set([key]);
      state.expandedProject = null;
      render();
      requestAnimationFrame(() => {
        const replacement = [...$('modelTable').querySelectorAll('tbody tr[data-model-key]')]
          .find((row) => row.dataset.modelKey === key);
        replacement?.focus({ preventScroll: true });
      });
    };
    tr.addEventListener('click', toggleModelFilter);
    tr.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleModelFilter();
    });
    tbody.appendChild(tr);
  }
}

const PROJECT_PREVIEW_COUNT = 6;

function setProjectOpen(item, button, details, open) {
  item.classList.toggle('open', open);
  button.setAttribute('aria-expanded', String(open));
  details.hidden = !open;
}

function projTableRow(label, tok, cost, opts = {}) {
  const row = document.createElement('div');
  row.className = 'proj-trow'
    + (opts.head ? ' head' : '')
    + (opts.cols ? ' cols' : '')
    + (opts.sub ? ' sub' : '');
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  if (opts.dot) {
    const dot = document.createElement('i');
    dot.style.background = opts.dot;
    lbl.appendChild(dot);
  }
  const txt = document.createElement('span');
  txt.textContent = label;
  if (opts.title) txt.title = opts.title;
  lbl.appendChild(txt);
  const tokEl = document.createElement('span');
  tokEl.className = 'tok';
  tokEl.textContent = tok;
  const costEl = document.createElement('span');
  costEl.className = 'cost';
  costEl.textContent = cost;
  if (cost === 'Unpriced') costEl.classList.add('unpriced');
  row.append(lbl, tokEl, costEl);
  return row;
}

// One aligned group per model — rows of label | tokens | cost — plus an
// "All models" totals group when the project used more than one model.
// Rows adapt to the provider: Claude models have real cache-write counts;
// Codex models show cached input and an estimated write surcharge. Both report
// reasoning when the logs carry it — as a sub-row, since it is already billed
// inside output.
function appendProjectModels(table, p) {
  const entries = [...p.models.values()].sort((a, b) =>
    b.cost - a.cost || a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }));
  const money = (v, priced, estimated = false) => (priced ? `${estimated ? '≈' : ''}${fmtCost(v)}` : 'Unpriced');
  const addGroup = (head, m, priced, provider) => {
    const g = document.createElement('div');
    g.className = 'proj-tgroup';
    g.appendChild(head);
    g.appendChild(projTableRow('Input', fmtTok(m.input), money(m.cIn, priced)));
    g.appendChild(projTableRow('Output', fmtTok(m.output), money(m.cOut, priced)));
    g.appendChild(projTableRow('Cache read', fmtTok(m.cacheRead), money(m.cCr, priced)));
    if (provider === 'codex') {
      if (m.reasoning > 0) {
        g.appendChild(projTableRow('Reasoning', fmtTok(m.reasoning), money(m.cRs, priced),
          { sub: true, title: 'Billed inside output — already counted in the total' }));
      }
      if (m.cacheWrite > 0) {
        g.appendChild(projTableRow('Cache write', fmtTok(m.cacheWrite), money(m.cCw, priced),
          { title: 'Measured cache-write tokens' }));
      } else if (m.estimated && m.cCw > 0) {
        g.appendChild(projTableRow('Write premium (est.)', 'unreported', money(m.cCw, priced, true),
          { title: 'Conservative cache-write premium; native Codex logs do not expose write-token counts' }));
      }
    } else if (provider === 'claude' || provider === 'zcode') {
      if (m.reasoning > 0) {
        g.appendChild(projTableRow('Reasoning', fmtTok(m.reasoning), money(m.cRs, priced),
          { sub: true, title: 'Billed inside output — already counted in the total' }));
      }
      g.appendChild(projTableRow('Cache write', fmtTok(m.cacheWrite), money(m.cCw, priced)));
    } else {
      g.appendChild(projTableRow(m.estimated ? 'Cache write / premium' : 'Cache write', fmtTok(m.cacheWrite), money(m.cCw, priced, m.estimated)));
    }
    if (m.cTool > 0) g.appendChild(projTableRow('Server tools', '', money(m.cTool, priced)));
    table.appendChild(g);
  };

  table.appendChild(projTableRow('', 'tokens', 'cost', { cols: true }));
  for (const m of entries) {
    addGroup(
      projTableRow(prettyModel(m.provider, m.model, m.source), `${m.msgs.toLocaleString()} calls`, money(m.cost, m.priced, m.estimated),
        { head: true, dot: modelColor(m.provider, m.model), title: `${pmeta(m.provider).label} · ${m.model}` }),
      m, m.priced, m.provider);
  }
  if (entries.length > 1) {
    addGroup(
      projTableRow('All models', `${p.msgs.toLocaleString()} calls`, money(p.cost, p.unpricedCalls === 0, p.estimated), { head: true }),
      p, p.unpricedCalls === 0, 'all');
  }
}

// Working time per model: each finished turn counts for the model that ran it,
// so the rows add up to the project's total. A model that only served as a
// subagent books no turns of its own — its work sits inside its parent's.
function appendProjectTime(table, p) {
  const total = p.activeMs;
  const { fmtDuration } = window.EmberActiveTime;
  const entries = [...p.models.values()].sort((a, b) =>
    b.activeMs - a.activeMs || b.cost - a.cost
    || a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }));
  table.appendChild(projTableRow('', 'worked', 'share', { cols: true }));
  for (const m of entries) {
    const share = total ? Math.min(100, Math.round((m.activeMs / total) * 100)) : 0;
    const color = modelColor(m.provider, m.model);
    const row = projTableRow(prettyModel(m.provider, m.model, m.source), fmtDuration(m.activeMs), m.activeMs ? `${share}%` : '—',
      { dot: color, title: `${pmeta(m.provider).label} · ${m.model}` });
    row.classList.add('timed');
    const bar = document.createElement('span');
    bar.className = 'proj-tbar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    fill.style.setProperty('--w', `${share}%`);
    fill.style.background = color;
    bar.appendChild(fill);
    row.appendChild(bar);
    table.appendChild(row);
  }
}

// Export selection. A tick lives beside each row rather than behind a mode
// switch: one click to pick a project, shift-click to take a run of them.
let selectionAnchor = null;

function toggleProjectSelection(name, extend, visibleNames) {
  const sel = state.selectedProjects;
  const anchor = selectionAnchor;
  const spans = extend && anchor && anchor !== name
    && visibleNames.includes(anchor) && visibleNames.includes(name);
  if (spans) {
    const a = visibleNames.indexOf(anchor);
    const b = visibleNames.indexOf(name);
    for (const n of visibleNames.slice(Math.min(a, b), Math.max(a, b) + 1)) {
      if (!state.hiddenProjects.has(n)) sel.add(n);
    }
  } else if (sel.has(name)) {
    sel.delete(name);
  } else {
    sel.add(name);
  }
  selectionAnchor = name;
  render();
}

function buildProjectCheck(name, visibleNames) {
  const selected = state.selectedProjects.has(name);
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'proj-check' + (selected ? ' on' : '');
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(selected));
  check.setAttribute('aria-label', `Select ${name} for export`);
  check.title = selected ? 'Selected for export' : 'Select for export — shift-click for a range';
  check.innerHTML = `<span class="box"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.6 6.2 2.3 2.3 4.5-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleProjectSelection(name, e.shiftKey, visibleNames);
  });
  return check;
}

function archiveProjects(names) {
  if (!names.length) return;
  for (const n of names) {
    state.archivedProjects.add(n);
    state.selectedProjects.delete(n);
    if (state.expandedProject === n) state.expandedProject = null;
  }
  saveArchivedProjects();
  selectionAnchor = null;
  render();
  toast(names.length === 1
    ? `Archived ${names[0]}`
    : `Archived ${names.length} projects — still counted in every total`);
}

function toggleProjectArchive(name) {
  if (state.archivedProjects.has(name)) {
    state.archivedProjects.delete(name);
  } else {
    state.archivedProjects.add(name);
    state.selectedProjects.delete(name);
    if (state.expandedProject === name) state.expandedProject = null;
  }
  saveArchivedProjects();
  render();
}

function buildProjectArchive(name) {
  const archived = state.archivedProjects.has(name);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'proj-archive' + (archived ? ' on' : '');
  btn.title = archived ? 'Unarchive — put it back in the list' : 'Archive — file it away, totals keep counting it';
  btn.setAttribute('aria-label', `${archived ? 'Unarchive' : 'Archive'} ${name}`);
  btn.innerHTML = archived
    ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 5.4h10.8M3.6 5.4v7.2h8.8V5.4M2.6 3.4h10.8v2H2.6zM8 11V7.4m0 0L6.4 9M8 7.4 9.6 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 5.4h10.8M3.6 5.4v7.2h8.8V5.4M2.6 3.4h10.8v2H2.6zM6.4 7.8h3.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleProjectArchive(name);
  });
  return btn;
}

function buildProjectItem(wrap, name, p, max, visibleNames = []) {
  const isHidden = state.hiddenProjects.has(name);
  const item = document.createElement('div');
  item.className = 'proj';
  if (isHidden) item.classList.add('is-hidden');

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'proj-summary';
  summary.setAttribute('aria-expanded', 'false');
  const projectCost = p.unpricedCalls > 0 ? `${fmtCost(p.cost)} + unpriced` : `${p.estimated ? '≈' : ''}${fmtCost(p.cost)}`;
  summary.innerHTML = `
    <span class="proj-chevron" aria-hidden="true">
      <svg viewBox="0 0 12 12"><path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="proj-name"></span>
    <span class="proj-time"></span>
    <span class="proj-cost"></span>
    <span class="proj-bar" aria-hidden="true"><i style="--w:${((p.cost / max) * 100).toFixed(1)}%"></i></span>`;
  const nameEl = summary.querySelector('.proj-name');
  nameEl.textContent = name;
  nameEl.title = name;
  const { fmtDuration, NOTE: TIME_NOTE } = window.EmberActiveTime;
  const timeEl = summary.querySelector('.proj-time');
  timeEl.textContent = p.activeMs ? fmtDuration(p.activeMs) : '';
  timeEl.title = TIME_NOTE;
  const costEl = summary.querySelector('.proj-cost');
  costEl.textContent = projectCost;
  if (p.unpricedCalls > 0) costEl.title = `Dollar value omitted for ${p.unpricedCalls.toLocaleString()} calls because no official price is published`;
  else if (p.estimated) costEl.title = `Conservative estimate; lower bound ${fmtCost(p.costMin)}`;
  summary.title = isHidden
    ? 'Hidden from totals — right-click to unhide'
    : name;

  const details = document.createElement('div');
  details.className = 'proj-details';
  details.hidden = true;
  const totalTokens = p.input + p.output + p.cacheRead + p.cacheWrite;
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  details.innerHTML = `
    <div class="proj-detail-head">
      <span>Time breakdown</span>
      <span><span class="dur">${fmtDuration(p.activeMs)}</span> worked · ${plural(p.sessions.size, 'session')} · ${plural(p.days.size, 'day')}</span>
    </div>
    <div class="proj-table proj-time-table"></div>
    <div class="proj-detail-head">
      <span>Token breakdown</span>
      <span>${fmtTok(totalTokens)} total · ${p.msgs.toLocaleString()} calls</span>
    </div>
    <div class="proj-table proj-token-table"></div>`;
  const timeTable = details.querySelector('.proj-time-table');
  timeTable.title = `${TIME_NOTE} Subagent work is inside the turn of the model that called it.`;
  appendProjectTime(timeTable, p);
  appendProjectModels(details.querySelector('.proj-token-table'), p);

  summary.addEventListener('click', () => {
    if (isHidden) return; // blurred rows don't expand — right-click unhides
    const wasOpen = item.classList.contains('open');
    const current = wrap.querySelector('.proj.open');
    if (current && current !== item) {
      setProjectOpen(current, current.querySelector('.proj-summary'), current.querySelector('.proj-details'), false);
    }
    setProjectOpen(item, summary, details, !wasOpen);
    state.expandedProject = wasOpen ? null : name;
  });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.hiddenProjects.has(name)) {
      state.hiddenProjects.delete(name);
    } else {
      state.hiddenProjects.add(name);
      if (state.expandedProject === name) state.expandedProject = null;
    }
    saveHiddenProjects();
    render(); // totals change, so everything re-renders
  });

  const isArchived = state.archivedProjects.has(name);
  if (isArchived) item.classList.add('is-archived');

  const head = document.createElement('div');
  head.className = 'proj-head';
  // Hidden and archived rows are not part of the visible list, so they cannot
  // be ticked for export either.
  if (!isHidden && !isArchived) head.appendChild(buildProjectCheck(name, visibleNames));
  else head.appendChild(document.createElement('span'));
  head.appendChild(summary);
  head.appendChild(buildProjectArchive(name));

  item.append(head, details);
  wrap.appendChild(item);
  if (state.expandedProject === name && !isHidden) setProjectOpen(item, summary, details, true);
}

function buildSelectionBar(wrap, entries) {
  const chosen = entries.filter(([n]) => state.selectedProjects.has(n));
  if (!chosen.length) return;

  const bar = document.createElement('div');
  bar.className = 'proj-selbar';
  const cost = chosen.reduce((s, [, p]) => s + p.cost, 0);
  const tokens = chosen.reduce((s, [, p]) => s + p.input + p.output + p.cacheRead + p.cacheWrite, 0);
  const calls = chosen.reduce((s, [, p]) => s + p.msgs, 0);
  const unpriced = chosen.some(([, p]) => p.unpricedCalls > 0);
  const estimated = chosen.some(([, p]) => p.estimated);
  const activeMs = chosen.reduce((sum, [, p]) => sum + p.activeMs, 0);

  const info = document.createElement('span');
  info.className = 'proj-selinfo';
  info.textContent = `${chosen.length} selected · ${unpriced ? '' : estimated ? '≈' : ''}${fmtCost(cost)}${unpriced ? ' + unpriced' : ''} · ${fmtTok(tokens)} tokens · ${calls.toLocaleString()} calls${activeMs ? ` · ${window.EmberActiveTime.fmtDuration(activeMs)} worked` : ''}`;
  info.title = window.EmberActiveTime.NOTE;

  const actions = document.createElement('div');
  actions.className = 'proj-selactions';
  const addBtn = (label, title, onClick, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'proj-selbtn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.title = title;
    b.onclick = onClick;
    actions.appendChild(b);
  };
  addBtn('CSV', 'Save the selected projects as CSV — one row per project and model', () => runExport('projects-csv'), true);
  addBtn('JSON', 'Save the selected projects as JSON — full token and cost breakdown', () => runExport('projects-json'), true);
  addBtn('Copy', 'Copy a Markdown table of the selected projects', () => runExport('projects-summary'));
  const selectable = entries.filter(([n]) => !state.hiddenProjects.has(n));
  if (chosen.length < selectable.length) {
    addBtn('All', 'Select every project in this view', () => {
      for (const [n] of selectable) state.selectedProjects.add(n);
      render();
    });
  }
  addBtn('Archive', 'Archive the selected projects — they leave the list, totals keep counting them', () => {
    archiveProjects(chosen.map(([n]) => n));
  });
  addBtn('Clear', 'Clear the selection', () => {
    state.selectedProjects.clear();
    selectionAnchor = null;
    render();
  });

  bar.append(info, actions);
  wrap.appendChild(bar);
}

// Quick archive. With a model filter on, the project list already *is* "every
// project that used this model in this range" — so one button files the whole
// list away without ticking anything.
function buildModelArchiveBar(wrap, entries) {
  if (!state.selectedModels.size || !entries.length) return;
  const names = entries.map(([n]) => n);
  const labels = [...state.selectedModels].map((key) => {
    const [provider, ...rest] = key.split('|');
    const model = rest.join('|');
    const seen = state.buckets.find((b) => b.provider === provider && b.model === model);
    return prettyModel(provider, model, seen && seen.source);
  });
  const label = labels.length === 1 ? labels[0] : `${labels.length} models`;

  const bar = document.createElement('div');
  bar.className = 'proj-selbar proj-modelbar';
  const info = document.createElement('span');
  info.className = 'proj-selinfo';
  info.textContent = `${label} · ${names.length} project${names.length === 1 ? '' : 's'} in this range`;
  const actions = document.createElement('div');
  actions.className = 'proj-selactions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'proj-selbtn';
  btn.textContent = `Archive all ${names.length}`;
  btn.title = `Archive every project that used ${label} in this range — totals keep counting them`;
  btn.onclick = () => archiveProjects(names);
  // The bar reads as a prompt, so it needs a way out that does not archive
  // anything: clearing the model filter puts the full list back.
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'proj-selbtn';
  cancel.textContent = 'Cancel';
  cancel.title = 'Clear the model filter and show every project again';
  cancel.onclick = () => {
    state.selectedModels = new Set();
    render();
  };
  actions.append(btn, cancel);
  bar.append(info, actions);
  wrap.appendChild(bar);
}

// The export menu mirrors the selection so the footer stays the one place
// that answers "how do I get this out?".
function syncProjectExportItems() {
  const count = state.selectedProjects.size;
  for (const item of document.querySelectorAll('[data-export^="projects-"]')) {
    item.hidden = count === 0;
    const small = item.querySelector('small');
    if (small && count) {
      small.textContent = `${count} selected project${count === 1 ? '' : 's'}, model by model`;
    }
  }
}

function renderProjects(byProject) {
  const wrap = $('projectList');
  wrap.innerHTML = '';
  const allEntries = [...byProject.entries()].filter(([, p]) => p.live).sort((a, b) =>
    b[1].cost - a[1].cost || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  // Archived projects still count everywhere else; they simply step out of
  // the list so the rest is readable.
  const entries = allEntries.filter(([n]) => !state.archivedProjects.has(n));
  const archivedEntries = allEntries.filter(([n]) => state.archivedProjects.has(n));
  // A project that left the current view cannot be exported from it, so the
  // selection is trimmed to what is actually on screen.
  const inView = new Set(entries.filter(([n]) => !state.hiddenProjects.has(n)).map(([n]) => n));
  for (const n of [...state.selectedProjects]) {
    if (!inView.has(n)) state.selectedProjects.delete(n);
  }
  syncProjectExportItems();

  const note = $('projNote');
  if (note) {
    const hiddenCount = entries.filter(([n]) => state.hiddenProjects.has(n)).length;
    const selectedCount = state.selectedProjects.size;
    const marks = [];
    if (hiddenCount) marks.push(`${hiddenCount} hidden`);
    if (archivedEntries.length) marks.push(`${archivedEntries.length} archived`);
    note.textContent = selectedCount
      ? `${selectedCount} selected for export`
      : marks.length
        ? `sorted by cost · ${marks.join(' · ')}`
        : 'sorted by cost · tick to export · right-click to hide';
  }
  if (!entries.length && !archivedEntries.length) {
    state.expandedProject = null;
    wrap.innerHTML = `<div class="empty">no usage in this range</div>`;
    return;
  }

  buildModelArchiveBar(wrap, entries);
  buildSelectionBar(wrap, entries);

  if (!byProject.has(state.expandedProject)) state.expandedProject = null;
  const max = (entries[0] || archivedEntries[0])[1].cost || 1;

  const visibleEntries = state.projectsExpanded ? entries : entries.slice(0, PROJECT_PREVIEW_COUNT);
  const visibleNames = visibleEntries.map(([name]) => name);
  for (const [name, p] of visibleEntries) buildProjectItem(wrap, name, p, max, visibleNames);

  if (!entries.length) {
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = 'every project in this range is archived';
    wrap.appendChild(none);
  }

  if (entries.length > PROJECT_PREVIEW_COUNT) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-expand';
    toggle.setAttribute('aria-expanded', String(state.projectsExpanded));
    toggle.innerHTML = `
      <span>${state.projectsExpanded ? `Show top ${PROJECT_PREVIEW_COUNT}` : `Show all ${entries.length} projects`}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    toggle.addEventListener('click', () => {
      state.projectsExpanded = !state.projectsExpanded;
      if (!state.projectsExpanded && !entries.slice(0, PROJECT_PREVIEW_COUNT).some(([name]) => name === state.expandedProject)) {
        state.expandedProject = null;
      }
      renderProjects(byProject);
      wrap.querySelector('.project-expand')?.focus({ preventScroll: true });
    });
    wrap.appendChild(toggle);
  }

  buildArchivedDrawer(wrap, byProject, archivedEntries, max);
}

// Archived projects live behind one collapsed row. Opening it shows them with
// their real numbers — nothing was thrown away — and the same button puts a
// project back.
function buildArchivedDrawer(wrap, byProject, archivedEntries, max) {
  if (!archivedEntries.length) return;
  const cost = archivedEntries.reduce((s, [, p]) => s + p.cost, 0);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'project-expand archived-toggle';
  toggle.setAttribute('aria-expanded', String(state.archivedExpanded));
  const label = document.createElement('span');
  label.textContent = `Archived · ${archivedEntries.length} · ${fmtCost(cost)} still counted`;
  toggle.appendChild(label);
  toggle.insertAdjacentHTML('beforeend',
    `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  toggle.addEventListener('click', () => {
    state.archivedExpanded = !state.archivedExpanded;
    if (!state.archivedExpanded && state.archivedProjects.has(state.expandedProject)) {
      state.expandedProject = null;
    }
    renderProjects(byProject);
    wrap.querySelector('.archived-toggle')?.focus({ preventScroll: true });
  });
  wrap.appendChild(toggle);

  if (!state.archivedExpanded) return;
  const box = document.createElement('div');
  box.className = 'archived-list';
  for (const [name, p] of archivedEntries) buildProjectItem(box, name, p, max);
  wrap.appendChild(box);
}

/* ───────────────────────── chart ───────────────────────── */

let chartGeom = null; // for hover hit-testing
let chartBinsCache = null;

function renderChart(byDay, hoverIdx = -1) {
  state.lastByDay = byDay;
  const canvas = $('chart');
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const ctx = prepCanvas(canvas, W, H);
  const T = window.EmberTheme.tokens();

  // build continuous day list for the visible range
  let [from, to] = chartRangeForSelection();
  const allDates = [...byDay.keys()].sort();
  if (from === '0000') from = allDates[0] || today();
  if (to === '9999') to = today();
  if (from > to) [from, to] = [to, from];

  const rangeKey = `${from}|${to}`;
  let bins;
  let groupByWeek;
  if (chartBinsCache && chartBinsCache.byDay === byDay && chartBinsCache.rangeKey === rangeKey) {
    ({ bins, groupByWeek } = chartBinsCache);
  } else {
    const dayList = [];
    const cur = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    let guard = 0;
    while (cur <= end && guard++ < 1000) {
      dayList.push(dstr(cur));
      cur.setDate(cur.getDate() + 1);
    }

    // group into weeks when the range is long
    groupByWeek = dayList.length > 70;
    bins = [];
    if (groupByWeek) {
      const map = new Map();
      for (const d of dayList) {
        const dt = new Date(d + 'T00:00:00');
        const monday = new Date(dt);
        monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        const key = dstr(monday);
        if (!map.has(key)) map.set(key, { label: key, models: new Map(), total: 0, week: true });
        const bin = map.get(key);
        const day = byDay.get(d);
        if (day) {
          bin.total += day.total;
          for (const [m, c] of day.models) bin.models.set(m, (bin.models.get(m) || 0) + c);
        }
      }
      bins = [...map.values()];
    } else {
      bins = dayList.map((d) => {
        const day = byDay.get(d);
        return { label: d, total: day ? day.total : 0, models: day ? day.models : new Map(), week: false };
      });
    }
    chartBinsCache = { byDay, rangeKey, bins, groupByWeek };
  }

  $('chartNote').textContent = state.selectedDay
    ? `${prettyDay(state.selectedDay)} selected · click again to clear`
    : (groupByWeek ? 'weekly · click to drill down' : 'daily · click a bar for full details');
  const chartTotal = bins.reduce((sum, bin) => sum + bin.total, 0);
  canvas.setAttribute('aria-label', `${groupByWeek ? 'Weekly' : 'Daily'} API-equivalent cost history, ${fmtCost(chartTotal)} total across ${bins.length} periods`);

  const padL = 4, padR = 4, padT = 8, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...bins.map((b) => b.total), 0.0001);
  const n = bins.length;
  const gap = n > 40 ? 1 : 3;
  const barW = Math.max(2, (plotW - gap * (n - 1)) / n);

  if (chartGeom && chartGeom.bins !== bins) resetChartHover();
  chartGeom = { bins, padL, barW, gap, W, H };
  const focusIdx = hoverIdx >= 0
    ? hoverIdx
    : bins.findIndex((bin) => !bin.week && bin.label === state.selectedDay);

  // faint gridlines at 25 / 50 / 75 % and the baseline
  ctx.strokeStyle = T.grid;
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = H - padB - plotH * f + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(W - padR, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = T.axis;
  ctx.beginPath();
  ctx.moveTo(padL, H - padB + 0.5);
  ctx.lineTo(W - padR, H - padB + 0.5);
  ctx.stroke();

  // scale hint, top-right
  ctx.fillStyle = T.label;
  ctx.font = chartFont(0.95, '600');
  ctx.textAlign = 'right';
  ctx.fillText(fmtCost(maxV), W - padR, padT + 2);

  bins.forEach((bin, i) => {
    const x = padL + i * (barW + gap);
    let y = H - padB;
    ctx.globalAlpha = focusIdx >= 0 && i !== focusIdx ? 0.35 : 1;
    const sorted = [...bin.models.entries()].sort((a, b) => b[1] - a[1]);
    for (const [mk, cost] of sorted) {
      const h = (cost / maxV) * plotH;
      if (h < 0.5) continue;
      const yTop = y - h;
      const [pv, model] = splitKey(mk);
      // Flat fill: a per-segment gradient meant allocating one object per
      // model per bar — hundreds a frame — for a shading nobody can see at
      // three pixels wide.
      ctx.fillStyle = modelColor(pv, model);
      roundRectPath(ctx, x, yTop, barW, h, Math.min(2.5, barW / 2));
      ctx.fill();
      y = yTop;
    }
    if (bin.total === 0) {
      ctx.fillStyle = T.zero;
      ctx.fillRect(x, H - padB - 1.5, barW, 1.5);
    }
    ctx.globalAlpha = 1;
  });

  // x labels: first, middle, last
  ctx.fillStyle = T.label;
  ctx.font = chartFont(0.95);
  const lbl = (b) => b.label.slice(5).replace('-', '/');
  if (n > 0) {
    ctx.textAlign = 'left';
    ctx.fillText(lbl(bins[0]), padL, H - 4);
    if (n > 2) {
      ctx.textAlign = 'center';
      ctx.fillText(lbl(bins[Math.floor(n / 2)]), padL + plotW / 2, H - 4);
    }
    if (n > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(lbl(bins[n - 1]), W - padR, H - 4);
    }
  }
}

function splitKey(mk) {
  const i = mk.indexOf('|');
  return [mk.slice(0, i), mk.slice(i + 1)];
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function setupChartHover() {
  const canvas = $('chart');
  const tip = $('chartTip');
  let lastHover = -1;
  resetChartHover = () => { lastHover = -1; };

  const binAtX = (clientX) => {
    if (!chartGeom) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { bins, padL, barW, gap } = chartGeom;
    const i = Math.floor((x - padL) / (barW + gap));
    return i >= 0 && i < bins.length ? { bin: bins[i], i } : null;
  };

  const activateBin = (bin) => {
    if (!bin) return;
    if (bin.week) {
      const end = new Date(`${bin.label}T00:00:00`);
      end.setDate(end.getDate() + 6);
      state.preset = 'custom';
      state.customFrom = bin.label;
      state.customTo = dstr(end);
      state.customFromTime = '00:00';
      state.customToTime = '23:59';
      state.customEndMode = 'custom';
      state.selectedDay = null;
      state.selectionOrigin = null;
      writeCustomControls();
      $('customRange').hidden = false;
      document.querySelectorAll('#dateChips .chip').forEach((chip) => {
        const active = chip.dataset.range === 'custom';
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', String(active));
      });
      moveSegThumb();
    } else {
      if (state.selectedDay === bin.label && state.selectionOrigin) {
        const origin = state.selectionOrigin;
        state.preset = origin.preset;
        state.customFrom = origin.customFrom;
        state.customTo = origin.customTo;
        state.customFromTime = origin.customFromTime;
        state.customToTime = origin.customToTime;
        state.customEndMode = origin.customEndMode;
        state.selectedDay = null;
        state.selectionOrigin = null;
        $('customRange').hidden = state.preset !== 'custom';
        if (state.preset === 'custom') {
          writeCustomControls(origin.range);
        }
        document.querySelectorAll('#dateChips .chip').forEach((chip) => {
          const active = chip.dataset.range === state.preset;
          chip.classList.toggle('active', active);
          chip.setAttribute('aria-pressed', String(active));
        });
        moveSegThumb();
      } else {
        if (!state.selectionOrigin) {
          state.selectionOrigin = {
            preset: state.preset,
            customFrom: state.customFrom,
            customTo: state.customTo,
            customFromTime: state.customFromTime,
            customToTime: state.customToTime,
            customEndMode: state.customEndMode,
            range: rangeForPreset(),
            customBounds: state.preset === 'custom' ? resolveCustomBounds() : null,
          };
        }
        state.selectedDay = bin.label;
        state.preset = 'custom';
        state.customFrom = bin.label;
        state.customTo = bin.label;
        state.customFromTime = '00:00';
        state.customToTime = '23:59';
        state.customEndMode = 'custom';
        writeCustomControls();
        $('customRange').hidden = false;
        document.querySelectorAll('#dateChips .chip').forEach((chip) => {
          const active = chip.dataset.range === 'custom';
          chip.classList.toggle('active', active);
          chip.setAttribute('aria-pressed', String(active));
        });
        moveSegThumb();
      }
    }
    state.expandedProject = null;
    tip.hidden = true;
    lastHover = -1;
    render();
  };

  canvas.addEventListener('mousemove', (e) => {
    if (!chartGeom) return;
    const hit = binAtX(e.clientX);
    const { bins, padL, barW, gap, W } = chartGeom;
    if (!hit) {
      tip.hidden = true;
      if (lastHover !== -1 && state.lastByDay) { lastHover = -1; renderChart(state.lastByDay, -1); }
      return;
    }
    const { i } = hit;
    if (i !== lastHover && state.lastByDay) {
      lastHover = i;
      renderChart(state.lastByDay, i); // focus: dim the other bars
    }
    const bin = bins[i];
    const sorted = [...bin.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    tip.replaceChildren();
    const date = document.createElement('div');
    date.className = 'tip-date';
    date.textContent = `${bin.label}${bin.week ? ' · week' : ''}`;
    tip.appendChild(date);
    const addTipRow = (label, cost, color) => {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const name = document.createElement('span');
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = color;
        name.appendChild(dot);
      }
      name.appendChild(document.createTextNode(label));
      const value = document.createElement('b');
      value.textContent = fmtCost(cost);
      row.append(name, value);
      tip.appendChild(row);
    };
    addTipRow('Total', bin.total);
    for (const [mk, c] of sorted) {
      const [pv, model] = splitKey(mk);
      addTipRow(prettyModel(pv, model), c, modelColor(pv, model));
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let tx = padL + i * (barW + gap) + barW / 2 - tw / 2;
    tx = Math.max(0, Math.min(W - tw, tx));
    tip.style.left = tx + 'px';
    tip.style.top = '2px';
  });

  canvas.addEventListener('click', (e) => {
    const hit = binAtX(e.clientX);
    if (hit) activateBin(hit.bin);
  });

  canvas.addEventListener('keydown', (e) => {
    if (!chartGeom || !chartGeom.bins.length) return;
    const { bins } = chartGeom;
    if (lastHover >= bins.length) lastHover = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const selected = bins.findIndex((bin) => !bin.week && bin.label === state.selectedDay);
      const start = lastHover >= 0 ? lastHover : (selected >= 0 ? selected : bins.length - 1);
      lastHover = Math.max(0, Math.min(bins.length - 1, start + (e.key === 'ArrowLeft' ? -1 : 1)));
      renderChart(state.lastByDay, lastHover);
      const bin = bins[lastHover];
      canvas.setAttribute('aria-label', `${bin.label}${bin.week ? ', week' : ''}, ${fmtCost(bin.total)}. Press Enter for details.`);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const selected = bins.findIndex((bin) => !bin.week && bin.label === state.selectedDay);
      const i = lastHover >= 0 ? lastHover : (selected >= 0 ? selected : bins.length - 1);
      activateBin(bins[i]);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tip.hidden = true;
    if (lastHover !== -1 && state.lastByDay) { lastHover = -1; renderChart(state.lastByDay, -1); }
  });
}

/* ───────────────────────── session burn ─────────────────────────
   The panel that answers what a plan meter never does: what one window of
   work actually costs, and whether that is holding steady. Windows come
   from the logs (every 5-hour block ever worked) and, where Ember has
   watched the meter, carry the percentage of quota they consumed. */

const QUOTA_METRICS = [
  { id: 'cost', label: 'Value', needsRate: false },
  { id: 'tokens', label: 'Tokens', needsRate: false },
  { id: 'perPct', label: 'Per 1%', needsRate: true },
];

const HOUR_MS = 3600 * 1000;

// Rebuilt only when the data or the meter history moves — the compact strip
// asks for it once a second.
const scopeCache = { key: '', scopes: [] };

function quotaScopeList() {
  const key = `${state.dataRevision}|${state.quotaRevision}`;
  if (scopeCache.key === key) return scopeCache.scopes;
  const scopes = buildQuotaScopes();
  scopeCache.key = key;
  scopeCache.scopes = scopes;
  return scopes;
}

function buildQuotaScopes() {
  const providers = new Set(state.buckets.map((b) => b.provider));
  const meters = (state.quota && state.quota.meters) || [];
  const meterFor = (provider, kind) =>
    meters.find((m) => m.provider === provider && m.kind === kind) || null;
  const both = providers.has('claude') && providers.has('codex');
  const out = [];
  const push = (provider, mode, meter, windowMs, short, title) => {
    out.push({
      id: `${provider}|${mode}`,
      provider,
      mode,
      meter,
      windowMs,
      label: both ? `${pmeta(provider).label} · ${short}` : short,
      title,
    });
  };

  if (providers.has('claude')) {
    // Claude's session window is a documented fixed length, so the block
    // history is reconstructable whether or not a meter has been seen yet.
    push('claude', 'session', meterFor('claude', 'session'), 5 * HOUR_MS, '5h session',
      'Claude Code five-hour session windows, rebuilt from the logs');
    push('claude', 'period', meterFor('claude', 'weekly'), 7 * 24 * HOUR_MS, 'Week',
      'Claude weekly quota periods');
  }
  if (providers.has('codex')) {
    const Q = window.EmberQuota;
    const current = state.limits && state.limits.codex;
    const activeWindows = current && current.ok && Array.isArray(current.windows)
      ? current.windows.filter((w) => Number(w.windowMinutes) > 0) : [];
    const windowFor = (kind) => activeWindows.find((w) =>
      (kind === 'session') === (Number(w.windowMinutes) <= 720));

    if (activeWindows.length) {
      // Current account telemetry decides which scopes exist. Old ledger rows
      // must not resurrect a removed account window or a model-specific quota
      // that an earlier parser accidentally attributed to Codex as a whole.
      const sessionWindow = windowFor('session');
      if (sessionWindow) {
        const minutes = Number(sessionWindow.windowMinutes);
        const session = Q.reconcileCodexMeter(meterFor('codex', 'session'), sessionWindow);
        push('codex', 'session', session, minutes * 60000,
          `${Math.round(minutes / 60)}h session`, 'Codex session windows');
      }
      const weeklyWindow = windowFor('weekly');
      if (weeklyWindow) {
        const minutes = Number(weeklyWindow.windowMinutes);
        const weekly = Q.reconcileCodexMeter(meterFor('codex', 'weekly'), weeklyWindow);
        push('codex', 'period', weekly, minutes * 60000, 'Week', 'Codex weekly quota periods');
      }
    } else {
      // Never resurrect a Codex session scope from ledger history alone: old
      // versions could have put a model-specific quota there. Weekly usage can
      // still be reconstructed offline without asserting a session limit.
      const weekly = meterFor('codex', 'weekly');
      push('codex', 'period', weekly,
        (weekly && weekly.windowMinutes ? weekly.windowMinutes : 7 * 24 * 60) * 60000,
        'Week', 'Codex weekly quota periods');
    }
  }
  return out;
}

function activeQuotaScope(scopes) {
  return scopes.find((s) => s.id === state.quotaScope) || scopes[0] || null;
}

const quotaCache = { key: '', rows: [], scope: null };

function quotaRowsFor(scope) {
  const key = [state.dataRevision, state.quotaRevision, scope.id, scope.windowMs].join('|');
  quotaCache.scope = scope;
  if (quotaCache.key === key) return quotaCache.rows;
  const Q = window.EmberQuota;
  const now = Date.now();
  // The panel deliberately ignores the date, provider and model filters: a
  // plan meter counts everything, so a filtered view would not be comparable.
  const rows = Q.timeline(state.buckets, scope.provider);
  const windows = scope.meter ? Q.quotaWindows(null, scope.meter, { rows, now, limit: 80 }) : [];
  const blocks = scope.mode === 'session'
    ? Q.sessionBlocks(null, { rows, windowMs: scope.windowMs, now, limit: 48, anchors: windows })
    : Q.fixedPeriods(null, {
      rows,
      periodMs: scope.windowMs,
      anchorMs: windows.length ? windows[0].endsAt : 0,
      now,
      limit: 26,
    });
  Q.attachObserved(blocks, windows, { rows, now });
  quotaCache.key = key;
  quotaCache.rows = blocks;
  return blocks;
}

function metricValue(row, metric) {
  if (metric === 'tokens') return row.totals.tokens;
  if (metric === 'perPct') return row.rate ? row.rate.costPerPct : 0;
  return row.totals.cost;
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtShortDay(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function quotaRowLabel(row, scope) {
  return scope.mode === 'session'
    ? `${fmtShortDay(row.startedAt)} · ${fmtClock(row.startedAt)}–${fmtClock(row.endsAt)}`
    : `${fmtShortDay(row.startedAt)} – ${fmtShortDay(row.endsAt - 1)}`;
}

function fmtRemaining(ms) {
  if (!(ms > 0)) return 'closing';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ${mins % 60} min left`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h left`;
}

function renderQuotaScopes(scopes, active) {
  const wrap = $('quotaScopes');
  wrap.innerHTML = '';
  if (scopes.length < 2) return;
  for (const scope of scopes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip quota-scope';
    btn.setAttribute('role', 'tab');
    const on = scope.id === active.id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
    btn.textContent = scope.label;
    if (scope.title) btn.title = scope.title;
    btn.onclick = () => {
      state.quotaScope = scope.id;
      resetQuotaHover();
      render();
    };
    wrap.appendChild(btn);
  }
}

function renderQuotaMetrics(rows, metric) {
  const wrap = $('quotaMetrics');
  wrap.innerHTML = '';
  const hasRates = rows.some((r) => r.rate);
  for (const m of QUOTA_METRICS) {
    if (m.needsRate && !hasRates) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip quota-metric';
    const on = m.id === metric;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = m.label;
    if (m.id === 'perPct') btn.title = 'API-equivalent value bought by one percent of the plan quota';
    btn.onclick = () => {
      state.quotaMetric = m.id;
      resetQuotaHover();
      render();
    };
    wrap.appendChild(btn);
  }
}

// The newest open block is the one being metered; an older block can still
// read as open when the provider replaced its window before the reset.
function liveQuotaRow(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].active) return rows[i];
  }
  return null;
}

function renderQuotaLive(rows, scope, animate) {
  const card = $('quotaLive');
  const live = liveQuotaRow(rows);
  if (!live) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('quotaLiveLabel').textContent = scope.mode === 'session' ? 'Current session' : 'Current week';
  $('quotaLiveClock').textContent = `${fmtClock(live.startedAt)} · ${fmtRemaining(live.endsAt - Date.now())}`;
  updateValue($('quotaLiveCost'), live.totals.cost, paintMoney, animate);
  $('quotaLiveTokens').textContent = live.totals.msgs
    ? `${fmtTok(live.totals.tokens)} tokens · ${live.totals.msgs.toLocaleString()} calls`
    : 'no activity yet';

  const meter = $('quotaMeter');
  const projection = $('quotaProjection');
  if (Number.isFinite(live.percent)) {
    meter.hidden = false;
    const pct = Math.max(0, Math.min(100, live.percent));
    const fill = $('quotaMeterFill');
    fill.style.setProperty('--w', `${pct.toFixed(1)}%`);
    fill.className = pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : scope.provider;
    $('quotaMeterPct').textContent = `${Math.round(pct)}%`;
    meter.title = `${Math.round(pct)}% of the plan ${scope.mode === 'session' ? 'session' : 'weekly'} quota consumed`;
    projection.textContent = live.rate
      ? `${fmtCost(live.rate.costPerPct)} and ${fmtTok(live.rate.tokensPerPct)} tokens per 1% · a full window at this rate is worth ${fmtCost(live.rate.projectedCost)}`
      : 'The provider reports 0% used in this window.';
    projection.hidden = false;
  } else {
    meter.hidden = true;
    projection.hidden = false;
    projection.textContent = state.quota
      ? 'Waiting for the first plan-meter reading of this window.'
      : 'Plan meters unavailable — window totals still come from the local logs.';
  }
}

let quotaGeom = null;
let quotaHover = -1;
function resetQuotaHover() { quotaHover = -1; }

function renderQuotaChart(rows, scope, metric, hoverIdx = -1) {
  const canvas = $('quotaChart');
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (!W || !H) return;
  const ctx = prepCanvas(canvas, W, H);
  const T = window.EmberTheme.tokens();

  // The rate view only has a value where a meter reading exists, so plotting
  // the unmeasured windows as zero would invent a collapse that never happened.
  const bars = metric === 'perPct' ? rows.filter((r) => r.rate) : rows;
  quotaGeom = null;
  if (!bars.length) {
    ctx.fillStyle = T.label;
    ctx.font = chartFont(1.05);
    ctx.textAlign = 'center';
    ctx.fillText('no windows to chart yet', W / 2, H / 2);
    return;
  }

  const padL = 4, padR = 4, padT = 10, padB = 15;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = bars.map((r) => metricValue(r, metric));
  const maxV = Math.max(...values, 1e-9);
  const n = bars.length;
  const gap = n > 30 ? 1 : 3;
  const barW = Math.max(2, (plotW - gap * (n - 1)) / n);
  const scaleY = (v) => (v / maxV) * plotH;

  ctx.strokeStyle = T.grid;
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = H - padB - plotH * f + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(W - padR, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = T.axis;
  ctx.beginPath();
  ctx.moveTo(padL, H - padB + 0.5);
  ctx.lineTo(W - padR, H - padB + 0.5);
  ctx.stroke();

  bars.forEach((row, i) => {
    const x = padL + i * (barW + gap);
    const dim = hoverIdx >= 0 && i !== hoverIdx;
    ctx.globalAlpha = dim ? 0.32 : 1;
    if (metric === 'perPct') {
      // A ratio cannot be stacked; one bar per window, tinted by the model
      // that dominated it so a mix change stays visible.
      const h = scaleY(values[i]);
      const top = H - padB - h;
      const lead = [...row.totals.models.values()].sort((a, b) => b.cost - a.cost)[0];
      ctx.fillStyle = lead ? modelColor(lead.provider, lead.model) : pmeta(scope.provider).color;
      if (h >= 0.5) {
        roundRectPath(ctx, x, top, barW, h, Math.min(2.5, barW / 2));
        ctx.fill();
      }
    } else {
      // Stacked by model: a window that looks cheap because it ran a smaller
      // model should say so on the chart, not only in a tooltip.
      let y = H - padB;
      const entries = [...row.totals.models.entries()]
        .map(([key, m]) => [key, metric === 'tokens' ? m.tokens : m.cost, m])
        .sort((a, b) => b[1] - a[1]);
      for (const [, value, m] of entries) {
        const h = scaleY(value);
        if (h < 0.5) continue;
        const top = y - h;
        ctx.fillStyle = modelColor(m.provider, m.model);
        roundRectPath(ctx, x, top, barW, h, Math.min(2.5, barW / 2));
        ctx.fill();
        y = top;
      }
      if (values[i] === 0) {
        ctx.fillStyle = T.zero;
        ctx.fillRect(x, H - padB - 1.5, barW, 1.5);
      }
    }
    if (row.active) {
      ctx.globalAlpha = dim ? 0.3 : 0.75;
      ctx.strokeStyle = T.live;
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, padT - 2, barW + 1, H - padB - padT + 2);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  });

  // Average line: the reference the eye needs to judge "is this consistent".
  const mean = window.EmberQuota.mean(values.filter((v) => v > 0));
  if (mean > 0) {
    const my = H - padB - scaleY(mean) + 0.5;
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = T.mean;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, my);
    ctx.lineTo(W - padR, my);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  const fmtMetric = (v) => (metric === 'tokens' ? fmtTok(v) : fmtCost(v));
  // The scale sits over the tallest bar by definition, so it carries its own
  // backing rather than competing with whatever is behind it.
  ctx.font = chartFont(0.95, '600');
  const fpx = remPx() * 0.95;
  const scaleText = fmtMetric(maxV);
  const scaleW = ctx.measureText(scaleText).width;
  ctx.fillStyle = T.scaleBg;
  roundRectPath(ctx, W - padR - scaleW - 5, padT - 5, scaleW + 6, fpx + 4, 3);
  ctx.fill();
  ctx.fillStyle = T.label;
  ctx.textAlign = 'right';
  ctx.fillText(scaleText, W - padR - 2, padT + 4);
  ctx.textAlign = 'left';
  ctx.font = chartFont(0.95);
  ctx.fillText(`${n} ${scope.mode === 'session' ? 'sessions' : 'weeks'} · avg ${fmtMetric(mean)}${metric === 'perPct' ? ' per 1%' : ''}`, padL, H - 4);

  quotaGeom = { bars, padL, barW, gap, W, scope, metric };
  canvas.setAttribute('aria-label',
    `${scope.label} history, ${n} windows, average ${fmtMetric(mean)}${metric === 'perPct' ? ' per one percent of quota' : ''}.`);
}

function setupQuotaHover() {
  const canvas = $('quotaChart');
  const tip = $('quotaTip');

  const binAtX = (clientX) => {
    if (!quotaGeom) return -1;
    const rect = canvas.getBoundingClientRect();
    const { padL, barW, gap, bars } = quotaGeom;
    const i = Math.floor((clientX - rect.left - padL) / (barW + gap));
    return i >= 0 && i < bars.length ? i : -1;
  };

  const showTip = (i) => {
    if (!quotaGeom || i < 0) { tip.hidden = true; return; }
    const { bars, padL, barW, gap, W, scope, metric } = quotaGeom;
    const row = bars[i];
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-date';
    head.textContent = quotaRowLabel(row, scope) + (row.active ? ' · live' : '');
    tip.appendChild(head);
    const addRow = (label, value, color) => {
      const el = document.createElement('div');
      el.className = 'tip-row';
      const name = document.createElement('span');
      if (color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = color;
        name.appendChild(dot);
      }
      name.appendChild(document.createTextNode(label));
      const v = document.createElement('b');
      v.textContent = value;
      el.append(name, v);
      tip.appendChild(el);
    };
    addRow('Value', fmtCost(row.totals.cost));
    addRow('Tokens', fmtTok(row.totals.tokens));
    addRow('Calls', row.totals.msgs.toLocaleString());
    if (Number.isFinite(row.percent)) addRow('Quota used', `${Math.round(row.percent)}%`);
    if (row.rate) {
      addRow('Per 1%', fmtCost(row.rate.costPerPct));
      addRow('Full window', `≈${fmtCost(row.rate.projectedCost)}`);
    }
    const top = [...row.totals.models.values()].sort((a, b) => b.cost - a.cost).slice(0, 3);
    for (const m of top) {
      addRow(prettyModel(m.provider, m.model, m.source), metric === 'tokens' ? fmtTok(m.tokens) : fmtCost(m.cost),
        modelColor(m.provider, m.model));
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let tx = padL + i * (barW + gap) + barW / 2 - tw / 2;
    tx = Math.max(0, Math.min(W - tw, tx));
    tip.style.left = `${tx}px`;
    tip.style.top = '2px';
  };

  const repaint = (i) => {
    if (!quotaGeom) return;
    const { scope, metric } = quotaGeom;
    renderQuotaChart(quotaCache.rows, scope, metric, i);
  };

  canvas.addEventListener('mousemove', (e) => {
    const i = binAtX(e.clientX);
    if (i !== quotaHover) {
      quotaHover = i;
      repaint(i);
    }
    showTip(i);
  });
  canvas.addEventListener('mouseleave', () => {
    if (quotaHover !== -1) { quotaHover = -1; repaint(-1); }
    tip.hidden = true;
  });
  canvas.addEventListener('keydown', (e) => {
    if (!quotaGeom || !quotaGeom.bars.length) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const last = quotaGeom.bars.length - 1;
    const start = quotaHover >= 0 ? quotaHover : last;
    quotaHover = Math.max(0, Math.min(last, start + (e.key === 'ArrowLeft' ? -1 : 1)));
    repaint(quotaHover);
    showTip(quotaHover);
  });
  canvas.addEventListener('blur', () => {
    if (quotaHover !== -1) { quotaHover = -1; repaint(-1); }
    tip.hidden = true;
  });
}

function renderQuota(animate = false) {
  const panel = document.querySelector('.quota-panel');
  const scopes = quotaScopeList();
  const scope = activeQuotaScope(scopes);
  if (!scope) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  state.quotaScope = scope.id;

  const rows = quotaRowsFor(scope);
  let metric = state.quotaMetric;
  if (metric === 'perPct' && !rows.some((r) => r.rate)) metric = 'cost';

  renderQuotaScopes(scopes, scope);
  renderQuotaMetrics(rows, metric);
  renderQuotaLive(rows, scope, animate);
  if (quotaHover >= 0) quotaHover = -1;
  renderQuotaChart(rows, scope, metric, -1);
  $('quotaNote').textContent = scope.meter
    ? 'unfiltered · plan-metered'
    : 'unfiltered · rebuilt from logs';
}

// Only the countdown moves between renders; recomputing the panel every
// second for it would be wasteful.
function tickQuotaClock() {
  const live = quotaCache.liveQuotaRow(rows);
  if (state.settings.miniMode) {
    const kind = quotaCache.scope && quotaCache.scope.mode === 'period' ? 'week' : 'session';
    $('miniWhen').textContent = live
      ? `${kind} · ${fmtRemaining(live.endsAt - Date.now())}`
      : `${kind} · idle`;
    return;
  }
  const card = $('quotaLive');
  if (!card || card.hidden || !live) return;
  $('quotaLiveClock').textContent = `${fmtClock(live.startedAt)} · ${fmtRemaining(live.endsAt - Date.now())}`;
}

/* ───────────────────────── plan limits ─────────────────────────
   Two groups — Claude and Codex — each with its own 5-hour session
   tracker and weekly tracker (plus Claude's per-model weekly rows). */

function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'Resetting…';
  const m = Math.ceil(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `Resets in ${h} hr ${m % 60} min` : `Resets in ${m} min`;
}

function fmtResetDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return 'Resets ' + d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Claude limit rows from the account API payload
function claudeRows(l) {
  const d = l.data || {};
  const rows = [];
  const modelRows = new Set();
  if (d.five_hour) {
    rows.push({ name: 'Current session', sub: () => fmtCountdown(d.five_hour.resets_at), u: d.five_hour.utilization });
  }
  if (d.seven_day) {
    rows.push({ name: 'Weekly · all models', sub: () => fmtResetDay(d.seven_day.resets_at), u: d.seven_day.utilization });
  }
  for (const [key, label] of [
    ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_sonnet', 'Weekly · Sonnet'],
    ['seven_day_fable', 'Weekly · Fable'],
    ['seven_day_fable_5', 'Weekly · Fable'],
  ]) {
    const v = d[key];
    const showAtZero = key.startsWith('seven_day_fable');
    if (v && v.utilization != null && (showAtZero || v.utilization > 0) && !modelRows.has(label)) {
      rows.push({ name: label, sub: () => fmtResetDay(v.resets_at), u: v.utilization });
      modelRows.add(label);
    }
  }

  // Newer account API payloads put model-specific quotas in a generic limits
  // array instead of a named seven_day_* field. Fable arrives with the display
  // name "Fable" (sometimes "Fable 5"); one meter covers every Fable release.
  for (const v of Array.isArray(d.limits) ? d.limits : []) {
    const displayName = v && v.scope && v.scope.model && v.scope.model.display_name;
    if (v && v.kind === 'weekly_scoped' && /^fable(?:\s*5(?:\.\d+)?)?$/i.test(displayName || '')
      && v.percent != null && !modelRows.has('Weekly · Fable')) {
      rows.push({ name: 'Weekly · Fable', sub: () => fmtResetDay(v.resets_at), u: v.percent });
      modelRows.add('Weekly · Fable');
    }
  }
  return rows;
}

// Codex limit rows from the rollout-log snapshot
function codexRows(l) {
  return (l.windows || []).map((w) => ({
    name: w.name,
    sub: () => (w.resetsAt ? (w.style === 'countdown' ? fmtCountdown(w.resetsAt) : fmtResetDay(w.resetsAt)) : ''),
    u: w.utilization,
  }));
}

function claudeErrorMsg(l) {
  return l.reason === 'no-credentials' ? 'Sign in to Claude Code to show plan limits.'
    : l.reason === 'http-401' || l.reason === 'http-403' ? 'Sign-in expired — open Claude Code once to refresh it.'
    : l.reason === 'http-429' ? 'Rate-limited by the account API — retrying in a few minutes.'
    : 'Plan limits unavailable — retrying.';
}

function codexErrorMsg(l) {
  return l.reason === 'no-data'
    ? 'Run Codex or ClaudeX once — limits are read from local account snapshots.'
    : 'Plan limits unavailable.';
}

function renderLimits() {
  const sec = $('limitsSection');
  const wrap = $('limitRows');
  const lims = state.limits;
  if (!lims || (!lims.claude && !lims.codex)) { sec.hidden = true; return; }
  sec.hidden = false;

  wrap.innerHTML = '';
  state.limitRows = [];
  let subIdx = 0;
  let worstAll = 0;

  const addGroup = (provider, l, buildRows, errorMsg, staleMsg) => {
    if (!l) return;
    const head = document.createElement('div');
    head.className = 'limit-group-head';
    const badge = l.plan && l.plan.label
      ? `<span class="plan-badge ${provider}">${l.plan.label}</span>` : '';
    head.innerHTML = `<span class="pdot" style="background:${pmeta(provider).color}"></span>${pmeta(provider).label}${badge}`;
    wrap.appendChild(head);

    if (!l.ok) {
      const div = document.createElement('div');
      div.className = 'limits-msg';
      div.textContent = errorMsg(l);
      wrap.appendChild(div);
      return;
    }

    const rows = buildRows(l);
    rows.forEach((r) => {
      const u = Math.max(0, Math.min(100, r.u ?? 0));
      const cls = u >= 95 ? 'crit' : u >= 80 ? 'warn' : provider;
      const div = document.createElement('div');
      div.className = 'limit-row';
      div.innerHTML = `
        <div class="limit-info">
          <span class="limit-name">${r.name}</span>
          <span class="limit-sub" data-sub="${subIdx}">${r.sub()}</span>
        </div>
        <div class="limit-bar"><i class="${cls}" style="--w:${u.toFixed(1)}%"></i></div>
        <span class="limit-pct">${Math.round(u)}%</span>`;
      wrap.appendChild(div);
      state.limitRows.push(r);
      subIdx++;
    });

    const stale = staleMsg(l);
    if (stale) {
      const div = document.createElement('div');
      div.className = 'limits-msg';
      div.textContent = stale;
      wrap.appendChild(div);
    }

    worstAll = Math.max(worstAll, ...rows.map((r) => r.u ?? 0));
  };

  addGroup('claude', lims.claude, claudeRows, claudeErrorMsg, (l) => {
    if (l.stale && l.fetchedAt) {
      const mins = Math.round((Date.now() - l.fetchedAt) / 60000);
      const age = mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} hr`;
      if (l.lastError === 'http-429') {
        const retry = Number(l.retryAt) - Date.now();
        const retryText = retry > 0
          ? ` Retry available in ${fmtRemaining(retry).replace(/ left$/, '')}.` : '';
        return `Snapshot from ${age} ago — Anthropic rate-limited the refresh.${retryText}`;
      }
      if (l.lastError === 'http-401' || l.lastError === 'http-403') {
        return `Snapshot from ${age} ago — Claude Code sign-in has expired.`;
      }
      if (l.lastError) return `Snapshot from ${age} ago — refresh failed (${l.lastError}).`;
      if (mins >= 5) return `Snapshot from ${age} ago — refreshing soon.`;
    }
    if (l.ok) {
      const ex = (l.data || {}).extra_usage;
      if (ex && ex.is_enabled && ex.used_credits > 0) {
        return `Extra usage: ${ex.used_credits} of ${ex.monthly_limit} ${ex.currency || ''}`.trim();
      }
    }
    return null;
  });

  addGroup('codex', lims.codex, codexRows, codexErrorMsg, (l) => {
    if (l.stale && l.fetchedAt) {
      const mins = Math.round((Date.now() - l.fetchedAt) / 60000);
      if (mins >= 30) {
        const ago = mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} hr`;
        return `Codex account snapshot from ${ago} ago — updates after the next call.`;
      }
    }
    return null;
  });

  // the ember heats up with the worst window across BOTH providers
  state.worstLimit = worstAll;
  avatarMood(worstAll);
  renderMini();
}

// refresh the "Resets in…" countdowns every second without refetching
function tickLimitCountdowns() {
  if (!state.limitRows) return;
  state.limitRows.forEach((r, i) => {
    const el = document.querySelector(`[data-sub="${i}"]`);
    if (el) el.textContent = r.sub();
  });
}

/* ───────────────────────── status / footer ───────────────────────── */

function renderStatus() {
  const el = $('lastUpdated');
  if (!state.generatedAt) { el.textContent = 'loading…'; return; }
  const secs = Math.round((Date.now() - state.generatedAt) / 1000);
  // Reconciliation runs every few seconds, so anything inside that cadence is
  // "now" — counting up from one would just be a flickering stopwatch.
  el.textContent = secs < 10 ? 'Updated just now'
    : secs < 60 ? `Updated ${secs}s ago`
    : `Updated ${Math.round(secs / 60)}m ago`;
  $('liveDot').classList.toggle('stale', secs > 45);
}

// One quiet beat whenever genuinely new usage lands — the difference between
// a widget that is running and one that merely looks like it is.
function pulseLiveDot() {
  if (reduceMotion.matches) return;
  const dot = $('liveDot');
  dot.classList.remove('beat');
  void dot.offsetWidth;
  dot.classList.add('beat');
}
setInterval(() => {
  renderStatus();
  tickLimitCountdowns();
  tickQuotaClock();
}, 1000);

/* ───────────────────────── mascot reactions ───────────────────────── */

function avatarMood(worstUtilization) {
  const pet = $('pet');
  pet.classList.toggle('worried', worstUtilization >= 80 && worstUtilization < 95);
  pet.classList.toggle('crit', worstUtilization >= 95);
  // Drives the edge thermometer and the hearth bloom. A custom property on
  // the root costs a style recalc; the two things reading it animate on
  // transform and opacity, so nothing repaints.
  const heat = Math.max(0, Math.min(1, (worstUtilization || 0) / 100));
  document.documentElement.style.setProperty('--heat', heat.toFixed(3));
}

/* ───────────────────────── scroll affordances ───────────────────────── */

// A chip row that runs past the edge fades on that side, so a clipped
// "Sonnet" reads as "there is more this way" rather than as a rendering bug.
function syncScrollerFades() {
  for (const el of document.querySelectorAll('.filter-scroller')) {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-start', max > 1 && el.scrollLeft > 1);
    el.classList.toggle('fade-end', max > 1 && el.scrollLeft < max - 1);
  }
}

// The filter bar is sticky; once it has caught on the titlebar it floats over
// the panels scrolling beneath it and gets a drop edge to say so.
function syncStuckFilters() {
  const filters = $('filters');
  filters.classList.toggle('is-stuck', $('scrollArea').scrollTop > filters.offsetTop - 1);
}

/* ───────────────────────── segmented control thumb ───────────────────────── */

function moveSegThumb() {
  const active = document.querySelector('#dateChips .chip.active');
  const thumb = $('segThumb');
  if (!active || !thumb) return;
  thumb.style.left = active.offsetLeft + 'px';
  thumb.style.width = active.offsetWidth + 'px';
}

let settingsReturnFocus = null;
function setSettingsOpen(open) {
  const overlay = $('settingsOverlay');
  if (open) {
    settingsReturnFocus = document.activeElement;
    $('setAutostart').checked = state.settings.launchAtStartup;
    $('setPin').checked = state.settings.alwaysOnTop;
    overlay.hidden = false;
    requestAnimationFrame(() => $('btnSettingsClose').focus());
  } else {
    overlay.hidden = true;
    if (settingsReturnFocus && typeof settingsReturnFocus.focus === 'function') settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function syncCustomEndModeUI() {
  const customEnd = $('endModeCustom').checked;
  $('customEndFields').hidden = !customEnd;
  $('dateTo').required = customEnd;
  $('timeTo').required = customEnd;
}

function setCustomRangeError(message) {
  const error = $('customRangeError');
  error.textContent = message;
  error.hidden = !message;
  const customEnd = $('endModeCustom').checked;
  for (const id of ['dateFrom', 'timeFrom', 'dateTo', 'timeTo']) {
    const relevant = id === 'dateFrom' || id === 'timeFrom' || customEnd;
    $(id).setAttribute('aria-invalid', String(!!message && relevant));
  }
  $('applyCustom').disabled = !!message;
}

function readCustomDraft() {
  return {
    customFrom: $('dateFrom').value,
    customFromTime: $('timeFrom').value,
    customTo: $('dateTo').value,
    customToTime: $('timeTo').value,
    customEndMode: $('endModeCustom').checked ? 'custom' : 'now',
  };
}

function validateCustomDraft() {
  const draft = readCustomDraft();
  let message = '';
  if (!draft.customFrom || !HHMM_RE.test(draft.customFromTime)) {
    message = 'Choose a complete start date and 24-hour time (HH:MM).';
  } else if (draft.customEndMode === 'custom'
    && (!draft.customTo || !HHMM_RE.test(draft.customToTime))) {
    message = 'Choose a complete custom end date and 24-hour time (HH:MM).';
  } else {
    const from = minuteStamp(draft.customFrom, draft.customFromTime);
    const toDate = draft.customEndMode === 'custom' ? draft.customTo : today();
    const toTime = draft.customEndMode === 'custom' ? draft.customToTime : currentTime();
    if (minuteStamp(toDate, toTime) < from) message = 'End must be the same as or later than the start.';
  }
  if (draft.customFrom) $('dateTo').min = draft.customFrom;
  $('timeTo').min = draft.customTo === draft.customFrom && HHMM_RE.test(draft.customFromTime)
    ? draft.customFromTime : '00:00';
  setCustomRangeError(message);
  return message ? null : draft;
}

function writeCustomControls(fallbackRange = null) {
  $('dateFrom').value = state.customFrom || (fallbackRange ? fallbackRange[0] : daysAgo(13));
  $('timeFrom').value = state.customFromTime || '00:00';
  $('dateTo').value = state.customTo || (fallbackRange ? fallbackRange[1] : today());
  $('timeTo').value = state.customToTime || '23:59';
  $('endModeCustom').checked = state.customEndMode === 'custom';
  $('endModeNow').checked = state.customEndMode !== 'custom';
  syncCustomEndModeUI();
  validateCustomDraft();
}

/* ───────────────────────── compact mode ─────────────────────────
   The strip keeps the one number worth watching while you work: what the
   window open right now has already cost, and how much of the plan it took. */

function applyMiniMode() {
  const on = !!state.settings.miniMode;
  document.body.classList.toggle('mini', on);
  $('btnMini').classList.toggle('on', on);
  const setMini = $('setMini');
  if (setMini) setMini.checked = on;
  if (on) renderMini();
}

function renderMini() {
  if (!state.settings.miniMode) return;
  const scopes = quotaScopeList();
  const scope = activeQuotaScope(scopes);
  const rows = scope ? quotaRowsFor(scope) : [];
  const live = liveQuotaRow(rows);
  const view = state.lastView;

  $('miniCost').innerHTML = moneyHTML(live ? live.totals.cost : 0);
  const kind = scope && scope.mode === 'period' ? 'week' : 'session';
  $('miniWhen').textContent = live
    ? `${kind} · ${fmtRemaining(live.endsAt - Date.now())}`
    : `${kind} · idle`;

  // Without a meter reading for this window, the strip falls back to the
  // hottest plan bar so it is never blank while a limit is filling up.
  const measured = !!live && Number.isFinite(live.percent);
  const pct = measured ? live.percent : state.worstLimit;
  const fill = $('miniFill');
  const shown = Math.max(0, Math.min(100, pct || 0));
  fill.style.setProperty('--w', `${shown.toFixed(1)}%`);
  fill.className = shown >= 95 ? 'crit' : shown >= 80 ? 'warn' : (scope ? scope.provider : 'claude');
  $('miniPct').textContent = measured || shown > 0 ? `${Math.round(shown)}%` : '–';

  const parts = [];
  if (live && live.totals.msgs) {
    parts.push(`${fmtTok(live.totals.tokens)} tokens`);
    if (live.rate) parts.push(`${fmtCost(live.rate.costPerPct)} per 1%`);
    else parts.push(`${live.totals.msgs.toLocaleString()} calls`);
  } else {
    parts.push('no activity in this window');
  }
  if (view) parts.push(`${fmtCost(view.todayCost)} today`);
  $('miniSub').textContent = parts.join(' · ');
}

/* ───────────────────────── export ─────────────────────────
   Everything here is composed from what is already on screen and handed to
   the main process only when the user picks a destination. */

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function isoMinute(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function round(value, places = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : '';
}

function topModelOf(totals) {
  const lead = [...totals.models.values()].sort((a, b) => b.cost - a.cost)[0];
  return lead ? prettyModel(lead.provider, lead.model, lead.source) : '';
}

function currentQuotaContext() {
  const scopes = quotaScopeList();
  const scope = activeQuotaScope(scopes);
  return { scope, rows: scope ? quotaRowsFor(scope) : [] };
}

function buildWindowsCsv() {
  const { scope, rows } = currentQuotaContext();
  if (!scope) return null;
  const out = [[
    'window_start', 'window_end', 'provider', 'window_kind', 'state', 'quota_measured',
    'tokens', 'input', 'output', 'cache_read', 'cache_write', 'calls',
    'value_usd', 'quota_percent', 'value_per_percent', 'tokens_per_percent',
    'projected_full_window_usd', 'top_model',
  ]];
  for (const row of [...rows].reverse()) {
    const t = row.totals;
    out.push([
      isoMinute(row.startedAt), isoMinute(row.endsAt), scope.provider,
      scope.mode === 'session' ? 'session' : 'weekly',
      row.active ? 'live' : 'closed',
      row.observed ? 'yes' : 'no',
      t.tokens, t.input, t.output, t.cacheRead, t.cacheWrite, t.msgs,
      round(t.cost, 4),
      Number.isFinite(row.percent) ? round(row.percent, 2) : '',
      row.rate ? round(row.rate.costPerPct, 4) : '',
      row.rate ? Math.round(row.rate.tokensPerPct) : '',
      row.rate ? round(row.rate.projectedCost, 2) : '',
      topModelOf(t),
    ]);
  }
  return toCsv(out);
}

function buildViewCsv() {
  const byKey = new Map();
  for (const b of filteredBuckets()) {
    if (state.hiddenProjects.has(b.project)) continue;
    const key = `${b.date}|${b.provider}|${b.model}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        date: b.date, provider: b.provider, model: b.model, source: b.source,
        msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        cost: 0, unpricedCalls: 0,
      };
      byKey.set(key, row);
    }
    row.msgs += b.msgs;
    row.input += b.input;
    row.output += b.output;
    row.cacheRead += b.cacheRead;
    row.cacheWrite += b.cacheWrite;
    row.reasoning += b.reasoning || 0;
    row.cost += b.cost;
    row.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
  }
  const out = [[
    'date', 'provider', 'model', 'calls', 'input', 'output', 'cache_read',
    'cache_write', 'reasoning', 'value_usd', 'unpriced_calls',
  ]];
  for (const row of [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost)) {
    out.push([
      row.date, row.provider, prettyModel(row.provider, row.model, row.source), row.msgs,
      row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning,
      round(row.cost, 4), row.unpricedCalls,
    ]);
  }
  return toCsv(out);
}

function buildViewJson() {
  const view = state.lastView;
  if (!view) return null;
  const { scope, rows } = currentQuotaContext();
  const [from, to] = rangeForPreset();
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    app: { name: 'Ember', version: APP_VERSION, note: 'API-equivalent value of subscription usage, not an invoice' },
    view: {
      range: state.preset,
      from: state.preset === 'all' ? null : from,
      to: state.preset === 'all' ? null : to,
      selectedDay: state.selectedDay,
      providers: [...state.selectedProviders],
      models: [...state.selectedModels],
      hiddenProjects: [...state.hiddenProjects],
    },
    totals: {
      valueUsd: round(view.tot.cost, 4),
      lowerBoundUsd: round(view.tot.costMin, 4),
      calls: view.tot.msgs,
      unpricedCalls: view.tot.unpricedCalls,
      input: view.tot.input,
      output: view.tot.output,
      cacheRead: view.tot.cacheRead,
      cacheWrite: view.tot.cacheWrite,
      reasoning: view.tot.reasoning,
      cacheSavingsUsd: round(view.tot.saved, 4),
      activeDays: view.dayCount,
      sessions: view.sessionCount,
    },
    rolling: {
      last5h: { valueUsd: round(view.w5.cost, 4), tokens: view.w5.tok, calls: view.w5.msgs },
      last7d: { valueUsd: round(view.wk.cost, 4), tokens: view.wk.tok, calls: view.wk.msgs },
      today: { valueUsd: round(view.todayCost, 4) },
    },
    models: [...view.byModel.values()].sort((a, b) => b.cost - a.cost).map((m) => ({
      provider: m.provider, model: m.model, name: prettyModel(m.provider, m.model, m.source),
      calls: m.pricedCalls + m.unpricedCalls, input: m.input, output: m.output,
      cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, reasoning: m.reasoning,
      valueUsd: round(m.cost, 4), priced: !!m.priced,
    })),
    projects: [...view.byProject.entries()].filter(([, p]) => p.live).sort((a, b) => b[1].cost - a[1].cost).map(([name, p]) => ({
      name, calls: p.msgs, valueUsd: round(p.cost, 4),
      hidden: state.hiddenProjects.has(name),
    })),
    windows: scope ? {
      provider: scope.provider,
      kind: scope.mode === 'session' ? 'session' : 'weekly',
      lengthMinutes: Math.round(scope.windowMs / 60000),
      entries: [...rows].reverse().map((row) => ({
        start: new Date(row.startedAt).toISOString(),
        end: new Date(row.endsAt).toISOString(),
        live: !!row.active,
        quotaMeasured: !!row.observed,
        quotaPercent: Number.isFinite(row.percent) ? round(row.percent, 2) : null,
        tokens: row.totals.tokens,
        calls: row.totals.msgs,
        valueUsd: round(row.totals.cost, 4),
        valuePerPercent: row.rate ? round(row.rate.costPerPct, 4) : null,
        tokensPerPercent: row.rate ? Math.round(row.rate.tokensPerPct) : null,
      })),
    } : null,
  }, null, 2);
}

function buildSummary() {
  const view = state.lastView;
  if (!view) return null;
  const Q = window.EmberQuota;
  const { scope, rows } = currentQuotaContext();
  const label = state.selectedDay ? prettyDay(state.selectedDay) : RANGE_LABELS[state.preset];
  const lines = [];
  lines.push(`**Ember — API-equivalent usage · ${label}**`);
  lines.push('');
  lines.push(`- Value: **${fmtCost(view.tot.cost)}** across ${view.tot.msgs.toLocaleString()} calls and ${fmtTok(view.tot.input + view.tot.output + view.tot.cacheRead + view.tot.cacheWrite)} tokens`);
  lines.push(`- Rolling: ${fmtCost(view.w5.cost)} in the last 5 hours · ${fmtCost(view.wk.cost)} in the last 7 days`);
  if (view.tot.unpricedCalls) {
    lines.push(`- Coverage: ${view.tot.unpricedCalls.toLocaleString()} calls have no published official price and are excluded from the value`);
  }

  if (scope && rows.length) {
    const recent = [...rows].reverse().slice(0, 8);
    lines.push('');
    lines.push(`**${scope.label}** — last ${recent.length} windows`);
    lines.push('');
    lines.push('| Window | Tokens | Value | Quota | Per 1% |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const row of recent) {
      lines.push(`| ${quotaRowLabel(row, scope)}${row.active ? ' _(live)_' : ''} | ${fmtTok(row.totals.tokens)} | ${fmtCost(row.totals.cost)} | ${Number.isFinite(row.percent) ? `${Math.round(row.percent)}%` : '—'} | ${row.rate ? fmtCost(row.rate.costPerPct) : '—'} |`);
    }
    const rated = rows.filter((r) => r.rate && !r.active);
    if (rated.length >= 6) {
      const t = Q.trend(rated.map((r) => r.rate.costPerPct));
      if (t.ok) {
        const pct = Math.round(Math.abs(t.change) * 100);
        lines.push('');
        lines.push(t.direction === 'steady'
          ? `Quota rate is holding steady: ${fmtCost(t.recentMean)} per 1% across the last ${t.perSide} windows, within ${pct}% of the ${t.perSide} before.`
          : `Quota rate ${t.direction === 'down' ? 'fell' : 'rose'} ${pct}%: ${fmtCost(t.recentMean)} per 1% across the last ${t.perSide} windows vs ${fmtCost(t.olderMean)} for the ${t.perSide} before.`);
      }
    }
  }
  lines.push('');
  lines.push(`_Ember ${APP_VERSION} · reconstructed from local Claude Code and Codex logs at official API rates. Not a provider invoice._`);
  return lines.join('\n');
}

/* ─── selected projects ───
   Same numbers the expanded project row shows, written out for every ticked
   project at once, one row or object per model. Project-level totals live in
   the JSON export only. */

function selectedProjectEntries() {
  const view = state.lastView;
  if (!view) return [];
  return [...view.byProject.entries()]
    .filter(([name, p]) => p.live && state.selectedProjects.has(name))
    .sort((a, b) => b[1].cost - a[1].cost
      || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
}

function projectRangeMeta() {
  const [from, to] = rangeForPreset();
  return {
    range: state.preset,
    from: state.preset === 'all' ? null : from,
    to: state.preset === 'all' ? null : to,
    selectedDay: state.selectedDay,
    providers: [...state.selectedProviders],
    models: [...state.selectedModels],
  };
}

const PROJECT_CSV_HEADER = [
  'project', 'provider', 'model', 'calls', 'priced_calls', 'unpriced_calls',
  'input', 'output', 'reasoning_in_output', 'cache_read', 'cache_write', 'total_tokens',
  'input_usd', 'output_usd', 'reasoning_usd', 'cache_read_usd', 'cache_write_usd',
  'server_tools_usd', 'value_usd', 'value_lower_usd', 'value_upper_usd', 'estimated',
  'worked_seconds',
];

function projectCsvRow(name, provider, model, t) {
  return [
    name, provider, model,
    t.msgs, t.pricedCalls, t.unpricedCalls,
    t.input, t.output, t.reasoning || 0, t.cacheRead, t.cacheWrite,
    t.input + t.output + t.cacheRead + t.cacheWrite,
    round(t.cIn || 0, 4), round(t.cOut || 0, 4), round(t.cRs || 0, 4),
    round(t.cCr || 0, 4), round(t.cCw || 0, 4), round(t.cTool || 0, 4),
    round(t.cost, 4), round(t.costMin || 0, 4), round(t.costMax || t.cost, 4),
    t.estimated ? 'yes' : 'no',
    Math.round((t.activeMs || 0) / 1000),
  ];
}

function buildProjectsCsv() {
  const entries = selectedProjectEntries();
  if (!entries.length) return null;
  const out = [PROJECT_CSV_HEADER];
  for (const [name, p] of entries) {
    const models = [...p.models.values()].sort((a, b) =>
      b.cost - a.cost || a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }));
    for (const m of models) out.push(projectCsvRow(name, m.provider, m.model, m));
  }
  return toCsv(out);
}

function buildProjectsJson() {
  const entries = selectedProjectEntries();
  if (!entries.length) return null;
  const tokens = (t) => ({
    input: t.input,
    output: t.output,
    reasoning: t.reasoning || 0,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    total: t.input + t.output + t.cacheRead + t.cacheWrite,
  });
  const costs = (t) => ({
    inputUsd: round(t.cIn || 0, 4),
    outputUsd: round(t.cOut || 0, 4),
    reasoningUsd: round(t.cRs || 0, 4),
    cacheReadUsd: round(t.cCr || 0, 4),
    cacheWriteUsd: round(t.cCw || 0, 4),
    serverToolsUsd: round(t.cTool || 0, 4),
    valueUsd: round(t.cost, 4),
    lowerBoundUsd: round(t.costMin || 0, 4),
    upperBoundUsd: round(t.costMax || t.cost, 4),
    estimated: !!t.estimated,
  });
  const calls = (t) => ({ total: t.msgs, priced: t.pricedCalls, unpriced: t.unpricedCalls });
  const seconds = (t) => Math.round((t.activeMs || 0) / 1000);

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    app: { name: 'Ember', version: APP_VERSION, note: `API-equivalent value of subscription usage, not an invoice. Reasoning tokens are billed inside output and are already counted in it. ${window.EmberActiveTime.NOTE}` },
    view: projectRangeMeta(),
    selection: { projects: entries.map(([name]) => name) },
    totals: (() => {
      const sum = entries.reduce((acc, [, p]) => {
        for (const k of ['cost', 'costMin', 'costMax', 'input', 'output', 'reasoning',
          'cacheRead', 'cacheWrite', 'msgs', 'pricedCalls', 'unpricedCalls',
          'cIn', 'cOut', 'cCr', 'cCw', 'cRs', 'cTool']) {
          acc[k] = (acc[k] || 0) + (p[k] || 0);
        }
        acc.estimated = acc.estimated || !!p.estimated;
        return acc;
      }, {});
      return {
        calls: calls(sum), tokens: tokens(sum), cost: costs(sum),
        workedSeconds: entries.reduce((n, [, p]) => n + seconds(p), 0),
      };
    })(),
    projects: entries.map(([name, p]) => ({
      name,
      calls: calls(p),
      tokens: tokens(p),
      cost: costs(p),
      workedSeconds: seconds(p),
      sessions: p.sessions.size,
      days: p.days.size,
      models: [...p.models.values()]
        .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }))
        .map((m) => ({
          provider: m.provider,
          model: m.model,
          name: prettyModel(m.provider, m.model, m.source),
          priced: !!m.priced,
          calls: calls(m),
          tokens: tokens(m),
          cost: costs(m),
          workedSeconds: seconds(m),
        })),
    })),
  }, null, 2);
}

function buildProjectsSummary() {
  const entries = selectedProjectEntries();
  if (!entries.length) return null;
  const label = state.selectedDay ? prettyDay(state.selectedDay) : RANGE_LABELS[state.preset];
  const lines = [];
  lines.push(`**Ember — API-equivalent usage by project · ${label}**`);
  lines.push('');
  const { fmtDuration } = window.EmberActiveTime;
  lines.push('| Project | Worked | Calls | Input | Output | Cache read | Cache write | Value |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  const sum = { msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedCalls: 0 };
  for (const [name, p] of entries) {
    lines.push(`| ${name} | ${fmtDuration(p.activeMs)} | ${p.msgs.toLocaleString()} | ${fmtTok(p.input)} | ${fmtTok(p.output)} | ${fmtTok(p.cacheRead)} | ${fmtTok(p.cacheWrite)} | ${p.estimated ? '≈' : ''}${fmtCost(p.cost)} |`);
    for (const k of Object.keys(sum)) sum[k] += p[k] || 0;
  }
  const allTime = fmtDuration(entries.reduce((n, [, p]) => n + p.activeMs, 0));
  lines.push(`| **Total (${entries.length})** | ${allTime} | ${sum.msgs.toLocaleString()} | ${fmtTok(sum.input)} | ${fmtTok(sum.output)} | ${fmtTok(sum.cacheRead)} | ${fmtTok(sum.cacheWrite)} | **${fmtCost(sum.cost)}** |`);
  if (sum.unpricedCalls) {
    lines.push('');
    lines.push(`_${sum.unpricedCalls.toLocaleString()} calls have no published official price and are excluded from the value._`);
  }
  lines.push('');
  lines.push(`_Ember ${APP_VERSION} · reconstructed from local Claude Code and Codex logs at official API rates. Not a provider invoice. ${window.EmberActiveTime.NOTE}_`);
  return lines.join('\n');
}

const EXPORTS = {
  summary: { kind: 'copy', build: buildSummary, done: 'Summary copied to the clipboard' },
  'projects-csv': { kind: 'file', format: 'csv', name: 'ember-projects', build: buildProjectsCsv },
  'projects-json': { kind: 'file', format: 'json', name: 'ember-projects', build: buildProjectsJson },
  'projects-summary': { kind: 'copy', build: buildProjectsSummary, done: 'Selected projects copied to the clipboard' },
  'windows-csv': { kind: 'file', format: 'csv', name: 'ember-session-windows', build: buildWindowsCsv },
  'view-csv': { kind: 'file', format: 'csv', name: 'ember-usage', build: buildViewCsv },
  'view-json': { kind: 'file', format: 'json', name: 'ember-usage', build: buildViewJson },
};

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 240);
  }, 3000);
}

function setExportMenu(open) {
  $('exportMenu').hidden = !open;
  $('btnExport').setAttribute('aria-expanded', String(open));
  $('btnExport').classList.toggle('on', open);
  if (open) $('exportMenu').querySelector('button')?.focus();
}

async function runExport(id) {
  const spec = EXPORTS[id];
  if (!spec) return;
  setExportMenu(false);
  let content = null;
  try {
    content = spec.build();
  } catch (err) {
    console.error('export build failed:', err);
  }
  if (!content) {
    toast('Nothing to export from this view yet');
    return;
  }
  try {
    if (spec.kind === 'copy') {
      const copied = await window.api.copyText(content);
      toast(copied === false ? 'Could not copy the summary' : spec.done);
      return;
    }
    const result = await window.api.saveExport({
      suggestedName: `${spec.name}-${today()}.${spec.format}`,
      content,
      format: spec.format,
    });
    if (result && result.ok) toast(`Saved ${result.name}`);
    else if (result && result.reason === 'write-failed') toast('Could not write that file');
  } catch (err) {
    console.error('export failed:', err);
    toast('Export failed — please try again');
  }
}

/* ───────────────────────── events ───────────────────────── */

function setupEvents() {
  const pet = $('pet');
  pet.addEventListener('click', () => {
    pet.classList.remove('jump');
    void pet.offsetWidth;
    pet.classList.add('jump');
  });
  pet.addEventListener('animationend', () => pet.classList.remove('jump'));

  $('btnClose').onclick = () => window.api.close();
  $('btnHide').onclick = () => window.api.hide();
  $('btnPin').onclick = () => window.api.setPin(!state.settings.alwaysOnTop);
  $('btnMini').onclick = () => window.api.setMini(true);
  $('btnMiniExpand').onclick = () => window.api.setMini(false);
  $('btnMiniHide').onclick = () => window.api.hide();
  $('setMini').onchange = (e) => window.api.setMini(e.target.checked);
  // Double-clicking the strip is the fast way back, the way a collapsed
  // player expands.
  $('miniBar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    window.api.setMini(false);
  });

  $('btnExport').onclick = (e) => {
    e.stopPropagation();
    setExportMenu($('exportMenu').hidden);
  };
  for (const item of $('exportMenu').querySelectorAll('[data-export]')) {
    item.onclick = () => runExport(item.dataset.export);
  }
  document.addEventListener('click', (e) => {
    if ($('exportMenu').hidden) return;
    if (e.target.closest('.export-wrap')) return;
    setExportMenu(false);
  });

  $('btnRefresh').onclick = async () => {
    const button = $('btnRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('spinning');
    button.setAttribute('aria-busy', 'true');
    const started = performance.now();
    try {
      const result = await window.api.refresh();
      if (!result || result.ok !== true) throw new Error('refresh did not complete');
      const files = Number.isFinite(result.fileCount)
        ? ` · ${result.fileCount.toLocaleString()} local files checked`
        : '';
      // Refresh overrides a rate-limit backoff, so a 429 here means the button
      // genuinely went out and asked — worth saying, and so is the success.
      const claude = result.limits && result.limits.claude;
      const claudeState = claude ? claude.state : null;
      let limitsNote = '';
      if (claudeState === 'updated') {
        limitsNote = ' · Claude limits updated';
      } else if (claude && (claude.reason === 'http-429' || claudeState === 'backoff')) {
        limitsNote = ' · Claude limits rate-limited';
      } else if (claudeState === 'cooldown' || claudeState === 'recent') {
        limitsNote = ' · Claude limits checked recently';
      } else if (claudeState === 'in-flight') {
        limitsNote = ' · Claude limit check already running';
      } else if (claudeState === 'error') {
        limitsNote = ' · Claude limits unavailable';
      }
      toast(`Local usage rescanned${files}${limitsNote}`);
    } catch (err) {
      console.error('refresh failed:', err);
      toast('Refresh failed — please try again');
    } finally {
      const remaining = Math.max(0, 350 - (performance.now() - started));
      if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
      button.classList.remove('spinning');
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  };

  $('btnSettings').onclick = () => setSettingsOpen(true);
  $('btnSettingsClose').onclick = () => setSettingsOpen(false);
  $('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) setSettingsOpen(false); };
  $('setAutostart').onchange = (e) => window.api.setAutostart(e.target.checked);
  $('setPin').onchange = (e) => window.api.setPin(e.target.checked);

  for (const chip of document.querySelectorAll('#dateChips .chip')) {
    chip.onclick = () => {
      document.querySelectorAll('#dateChips .chip').forEach((c) => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      moveSegThumb();
      state.preset = chip.dataset.range;
      state.selectedDay = null;
      state.selectionOrigin = null;
      state.expandedProject = null;
      $('customRange').hidden = state.preset !== 'custom';
      if (state.preset === 'custom') {
        if (!state.customFrom) state.customFrom = daysAgo(13);
        if (!state.customTo) state.customTo = today();
        writeCustomControls();
      }
      render();
    };
  }
  for (const radio of document.querySelectorAll('input[name="customEndMode"]')) {
    radio.onchange = () => {
      syncCustomEndModeUI();
      validateCustomDraft();
    };
  }
  for (const id of ['dateFrom', 'timeFrom', 'dateTo', 'timeTo']) {
    $(id).addEventListener('input', validateCustomDraft);
    $(id).addEventListener('change', validateCustomDraft);
  }
  $('applyCustom').onclick = () => {
    const draft = validateCustomDraft();
    if (!draft) return;
    state.customFrom = draft.customFrom;
    state.customFromTime = draft.customFromTime;
    state.customTo = draft.customTo || today();
    state.customToTime = draft.customToTime || '23:59';
    state.customEndMode = draft.customEndMode;
    state.selectedDay = null;
    state.selectionOrigin = null;
    state.expandedProject = null;
    render();
  };

  document.querySelectorAll('#dateChips .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.classList.contains('active')));
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('exportMenu').hidden) {
      e.preventDefault();
      setExportMenu(false);
      $('btnExport').focus();
      return;
    }
    if (e.key === 'Escape' && state.settings.miniMode && $('settingsOverlay').hidden) {
      e.preventDefault();
      window.api.setMini(false);
      return;
    }
    if (e.key === 'Escape' && !$('settingsOverlay').hidden) {
      e.preventDefault();
      setSettingsOpen(false);
      return;
    }
    if (e.key !== 'Tab' || $('settingsOverlay').hidden) return;
    const focusable = [...$('settingsOverlay').querySelectorAll('button, input:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (state.lastByDay) renderChart(state.lastByDay);
      if (quotaGeom) renderQuotaChart(quotaCache.rows, quotaGeom.scope, quotaGeom.metric, -1);
      moveSegThumb();
      syncScrollerFades();
      syncStuckFilters();
    });
  });

  $('scrollArea').addEventListener('scroll', syncStuckFilters, { passive: true });
  for (const el of document.querySelectorAll('.filter-scroller')) {
    el.addEventListener('scroll', syncScrollerFades, { passive: true });
  }

  // position the thumb once layout and webfonts have settled
  moveSegThumb();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSegThumb);
  setTimeout(moveSegThumb, 400);
}

/* ───────────────────────── init ───────────────────────── */

async function init() {
  // theme.js already put the saved palette on the root element; from here the
  // renderer only needs the resolved values and a repaint when they change.
  invalidateThemeColors();
  window.EmberTheme.onChange(() => {
    invalidateThemeColors();
    renderLimits();
    if (state.hasRenderedUsage) render();
  });
  renderThemePicker();

  setupEvents();
  setupChartHover();
  setupQuotaHover();

  state.settings = await window.api.getSettings();
  APP_VERSION = await window.api.getVersion();
  $('settingsVersion').textContent = APP_VERSION ? `v${APP_VERSION}` : '';
  updatePinButton();
  applyMiniMode();

  window.api.onSettings((s) => {
    const modeChanged = s.miniMode !== state.settings.miniMode;
    state.settings = s;
    updatePinButton();
    $('setAutostart').checked = s.launchAtStartup;
    $('setPin').checked = s.alwaysOnTop;
    if (modeChanged) {
      applyMiniMode();
      // The charts were laid out against a window of a different size.
      if (!s.miniMode) requestAnimationFrame(() => render());
    }
  });

  window.api.onUsage((data) => {
    const changed = applyUsageData(data);
    if (changed) {
      scheduleLiveRender();
      pulseLiveDot();
    }
    renderStatus();
    renderPricingStatus();
  });

  // every-second confirmation that the data was checked and is unchanged
  window.api.onHeartbeat((ts) => {
    state.generatedAt = ts;
    renderStatus();
  });

  window.api.onLimits((l) => {
    state.limits = l;
    renderLimits();
  });
  window.api.onQuota((q) => {
    state.quota = q;
    state.quotaRevision++;
    if (state.hasRenderedUsage) render();
  });
  state.limits = await window.api.getLimits();
  renderLimits();
  state.quota = await window.api.getQuota();
  state.quotaRevision++;

  const data = await window.api.getUsage();
  const changed = applyUsageData(data);
  if (changed || !state.hasRenderedUsage) render();
  renderStatus();
  renderPricingStatus();
  document.body.dataset.ready = 'true';
}

/* Theme picker. Each button paints itself from the theme it selects — base,
   then the three gauge steps — so the swatch is the preview. */
function renderThemePicker() {
  const grid = $('themeGrid');
  if (!grid) return;
  const active = window.EmberTheme.current();
  grid.innerHTML = '';
  for (const theme of window.EmberTheme.THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `theme-swatch${theme.id === active ? ' active' : ''}`;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(theme.id === active));
    btn.innerHTML = `
      <span class="tsw" aria-hidden="true">${theme.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      <span class="tname">${theme.name}</span>`;
    btn.onclick = () => {
      if (window.EmberTheme.current() === theme.id) return;
      window.EmberTheme.apply(theme.id);
      renderThemePicker();
      toast(`${theme.name} applied`);
    };
    grid.appendChild(btn);
  }
}

function renderPricingStatus() {
  const el = $('pricingStatus');
  if (!el) return;
  const statuses = state.pricing ? [state.pricing.openai, state.pricing.anthropic].filter(Boolean) : [];
  if (!statuses.length) {
    el.textContent = 'Official bundled rates are active; live pricing status is unavailable.';
    return;
  }
  el.textContent = statuses.map((p) => {
    if (!p.live) return `${p.provider}: official bundled table (live refresh retrying)`;
    const hrs = Math.max(0, Math.round((Date.now() - p.fetchedAt) / 3600000));
    const age = hrs < 1 ? 'just now' : hrs < 48 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} days ago`;
    return `${p.provider}: ${p.models} official rows refreshed ${age}`;
  }).join(' · ');
}

function updatePinButton() {
  const on = !!state.settings.alwaysOnTop;
  $('btnPin').classList.toggle('on', on);
  $('btnPin').setAttribute('aria-pressed', String(on));
}

function showStartupError(error) {
  console.error('Ember startup failed:', error);
  const panel = $('startupError');
  const detail = error && error.message ? error.message : String(error || 'Unknown startup error');
  $('startupErrorMessage').textContent = `The local Ember service did not respond. ${detail}`;
  panel.hidden = false;
  $('btnStartupRetry').onclick = () => window.location.reload();
  $('btnStartupRetry').focus();
}

init().catch(showStartupError);
