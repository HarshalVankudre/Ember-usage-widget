'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberFilterState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function reconcileModelSelection(selectedModels, visibleModelKeys) {
    const visible = new Set(visibleModelKeys);
    const selected = new Set([...selectedModels].filter((key) => visible.has(key)));
    // An empty selection and a selection containing every visible model both
    // mean "all". Canonicalizing that state keeps chip toggles predictable.
    if (selected.size === 0 || selected.size === visible.size) return new Set();
    return selected;
  }

  return { reconcileModelSelection };
});
