'use strict';

/* Tauri bridge — exposes the same `window.api` surface the Electron preload
   provided, so the renderer logic is host-agnostic. Loaded before app.js. */

(() => {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error('Tauri globals missing — was withGlobalTauri disabled?');
    return;
  }
  const invoke = tauri.core.invoke;
  const listen = (name, cb) => {
    tauri.event.listen(name, (e) => cb(e.payload));
  };

  window.api = {
    getUsage: () => invoke('get_usage'),
    getLimits: () => invoke('get_limits'),
    onLimits: (cb) => listen('limits:update', cb),
    getQuota: () => invoke('get_quota'),
    onQuota: (cb) => listen('quota:update', cb),
    getSettings: () => invoke('get_settings'),
    getVersion: () => invoke('get_version'),
    getRemote: () => invoke('get_remote'),
    onRemote: (cb) => listen('remote:update', cb),
    listRemoteSources: () => invoke('remote_sources'),
    saveRemoteSource: (original, source) => invoke('remote_save_source', { original: original || null, source }),
    deleteRemoteSource: (name) => invoke('remote_delete_source', { name: String(name) }),
    setRemoteIncluded: (name, v) => invoke('remote_set_included', { name: String(name), value: !!v }),
    onUsage: (cb) => listen('usage:update', cb),
    onHeartbeat: (cb) => listen('usage:heartbeat', cb),
    onSettings: (cb) => listen('settings:update', cb),
    hide: () => invoke('win_hide'),
    close: () => invoke('win_close'),
    setPin: (v) => invoke('win_pin', { value: !!v }),
    setMini: (v) => invoke('win_mini', { value: !!v }),
    setAutostart: (v) => invoke('app_autostart', { value: !!v }),
    refresh: () => invoke('usage_refresh'),
    saveExport: (payload) => invoke('export_save', { payload }),
    revealExport: (filePath) => invoke('export_reveal', { path: String(filePath || '') }),
    copyText: (text) => invoke('clipboard_write', { text: String(text ?? '') }),
  };

  /* Frameless-window dragging. `-webkit-app-region: drag` is an Electron-only
     extension, so the drag zones invoke the native move loop instead. A small
     movement threshold preserves click and double-click semantics on the
     compact strip. */
  const DRAG_ZONES = '.titlebar, .mini-bar';
  const INTERACTIVE = 'button, input, select, textarea, a, .window-actions, .mini-actions';
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const zone = e.target.closest(DRAG_ZONES);
    if (!zone || e.target.closest(INTERACTIVE)) return;
    const startX = e.screenX;
    const startY = e.screenY;
    const move = (ev) => {
      if (Math.abs(ev.screenX - startX) + Math.abs(ev.screenY - startY) > 2) {
        cleanup();
        invoke('win_drag');
      }
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', cleanup);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', cleanup);
  });
})();
