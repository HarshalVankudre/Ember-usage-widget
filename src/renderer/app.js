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
  selectedProviders: new Set(), // empty = both
  selectedModels: new Set(),    // keys `provider|model`; empty = all
  projectsExpanded: false,
  deletedExpanded: false,
  expandedProject: null,
  hiddenProjects: loadHiddenProjects(), // excluded from all totals, shown blurred
  settings: { alwaysOnTop: false, launchAtStartup: true },
  limits: null, // { claude, codex }
};

const PROVIDERS = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', color: '#19c37d' },
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
  if (from == null || !isFinite(from) || Math.abs(to - from) < 1e-9) {
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

function rangeForPreset() {
  const t = today();
  switch (state.preset) {
    case 'today': return [t, t];
    case '7d': return [daysAgo(6), t];
    case '30d': return [daysAgo(29), t];
    case 'mtd': return [t.slice(0, 8) + '01', t];
    case 'custom': return [state.customFrom || '0000', state.customTo || t];
    default: return ['0000', '9999'];
  }
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
  fable: '#ff375f', mythos: '#ff375f',
  opus: '#0a84ff',
  sonnet: '#30d158',
  haiku: '#bf5af2',
  other: '#98989d',
};
const CODEX_FAMILY_COLOR = {
  pro: '#ff9f0a',
  mini: '#64d2ff',
  nano: '#bf5af2',
  'gpt-5': '#19c37d',
  codex: '#19c37d',
  'gpt-4': '#ff375f',
  'o4': '#0a84ff',
  'o3': '#0a84ff',
  other: '#98989d',
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

function filteredBuckets() {
  const [from, to] = rangeForPreset();
  return state.buckets.filter((b) => {
    if (b.date < from || b.date > to) return false;
    return passesLiveFilters(b);
  });
}

/* ───────────────────────── rendering ───────────────────────── */

function render() {
  const rows = filteredBuckets();

  const tot = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0, saved: 0,
    cIn: 0, cOut: 0, cCr: 0, cCw: 0 };
  const byModel = new Map();   // mkey -> totals
  const byProject = new Map(); // project name -> totals (providers merge)
  const byDay = new Map();
  const sessions = new Set();
  const days = new Set();

  for (const b of rows) {
    const mk = mkey(b);

    let p = byProject.get(b.project);
    if (!p) {
      p = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, msgs: 0,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, live: false, models: new Map() };
      byProject.set(b.project, p);
    }
    // a project counts as deleted only when every source log is gone
    // (across both providers)
    if (!b.projectDeleted) p.live = true;
    p.cost += b.cost;
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
    let pm = p.models.get(mk);
    if (!pm) {
      pm = { provider: b.provider, model: b.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, msgs: 0,
        cIn: 0, cOut: 0, cCr: 0, cCw: 0, cRs: 0, priced: true };
      p.models.set(mk, pm);
    }
    pm.input += b.input;
    pm.output += b.output;
    pm.cacheRead += b.cacheRead;
    pm.cacheWrite += b.cacheWrite;
    pm.reasoning += b.reasoning;
    pm.cost += b.cost;
    pm.msgs += b.msgs;
    pm.cIn += b.cIn || 0;
    pm.cOut += b.cOut || 0;
    pm.cCr += b.cCr || 0;
    pm.cCw += b.cCw || 0;
    pm.cRs += b.cRs || 0;
    if (!b.priced) pm.priced = false;

    // hidden projects still render (blurred) but count toward nothing else
    if (state.hiddenProjects.has(b.project)) continue;

    tot.cost += b.cost;
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
    sessions.add(`${b.provider}|${b.session}`);
    days.add(b.date);

    let m = byModel.get(mk);
    if (!m) {
      m = { provider: b.provider, model: b.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: b.priced };
      byModel.set(mk, m);
    }
    m.input += b.input; m.output += b.output; m.cacheRead += b.cacheRead; m.cacheWrite += b.cacheWrite; m.cost += b.cost;

    let d = byDay.get(b.date);
    if (!d) { d = { total: 0, models: new Map() }; byDay.set(b.date, d); }
    d.total += b.cost;
    d.models.set(mk, (d.models.get(mk) || 0) + b.cost);
  }

  // today's spend under the mascots (provider/model filters apply; date filter doesn't — it's live)
  const t = today();
  let todayCost = 0;
  for (const b of state.buckets) {
    if (state.hiddenProjects.has(b.project)) continue;
    if (b.date === t && passesLiveFilters(b)) todayCost += b.cost;
  }
  animateValue($('todayVal'), todayCost, paintCost);

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
  animateValue($('w5hCost'), w5.cost, paintMoney);
  $('w5hTok').textContent = w5.msgs ? `${fmtTok(w5.tok)} tokens · ${w5.msgs.toLocaleString()} calls` : 'no activity';
  animateValue($('wkCost'), wk.cost, paintMoney);
  $('wkTok').textContent = wk.msgs ? `${fmtTok(wk.tok)} tokens · ${wk.msgs.toLocaleString()} calls` : 'no activity';

  // hero
  $('heroLabel').textContent = 'API spend · ' + RANGE_LABELS[state.preset];
  animateValue($('heroCost'), tot.cost, paintMoney);
  const allTok = tot.input + tot.output + tot.cacheRead + tot.cacheWrite;
  $('heroTokens').textContent = fmtTok(allTok) + ' tokens';
  $('heroMsgs').textContent = tot.msgs.toLocaleString() + ' calls';

  // stat cards
  $('stIn').innerHTML = tokHTML(tot.input);
  $('stOut').innerHTML = tokHTML(tot.output);
  $('stCr').innerHTML = tokHTML(tot.cacheRead);
  $('stCw').innerHTML = tokHTML(tot.cacheWrite);
  $('stInCost').textContent = fmtCost(tot.cIn);
  $('stOutCost').textContent = fmtCost(tot.cOut);
  $('stCrCost').textContent = fmtCost(tot.cCr);
  $('stCwCost').textContent = fmtCost(tot.cCw);

  // insights
  $('insSaved').textContent = fmtCost(tot.saved);
  $('insBurn').textContent = days.size ? fmtCost(tot.cost / days.size) : '$0.00';
  $('insSessions').textContent = sessions.size.toLocaleString();
  const inTotal = tot.input + tot.cacheRead;
  $('insCacheRate').textContent = inTotal ? Math.round((tot.cacheRead / inTotal) * 100) + '%' : '–';

  renderProviderChips();
  renderModelChips();
  renderModelTable(byModel);
  renderProjects(byProject);
  renderChart(byDay);
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
    btn.style.setProperty('--c', PROVIDERS[pv].color);
    btn.innerHTML = `<span class="swatch"></span>${PROVIDERS[pv].label}`;
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
    btn.style.setProperty('--c', modelColor(provider, model));
    btn.title = `${PROVIDERS[provider].label} · ${model}`;
    btn.innerHTML = `<span class="swatch"></span>${prettyModel(provider, model)}`;
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
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">no usage in this range</div></td></tr>`;
    return;
  }
  for (const m of entries) {
    const tr = document.createElement('tr');
    // Codex logs carry no cache-write token counts — show "—" instead of 0
    const cw = m.provider === 'codex' ? '—' : fmtTok(m.cacheWrite);
    tr.innerHTML = `
      <td><span class="mname" title="${PROVIDERS[m.provider].label}"><span class="swatch" style="background:${modelColor(m.provider, m.model)}"></span>${prettyModel(m.provider, m.model)}</span></td>
      <td>${fmtTok(m.input)}</td>
      <td>${fmtTok(m.output)}</td>
      <td>${fmtTok(m.cacheRead)}</td>
      <td>${cw}</td>
      <td class="r">${m.priced ? fmtCost(m.cost) : '—'}</td>`;
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
  const money = (v, priced) => (priced ? fmtCost(v) : '—');
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
      if (m.cCw > 0) {
        g.appendChild(projTableRow('Cache write (est.)', '', money(m.cCw, priced),
          { title: '25% surcharge on non-cached input (GPT-5.6+) — logs carry no write counts' }));
      }
    } else {
      g.appendChild(projTableRow('Cache write', fmtTok(m.cacheWrite), money(m.cCw, priced)));
    }
    table.appendChild(g);
  };

  table.appendChild(projTableRow('', 'tokens', 'cost', { cols: true }));
  for (const m of entries) {
    addGroup(
      projTableRow(prettyModel(m.provider, m.model), `${m.msgs.toLocaleString()} calls`, money(m.cost, m.priced),
        { head: true, dot: modelColor(m.provider, m.model), title: `${PROVIDERS[m.provider].label} · ${m.model}` }),
      m, m.priced, m.provider);
  }
  if (entries.length > 1) {
    addGroup(
      projTableRow('All models', `${p.msgs.toLocaleString()} calls`, fmtCost(p.cost), { head: true }),
      p, true, 'all');
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
  summary.innerHTML = `
    <span class="proj-chevron" aria-hidden="true">
      <svg viewBox="0 0 12 12"><path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="proj-name"></span>
    <span class="proj-cost">${fmtCost(p.cost)}</span>
    <span class="proj-bar" aria-hidden="true"><i style="--w:${((p.cost / max) * 100).toFixed(1)}%"></i></span>`;
  const nameEl = summary.querySelector('.proj-name');
  nameEl.textContent = name;
  nameEl.title = name;
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
  let [from, to] = rangeForPreset();
  const allDates = [...byDay.keys()].sort();
  if (from === '0000') from = allDates[0] || today();
  if (to === '9999') to = today();
  if (from > to) [from, to] = [to, from];

  const dayList = [];
  const cur = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  let guard = 0;
  while (cur <= end && guard++ < 1000) {
    dayList.push(dstr(cur));
    cur.setDate(cur.getDate() + 1);
  }

  // group into weeks when the range is long
  const groupByWeek = dayList.length > 70;
  let bins = [];
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

  $('chartNote').textContent = groupByWeek ? 'weekly' : 'daily';

  const padL = 4, padR = 4, padT = 8, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...bins.map((b) => b.total), 0.0001);
  const n = bins.length;
  const gap = n > 40 ? 1 : 3;
  const barW = Math.max(2, (plotW - gap * (n - 1)) / n);

  chartGeom = { bins, padL, barW, gap, W, H };

  // faint gridlines at 25 / 50 / 75 % and the baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = H - padB - plotH * f + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(W - padR, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(padL, H - padB + 0.5);
  ctx.lineTo(W - padR, H - padB + 0.5);
  ctx.stroke();

  // scale hint, top-right
  ctx.fillStyle = 'rgba(235,235,245,0.28)';
  ctx.font = '500 8.5px Inter, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(fmtCost(maxV), W - padR, padT + 2);

  bins.forEach((bin, i) => {
    const x = padL + i * (barW + gap);
    let y = H - padB;
    ctx.globalAlpha = hoverIdx >= 0 && i !== hoverIdx ? 0.35 : 1;
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
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x, H - padB - 1.5, barW, 1.5);
    }
    ctx.globalAlpha = 1;
  });

  // x labels: first, middle, last
  ctx.fillStyle = 'rgba(235,235,245,0.35)';
  ctx.font = '9px Inter, "Segoe UI", sans-serif';
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

  canvas.addEventListener('mousemove', (e) => {
    if (!chartGeom) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { bins, padL, barW, gap, W } = chartGeom;
    const i = Math.floor((x - padL) / (barW + gap));
    if (i < 0 || i >= bins.length) {
      tip.hidden = true;
      if (lastHover !== -1 && state.lastByDay) { lastHover = -1; renderChart(state.lastByDay, -1); }
      return;
    }
    if (i !== lastHover && state.lastByDay) {
      lastHover = i;
      renderChart(state.lastByDay, i); // focus: dim the other bars
    }
    const bin = bins[i];
    const sorted = [...bin.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let html = `<div class="tip-date">${bin.label}${bin.week ? ' · week' : ''}</div>`;
    html += `<div class="tip-row"><span>Total</span><b>${fmtCost(bin.total)}</b></div>`;
    for (const [mk, c] of sorted) {
      const [pv, model] = splitKey(mk);
      html += `<div class="tip-row"><span><span class="dot" style="background:${modelColor(pv, model)}"></span>${prettyModel(pv, model)}</span><b>${fmtCost(c)}</b></div>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let tx = padL + i * (barW + gap) + barW / 2 - tw / 2;
    tx = Math.max(0, Math.min(W - tw, tx));
    tip.style.left = tx + 'px';
    tip.style.top = '2px';
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
  if (d.five_hour) {
    rows.push({ name: 'Current session', sub: () => fmtCountdown(d.five_hour.resets_at), u: d.five_hour.utilization });
  }
  if (d.seven_day) {
    rows.push({ name: 'Weekly · all models', sub: () => fmtResetDay(d.seven_day.resets_at), u: d.seven_day.utilization });
  }
  for (const [key, label] of [['seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'Weekly · Sonnet']]) {
    const v = d[key];
    if (v && v.utilization != null && v.utilization > 0) {
      rows.push({ name: label, sub: () => fmtResetDay(v.resets_at), u: v.utilization });
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

  $('btnSettings').onclick = () => {
    $('setAutostart').checked = state.settings.launchAtStartup;
    $('setPin').checked = state.settings.alwaysOnTop;
    $('settingsOverlay').hidden = false;
  };
  $('btnSettingsClose').onclick = () => { $('settingsOverlay').hidden = true; };
  $('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').hidden = true; };
  $('setAutostart').onchange = (e) => window.api.setAutostart(e.target.checked);
  $('setPin').onchange = (e) => window.api.setPin(e.target.checked);

  for (const chip of document.querySelectorAll('#dateChips .chip')) {
    chip.onclick = () => {
      document.querySelectorAll('#dateChips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      moveSegThumb();
      state.preset = chip.dataset.range;
      $('customRange').hidden = state.preset !== 'custom';
      if (state.preset === 'custom') {
        if (!$('dateFrom').value) $('dateFrom').value = daysAgo(13);
        if (!$('dateTo').value) $('dateTo').value = today();
        state.customFrom = $('dateFrom').value;
        state.customTo = $('dateTo').value;
      }
      render();
    };
  }
  $('applyCustom').onclick = () => {
    state.customFrom = $('dateFrom').value || daysAgo(13);
    state.customTo = $('dateTo').value || today();
    render();
  };

  window.addEventListener('resize', () => {
    render();
    moveSegThumb();
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
    state.buckets = data.buckets;
    state.generatedAt = data.generatedAt;
    state.pricing = data.pricing;
    render();
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
  state.buckets = data.buckets;
  state.generatedAt = data.generatedAt;
  state.pricing = data.pricing;
  render();
  renderStatus();
  renderPricingStatus();
}

function renderPricingStatus() {
  const el = $('pricingStatus');
  if (!el) return;
  const p = state.pricing;
  if (p && p.live) {
    const hrs = Math.round((Date.now() - p.fetchedAt) / 3600000);
    const age = hrs < 1 ? 'just now' : hrs < 48 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} days ago`;
    el.textContent = `Known models use official bundled rates. New Codex-model fallback: ${p.source} (${p.models} models), updated ${age}.`;
  } else {
    el.textContent = 'Known models use official bundled rates. New Codex-model fallback unavailable — retrying hourly.';
  }
}

function updatePinButton() {
  $('btnPin').classList.toggle('on', !!state.settings.alwaysOnTop);
}

init();
