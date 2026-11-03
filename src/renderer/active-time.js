'use strict';

// Agent working time. The backend times each finished turn — from the prompt
// to the agent's final reply, or the agent's own measure when its log records
// one — and books it on the call that ended the turn. A turn still running
// books nothing until it finishes, so these figures are history, never a
// live clock.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberActiveTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const NOTE = 'Agent working time: each finished turn, from the prompt to the agent\'s final reply. A turn still running is added once it finishes.';

  // Reads like the agent's own status line: 45s, 7m 25s, 3h 12m.
  function fmtDuration(ms) {
    const total = Math.round((ms || 0) / 1000);
    if (total <= 0) return '—';
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) {
      const s = total % 60;
      return s ? `${minutes}m ${s}s` : `${minutes}m`;
    }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h >= 100) return `${h.toLocaleString()}h`;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  return { NOTE, fmtDuration };
});
