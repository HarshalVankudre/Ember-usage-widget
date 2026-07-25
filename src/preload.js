'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUsage: () => ipcRenderer.invoke('usage:get'),
  getLimits: () => ipcRenderer.invoke('limits:get'),
  onLimits: (cb) => ipcRenderer.on('limits:update', (_e, l) => cb(l)),
  getQuota: () => ipcRenderer.invoke('quota:get'),
  onQuota: (cb) => ipcRenderer.on('quota:update', (_e, q) => cb(q)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  onUsage: (cb) => ipcRenderer.on('usage:update', (_e, data) => cb(data)),
  onHeartbeat: (cb) => ipcRenderer.on('usage:heartbeat', (_e, ts) => cb(ts)),
  onSettings: (cb) => ipcRenderer.on('settings:update', (_e, s) => cb(s)),
  hide: () => ipcRenderer.send('win:hide'),
  close: () => ipcRenderer.send('win:close'),
  setPin: (v) => ipcRenderer.send('win:pin', v),
  setMini: (v) => ipcRenderer.send('win:mini', v),
  setAutostart: (v) => ipcRenderer.send('app:autostart', v),
  refresh: () => ipcRenderer.send('usage:refresh'),
  saveExport: (payload) => ipcRenderer.invoke('export:save', payload),
  revealExport: (filePath) => ipcRenderer.invoke('export:reveal', filePath),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
});
