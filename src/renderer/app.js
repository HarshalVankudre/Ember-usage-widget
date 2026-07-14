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
  deletedExpanded: false,
  expandedProject: null,
  hiddenProjects: loadHiddenProjects(), // excluded from all totals, shown blurred
  settings: { alwaysOnTop: false, launchAtStartup: true },
  limits: null, // { claude, codex }
  pricing: null,
  dataRevision: 0,
  usageRevision: null,
  usageGeneratedAt: null,
  hasRenderedUsage: false,
};

const PROVIDERS = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', color: '#38c98b' },
};

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

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

function prettyModel(provider, model) {
  return provider === 'codex' ? prettyCodexModel(model) : prettyClaudeModel(model);
}

// family palettes (dark mode) — checked in order, first substring match wins
const CLAUDE_FAMILY_COLOR = {
  fable: '#ef746f', mythos: '#ef746f',
  opus: '#7fa8e8',
  sonnet: '#79c995',
  haiku: '#b59bd8',
  other: '#8f857c',
};
const CODEX_FAMILY_COLOR = {
  pro: '#eeb261',
  mini: '#72b8d0',
  nano: '#aa92cd',
  'gpt-5': '#54c895',
  codex: '#54c895',
  'gpt-4': '#df7a73',
  'o4': '#7fa8e8',
  'o3': '#7fa8e8',
  other: '#8f857c',
};

const modelColorCache = new Map();
function modelColor(provider, model) {
  const key = `${provider}|${model}`;
  if (modelColorCache.has(key)) return modelColorCache.get(key);
  const palette = provider === 'codex' ? CODEX_FAMILY_COLOR : CLAUDE_FAMILY_COLOR;
  const lower = model.toLowerCase();
  let fam = 'other';
  for (const f of Object.keys(palette)) if (f !== 'other' && lower.includes(f)) { fam = f; break; }
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const base = palette[fam];
  // shift lightness slightly per variant so e.g. Opus 4.7 vs 4.8 differ
  const shift = ((hash % 5) - 2) * 7;
  const c = shade(base, shift);
  modelColorCache.set(key, c);
  return c;
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
};
let liveRenderFrame = 0;
let resetChartHover = () => {};

function setKey(value) {
  return [...value].sort().join(',');
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

  const rows = filteredBuckets();
  const byDay = dayTotals(chartFilteredBuckets());

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
  const visibleProviders = new Set();

  for (const b of rows) {
    const mk = mkey(b);

    let p = byProject.get(b.project);
    if (!p) {
      p = { cost: 0, costMin: 0, costMax: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0,
        pricedCalls: 0, unpricedCalls: 0, estimated: false,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, cTool: 0, live: false, models: new Map() };
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
    let pm = p.models.get(mk);
    if (!pm) {
      pm = { provider: b.provider, model: b.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, msgs: 0,
        costMin: 0, costMax: 0,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, cTool: 0,
        pricedCalls: 0, unpricedCalls: 0, estimated: false, priced: true };
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
    if (!b.priced) pm.priced = false;

    // hidden projects still render (blurred) but count toward nothing else
    if (state.hiddenProjects.has(b.project)) continue;

    visibleProviders.add(b.provider);
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

    let m = byModel.get(mk);
    if (!m) {
      m = { provider: b.provider, model: b.model,
        input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costMin: 0, costMax: 0,
        estimated: false, pricedCalls: 0, unpricedCalls: 0, priced: b.priced };
      byModel.set(mk, m);
    }
    m.input += b.input; m.output += b.output; m.cacheRead += b.cacheRead; m.cacheWrite += b.cacheWrite; m.cost += b.cost;
    m.reasoning += b.reasoning || 0;
    m.costMin += b.costMin || 0; m.costMax += b.costMax || b.cost || 0;
    m.estimated = m.estimated || !!b.estimated;
    m.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
    m.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
    if (!b.priced) m.priced = false;

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
  $('w5hTok').textContent = w5.msgs ? `${fmtTok(w5.tok)} tokens · ${w5.msgs.toLocaleString()} calls` : 'no activity';
  updateValue($('wkCost'), wk.cost, paintMoney, animate);
  $('wkTok').textContent = wk.msgs ? `${fmtTok(wk.tok)} tokens · ${wk.msgs.toLocaleString()} calls` : 'no activity';

  // hero: only officially priced usage contributes to the number. Unknown
  // model prices are called out separately instead of silently counting $0.
  const detailLabel = state.selectedDay ? prettyDay(state.selectedDay) : RANGE_LABELS[state.preset];
  $('heroLabel').textContent = (tot.unpricedCalls ? 'Priced API value · ' : 'API-equivalent value · ') + detailLabel;
  updateValue($('heroCost'), tot.cost, paintMoney, animate);
  const allTok = tot.input + tot.output + tot.cacheRead + tot.cacheWrite;
  $('heroTokens').textContent = fmtTok(allTok) + ' tokens';
  $('heroMsgs').textContent = tot.msgs.toLocaleString() + ' calls';
  renderPricingConfidence(tot);

  // stat cards
  const codexOnly = visibleProviders.has('codex') && !visibleProviders.has('claude');
  const showReasoningCard = tot.cacheWrite === 0 && (codexOnly || tot.reasoning > 0);
  $('stIn').innerHTML = tokHTML(tot.input);
  $('stOut').innerHTML = tokHTML(tot.output);
  $('stCr').innerHTML = tokHTML(tot.cacheRead);
  $('stInCost').textContent = fmtCost(tot.cIn);
  $('stOutCost').textContent = fmtCost(tot.cOut)
    + (tot.cTool > 0 ? ` + ${fmtCost(tot.cTool)} tools` : '')
    + (!showReasoningCard && tot.reasoning > 0 ? ` · ${fmtTok(tot.reasoning)} reasoning` : '');
  $('stCrCost').textContent = fmtCost(tot.cCr);
  if (showReasoningCard) {
    $('stCwLabel').textContent = 'Reasoning';
    $('stCw').innerHTML = tokHTML(tot.reasoning);
    $('stCwCost').textContent = 'included in output'
      + (tot.cCw > 0 ? ` · ≈${fmtCost(tot.cCw)} write est.` : '');
    $('stCwCard').title = 'Codex reasoning tokens are included in output billing'
      + (tot.cCw > 0 ? '; estimated cache-write premium retained below' : '');
  } else {
    $('stCwLabel').textContent = 'Cache write';
    $('stCw').innerHTML = tokHTML(tot.cacheWrite);
    $('stCwCost').textContent = `${tot.estimated && tot.cCw > 0 ? '≈' : ''}${fmtCost(tot.cCw)}`;
    $('stCwCard').title = 'Measured cache writes; an estimated premium may also appear in cost';
  }

  // insights
  $('insSaved').textContent = fmtCost(tot.saved);
  $('insBurn').textContent = days.size ? fmtCost(tot.cost / days.size) : '$0.00';
  $('insSessions').textContent = sessions.size.toLocaleString();
  const inTotal = tot.input + tot.cacheRead + tot.cacheWrite;
  $('insCacheRate').textContent = inTotal ? Math.round((tot.cacheRead / inTotal) * 100) + '%' : '–';

  const providersKey = `${state.dataRevision}|${setKey(state.selectedProviders)}`;
  if (sectionRenderKeys.providers !== providersKey) {
    renderProviderChips();
    sectionRenderKeys.providers = providersKey;
  }

  const modelsKey = `${providersKey}|${setKey(state.selectedModels)}`;
  if (sectionRenderKeys.models !== modelsKey) {
    renderModelChips();
    sectionRenderKeys.models = modelsKey;
  }

  const hiddenKey = setKey(state.hiddenProjects);
  const detailKey = [
    state.dataRevision, state.preset, state.customFrom, state.customFromTime,
    state.customTo, state.customToTime, state.customEndMode,
    state.selectedDay, setKey(state.selectedProviders),
    setKey(state.selectedModels), hiddenKey,
  ].join('|');
  if (sectionRenderKeys.modelTable !== detailKey) {
    renderModelTable(byModel);
    sectionRenderKeys.modelTable = detailKey;
  }

  const projectsKey = `${detailKey}|${state.projectsExpanded}|${state.deletedExpanded}|${state.expandedProject}`;
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
}

function renderPricingConfidence(tot) {
  const box = $('pricingConfidence');
  const summary = $('pricingSummary');
  const range = $('pricingRange');
  box.classList.remove('estimated', 'partial');
  if (!tot.msgs) {
    summary.textContent = 'No usage in this view';
    range.textContent = '';
    return;
  }

  const tokenTotal = tot.pricedTokens + tot.unpricedTokens;
  const coverage = tokenTotal ? (tot.pricedTokens / tokenTotal) * 100 : 100;
  const coverageText = tot.unpricedCalls > 0
    ? `${Math.min(99.99, coverage).toFixed(coverage >= 99 ? 2 : 1)}%`
    : '100%';
  if (tot.unpricedCalls > 0) {
    box.classList.add('partial');
    summary.textContent = `${coverageText} of tokens priced · ${tot.unpricedCalls.toLocaleString()} calls excluded`;
    box.title = 'Some models have no published official API price, so those calls are excluded from the dollar total.';
  } else if (tot.estimated) {
    box.classList.add('estimated');
    summary.textContent = '100% officially priced · cache-write premium estimated';
    box.title = 'Codex logs omit GPT-5.6 cache-write counts. The headline uses the conservative upper estimate.';
  } else {
    summary.textContent = '100% officially priced from measured token classes';
    box.title = 'Every visible call has an official model price and measured token categories.';
  }

  const spread = Math.max(0, tot.costMax - tot.costMin);
  range.textContent = spread >= 0.005 ? `lower ${fmtCost(tot.costMin)}` : '';
}

function renderProviderChips() {
  const present = [...new Set(state.buckets.map((b) => b.provider))];
  const wrap = $('providerChips');
  wrap.innerHTML = '';
  if (present.length < 2) return; // nothing to filter with a single provider
  for (const pv of ['claude', 'codex']) {
    if (!present.includes(pv)) continue;
    const btn = document.createElement('button');
    btn.className = 'chip model-chip provider-chip';
    const active = state.selectedProviders.size === 0 || state.selectedProviders.has(pv);
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.title = `Filter to ${PROVIDERS[pv].label}`;
    btn.style.setProperty('--c', PROVIDERS[pv].color);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    btn.append(swatch, document.createTextNode(PROVIDERS[pv].label));
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
    if (state.selectedProviders.size > 0 && !state.selectedProviders.has(b.provider)) continue;
    if (!seen.has(mkey(b))) seen.set(mkey(b), { provider: b.provider, model: b.model });
  }
  const models = [...seen.entries()].sort((a, b) =>
    a[1].provider.localeCompare(b[1].provider) || a[1].model.localeCompare(b[1].model));
  const wrap = $('modelChips');
  wrap.innerHTML = '';
  for (const [key, { provider, model }] of models) {
    const btn = document.createElement('button');
    btn.className = 'chip model-chip';
    const active = state.selectedModels.size === 0 || state.selectedModels.has(key);
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.style.setProperty('--c', modelColor(provider, model));
    btn.title = `${PROVIDERS[provider].label} · ${model}`;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    btn.append(swatch, document.createTextNode(prettyModel(provider, model)));
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
  const entries = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  if (!entries.length) {
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
    const tr = document.createElement('tr');
    const modelCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'mname';
    name.title = `${PROVIDERS[m.provider].label} · ${m.model}`;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = modelColor(m.provider, m.model);
    const label = document.createElement('span');
    label.className = 'model-label';
    label.textContent = prettyModel(m.provider, m.model);
    name.append(swatch, label);
    modelCell.appendChild(name);
    tr.appendChild(modelCell);

    const values = [
      { text: fmtTok(m.input) },
      {
        text: fmtTok(m.output) + (m.reasoning > 0 ? ` · R ${fmtTok(m.reasoning)}` : ''),
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
  row.append(lbl, tokEl, costEl);
  return row;
}

// One aligned group per model — rows of label | tokens | cost — plus an
// "All models" totals group when the project used more than one model.
// Rows adapt to the provider: Claude models have real cache-write counts;
// Codex models show cached input, reasoning, and an estimated write surcharge.
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
    } else if (provider === 'claude') {
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
      projTableRow(prettyModel(m.provider, m.model), `${m.msgs.toLocaleString()} calls`, money(m.cost, m.priced, m.estimated),
        { head: true, dot: modelColor(m.provider, m.model), title: `${PROVIDERS[m.provider].label} · ${m.model}` }),
      m, m.priced, m.provider);
  }
  if (entries.length > 1) {
    addGroup(
      projTableRow('All models', `${p.msgs.toLocaleString()} calls`, money(p.cost, p.unpricedCalls === 0, p.estimated), { head: true }),
      p, p.unpricedCalls === 0, 'all');
  }
}

function buildProjectItem(wrap, name, p, max, isDeleted) {
  const isHidden = state.hiddenProjects.has(name);
  const item = document.createElement('div');
  item.className = 'proj';
  if (isHidden) item.classList.add('is-hidden');
  if (isDeleted) item.classList.add('is-deleted');

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
    <span class="proj-cost"></span>
    <span class="proj-bar" aria-hidden="true"><i style="--w:${((p.cost / max) * 100).toFixed(1)}%"></i></span>`;
  const nameEl = summary.querySelector('.proj-name');
  nameEl.textContent = name;
  nameEl.title = name;
  const costEl = summary.querySelector('.proj-cost');
  costEl.textContent = projectCost;
  if (p.unpricedCalls > 0) costEl.title = `${p.unpricedCalls.toLocaleString()} calls excluded because no official price is published`;
  else if (p.estimated) costEl.title = `Conservative estimate; lower bound ${fmtCost(p.costMin)}`;
  summary.title = isHidden
    ? 'Hidden from totals — right-click to unhide'
    : isDeleted
      ? `${name} — logs deleted from disk; records kept by Ember`
      : name;

  const details = document.createElement('div');
  details.className = 'proj-details';
  details.hidden = true;
  const totalTokens = p.input + p.output + p.cacheRead + p.cacheWrite;
  details.innerHTML = `
    <div class="proj-detail-head">
      <span>Token breakdown</span>
      <span>${fmtTok(totalTokens)} total · ${p.msgs.toLocaleString()} calls</span>
    </div>
    <div class="proj-table"></div>`;
  appendProjectModels(details.querySelector('.proj-table'), p);

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

  item.append(summary, details);
  wrap.appendChild(item);
  if (state.expandedProject === name && !isHidden) setProjectOpen(item, summary, details, true);
}

function renderProjects(byProject) {
  const wrap = $('projectList');
  wrap.innerHTML = '';
  const entries = [...byProject.entries()].sort((a, b) =>
    b[1].cost - a[1].cost || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  const note = $('projNote');
  if (note) {
    const hiddenCount = entries.filter(([n]) => state.hiddenProjects.has(n)).length;
    note.textContent = hiddenCount
      ? `sorted by cost · ${hiddenCount} hidden`
      : 'sorted by cost · right-click to hide';
  }
  if (!entries.length) {
    state.expandedProject = null;
    wrap.innerHTML = `<div class="empty">no usage in this range</div>`;
    return;
  }

  if (!byProject.has(state.expandedProject)) state.expandedProject = null;
  const max = entries[0][1].cost || 1;

  // projects whose logs were deleted from disk live in their own group at
  // the bottom — records survive (parsed data is kept in Ember's cache)
  const liveEntries = entries.filter(([, p]) => p.live);
  const deletedEntries = entries.filter(([, p]) => !p.live);

  const visibleEntries = state.projectsExpanded ? liveEntries : liveEntries.slice(0, PROJECT_PREVIEW_COUNT);
  for (const [name, p] of visibleEntries) buildProjectItem(wrap, name, p, max, false);

  if (liveEntries.length > PROJECT_PREVIEW_COUNT) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'project-expand';
    toggle.setAttribute('aria-expanded', String(state.projectsExpanded));
    toggle.innerHTML = `
      <span>${state.projectsExpanded ? `Show top ${PROJECT_PREVIEW_COUNT}` : `Show all ${liveEntries.length} projects`}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    toggle.addEventListener('click', () => {
      state.projectsExpanded = !state.projectsExpanded;
      if (!state.projectsExpanded && !liveEntries.slice(0, PROJECT_PREVIEW_COUNT).some(([name]) => name === state.expandedProject)) {
        state.expandedProject = null;
      }
      renderProjects(byProject);
      wrap.querySelector('.project-expand')?.focus({ preventScroll: true });
    });
    wrap.appendChild(toggle);
  }

  if (deletedEntries.length) {
    const divider = document.createElement('button');
    divider.type = 'button';
    divider.className = 'deleted-divider';
    divider.setAttribute('aria-expanded', String(state.deletedExpanded));
    divider.title = 'Projects whose logs were deleted from disk — usage records are kept';
    divider.innerHTML = `
      <span>Deleted projects (${deletedEntries.length})</span>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    divider.addEventListener('click', () => {
      state.deletedExpanded = !state.deletedExpanded;
      if (!state.deletedExpanded && deletedEntries.some(([name]) => name === state.expandedProject)) {
        state.expandedProject = null;
      }
      renderProjects(byProject);
    });
    wrap.appendChild(divider);
    if (state.deletedExpanded) {
      for (const [name, p] of deletedEntries) buildProjectItem(wrap, name, p, max, true);
    }
  }
}

/* ───────────────────────── chart ───────────────────────── */

let chartGeom = null; // for hover hit-testing
let chartBinsCache = null;

function renderChart(byDay, hoverIdx = -1) {
  state.lastByDay = byDay;
  const canvas = $('chart');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

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
  ctx.strokeStyle = 'rgba(245,239,232,0.05)';
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = H - padB - plotH * f + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(W - padR, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(245,239,232,0.12)';
  ctx.beginPath();
  ctx.moveTo(padL, H - padB + 0.5);
  ctx.lineTo(W - padR, H - padB + 0.5);
  ctx.stroke();

  // scale hint, top-right
  ctx.fillStyle = 'rgba(198,187,176,0.48)';
  ctx.font = '600 9px "Segoe UI", sans-serif';
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
      const color = modelColor(pv, model);
      const grad = ctx.createLinearGradient(0, yTop, 0, y);
      grad.addColorStop(0, shade(color, 26));
      grad.addColorStop(1, shade(color, -6));
      ctx.fillStyle = grad;
      roundRectPath(ctx, x, yTop, barW, h, Math.min(2.5, barW / 2));
      ctx.fill();
      y = yTop;
    }
    if (bin.total === 0) {
      ctx.fillStyle = 'rgba(245,239,232,0.08)';
      ctx.fillRect(x, H - padB - 1.5, barW, 1.5);
    }
    ctx.globalAlpha = 1;
  });

  // x labels: first, middle, last
  ctx.fillStyle = 'rgba(198,187,176,0.48)';
  ctx.font = '9px "Segoe UI", sans-serif';
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
    ['seven_day_fable', 'Weekly · Fable 5'],
    ['seven_day_fable_5', 'Weekly · Fable 5'],
  ]) {
    const v = d[key];
    const showAtZero = key.startsWith('seven_day_fable');
    if (v && v.utilization != null && (showAtZero || v.utilization > 0) && !modelRows.has(label)) {
      rows.push({ name: label, sub: () => fmtResetDay(v.resets_at), u: v.utilization });
      modelRows.add(label);
    }
  }

  // Newer account API payloads put model-specific quotas in a generic limits
  // array instead of a named seven_day_* field. Fable currently arrives with
  // display_name "Fable", while the product-facing model name is Fable 5.
  for (const v of Array.isArray(d.limits) ? d.limits : []) {
    const displayName = v && v.scope && v.scope.model && v.scope.model.display_name;
    if (v && v.kind === 'weekly_scoped' && /^fable(?:\s*5)?$/i.test(displayName || '')
      && v.percent != null && !modelRows.has('Weekly · Fable 5')) {
      rows.push({ name: 'Weekly · Fable 5', sub: () => fmtResetDay(v.resets_at), u: v.percent });
      modelRows.add('Weekly · Fable 5');
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
    ? 'Run a Codex session once — limits are read from its local logs.'
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
    head.innerHTML = `<span class="pdot" style="background:${PROVIDERS[provider].color}"></span>${PROVIDERS[provider].label}${badge}`;
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
      if (mins >= 5) return `Snapshot from ${mins} min ago — refreshing soon.`;
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
        return `From your last Codex call, ${ago} ago — updates on the next one.`;
      }
    }
    return null;
  });

  // the ember heats up with the worst window across BOTH providers
  avatarMood(worstAll);
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
  el.textContent = secs < 3 ? 'Updated just now'
    : secs < 60 ? `Updated ${secs}s ago`
    : `Updated ${Math.round(secs / 60)}m ago`;
  $('liveDot').classList.toggle('stale', secs > 30);
}
setInterval(() => {
  renderStatus();
  tickLimitCountdowns();
}, 1000);

/* ───────────────────────── mascot reactions ───────────────────────── */

function avatarMood(worstUtilization) {
  const pet = $('pet');
  pet.classList.toggle('worried', worstUtilization >= 80 && worstUtilization < 95);
  pet.classList.toggle('crit', worstUtilization >= 95);
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

  $('btnRefresh').onclick = () => {
    $('btnRefresh').classList.add('spinning');
    window.api.refresh();
    setTimeout(() => $('btnRefresh').classList.remove('spinning'), 1200);
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
      moveSegThumb();
    });
  });

  // position the thumb once layout and webfonts have settled
  moveSegThumb();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSegThumb);
  setTimeout(moveSegThumb, 400);
}

/* ───────────────────────── init ───────────────────────── */

async function init() {
  setupEvents();
  setupChartHover();

  state.settings = await window.api.getSettings();
  updatePinButton();

  window.api.onSettings((s) => {
    state.settings = s;
    updatePinButton();
    $('setAutostart').checked = s.launchAtStartup;
    $('setPin').checked = s.alwaysOnTop;
  });

  window.api.onUsage((data) => {
    const changed = applyUsageData(data);
    if (changed) scheduleLiveRender();
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
  state.limits = await window.api.getLimits();
  renderLimits();

  const data = await window.api.getUsage();
  const changed = applyUsageData(data);
  if (changed || !state.hasRenderedUsage) render();
  renderStatus();
  renderPricingStatus();
  document.body.dataset.ready = 'true';
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

init();
