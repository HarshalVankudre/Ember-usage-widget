'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const claudeUsage = require('./providers/claude/usage');
const claudeLimits = require('./providers/claude/limits');
const codexUsage = require('./providers/codex/usage');
const codexLimits = require('./providers/codex/limits');
const codexPricingLive = require('./providers/codex/pricing-live');

let win = null;
let tray = null;
let settings = null;
let settingsPath = null;
let watchDebounce = null;
let saveBoundsDebounce = null;
let isQuitting = false;

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
      'pricing-live.json',
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
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.WIDGET_SHOT, img.toPNG());
          await win.webContents.executeJavaScript(
            `document.querySelector('.scroll-area').scrollTop = 99999`
          );
          await new Promise((r) => setTimeout(r, 400));
          const img2 = await win.webContents.capturePage();
          fs.writeFileSync(process.env.WIDGET_SHOT.replace('.png', '-2.png'), img2.toPNG());
          console.log('shots saved');
        } catch (e) {
          console.error('shot failed:', e);
        }
      }, 3500);
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

// Both providers' buckets are normalized to one shape so the renderer can
// merge them freely:
//   { provider, date, hour, model, project, session, msgs,
//     input, output, cacheRead, cacheWrite, reasoning,   <- token counts
//     cost, cIn, cOut, cCr, cCw, cRs, cacheSavings, priced }
// Claude: cacheRead/cacheWrite are real log counts (5m+1h writes merged).
// Codex: `cached` maps to cacheRead; writes have no token counts in Codex
// logs, so cacheWrite is 0 while cCw carries the estimated write surcharge.
function normalizeClaude(b) {
  return {
    provider: 'claude',
    date: b.date, hour: b.hour, model: b.model, project: b.project, session: b.session,
    msgs: b.msgs,
    input: b.input, output: b.output,
    cacheRead: b.cacheRead, cacheWrite: b.cacheW5m + b.cacheW1h, reasoning: 0,
    cost: b.cost, cIn: b.cIn, cOut: b.cOut, cCr: b.cCr, cCw: b.cCw, cRs: 0,
    cacheSavings: b.cacheSavings, priced: b.priced,
    projectDeleted: !!b.projectDeleted,
  };
}

function normalizeCodex(b) {
  return {
    provider: 'codex',
    date: b.date, hour: b.hour, model: b.model, project: b.project, session: b.session,
    msgs: b.msgs,
    input: b.input, output: b.output,
    cacheRead: b.cached, cacheWrite: 0, reasoning: b.reasoning,
    cost: b.cost, cIn: b.cIn, cOut: b.cOut, cCr: b.cCached, cCw: b.cWrite, cRs: b.cReasoning,
    cacheSavings: b.cacheSavings, priced: b.priced,
    projectDeleted: !!b.projectDeleted,
  };
}

async function aggregateAll() {
  const [claude, codex] = await Promise.all([claudeUsage.aggregate(), codexUsage.aggregate()]);
  return {
    buckets: [...claude.buckets.map(normalizeClaude), ...codex.buckets.map(normalizeCodex)],
    generatedAt: Date.now(),
    fileCount: claude.fileCount + codex.fileCount,
    codexLimitsSnapshot: codex.limits, // newest rate-limit state from the Codex logs
    pricing: codexPricingLive.status(),
  };
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
let aggregating = false;

async function pushUpdate(force = false) {
  if (aggregating) return; // never stack aggregations
  aggregating = true;
  try {
    const data = await aggregateAll();
    if (!win || win.isDestroyed()) return;
    // cheap change signature: only re-render the UI when numbers actually moved
    let msgs = 0, toks = 0;
    for (const b of data.buckets) {
      msgs += b.msgs;
      toks += b.input + b.output + b.cacheRead + b.cacheWrite;
    }
    const sig = `${data.fileCount}:${data.buckets.length}:${msgs}:${toks}`;
    if (force || sig !== lastSig) {
      lastSig = sig;
      win.webContents.send('usage:update', data);
    } else {
      win.webContents.send('usage:heartbeat', Date.now());
    }
    pushCodexLimits(data.codexLimitsSnapshot);
  } catch (err) {
    console.error('aggregate failed:', err);
  } finally {
    aggregating = false;
  }
}

function startWatcher() {
  // a fresh-enough snapshot from the last run means startup costs no request
  const cacheFresh = lastGoodClaudeLimits && Date.now() - lastGoodClaudeLimits.fetchedAt < 4 * 60 * 1000;
  if (!cacheFresh) setTimeout(() => pushClaudeLimits(), 2000);
  setInterval(() => pushClaudeLimits(), 5 * 60 * 1000); // gentle cadence; the endpoint 429s easily

  for (const dir of [claudeUsage.PROJECTS_DIR, ...codexUsage.SESSION_DIRS]) {
    try {
      fs.watch(dir, { recursive: true }, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => pushUpdate(), 500);
      });
    } catch (err) {
      console.error(`fs.watch failed for ${dir}, falling back to polling only:`, err.message);
    }
  }
  // Live mode: re-check every second (per-file mtime cache keeps this cheap).
  setInterval(() => pushUpdate(), 1000);
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
