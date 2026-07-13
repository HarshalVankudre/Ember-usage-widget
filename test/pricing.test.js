'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codex = require('../src/providers/codex/pricing');
const claude = require('../src/providers/claude/pricing');
const openAiLive = require('../src/providers/codex/pricing-live');
const anthropicLive = require('../src/providers/claude/pricing-live');

const close = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test('uses specific OpenAI rates before broad model-family matches', () => {
  assert.equal(codex.priceFor('gpt-5.6-terra').input, 2.5);
  assert.equal(codex.priceFor('gpt-5.6-luna').output, 6);
  assert.equal(codex.priceFor('chatgpt-4o-latest').input, 5);
  assert.equal(codex.priceFor('gpt-4.1-nano').input, 0.1);
});

test('does not invent a public API price for Codex Spark', () => {
  const c = codex.costOf('gpt-5.3-codex-spark', { input: 1_000, output: 100 });
  assert.equal(c.known, false);
  assert.equal(c.reason, 'unpublished-price');
  assert.equal(c.total, 0);
});

test('applies historical OpenAI long-context rates per request', () => {
  const atCap = codex.costOf('gpt-5.6-sol', {
    input: 272_000, output: 10_000, cacheWrite: 0, cacheWriteKnown: true, totalInput: 272_000,
  });
  close(atCap.total, 1.66);
  assert.equal(atCap.longContext, false);

  const above = codex.costOf('gpt-5.6-sol', {
    input: 272_001, output: 10_000, cacheWrite: 0, cacheWriteKnown: true, totalInput: 272_001,
  });
  close(above.total, 3.17001);
  assert.equal(above.longContext, true);
});

test('makes missing OpenAI cache writes an explicit bounded estimate', () => {
  const unknown = codex.costOf('gpt-5.6-sol', { input: 100_000, output: 0, cached: 0 });
  close(unknown.costMin, 0.5);
  close(unknown.costMax, 0.625);
  close(unknown.total, 0.625);
  assert.equal(unknown.estimated, true);

  const measured = codex.costOf('gpt-5.6-sol', {
    input: 80_000, cacheWrite: 20_000, cacheWriteKnown: true, output: 0, cached: 0,
  });
  close(measured.total, 0.525);
  assert.equal(measured.estimated, false);
});

test('parses the first official OpenAI standard-price rows', () => {
  const map = openAiLive.buildMap(`
    ["gpt-5.6-sol", 5, 0.5, 6.25, 30],
    ["gpt-5.5 (<272K context length)", 5, 0.5, "-", 30],
    ["chatgpt-4o-latest", 5, "-", 15],
    ["gpt-5.6-sol", 2.5, 0.25, 15],
  `);
  assert.deepEqual(map['gpt-5.6-sol'], { input: 5, cached: 0.5, write: 6.25, output: 30 });
  assert.deepEqual(map['gpt-5.5'], { input: 5, cached: 0.5, write: undefined, output: 30 });
  assert.equal(map['chatgpt-4o-latest'].cached, 5);
});

test('prices Claude introductory, fast, regional, and server-tool usage', () => {
  const intro = claude.costOf('claude-sonnet-5', { date: '2026-08-31', input: 1_000_000, output: 1_000_000 });
  close(intro.total, 12);
  const standard = claude.costOf('claude-sonnet-5', { date: '2026-09-01', input: 1_000_000, output: 1_000_000 });
  close(standard.total, 18);

  const fastUs = claude.costOf('claude-opus-4-8', {
    input: 1_000_000, output: 1_000_000, cacheRead: 100_000,
    speed: 'fast', inferenceGeo: 'us', webSearches: 2,
  });
  close(fastUs.total, 66.13);
  assert.equal(fastUs.fast, true);
  assert.equal(fastUs.usRegion, true);
});

test('parses Anthropic official model-price table rows', () => {
  const map = anthropicLive.buildMap(`
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5 [through August 31, 2026](x) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
  `);
  assert.equal(map['opus-4-8'].output, 25);
  assert.equal(map['sonnet-5@intro'].input, 2);
  assert.equal(map['sonnet-5@standard'].output, 15);
});
