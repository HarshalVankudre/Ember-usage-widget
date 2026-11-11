'use strict';

// The titlebar pill for each server Ember pulls Claude Code usage from
// (remote-sources.json). The light is the connection: green when the last
// sync worked recently, amber while connecting or when the last success is
// old, red when the last sync failed, grey when syncing is paused in the
// config. Clicking the pill switches the server's usage in or out of every
// total; switched out, the pill is blurred. Syncing carries on either way.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberRemoteView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MIN_STALE_MS = 5 * 60 * 1000;

  function ago(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }

  function badge(source, now, intervalMs) {
    const b = connection(source, now, intervalMs);
    const included = source.included !== false;
    const action = included
      ? 'Counted in the totals; click to leave it out.'
      : 'Left out of the totals; click to count it again.';
    return { ...b, included, title: `${b.title} ${action}` };
  }

  function connection(source, now, intervalMs) {
    const name = source.name;
    const host = source.host ? ` (${source.host})` : '';
    if (!source.enabled) {
      return {
        tone: 'off',
        status: 'paused',
        title: `${name}${host}: syncing paused ("enabled": false in remote-sources.json).`,
      };
    }
    if (source.atMs == null) {
      return { tone: 'warn', status: 'connecting', title: `${name}${host}: connecting….` };
    }
    const age = now - source.atMs;
    if (!source.ok) {
      return {
        tone: 'bad',
        status: 'offline',
        title: `${name}${host}: can't connect (${source.error || 'unknown error'}). Tried ${ago(age)}; retrying automatically.`,
      };
    }
    const staleAfter = Math.max(3 * (intervalMs || 60000), MIN_STALE_MS);
    if (age > staleAfter) {
      return { tone: 'warn', status: 'stale', title: `${name}${host}: last synced ${ago(age)}.` };
    }
    return { tone: 'ok', status: 'connected', title: `${name}${host}: connected, synced ${ago(age)}.` };
  }

  return { badge, ago };
});
