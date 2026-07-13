'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const claudeUsage = require('./providers/claude/usage');
const claudeLimits = require('./providers/claude/limits');
const codexUsage = require('./providers/codex/usage');
const codexLimits = require('./providers/codex/limits');
const codexPricingLive = require('./providers/codex/pricing-live');
const claudePricingLive = require('./providers/claude/pricing-live');
const { normalizeClaude, normalizeCodex } = require('./providers/normalize');

let win = null;
let tray = null;
let settings = null;
let settingsPath = null;
let watchDebounce = null;
let watchMaxWait = null;
let saveBoundsDebounce = null;
let isQuitting = false;

const WATCH_DEBOUNCE_MS = 150;
const WATCH_MAX_WAIT_MS = 900;
const RECONCILE_INTERVAL_MS = 30 * 1000;

const DEFAULT_SETTINGS = {
  bounds: { width: 460, height: 820 },
  alwaysOnTop: true,
  launchAtStartup: true,
  firstRun: true,
  trayTipShown: false,
};

// One-time carry-over from the app's previous identity ("ai-usage-widget"):
// settings and parsed-usage caches move to Ember's userData folder so history
// (including records of already-deleted logs) survives the rename.
function migrateLegacyData(userData) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    const legacy = path.join(userData, '..', 'ai-usage-widget');
    if (!fs.existsSync(legacy)) return;
    const carry = [
      'settings.json',
      'claude-usage-cache.json', 'codex-usage-cache.json',
      'claude-limits-cache.json', 'codex-limits-cache.json',
      'pricing-live.json', 'openai-pricing.json', 'anthropic-pricing.json',
    ];
    for (const f of carry) {
      const src = path.join(legacy, f);
      const dst = path.join(userData, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  } catch {
    /* non-fatal — worst case is a cold re-parse of the logs */
  }
}

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    /* non-fatal */
  }
}

function applyAutostart() {
  // Only the installed build registers autostart — a dev run would otherwise
  // leave a stale "electron.exe <app dir>" Run entry shadowing the real app.
  if (!app.isPackaged) return;
  // A portable exe extracts itself to %TEMP% before running; register the
  // real on-disk exe (PORTABLE_EXECUTABLE_FILE), not the throwaway copy.
  app.setLoginItemSettings({
    openAtLogin: !!settings.launchAtStartup,
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
  });
}

// Tray icon: the Ember flame (Microsoft Fluent emoji "Fire", MIT), rendered
// to src/assets/tray.png at build time by scripts/render-icon.js.
function makeTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
}

function clampToScreen(b) {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width && b.y < a.y + a.height;
  });
  if (!visible) {
    delete b.x;
    delete b.y;
  }
  return b;
}

function createWindow() {
  const b = clampToScreen({ ...settings.bounds });
  win = new BrowserWindow({
    width: b.width || 460,
    height: b.height || 780,
    x: b.x,
    y: b.y,
    minWidth: 390,
    minHeight: 560,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: !!settings.alwaysOnTop,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic', // real frosted-glass blur (Windows 11 22H2+)
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const persistBounds = () => {
    clearTimeout(saveBoundsDebounce);
    saveBoundsDebounce = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      settings.bounds = win.getBounds();
      saveSettings();
    }, 400);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  // Debug: WIDGET_SHOT=<path> saves a capture of the rendered page after load.
  if (process.env.WIDGET_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      try {
        // Some headless/background launchers inherit a hidden Windows show
        // state. Explicitly reveal only this opt-in verification window so
        // Chromium paints a surface before capturePage runs.
        win.showInactive();
        // Large local histories can take longer than a fixed timeout. The
        // renderer marks itself ready only after the first complete render.
        for (let i = 0; i < 90; i += 1) {
          const ready = await win.webContents.executeJavaScript(`document.body.dataset.ready === 'true'`);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        await new Promise((r) => setTimeout(r, 250));
        win.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 100));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.WIDGET_SHOT, img.toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('.scroll-area').scrollTop = 99999`);
        await new Promise((r) => setTimeout(r, 400));
        win.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 100));
        const img2 = await win.webContents.capturePage();
        fs.writeFileSync(process.env.WIDGET_SHOT.replace('.png', '-2.png'), img2.toPNG());
        console.log('shots saved');
      } catch (e) {
        console.error('shot failed:', e);
      }
    });
  }
  // Closing the window (X / Alt+F4) keeps the app alive in the tray,
  // like Discord/Zoom. Real quit comes from the tray menu or app updates.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideToTray();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

function hideToTray() {
  if (!win) return;
  win.hide();
  if (!settings.trayTipShown && tray) {
    settings.trayTipShown = true;
    saveSettings();
    tray.displayBalloon({
      title: 'Ember',
      content: 'Still burning here in the tray. Double-click the flame to reopen, right-click to quit.',
      iconType: 'info',
    });
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show widget', click: showWindow },
    { label: 'Hide widget', click: hideToTray },
    { type: 'separator' },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: !!settings.alwaysOnTop,
      click: (item) => setPin(item.checked),
    },
    {
      label: 'Launch at startup',
      type: 'checkbox',
      checked: !!settings.launchAtStartup,
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: 'Refresh data', click: () => { pushUpdate(true); pushClaudeLimits(true); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function setPin(value) {
  settings.alwaysOnTop = !!value;
  saveSettings();
  if (win) win.setAlwaysOnTop(settings.alwaysOnTop);
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win) win.webContents.send('settings:update', publicSettings());
}

function setAutostart(value) {
  settings.launchAtStartup = !!value;
  saveSettings();
  applyAutostart();
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win) win.webContents.send('settings:update', publicSettings());
}

function publicSettings() {
  return { alwaysOnTop: !!settings.alwaysOnTop, launchAtStartup: !!settings.launchAtStartup };
}

/* ---------------- usage aggregation (both providers) ---------------- */

let aggregateInFlight = null;
let aggregateRevision = 0;

function aggregateAll() {
  // IPC bootstrap, watcher events, pricing callbacks, and manual refreshes can
  // arrive together. They all consume the same immutable aggregation result
  // instead of making the providers walk their caches concurrently.
  if (aggregateInFlight) return aggregateInFlight;
  const revision = ++aggregateRevision;
  aggregateInFlight = (async () => {
    const [claude, codex] = await Promise.all([claudeUsage.aggregate(), codexUsage.aggregate()]);
    const visibleModel = (b) => !/^nexus[-_. ]*gpt(?:[-_. ]|$)/i.test(String(b.model || ''));
    return {
      buckets: [
        ...claude.buckets.filter(visibleModel).map(normalizeClaude),
        ...codex.buckets.filter(visibleModel).map(normalizeCodex),
      ],
      generatedAt: Date.now(),
      revision,
      fileCount: claude.fileCount + codex.fileCount,
      codexLimitsSnapshot: codex.limits, // newest rate-limit state from the Codex logs
      pricing: {
        openai: codexPricingLive.status(),
        anthropic: claudePricingLive.status(),
      },
    };
  })().finally(() => {
    aggregateInFlight = null;
  });
  return aggregateInFlight;
}

/* ---------------- plan limits ----------------
   Claude: polled from Anthropic's account API (rate-limits aggressively, so
   cached + backed off). Codex: rides along with usage — the newest
   rate_limits snapshot in the rollout logs IS the plan-limit state. */

let lastClaudeLimits = null;
let lastGoodClaudeLimits = null;
let claudeBackoffUntil = 0;
let lastForcedAt = 0;

let lastCodexLimits = null;
let lastCodexSig = '';

function sendLimits() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('limits:update', { claude: lastClaudeLimits, codex: lastCodexLimits });
  }
}

async function pushClaudeLimits(force = false) {
  if (!force && Date.now() < claudeBackoffUntil) return;
  if (force) {
    // protect the strict endpoint from refresh-button spam
    if (Date.now() - lastForcedAt < 60 * 1000) return;
    lastForcedAt = Date.now();
  }
  const res = await claudeLimits.fetchPlanLimits();
  if (res.ok) {
    lastGoodClaudeLimits = res;
    lastClaudeLimits = res;
    claudeBackoffUntil = 0;
    claudeLimits.saveCached(res);
  } else {
    // honor Retry-After and keep serving the last good snapshot; countdowns
    // keep ticking client-side
    if (res.reason === 'http-429') {
      claudeBackoffUntil = Date.now() + Math.max((res.retryAfter || 0) * 1000, 10 * 60 * 1000);
    }
    lastClaudeLimits = lastGoodClaudeLimits
      ? { ...lastGoodClaudeLimits, stale: true, lastError: res.reason }
      : res;
  }
  sendLimits();
}

function pushCodexLimits(snapshot) {
  let l = codexLimits.fromSnapshot(snapshot);
  if (l.ok) {
    codexLimits.saveCached(l);
  } else if (lastCodexLimits && lastCodexLimits.ok) {
    l = lastCodexLimits; // keep serving the last good snapshot
  }
  if (l.ok && Date.now() - l.fetchedAt > 30 * 60 * 1000) l = { ...l, stale: true };
  const sig = JSON.stringify([l.ok, l.fetchedAt, l.stale, l.reason]);
  lastCodexLimits = l;
  if (sig !== lastCodexSig) {
    lastCodexSig = sig;
    sendLimits();
  }
}

/* ---------------- update loop ---------------- */

let lastSig = '';
let updateInFlight = null;
let updateQueued = false;
let updateQueuedForce = false;
let updateQueuedAfterRevision = 0;

function hashSignatureValue(hash, value) {
  if (value === null) {
    hash.update('null;');
    return;
  }

  const type = typeof value;
  if (type === 'string') {
    hash.update(`string:${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value);
    return;
  }
  if (type === 'number') {
    const encoded = Number.isNaN(value) ? 'NaN'
      : value === Infinity ? 'Infinity'
        : value === -Infinity ? '-Infinity'
          : Object.is(value, -0) ? '-0'
            : String(value);
    hash.update(`number:${encoded};`);
    return;
  }
  if (type === 'boolean' || type === 'undefined' || type === 'bigint') {
    hash.update(`${type}:${String(value)};`);
    return;
  }

  if (Array.isArray(value)) {
    hash.update(`array:${value.length}:[`);
    for (const item of value) hashSignatureValue(hash, item);
    hash.update(']');
    return;
  }
  if (value instanceof Date) {
    hash.update(`date:${value.toISOString()};`);
    return;
  }

  const keys = Object.keys(value).sort();
  hash.update(`object:${keys.length}:{`);
  for (const key of keys) {
    hashSignatureValue(hash, key);
    hashSignatureValue(hash, value[key]);
  }
  hash.update('}');
}

function updateSignature(data) {
  const hash = crypto.createHash('sha256');
  const stablePayload = { ...data };
  // These transport fields intentionally change on every aggregation. The
  // revision orders responses; generatedAt preserves snapshot timing. Neither
  // represents a usage-state change that should trigger a full renderer pass.
  delete stablePayload.generatedAt;
  delete stablePayload.revision;
  hashSignatureValue(hash, stablePayload);
  return hash.digest('hex');
}

async function aggregateAfter(revision) {
  let data = await aggregateAll();
  // An IPC bootstrap may already have been aggregating when a watcher event
  // arrived. Never let that pre-event pass satisfy the event-driven refresh.
  while (data.revision <= revision) data = await aggregateAll();
  return data;
}

async function publishUpdate(force, afterRevision) {
  try {
    const data = await aggregateAfter(afterRevision);
    if (!win || win.isDestroyed()) return;
    // Canonical hashing covers every bucket field and all payload metadata, so
    // redistributions, reasoning tokens, deletions, and price-only changes are
    // observable even when top-level token totals happen to stay unchanged.
    const sig = updateSignature(data);
    if (force || sig !== lastSig) {
      lastSig = sig;
      win.webContents.send('usage:update', data);
    } else {
      win.webContents.send('usage:heartbeat', Date.now());
    }
    pushCodexLimits(data.codexLimitsSnapshot);
  } catch (err) {
    console.error('aggregate failed:', err);
  }
}

function pushUpdate(force = false) {
  // A pass started at or before this revision cannot contain the event that
  // requested this update. aggregateAfter() advances beyond this boundary.
  const afterRevision = aggregateRevision;
  if (updateInFlight) {
    // One follow-up pass is enough for any burst, but remember whether any
    // caller requires a forced renderer/pricing update.
    updateQueued = true;
    updateQueuedForce = updateQueuedForce || force;
    updateQueuedAfterRevision = Math.max(updateQueuedAfterRevision, afterRevision);
    return updateInFlight;
  }

  updateInFlight = (async () => {
    let nextForce = force;
    let nextAfterRevision = afterRevision;
    do {
      updateQueued = false;
      updateQueuedForce = false;
      updateQueuedAfterRevision = 0;
      await publishUpdate(nextForce, nextAfterRevision);
      if (!updateQueued) break;
      nextForce = updateQueuedForce;
      nextAfterRevision = updateQueuedAfterRevision;
    } while (true);
  })().finally(() => {
    updateInFlight = null;
  });
  return updateInFlight;
}

const usageWatchers = new Map();

function flushWatchedUsage() {
  clearTimeout(watchDebounce);
  clearTimeout(watchMaxWait);
  watchDebounce = null;
  watchMaxWait = null;
  pushUpdate();
}

function scheduleWatchedUsage() {
  clearTimeout(watchDebounce);
  watchDebounce = setTimeout(flushWatchedUsage, WATCH_DEBOUNCE_MS);
  // Keep the existing quiet-period debounce, but bound each write burst so a
  // continuously appended log still publishes fresh data at a steady cadence.
  if (!watchMaxWait) watchMaxWait = setTimeout(flushWatchedUsage, WATCH_MAX_WAIT_MS);
}

function attachUsageWatcher(dir) {
  if (usageWatchers.has(dir)) return;
  try {
    const watcher = fs.watch(dir, { recursive: true }, () => {
      scheduleWatchedUsage();
    });
    usageWatchers.set(dir, watcher);
    watcher.on('error', (err) => {
      if (usageWatchers.get(dir) !== watcher) return;
      usageWatchers.delete(dir);
      watcher.close();
      console.error(`fs.watch failed for ${dir}, retrying during reconciliation:`, err.message);
    });
    watcher.on('close', () => {
      if (usageWatchers.get(dir) === watcher) usageWatchers.delete(dir);
    });
  } catch (err) {
    console.error(`fs.watch failed for ${dir}, retrying during reconciliation:`, err.message);
  }
}

function startWatcher() {
  // a fresh-enough snapshot from the last run means startup costs no request
  const cacheFresh = lastGoodClaudeLimits && Date.now() - lastGoodClaudeLimits.fetchedAt < 4 * 60 * 1000;
  if (!cacheFresh) setTimeout(() => pushClaudeLimits(), 2000);
  setInterval(() => pushClaudeLimits(), 5 * 60 * 1000); // gentle cadence; the endpoint 429s easily

  const usageDirs = [...new Set([claudeUsage.PROJECTS_DIR, ...codexUsage.SESSION_DIRS])];
  for (const dir of usageDirs) attachUsageWatcher(dir);
  // fs.watch provides the live path. This slower pass reconciles missed or
  // unavailable watcher events without walking every log cache once a second.
  // It also picks up directories created after startup and replaces watchers
  // that failed or closed, while the map prevents duplicate attachments.
  setInterval(() => {
    for (const dir of usageDirs) attachUsageWatcher(dir);
    pushUpdate();
  }, RECONCILE_INTERVAL_MS);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.harshalvankudre.ember-widget');
    nativeTheme.themeSource = 'dark'; // keep the acrylic tint dark on any system theme
    const userData = app.getPath('userData');
    migrateLegacyData(userData);
    loadSettings();
    claudeUsage.init(userData);
    claudeLimits.init(userData);
    codexUsage.init(userData);
    codexLimits.init(userData);
    // costs re-push (force: token totals are unchanged) once fresh prices land
    codexPricingLive.init(userData, () => pushUpdate(true));
    claudePricingLive.init(userData, () => pushUpdate(true));

    lastGoodClaudeLimits = claudeLimits.loadCached();
    if (lastGoodClaudeLimits) lastClaudeLimits = { ...lastGoodClaudeLimits, stale: true };
    lastCodexLimits = codexLimits.loadCached();
    if (lastCodexLimits) lastCodexLimits = { ...lastCodexLimits, stale: true };

    if (settings.firstRun) {
      settings.firstRun = false;
      saveSettings();
      applyAutostart(); // default ON for first run
    } else {
      applyAutostart();
    }

    tray = new Tray(makeTrayIcon());
    tray.setToolTip('Ember — Claude + Codex usage');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);

    createWindow();
    startWatcher();
  });

  // The tray keeps the app alive even with every window closed;
  // quitting happens only via the tray menu.
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('usage:get', () => aggregateAll());
ipcMain.handle('limits:get', () => ({ claude: lastClaudeLimits, codex: lastCodexLimits }));
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.on('win:hide', () => hideToTray());
ipcMain.on('win:close', () => hideToTray());
ipcMain.on('win:pin', (_e, v) => setPin(v));
ipcMain.on('app:autostart', (_e, v) => setAutostart(v));
ipcMain.on('usage:refresh', () => {
  pushUpdate(true);
  pushClaudeLimits(true);
});
