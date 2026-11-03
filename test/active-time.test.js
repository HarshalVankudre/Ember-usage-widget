'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fmtDuration } = require('../src/renderer/active-time');

test('no finished turns reads as a dash, not zero', () => {
  assert.equal(fmtDuration(0), '—');
  assert.equal(fmtDuration(undefined), '—');
  assert.equal(fmtDuration(400), '—');
});

test('short turns read in seconds', () => {
  assert.equal(fmtDuration(1000), '1s');
  assert.equal(fmtDuration(45_400), '45s');
});

test('minutes keep their seconds, like the agent status line', () => {
  assert.equal(fmtDuration(60_000), '1m');
  assert.equal(fmtDuration(445_000), '7m 25s');
  assert.equal(fmtDuration(495_000), '8m 15s');
});

test('hours drop the seconds', () => {
  assert.equal(fmtDuration(3_600_000), '1h');
  assert.equal(fmtDuration((3 * 3600 + 12 * 60 + 40) * 1000), '3h 12m');
  assert.equal(fmtDuration(125 * 3_600_000), '125h');
});
