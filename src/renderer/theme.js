'use strict';

/* Theme runtime.

   The stylesheet owns every colour; this file only chooses which block of
   custom properties is live and hands the canvas charts a resolved copy of
   the ones they need. Canvas has no access to CSS, so without this bridge a
   theme switch would repaint the chrome and leave the bars behind.

   Reads are batched into one getComputedStyle call per theme change rather
   than one per draw — the previous code called it on every chart label. */

(() => {
  const STORAGE_KEY = 'emberTheme';

  /* Ordered as the picker shows them: Ember's own first, then the schemes
     developers are most likely already running in their editor. */
  const THEMES = [
    { id: 'classic', name: 'Ember Classic', swatch: ['#0d0806', '#46c194', '#f2b45c', '#ff6d3b'] },
    { id: 'noir', name: 'Ember Noir', swatch: ['#0b0e14', '#2fb59c', '#f0b44f', '#ff7a45'] },
    { id: 'catppuccin', name: 'Catppuccin', swatch: ['#11111b', '#a6e3a1', '#f9e2af', '#fab387'] },
    { id: 'tokyonight', name: 'Tokyo Night', swatch: ['#16161e', '#73daca', '#e0af68', '#ff9e64'] },
    { id: 'rosepine', name: 'Rosé Pine', swatch: ['#191724', '#9ccfd8', '#f6c177', '#ebbcba'] },
  ];

  // Whichever id sits here must be the palette written on bare :root in the
  // stylesheet — apply() expresses "default" by removing the attribute.
  const DEFAULT_ID = 'classic';
  const isKnown = (id) => THEMES.some((t) => t.id === id);

  /* Every custom property the canvas renderers need, by the name they use. */
  const TOKEN_MAP = {
    grid: '--chart-grid',
    axis: '--chart-axis',
    zero: '--chart-zero',
    label: '--chart-label',
    scaleBg: '--chart-scale-bg',
    live: '--chart-live',
    mean: '--chart-mean',
    claude: '--claude',
    codex: '--codex',
    fable: '--m-fable',
    opus: '--m-opus',
    sonnet: '--m-sonnet',
    haiku: '--m-haiku',
    pro: '--m-pro',
    mini: '--m-mini',
    nano: '--m-nano',
    gpt5: '--m-gpt5',
    gpt4: '--m-gpt4',
    o3: '--m-o3',
    other: '--m-other',
  };

  let cache = null;
  const listeners = new Set();

  function readTokens() {
    if (cache) return cache;
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const [key, prop] of Object.entries(TOKEN_MAP)) {
      out[key] = cs.getPropertyValue(prop).trim() || '#888888';
    }
    cache = out;
    return out;
  }

  function current() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isKnown(stored) ? stored : DEFAULT_ID;
  }

  function apply(id, { persist = true } = {}) {
    const theme = isKnown(id) ? id : DEFAULT_ID;
    // The default block lives on bare :root, so it carries no attribute.
    if (theme === DEFAULT_ID) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem(STORAGE_KEY, theme);
    cache = null;
    for (const cb of listeners) cb(theme);
    return theme;
  }

  /* Applied before first paint so the window never flashes the wrong palette
     — this script is loaded ahead of the renderer for that reason. */
  apply(current(), { persist: false });

  window.EmberTheme = {
    THEMES,
    DEFAULT_ID,
    current,
    apply,
    tokens: readTokens,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
})();
