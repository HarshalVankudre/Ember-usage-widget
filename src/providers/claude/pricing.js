'use strict';

// USD per million tokens. Cache multipliers apply to the input price:
//   cache read = 0.1x, 5-minute cache write = 1.25x, 1-hour cache write = 2x.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

const PRICING_RULES = [
  { test: /fable-5|mythos/, input: 10, output: 50, family: 'fable' },
  { test: /opus-4-[5-9]/, input: 5, output: 25, family: 'opus' },
  { test: /opus/, input: 15, output: 75, family: 'opus' }, // Opus 4.1/4.0/3
  // Introductory pricing is applied to each usage day's date so historical
  // costs remain correct after the standard rate begins on September 1, 2026.
  { test: /sonnet-5/, input: 3, output: 15, introUntil: '2026-09-01', introInput: 2, introOutput: 10, family: 'sonnet' },
  { test: /sonnet/, input: 3, output: 15, family: 'sonnet' },
  { test: /haiku-4/, input: 1, output: 5, family: 'haiku' },
  { test: /3-5-haiku/, input: 0.8, output: 4, family: 'haiku' },
  { test: /haiku/, input: 0.25, output: 1.25, family: 'haiku' },
];

function priceFor(model, usageDate) {
  const m = String(model || '').toLowerCase();
  for (const rule of PRICING_RULES) {
    if (!rule.test.test(m)) continue;
    const date = usageDate || new Date().toISOString().slice(0, 10);
    if (rule.introUntil && date < rule.introUntil) {
      return { ...rule, input: rule.introInput, output: rule.introOutput };
    }
    return rule;
  }
  return null;
}

// usage: { input, output, cacheRead, cacheW5m, cacheW1h } (raw token counts)
function costOf(model, u) {
  const p = priceFor(model, u && u.date);
  if (!p) return { total: 0, known: false };
  const M = 1e6;
  const input = (u.input / M) * p.input;
  const output = (u.output / M) * p.output;
  const cacheRead = (u.cacheRead / M) * p.input * CACHE_READ_MULT;
  const cacheWrite =
    (u.cacheW5m / M) * p.input * CACHE_WRITE_5M_MULT +
    (u.cacheW1h / M) * p.input * CACHE_WRITE_1H_MULT;
  // What the cached reads would have cost at the full input rate
  const cacheSavings = (u.cacheRead / M) * p.input * (1 - CACHE_READ_MULT);
  return { total: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite, cacheSavings, known: true };
}

function familyOf(model) {
  const p = priceFor(model);
  return p ? p.family : 'other';
}

module.exports = { costOf, familyOf, priceFor };
