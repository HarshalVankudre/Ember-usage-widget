'use strict';

// Codex writes its ChatGPT-plan rate-limit state (5-hour + weekly window
// utilization, plan type) into every token_count event in the rollout logs,
// so plan limits need no network call at all — we surface the newest
// snapshot found while parsing usage. It reflects the moment of your last
// Codex API call; countdowns keep ticking client-side.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

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
  };
}

module.exports = { init, loadCached, saveCached, fromSnapshot };
