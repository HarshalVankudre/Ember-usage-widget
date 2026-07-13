'use strict';

// USD per million tokens. The bundled table mirrors Anthropic's standard API
// table and is superseded by the daily official-doc refresh when available.
const PRICING_RULES = [
  { test: /(?:fable-5|mythos-5)/, input: 10, cacheW5m: 12.5, cacheW1h: 20, cacheRead: 1, output: 50, family: 'fable' },
  { test: /opus-4-[5-9]/, input: 5, cacheW5m: 6.25, cacheW1h: 10, cacheRead: 0.5, output: 25, family: 'opus' },
  { test: /opus/, input: 15, cacheW5m: 18.75, cacheW1h: 30, cacheRead: 1.5, output: 75, family: 'opus' },
  {
    test: /sonnet-5/,
    input: 3, cacheW5m: 3.75, cacheW1h: 6, cacheRead: 0.3, output: 15,
    introUntil: '2026-09-01',
    intro: { input: 2, cacheW5m: 2.5, cacheW1h: 4, cacheRead: 0.2, output: 10 },
    family: 'sonnet',
  },
  { test: /sonnet/, input: 3, cacheW5m: 3.75, cacheW1h: 6, cacheRead: 0.3, output: 15, family: 'sonnet' },
  { test: /haiku-4/, input: 1, cacheW5m: 1.25, cacheW1h: 2, cacheRead: 0.1, output: 5, family: 'haiku' },
  { test: /(?:3-5-haiku|haiku-3-5)/, input: 0.8, cacheW5m: 1, cacheW1h: 1.6, cacheRead: 0.08, output: 4, family: 'haiku' },
  { test: /haiku/, input: 0.25, cacheW5m: 0.3, cacheW1h: 0.5, cacheRead: 0.03, output: 1.25, family: 'haiku' },
];

let livePrices = null;

function canonicalModel(model) {
  const m = String(model || '').toLowerCase().replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const legacy = m.match(/^(\d+)-(\d+)-(fable|mythos|opus|sonnet|haiku)(?:-|$)/);
  if (legacy) return `${legacy[3]}-${legacy[1]}-${legacy[2]}`;
  const hit = m.match(/(fable|mythos|opus|sonnet|haiku)[-.]?(\d+)(?:[-.]?(\d+))?/);
  if (!hit) return m;
  return `${hit[1]}-${hit[2]}${hit[3] ? `-${hit[3]}` : ''}`;
}

function bundledRuleFor(model) {
  for (const rule of PRICING_RULES) {
    rule.test.lastIndex = 0;
    if (rule.test.test(model)) return rule;
  }
  return null;
}

function setLivePrices(map) {
  if (map && Object.keys(map).length) livePrices = map;
}

function priceFor(model, usageDate) {
  const canonical = canonicalModel(model);
  const date = usageDate || new Date().toISOString().slice(0, 10);
  const bundled = bundledRuleFor(canonical);
  let live = livePrices && livePrices[canonical];
  if (canonical === 'sonnet-5' && livePrices) {
    live = date < '2026-09-01' ? livePrices['sonnet-5@intro'] : livePrices['sonnet-5@standard'];
  }
  if (live) {
    return { ...bundled, ...live, family: (bundled && bundled.family) || live.family || 'other', source: 'Anthropic pricing (live)', official: true };
  }
  if (!bundled) return null;
  if (bundled.introUntil && date < bundled.introUntil) {
    return { ...bundled, ...bundled.intro, source: 'Anthropic pricing (bundled)', official: true };
  }
  return { ...bundled, source: 'Anthropic pricing (bundled)', official: true };
}

function supportsUsGeo(model) {
  const m = canonicalModel(model);
  return /^(?:fable-5|mythos-5|opus-4-[6-9]|sonnet-5|sonnet-4-[6-9])$/.test(m);
}

function fastRates(model) {
  const m = canonicalModel(model);
  if (m === 'opus-4-8') return { input: 10, output: 50 };
  if (m === 'opus-4-7') return { input: 30, output: 150 };
  return null;
}

// usage: { input, output, cacheRead, cacheW5m, cacheW1h, speed,
// inferenceGeo, webSearches }. Thinking tokens are already included in output.
function costOf(model, usage = {}) {
  let p = priceFor(model, usage.date);
  if (!p) return { total: 0, costMin: 0, costMax: 0, known: false, reason: 'unknown-model', source: 'No official price' };

  const speed = String(usage.speed || 'standard').toLowerCase();
  let fast = false;
  if (speed === 'fast') {
    const rates = fastRates(model);
    if (rates) {
      p = {
        ...p,
        input: rates.input,
        output: rates.output,
        cacheRead: rates.input * 0.1,
        cacheW5m: rates.input * 1.25,
        cacheW1h: rates.input * 2,
      };
      fast = true;
    }
    // Opus 4.6 reports fast in some logs but is explicitly billed standard.
  }

  const geo = String(usage.inferenceGeo || '').toLowerCase();
  const geoMultiplier = geo === 'us' && supportsUsGeo(model) ? 1.1 : 1;
  const M = 1e6;
  const input = ((Math.max(0, Number(usage.input) || 0)) / M) * p.input * geoMultiplier;
  const output = ((Math.max(0, Number(usage.output) || 0)) / M) * p.output * geoMultiplier;
  const cacheRead = ((Math.max(0, Number(usage.cacheRead) || 0)) / M) * p.cacheRead * geoMultiplier;
  const cacheWrite =
    ((Math.max(0, Number(usage.cacheW5m) || 0)) / M) * p.cacheW5m * geoMultiplier +
    ((Math.max(0, Number(usage.cacheW1h) || 0)) / M) * p.cacheW1h * geoMultiplier;
  const webSearches = Math.max(0, Number(usage.webSearches) || 0);
  const toolFee = webSearches * 0.01; // $10 / 1,000 searches
  const total = input + output + cacheRead + cacheWrite + toolFee;
  const cacheSavings = ((Math.max(0, Number(usage.cacheRead) || 0)) / M) * Math.max(0, p.input - p.cacheRead) * geoMultiplier;
  return {
    total,
    costMin: total,
    costMax: total,
    input,
    output,
    cacheRead,
    cacheWrite,
    toolFee,
    cacheSavings,
    known: true,
    estimated: false,
    fast,
    usRegion: geoMultiplier > 1,
    source: p.source,
    official: true,
  };
}

function familyOf(model) {
  const p = priceFor(model);
  return p ? p.family : 'other';
}

module.exports = { canonicalModel, costOf, familyOf, priceFor, setLivePrices };
