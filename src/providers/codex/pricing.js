'use strict';

// USD per million tokens — official OpenAI API list prices.
// `cached` is the discounted rate for cached input (prompt-cache hits);
// reasoning tokens are billed as part of output, so they carry no own rate.
// Rules are checked in order — keep the more specific patterns first.
const PRICING_RULES = [
  { test: /gpt-5\.5.*pro/, input: 30, cached: 30, output: 180, family: 'pro' },
  { test: /gpt-5\.4.*pro/, input: 30, cached: 30, output: 180, family: 'pro' },
  { test: /gpt-5\.2.*pro/, input: 21, cached: 21, output: 168, family: 'pro' },
  { test: /gpt-5.*pro/, input: 15, cached: 15, output: 120, family: 'pro' },
  // GPT-5.6 family (July 2026): Sol / Terra / Luna tiers. `write` is the
  // cache-write rate (1.25x input on 5.6+); logs don't report write
  // counts, so costOf estimates writes as all non-cached input.
  { test: /gpt-5\.6.*sol/, input: 5, cached: 0.5, output: 30, write: 6.25, family: 'gpt5' },
  { test: /gpt-5\.6.*terra/, input: 2.5, cached: 0.25, output: 15, write: 3.125, family: 'gpt5' },
  { test: /gpt-5\.6.*luna/, input: 1, cached: 0.1, output: 6, write: 1.25, family: 'gpt5' },
  { test: /gpt-5\.5/, input: 5, cached: 0.5, output: 30, family: 'gpt5' },
  { test: /gpt-5\.4.*mini/, input: 0.75, cached: 0.075, output: 4.5, family: 'mini' },
  { test: /gpt-5\.4.*nano/, input: 0.2, cached: 0.02, output: 1.25, family: 'nano' },
  { test: /gpt-5\.4/, input: 2.5, cached: 0.25, output: 15, family: 'gpt5' },
  { test: /gpt-5\.3.*codex/, input: 1.75, cached: 0.175, output: 14, family: 'gpt5' },
  { test: /gpt-5\.2/, input: 1.75, cached: 0.175, output: 14, family: 'gpt5' },
  { test: /gpt-5.*mini/, input: 0.25, cached: 0.025, output: 2, family: 'mini' },
  { test: /gpt-5.*nano/, input: 0.05, cached: 0.005, output: 0.4, family: 'nano' },
  { test: /gpt-5/, input: 1.25, cached: 0.125, output: 10, family: 'gpt5' }, // gpt-5 / older aliases
  { test: /codex-mini/, input: 1.5, cached: 0.375, output: 6, family: 'mini' },
  { test: /gpt-4\.1-mini/, input: 0.4, cached: 0.1, output: 1.6, family: 'gpt4' },
  { test: /gpt-4\.1/, input: 2, cached: 0.5, output: 8, family: 'gpt4' },
  { test: /gpt-4o-mini/, input: 0.15, cached: 0.075, output: 0.6, family: 'gpt4' },
  { test: /gpt-4o/, input: 2.5, cached: 1.25, output: 10, family: 'gpt4' },
  { test: /o3-pro/, input: 20, cached: 20, output: 80, family: 'o' },
  { test: /o4-mini/, input: 1.1, cached: 0.275, output: 4.4, family: 'o' },
  { test: /o3/, input: 2, cached: 0.5, output: 8, family: 'o' },
];

// Live prices (fetched daily from OpenRouter, see pricing-live.js) are a
// fallback for unknown models; known models always use the official table.
let livePrices = null; // lowercased model name -> { input, cached, output, family }

function ruleFor(m) {
  for (const rule of PRICING_RULES) {
    if (rule.test.test(m)) return rule;
  }
  return null;
}

function setLivePrices(map) {
  if (!map || !Object.keys(map).length) return;
  for (const [name, p] of Object.entries(map)) {
    const rule = ruleFor(name);
    p.family = rule ? rule.family : 'other';
    // Feed had no cache-read rate: trust the static table's discount if we
    // have one (never above the live input price), else bill cache at input.
    if (!(p.cached > 0)) p.cached = rule ? Math.min(rule.cached, p.input) : p.input;
    // Feed had no cache-write rate: carry over the static rule's write
    // multiplier (e.g. 1.25x for gpt-5.6) scaled to the live input price.
    if (!(p.write > 0) && rule && rule.write) p.write = p.input * (rule.write / rule.input);
  }
  livePrices = map;
}

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  // Known models use the bundled official OpenAI rates. The live third-party
  // feed is only a fallback for newly seen models until the table is updated.
  const official = ruleFor(m);
  if (official) return official;
  if (livePrices) {
    // exact name first, then without a trailing date stamp (gpt-x-2026-06-25)
    const hit = livePrices[m] || livePrices[m.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
    if (hit) return hit;
  }
  return null;
}

// usage: { input, output, cached, reasoning } — raw token counts, `input`
// already excludes the cached portion (Codex reports cached as a subset of
// input) and `reasoning` is a subset of `output` (verified against rollout
// logs: total_tokens == input + output, reasoning never exceeds output).
function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return { total: 0, known: false };
  const M = 1e6;
  const input = (u.input / M) * p.input;
  const output = (u.output / M) * p.output;
  const cached = (u.cached / M) * p.cached;
  // The slice of `output` that reasoning tokens account for — already inside
  // `output`, so it must never be added to `total`.
  const reasoning = ((u.reasoning || 0) / M) * p.output;
  // Cache-write surcharge (models with a `write` rate, e.g. 1.25x input on
  // GPT-5.6+). Logs carry no write counts; in agentic sessions every
  // non-cached input token extends the cached prefix, so writes ≈ `input`.
  const cacheWrite = p.write ? (u.input / M) * (p.write - p.input) : 0;
  // What the cached tokens would have cost at the full input rate
  const cacheSavings = (u.cached / M) * (p.input - p.cached);
  return {
    total: input + output + cached + cacheWrite,
    input, output, cached, reasoning, cacheWrite, cacheSavings, known: true,
  };
}

function familyOf(model) {
  const p = priceFor(model);
  return p ? p.family : 'other';
}

module.exports = { costOf, familyOf, priceFor, setLivePrices };
