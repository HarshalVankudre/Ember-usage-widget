'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOpenAIModel } = require('../src/providers/model-attribution');
const { normalizeClaude, normalizeCodex } = require('../src/providers/normalize');

test('recognizes OpenAI model ids surfaced through compatibility gateways', () => {
  for (const model of [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'ChatGPT-4o',
    'chat-latest',
    'codex-mini',
    'o3',
    'O4-mini',
  ]) {
    assert.equal(isOpenAIModel(model), true, model);
  }
});

test('does not reattribute Anthropic or custom provider ids', () => {
  for (const model of [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'fugu-ultra',
    'nexus-gpt-5-6-sol',
    '',
    null,
  ]) {
    assert.equal(isOpenAIModel(model), false, String(model));
  }
});

test('reattributes Claude Code gateway usage to Codex pricing', () => {
  const normalized = normalizeClaude({
    date: '2026-07-13', hour: 16, model: 'gpt-5.6-sol',
    project: 'Desktop/Saas/claudex', session: 'claude-session', msgs: 2,
    input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000,
    cacheW5m: 0, cacheW1h: 0, projectDeleted: false,
    cost: 65.5, costMin: 65.5, costMax: 65.5,
    cIn: 10, cOut: 45, cCr: 1, cCw: 0, cTool: 0,
    cacheSavings: 9, priced: true, pricedCalls: 2, unpricedCalls: 0,
    longContextCalls: 2, pricingSource: 'OpenAI pricing (bundled)',
  });

  assert.equal(normalized.provider, 'codex');
  assert.equal(normalized.input, 1_000_000);
  assert.equal(normalized.cacheRead, 1_000_000);
  assert.equal(normalized.cacheWrite, 0);
  assert.equal(normalized.cIn, 10);
  assert.equal(normalized.cOut, 45);
  assert.equal(normalized.cCr, 1);
  assert.equal(normalized.cCw, 0);
  assert.equal(normalized.cost, 65.5);
  assert.equal(normalized.priced, true);
});

test('gateway and native Codex buckets share one provider-model key', () => {
  const gateway = normalizeClaude({
    date: '2026-07-13', hour: 16, model: 'gpt-5.6-terra',
    project: 'Desktop/Saas/claudex', session: 'claude-session', msgs: 1,
    input: 100, output: 20, cacheRead: 50, cacheW5m: 0, cacheW1h: 0,
    cost: 0.001, costMin: 0.001, costMax: 0.001,
    cIn: 0.00025, cOut: 0.0003, cCr: 0.0000125, cCw: 0,
    cacheSavings: 0, priced: true, pricedCalls: 1, unpricedCalls: 0,
    projectDeleted: false,
  });
  const native = normalizeCodex({
    date: '2026-07-13', hour: 16, model: 'gpt-5.6-terra',
    project: '~ (home)', session: 'codex-session', msgs: 1,
    input: 100, output: 20, cached: 50, cacheWrite: 0, reasoning: 5,
    cost: 0, cIn: 0, cOut: 0, cCached: 0, cWrite: 0, cReasoning: 0,
    cacheSavings: 0, priced: true, projectDeleted: false,
  });

  assert.equal(`${gateway.provider}|${gateway.model}`, `${native.provider}|${native.model}`);
});
