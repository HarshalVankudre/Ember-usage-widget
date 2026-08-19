'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileModelSelection } = require('../src/renderer/filter-state');

test('provider changes discard model filters that are no longer visible', () => {
  const selected = new Set(['codex|gpt-5.6-sol']);
  const visible = ['claude|claude-sonnet-5', 'claude|claude-opus-5'];
  assert.deepEqual([...reconcileModelSelection(selected, visible)], []);
});

test('provider changes preserve model filters that remain visible', () => {
  const selected = new Set(['codex|gpt-5.6-sol', 'claude|claude-opus-5']);
  const visible = ['claude|claude-sonnet-5', 'claude|claude-opus-5'];
  assert.deepEqual([...reconcileModelSelection(selected, visible)], ['claude|claude-opus-5']);
});

test('selecting every visible model canonicalizes back to all models', () => {
  const visible = ['codex|gpt-5.6-sol', 'codex|o4-mini'];
  assert.deepEqual([...reconcileModelSelection(new Set(visible), visible)], []);
});
