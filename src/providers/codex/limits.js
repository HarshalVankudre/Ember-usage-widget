'use strict';

// Codex writes its ChatGPT-plan rate-limit state into rollout logs, while
// ClaudeX stores the same shared-account state in its local usage cache. Use
// whichever snapshot is newest so both runtimes feed one Codex limit group;
// countdowns keep ticking client-side without another network call.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { USAGE_DIR: CLAUDEX_USAGE_DIR } = require('../claudex-paths');

const CLAUDEX_LIMITS_FILE = path.join(CLAUDEX_USAGE_DIR, 'limits.json');

let cacheFile = null;

function init(userDataDir) {
  cacheFile = path.join(userDataDir, 'codex-limits-cache.json');
}

// last good snapshot survives restarts, so the card never goes blank
function loadCached() {
  try {
    const snap = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return snap && snap.ok ? snap : null;
  } catch {
    return null;
  }
}

function saveCached(snap) {
  if (!cacheFile) return;
  fsp.writeFile(cacheFile, JSON.stringify(snap)).catch(() => {});
}

const PLAN_LABELS = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  business: 'Business',
  team: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function planLabel(type) {
  if (!type) return '';
  const t = String(type).toLowerCase();
  return PLAN_LABELS[t] || t.charAt(0).toUpperCase() + t.slice(1);
}

function windowRow(w, fallbackName) {
  if (!w || w.used_percent == null) return null;
  const mins = w.window_minutes || 0;
  let name = fallbackName;
  let style = 'day';
  if (mins > 0 && mins <= 720) {
    name = `Current session (${Math.round(mins / 60)}h)`;
    style = 'countdown';
  } else if (mins >= 8640 && mins <= 11520) {
    name = 'Weekly limit';
  } else if (mins > 720) {
    name = `${Math.round(mins / 1440)}-day limit`;
  }
  return {
    name,
    style, // 'countdown' -> "Resets in X hr Y min", 'day' -> "Resets Tue 9:30 AM"
    utilization: w.used_percent,
    resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
  };
}

function timestampMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function claudexWindowRow(w, fallbackName) {
  if (!w || w.used_percent == null) return null;
  const seconds = Number(w.limit_window_seconds) || 0;
  const resets = timestampMs(w.reset_at);
  return windowRow({
    used_percent: w.used_percent,
    window_minutes: seconds / 60,
    resets_at: resets / 1000,
  }, fallbackName);
}

function fromClaudexPayload(payload) {
  const rl = payload && payload.rate_limit;
  if (!rl) return { ok: false, reason: 'no-data' };
  // additional_rate_limits are model-specific meters. Keep them out of the
  // account headroom card so ClaudeX does not create separate model bars.
  const windows = [];
  const primary = claudexWindowRow(rl.primary_window, 'Codex limit');
  const secondary = claudexWindowRow(rl.secondary_window, 'Secondary limit');
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  const label = planLabel(payload.plan_type);
  if (!windows.length && !label) return { ok: false, reason: 'no-data' };
  return {
    ok: true,
    fetchedAt: timestampMs(payload.fetched_at),
    plan: label ? { type: payload.plan_type, label } : null,
    windows,
    source: 'claudex',
  };
}

function loadClaudex() {
  try {
    return fromClaudexPayload(JSON.parse(fs.readFileSync(CLAUDEX_LIMITS_FILE, 'utf8')));
  } catch {
    return { ok: false, reason: 'no-data' };
  }
}

function newest(a, b) {
  if (!a || !a.ok) return b && b.ok ? b : (a || b);
  if (!b || !b.ok) return a;
  return (b.fetchedAt || 0) > (a.fetchedAt || 0) ? b : a;
}

// snapshot from usage.aggregate(): { ts, rateLimits } or null
function fromSnapshot(snap) {
  if (!snap || !snap.rateLimits) return { ok: false, reason: 'no-data' };
  const rl = snap.rateLimits;
  const windows = [];
  const primary = windowRow(rl.primary, 'Session limit');
  const secondary = windowRow(rl.secondary, 'Weekly limit');
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  const label = planLabel(rl.plan_type);
  if (!windows.length && !label) return { ok: false, reason: 'no-data' };
  return {
    ok: true,
    fetchedAt: snap.ts,
    plan: label ? { type: rl.plan_type, label } : null,
    windows,
    source: 'codex',
  };
}

module.exports = {
  init,
  loadCached,
  saveCached,
  fromSnapshot,
  fromClaudexPayload,
  loadClaudex,
  newest,
  CLAUDEX_USAGE_DIR,
};
