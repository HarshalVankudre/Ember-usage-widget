'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberFilterState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // Release dates, not first/last usage. Sources checked 2026-11-03:
  // https://developers.openai.com/api/docs/changelog
  // https://platform.claude.com/docs/en/release-notes/overview
  // Keep unknown releases visible rather than guessing their age.
  const releases = [
    [/^gpt-6\.1-terra(?:-|$)/, '2026-10-26'],
    [/^gpt-6\.1-sol(?:-|$)/, '2026-09-29'],
    [/^gpt-6-(?:sol|luna)(?:-|$)/, '2026-09-22'],
    [/^gpt-6-astra(?:-|$)/, '2026-09-03'],
    [/^gpt-5\.6-cyber(?:-|$)/, '2026-08-07'],
    [/^gpt-5\.6(?:-|$)/, '2026-07-09'],
    [/^gpt-5\.5(?:-|$)/, '2026-04-23'],
    [/^gpt-5\.4-(?:mini|nano)(?:-|$)/, '2026-03-17'],
    [/^gpt-5\.4(?:-|$)/, '2026-03-05'],
    [/^gpt-5\.3-codex-spark(?:-|$)/, '2026-02-12'],
    [/^gpt-5\.3-codex(?:-|$)/, '2026-02-05'],
    [/^gpt-5\.3-chat(?:-|$)/, '2026-03-03'],
    [/^gpt-5\.2(?:-|$)/, '2025-12-11'],
    [/^gpt-5\.1(?:-|$)/, '2025-11-13'],
    [/^gpt-5(?:-|$)/, '2025-08-07'],
    [/^gpt-4\.1(?:-|$)/, '2025-04-14'],
    [/^o3-pro(?:-|$)/, '2025-06-10'],
    [/^o3-mini(?:-|$)/, '2025-01-31'],
    [/^(?:o4-mini|o3)(?:-|$)/, '2025-04-16'],
    [/^gpt-4o-mini(?:-|$)/, '2024-07-18'],
    [/^chatgpt-4o(?:-|$)/, '2024-08-14'],
    [/^gpt-4o(?:-|$)/, '2024-05-13'],
    [/^o1-(?:mini|preview)(?:-|$)/, '2024-09-12'],
    [/^o1-pro(?:-|$)/, '2025-03-19'],
    [/^o1(?:-|$)/, '2024-12-05'],
    [/^codex-mini(?:-|$)/, '2025-05-16'],
    [/^claude-haiku-5-5(?:-|$)/, '2026-10-07'],
    [/^claude-sonnet-5-5(?:-|$)/, '2026-09-28'],
    [/^claude-opus-5-5(?:-|$)/, '2026-09-22'],
    [/^claude-(?:fable|mythos)-5-1(?:-|$)/, '2026-09-01'],
    [/^claude-opus-5(?:-|$)/, '2026-07-24'],
    [/^claude-sonnet-5(?:-|$)/, '2026-06-30'],
    [/^claude-(?:fable|mythos)-5(?:-|$)/, '2026-06-09'],
    [/^claude-opus-4-8(?:-|$)/, '2026-05-28'],
    [/^claude-opus-4-7(?:-|$)/, '2026-04-16'],
    [/^claude-sonnet-4-6(?:-|$)/, '2026-02-17'],
    [/^claude-opus-4-6(?:-|$)/, '2026-02-05'],
    [/^claude-opus-4-5(?:-|$)/, '2025-11-24'],
    [/^claude-haiku-4-5(?:-|$)/, '2025-10-15'],
    [/^claude-opus-4-1(?:-|$)/, '2025-08-05'],
    [/^claude-(?:opus|sonnet)-4(?:-latest)?$/, '2025-05-22'],
    [/^claude-(?:3-7-sonnet|sonnet-3-7)(?:-|$)/, '2025-02-24'],
    [/^claude-(?:3-5-haiku|haiku-3-5)(?:-|$)/, '2024-10-22'],
    [/^claude-(?:3-5-sonnet|sonnet-3-5)(?:-|$)/, '2024-06-20'],
    [/^claude-(?:3-(?:opus|sonnet|haiku)|(?:opus|sonnet|haiku)-3)(?:-|$)/, '2024-03-04'],
  ];

  function releaseDate(model) {
    const id = String(model).toLowerCase();
    // Dated snapshots are separate releases, including snapshots of old families.
    const snapshot = id.match(/-(\d{4})-?(\d{2})-?(\d{2})$/);
    if (snapshot) return `${snapshot[1]}-${snapshot[2]}-${snapshot[3]}`;
    return releases.find(([pattern]) => pattern.test(id))?.[1] || null;
  }

  function archiveCutoff(now = new Date()) {
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
    cutoff.setDate(Math.min(now.getDate(), lastDay));
    return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  }

  function isArchivedModel(model, cutoff = archiveCutoff()) {
    // Keep Fable 5.1 selectable by explicit user preference, regardless of age.
    if (/^claude-fable-5-1(?:-latest|-\d{8}|-\d{4}-\d{2}-\d{2})?$/i.test(String(model))) return false;
    const released = releaseDate(model);
    return released != null && released < cutoff;
  }

  function reconcileModelSelection(selectedModels, visibleModelKeys) {
    const visible = new Set(visibleModelKeys);
    const selected = new Set([...selectedModels].filter((key) => visible.has(key)));
    // An empty selection and a selection containing every visible model both
    // mean "all". Canonicalizing that state keeps chip toggles predictable.
    if (selected.size === 0 || selected.size === visible.size) return new Set();
    return selected;
  }

  return { reconcileModelSelection, releaseDate, archiveCutoff, isArchivedModel };
});
