'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describePricingConfidence } = require('../src/renderer/pricing-confidence');

test('explains unpriced calls without implying they were removed from usage', () => {
  const copy = describePricingConfidence({
    msgs: 36,
    pricedCalls: 8,
    unpricedCalls: 28,
    pricedTokens: 783_000,
    unpricedTokens: 777_000,
    estimated: false,
  }, [
    { model: 'gpt-5.3-codex-spark', unpricedCalls: 28 },
    { model: 'claude-fable-5', unpricedCalls: 0 },
  ]);

  assert.equal(copy.tone, 'partial');
  assert.equal(copy.summary, '50.2% of tokens priced · 28 calls unpriced');
  assert.doesNotMatch(copy.summary, /excluded/i);
  assert.match(copy.title, /gpt-5\.3-codex-spark \(28 calls\)/);
  assert.match(copy.title, /Calls and tokens remain in usage totals; only their dollar value is omitted/);
});

test('retains the complete and estimated pricing states', () => {
  assert.equal(describePricingConfidence({ msgs: 1, unpricedCalls: 0, estimated: false }).tone, 'complete');
  assert.equal(describePricingConfidence({ msgs: 1, unpricedCalls: 0, estimated: true }).tone, 'estimated');
  assert.equal(describePricingConfidence({ msgs: 0, unpricedCalls: 0, estimated: false }).summary, 'No usage in this view');
});
