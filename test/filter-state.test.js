'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileModelSelection } = require('../src/renderer/filter-state');
const { archiveCutoff, isArchivedModel } = require('../src/renderer/filter-state');

test('archive age uses calendar months with a strict release-date boundary', () => {
  const cutoff = archiveCutoff(new Date(2026, 10, 3));
  assert.equal(cutoff, '2026-09-03');
  assert.equal(isArchivedModel('gpt-6-astra', cutoff), false);
  assert.equal(isArchivedModel('claude-mythos-5-1', cutoff), true);
  assert.equal(isArchivedModel('gpt-6.1-sol', cutoff), false);
  assert.equal(archiveCutoff(new Date(2026, 3, 30)), '2026-02-28');
  assert.equal(archiveCutoff(new Date(2028, 3, 30)), '2028-02-29');
});

test('Fable 5.1 stays selectable regardless of age without retaining Fable 5', () => {
  for (const model of ['claude-fable-5-1', 'claude-fable-5-1-latest',
    'claude-fable-5-1-20260901', 'claude-fable-5-1-2026-09-01']) {
    assert.equal(isArchivedModel(model, '2027-09-03'), false, model);
  }
  assert.equal(isArchivedModel('claude-fable-5', '2026-09-03'), true);
  assert.equal(isArchivedModel('claude-mythos-5-1', '2026-09-03'), true);
});

test('old releases archive regardless of recent use and variant suffixes', () => {
  for (const model of ['gpt-5.6-sol-fast', 'gpt-5.6-sol-pro', 'gpt-5.3-codex-spark',
    'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']) {
    assert.equal(isArchivedModel(model, '2026-09-03'), true, model);
  }
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5',
    'gpt-6-luna', 'gpt-6.1-terra', 'future-model', 'gpt-7']) {
    assert.equal(isArchivedModel(model, '2026-09-03'), false, model);
  }
});

test('dated snapshots age independently and archived selections reset to all', () => {
  assert.equal(isArchivedModel('gpt-5.6-sol-2026-10-01', '2026-09-03'), false);
  const models = ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-luna'];
  const visible = models.filter((m) => !isArchivedModel(m, '2026-09-03')).map((m) => `codex|${m}`);
  assert.deepEqual([...reconcileModelSelection(new Set(['codex|gpt-5.6-sol']), visible)], []);
});

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
