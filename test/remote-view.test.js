'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { badge } = require('../src/renderer/remote-view');

const NOW = 1_800_000_000_000;
const src = (over) => ({ name: 'vps', host: 'me@host', enabled: true, included: true, ok: true, atMs: NOW - 20_000, error: null, ...over });

test('a recent successful sync is green', () => {
  const b = badge(src(), NOW, 60_000);
  assert.equal(b.tone, 'ok');
  assert.match(b.title, /connected, synced 20s ago/);
});

test('a failed sync is red and says why', () => {
  const b = badge(src({ ok: false, error: 'Permission denied (publickey)' }), NOW, 60_000);
  assert.equal(b.tone, 'bad');
  assert.match(b.title, /Permission denied/);
});

test('no attempt yet is amber, and so is an old success', () => {
  assert.equal(badge(src({ ok: null, atMs: null }), NOW, 60_000).status, 'connecting');
  assert.equal(badge(src({ atMs: NOW - 6 * 60_000 }), NOW, 60_000).status, 'stale');
  assert.equal(badge(src({ atMs: NOW - 4 * 60_000 }), NOW, 60_000).status, 'connected');
});

test('a paused server is grey whatever its last result', () => {
  assert.equal(badge(src({ enabled: false, ok: false }), NOW, 60_000).tone, 'off');
});

test('a server switched out of the totals says so, and its light still shows the connection', () => {
  const on = badge(src(), NOW, 60_000);
  assert.equal(on.included, true);
  assert.match(on.title, /click to leave it out/);
  const off = badge(src({ included: false }), NOW, 60_000);
  assert.equal(off.included, false);
  assert.equal(off.tone, 'ok');
  assert.match(off.title, /Left out of the totals; click to count it again/);
});

test('an older backend without the flag counts as included', () => {
  assert.equal(badge(src({ included: undefined }), NOW, 60_000).included, true);
});
