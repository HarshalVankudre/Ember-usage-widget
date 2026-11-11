'use strict';

// The titlebar light for each server Ember pulls Claude Code usage from
// (remote-sources.json). Green: the last sync worked recently. Amber: still
// connecting, or the last success is old. Red: the last sync failed. Grey:
// paused from the pill. A paused server's history stays in the totals.
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
    const name = source.name;
    const host = source.host ? ` (${source.host})` : '';
    if (!source.enabled) {
      return {
        tone: 'off',
        status: 'paused',
        title: `${name}${host}: paused. Click to resume syncing. Usage already synced stays in the totals.`,
      };
    }
    if (source.atMs == null) {
      return { tone: 'warn', status: 'connecting', title: `${name}${host}: connecting… Click to pause.` };
    }
    const age = now - source.atMs;
    if (!source.ok) {
      return {
        tone: 'bad',
        status: 'offline',
        title: `${name}${host}: can't connect (${source.error || 'unknown error'}). Tried ${ago(age)}; retrying automatically. Click to pause.`,
      };
    }
    const staleAfter = Math.max(3 * (intervalMs || 60000), MIN_STALE_MS);
    if (age > staleAfter) {
      return { tone: 'warn', status: 'stale', title: `${name}${host}: last synced ${ago(age)}. Click to pause.` };
    }
    return { tone: 'ok', status: 'connected', title: `${name}${host}: connected, synced ${ago(age)}. Click to pause.` };
  }

  return { badge, ago };
});
