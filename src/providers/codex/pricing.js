'use strict';

// USD per million tokens from OpenAI's standard API pricing table.
// Specific and intentionally-unpriced models must precede broad families.
const PRICING_RULES = [
  { test: /^gpt-5\.3-codex-spark(?:-|$)/, unpriced: true, family: 'codex' },
  { test: /^chatgpt-4o-latest(?:-|$)/, input: 5, cached: 5, output: 15, family: 'gpt4' },
  { test: /^chat-latest(?:-|$)/, input: 5, cached: 0.5, output: 30, family: 'gpt5' },

  { test: /^gpt-5\.6-terra(?:-|$)/, input: 2.5, cached: 0.25, write: 3.125, output: 15, longContext: true, family: 'gpt5' },
  { test: /^gpt-5\.6-luna(?:-|$)/, input: 1, cached: 0.1, write: 1.25, output: 6, longContext: true, family: 'gpt5' },
  { test: /^gpt-5\.6(?:-sol)?(?:-|$)/, input: 5, cached: 0.5, write: 6.25, output: 30, longContext: true, family: 'gpt5' },
  { test: /^gpt-5\.5-pro(?:-|$)/, input: 30, cached: 30, output: 180, longContext: true, family: 'pro' },
  { test: /^gpt-5\.5(?:-|$)/, input: 5, cached: 0.5, output: 30, longContext: true, family: 'gpt5' },
  { test: /^gpt-5\.4-pro(?:-|$)/, input: 30, cached: 30, output: 180, longContext: true, family: 'pro' },
  { test: /^gpt-5\.4-mini(?:-|$)/, input: 0.75, cached: 0.075, output: 4.5, family: 'mini' },
  { test: /^gpt-5\.4-nano(?:-|$)/, input: 0.2, cached: 0.02, output: 1.25, family: 'nano' },
  { test: /^gpt-5\.4(?:-|$)/, input: 2.5, cached: 0.25, output: 15, longContext: true, family: 'gpt5' },
  { test: /^gpt-5\.2-pro(?:-|$)/, input: 21, cached: 21, output: 168, family: 'pro' },
  { test: /^gpt-5\.2(?:-|$)/, input: 1.75, cached: 0.175, output: 14, family: 'gpt5' },
  { test: /^gpt-5(?:\.1)?-pro(?:-|$)/, input: 15, cached: 15, output: 120, family: 'pro' },
  { test: /^gpt-5(?:\.1)?-mini(?:-|$)/, input: 0.25, cached: 0.025, output: 2, family: 'mini' },
  { test: /^gpt-5(?:\.1)?-nano(?:-|$)/, input: 0.05, cached: 0.005, output: 0.4, family: 'nano' },
  { test: /^gpt-5(?:\.1)?(?:-|$)/, input: 1.25, cached: 0.125, output: 10, family: 'gpt5' },
  { test: /^codex-mini(?:-latest)?(?:-|$)/, input: 1.5, cached: 0.375, output: 6, family: 'mini' },

  { test: /^gpt-4\.1-nano(?:-|$)/, input: 0.1, cached: 0.025, output: 0.4, family: 'nano' },
  { test: /^gpt-4\.1-mini(?:-|$)/, input: 0.4, cached: 0.1, output: 1.6, family: 'mini' },
  { test: /^gpt-4\.1(?:-|$)/, input: 2, cached: 0.5, output: 8, family: 'gpt4' },
  { test: /^gpt-4o-mini(?:-|$)/, input: 0.15, cached: 0.075, output: 0.6, family: 'mini' },
  { test: /^gpt-4o-2024-05-13$/, input: 5, cached: 5, output: 15, family: 'gpt4' },
  { test: /^gpt-4o(?:-|$)/, input: 2.5, cached: 1.25, output: 10, family: 'gpt4' },

  { test: /^o1-pro(?:-|$)/, input: 150, cached: 150, output: 600, family: 'pro' },
  { test: /^o1-mini(?:-|$)/, input: 1.1, cached: 0.55, output: 4.4, family: 'o' },
  { test: /^o1-preview(?:-|$)/, input: 15, cached: 7.5, output: 60, family: 'o' },
  { test: /^o1(?:-|$)/, input: 15, cached: 7.5, output: 60, family: 'o' },
  { test: /^o3-pro(?:-|$)/, input: 20, cached: 20, output: 80, family: 'pro' },
  { test: /^o3-mini(?:-|$)/, input: 1.1, cached: 0.55, output: 4.4, family: 'o' },
  { test: /^o3(?:-|$)/, input: 2, cached: 0.5, output: 8, family: 'o' },
  { test: /^o4-mini(?:-|$)/, input: 1.1, cached: 0.275, output: 4.4, family: 'o' },
];

const LONG_CONTEXT_THRESHOLD = 272_000;
let livePrices = null;

function bundledRuleFor(model) {
  for (const rule of PRICING_RULES) {
    rule.test.lastIndex = 0;
    if (rule.test.test(model)) return rule;
  }
  return null;
}

function liveRuleFor(model) {
  if (!livePrices) return null;
  return livePrices[model] || livePrices[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')] || null;
}

function setLivePrices(map) {
  if (map && Object.keys(map).length) livePrices = map;
}

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  const bundled = bundledRuleFor(m);
  const live = liveRuleFor(m);
  if (live) {
    return {
      ...bundled,
      ...live,
      family: (bundled && bundled.family) || live.family || 'other',
      longContext: !!((bundled && bundled.longContext) || live.longContext),
      source: 'OpenAI pricing (live)',
      official: true,
    };
  }
  if (!bundled) return null;
  return { ...bundled, source: 'OpenAI pricing (bundled)', official: true };
}

// Unified OpenAI usage semantics:
// input = ordinary, non-cached input; cached = cache reads; cacheWrite =
// measured cache-write tokens when available. Current Codex token_count logs
// omit writes, so those calls carry a transparent min/max range and use the
// conservative upper estimate (all new input was written to cache).
function costOf(model, usage = {}) {
  const p = priceFor(model);
  if (!p || p.unpriced) {
    return {
      total: 0,
      costMin: 0,
      costMax: 0,
      known: false,
      estimated: false,
      reason: p && p.unpriced ? 'unpublished-price' : 'unknown-model',
      source: p ? p.source : 'No official price',
    };
  }

  const M = 1e6;
  const inputTokens = Math.max(0, Number(usage.input) || 0);
  const outputTokens = Math.max(0, Number(usage.output) || 0);
  const cachedTokens = Math.max(0, Number(usage.cached) || 0);
  const writeTokens = Math.max(0, Number(usage.cacheWrite) || 0);
  const writeKnown = usage.cacheWriteKnown === true;
  const totalInput = Math.max(
    0,
    Number(usage.totalInput) || inputTokens + cachedTokens + writeTokens
  );

  // OpenAI applies this per request to the whole request, not only the slice
  // beyond the threshold. Current Codex contexts are capped below the tier;
  // historical logs can still contain pre-cap requests above it.
  const longContext = !!p.longContext && totalInput > LONG_CONTEXT_THRESHOLD;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputRate = p.input * inputMultiplier;
  const cachedRate = p.cached * inputMultiplier;
  const writeRate = (p.write || p.input) * inputMultiplier;
  const outputRate = p.output * outputMultiplier;

  const input = (inputTokens / M) * inputRate;
  const output = (outputTokens / M) * outputRate;
  const cached = (cachedTokens / M) * cachedRate;
  const reasoning = ((Math.max(0, Number(usage.reasoning) || 0)) / M) * outputRate;
  const measuredWrite = (writeTokens / M) * writeRate;
  const base = input + output + cached + measuredWrite;

  let cacheWrite = measuredWrite;
  let costMin = base;
  let costMax = base;
  let estimated = false;
  if (p.write && !writeKnown) {
    // Input already carries the normal input charge; only add the uncertain
    // premium required to bring a possible write up to the write rate.
    const possiblePremium = (inputTokens / M) * Math.max(0, writeRate - inputRate);
    cacheWrite = possiblePremium;
    costMax += possiblePremium;
    estimated = possiblePremium > 0;
  }

  const total = costMax;
  const cacheSavings = (cachedTokens / M) * Math.max(0, inputRate - cachedRate);
  return {
    total,
    costMin,
    costMax,
    input,
    output,
    cached,
    reasoning,
    cacheWrite,
    cacheSavings,
    known: true,
    estimated,
    longContext,
    source: p.source,
    official: true,
  };
}

function familyOf(model) {
  const p = priceFor(model);
  return p ? p.family : 'other';
}

module.exports = {
  LONG_CONTEXT_THRESHOLD,
  costOf,
  familyOf,
  priceFor,
  setLivePrices,
};
