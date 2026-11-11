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
  // The connection is live: a round every couple of seconds. A dead link is
  // noticed by ssh's keepalive within about 30 seconds, so silence longer
  // than that, or than a few rounds, means something is stuck.
  const MIN_STALE_MS = 45 * 1000;

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
    const staleAfter = Math.max(5 * (intervalMs || 2000), MIN_STALE_MS);
    if (age > staleAfter) {
      return { tone: 'warn', status: 'stale', title: `${name}${host}: last synced ${ago(age)}.` };
    }
    return { tone: 'ok', status: 'connected', title: `${name}${host}: connected, live (last checked ${ago(age)}).` };
  }

  // The Servers form, checked before it goes to the backend. Returns the
  // payload for remote_save_source, or the first problem and its field.
  function readServerForm(fields) {
    const name = String(fields.name || '').trim();
    const ssh = String(fields.ssh || '').trim();
    const portText = String(fields.port || '').trim();
    const identityFile = String(fields.key || '').trim();
    if (!name) return { error: 'Give the server a name.', field: 'name' };
    if (!ssh) return { error: 'Enter the ssh login, like user@203.0.113.7.', field: 'ssh' };
    if (/\s/.test(ssh) || ssh.startsWith('-')) {
      return { error: 'The ssh login is one word, like user@host or a host alias.', field: 'ssh' };
    }
    let port = null;
    if (portText) {
      if (!/^\d+$/.test(portText) || +portText < 1 || +portText > 65535) {
        return { error: 'The port must be a number from 1 to 65535.', field: 'port' };
      }
      port = +portText;
    }
    return { value: { name, ssh, port, identityFile: identityFile || null, enabled: fields.enabled !== false } };
  }

  return { badge, ago, readServerForm };
});
