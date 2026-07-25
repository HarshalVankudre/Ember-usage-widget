'use strict';

/* Quota ledger — the history the plan meters never keep.

   Both providers publish a single "you are N% through your quota" number and
   nothing else: no history, and no record of what that percent used to buy.
   When the allowance behind the percentage moves, every earlier reading is
   gone, so a plan that quietly tightens looks identical to one that did not.

   Ember samples each meter it can see, remembers every window it observed, and
   stores enough to pair that window with the usage recorded in the same
   interval. The renderer turns the pair into the one figure that survives a
   policy change: how much real work a single percent of the plan bought.

   Only the meter readings live here. Tokens and cost are never copied into
   this file — they are recomputed from the usage buckets on demand, so the
   ledger stays small and can never drift away from the usage history. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE_VERSION = 1;
const MAX_INSTANCES = 260;        // per meter — roughly two months of sessions
const MAX_SAMPLES = 90;           // per instance, after thinning
const SAMPLE_MIN_GAP_MS = 60 * 1000;
const RESET_MATCH_TOLERANCE_MS = 90 * 1000;
const PERSIST_DEBOUNCE_MS = 4000;

// Anthropic publishes these window lengths; the meters themselves do not carry
// them. Codex reports its own window length in the rollout snapshot.
const CLAUDE_SESSION_MINUTES = 300;
const CLAUDE_WEEK_MINUTES = 7 * 24 * 60;

let ledgerPath = null;
let meters = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();

function init(userDataDir) {
  ledgerPath = path.join(userDataDir, 'quota-ledger.json');
  meters = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (parsed && parsed.v === FILE_VERSION && Array.isArray(parsed.meters)) {
      for (const meter of parsed.meters) {
        if (meter && meter.id && isKnownMeterId(meter.id)) {
          meters.set(meter.id, normalizeStoredMeter(meter));
        }
      }
    }
  } catch {
    /* a missing or unreadable ledger just starts a fresh history */
  }
}

// An early build filed Codex meters under their row label when the cached
// snapshot had no window length. Those entries describe a meter that can never
// receive another reading, so they are dropped rather than shown as a
// duplicate of the same window.
const KNOWN_METER_ID = /^(claude\|session|claude\|weekly(:[a-z0-9-]+)?|codex\|\d+)$/;

function isKnownMeterId(id) {
  return KNOWN_METER_ID.test(String(id));
}

function normalizeStoredMeter(meter) {
  return {
    id: String(meter.id),
    provider: meter.provider === 'codex' ? 'codex' : 'claude',
    kind: String(meter.kind || 'session'),
    label: String(meter.label || meter.id),
    windowMinutes: Number(meter.windowMinutes) || 0,
    instances: (Array.isArray(meter.instances) ? meter.instances : [])
      .filter((i) => i && Number.isFinite(i.startedAt))
      .slice(-MAX_INSTANCES),
  };
}

function persist() {
  if (!ledgerPath) return;
  const target = ledgerPath;
  const temp = `${target}.tmp`;
  const snapshot = JSON.stringify({ v: FILE_VERSION, meters: [...meters.values()] });
  persistChain = persistChain.then(async () => {
    try {
      await fsp.writeFile(temp, snapshot);
      await fsp.rename(temp, target);
    } catch {
      try { await fsp.unlink(temp); } catch { /* ignore cleanup failures */ }
    }
  });
}

function schedulePersist() {
  if (persistTimer || !ledgerPath) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

/* ---------------- meter extraction ---------------- */

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Reset times arrive with microsecond noise around a boundary the providers
// actually place on the minute — 03:59:59.190 and 04:00:00.388 are the same
// instant restated. Rounding there keeps a window from reading as 00:59–05:59
// and stops two readings of one window from looking like two windows.
function toMs(value) {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 60000) * 60000 : 0;
}

// "Fable" and "Fable 5" are the same product meter; the account API has used
// both display names. Keep one identity so a rename never splits the history.
function scopedModelKey(displayName) {
  return String(displayName || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-?\d+(\.\d+)?$/, '')
    .replace(/[^a-z0-9-]/g, '') || 'scoped';
}

function scopedModelLabel(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return 'Scoped model';
  return /^fable(\s*5)?$/i.test(name) ? 'Fable 5' : name;
}

function claudeMeters(limits) {
  // A stale snapshot is a snapshot Ember could not refresh, not a new reading.
  // Replaying it would stamp an outdated utilization onto the live window.
  if (!limits || !limits.ok || limits.stale || !limits.data) return [];
  const d = limits.data;
  const out = [];
  const seen = new Set();
  const add = (meter) => {
    if (meter.utilization == null || seen.has(meter.id)) return;
    seen.add(meter.id);
    out.push(meter);
  };

  if (d.five_hour) {
    add({
      id: 'claude|session',
      provider: 'claude',
      kind: 'session',
      label: 'Claude session · 5 hours',
      windowMinutes: CLAUDE_SESSION_MINUTES,
      utilization: pct(d.five_hour.utilization),
      resetsAt: toMs(d.five_hour.resets_at),
    });
  }
  if (d.seven_day) {
    add({
      id: 'claude|weekly',
      provider: 'claude',
      kind: 'weekly',
      label: 'Claude weekly · all models',
      windowMinutes: CLAUDE_WEEK_MINUTES,
      utilization: pct(d.seven_day.utilization),
      resetsAt: toMs(d.seven_day.resets_at),
    });
  }
  for (const [field, name] of [
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
    ['seven_day_fable', 'Fable 5'],
    ['seven_day_fable_5', 'Fable 5'],
  ]) {
    const v = d[field];
    if (!v || v.utilization == null) continue;
    add({
      id: `claude|weekly:${scopedModelKey(name)}`,
      provider: 'claude',
      kind: 'weekly-scoped',
      label: `Claude weekly · ${name}`,
      windowMinutes: CLAUDE_WEEK_MINUTES,
      utilization: pct(v.utilization),
      resetsAt: toMs(v.resets_at),
    });
  }
  // Newer payloads carry model-scoped quotas in a generic array rather than a
  // named field, so both shapes feed the same meter identity.
  for (const v of Array.isArray(d.limits) ? d.limits : []) {
    if (!v || v.percent == null) continue;
    if (v.kind === 'session') {
      add({
        id: 'claude|session',
        provider: 'claude',
        kind: 'session',
        label: 'Claude session · 5 hours',
        windowMinutes: CLAUDE_SESSION_MINUTES,
        utilization: pct(v.percent),
        resetsAt: toMs(v.resets_at),
      });
    } else if (v.kind === 'weekly_all') {
      add({
        id: 'claude|weekly',
        provider: 'claude',
        kind: 'weekly',
        label: 'Claude weekly · all models',
        windowMinutes: CLAUDE_WEEK_MINUTES,
        utilization: pct(v.percent),
        resetsAt: toMs(v.resets_at),
      });
    } else if (v.kind === 'weekly_scoped') {
      const display = v.scope && v.scope.model && v.scope.model.display_name;
      if (!display) continue;
      add({
        id: `claude|weekly:${scopedModelKey(display)}`,
        provider: 'claude',
        kind: 'weekly-scoped',
        label: `Claude weekly · ${scopedModelLabel(display)}`,
        windowMinutes: CLAUDE_WEEK_MINUTES,
        utilization: pct(v.percent),
        resetsAt: toMs(v.resets_at),
      });
    }
  }
  return out;
}

function codexMeters(limits) {
  if (!limits || !limits.ok || !Array.isArray(limits.windows)) return [];
  const out = [];
  const seen = new Set();
  for (const w of limits.windows) {
    if (!w || w.utilization == null) continue;
    // The window length is the stable identity: Codex renames the row (and
    // ChatGPT plan changes shift the label) while the meter stays the same.
    // A row that cannot supply one is skipped rather than filed under its
    // label, which would split one meter's history in two.
    const minutes = Number(w.windowMinutes) || 0;
    if (!minutes) continue;
    const id = `codex|${minutes}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      provider: 'codex',
      kind: minutes && minutes <= 720 ? 'session' : 'weekly',
      label: `Codex · ${w.name}`,
      windowMinutes: minutes,
      utilization: pct(w.utilization),
      resetsAt: toMs(w.resetsAt),
    });
  }
  return out;
}

/* ---------------- window instances ---------------- */

// A meter reading belongs to the window it says it belongs to. `resets_at` is
// the only stable identity both providers publish, so it decides the boundary;
// a utilization drop is the fallback for meters that omit a reset time.
function isSameInstance(instance, resetsAt, utilization) {
  if (instance.resetsAt && resetsAt) {
    return Math.abs(instance.resetsAt - resetsAt) <= RESET_MATCH_TOLERANCE_MS;
  }
  if (!instance.resetsAt && !resetsAt) return utilization + 5 >= instance.lastUtil;
  return false;
}

// Keep the shape of the burn curve without keeping every reading: once an
// instance is full, drop every second older sample and halve the resolution.
function pushSample(instance, ts, utilization) {
  const samples = instance.samples;
  const last = samples[samples.length - 1];
  if (last && ts - last[0] < SAMPLE_MIN_GAP_MS) {
    if (utilization === last[1]) return;
    // A change inside the sampling gap replaces the reading rather than
    // appending, so a burst of refreshes cannot flood the curve.
    last[0] = ts;
    last[1] = utilization;
    return;
  }
  samples.push([ts, utilization]);
  if (samples.length > MAX_SAMPLES) {
    const thinned = samples.filter((_, i) => i % 2 === 0 || i === samples.length - 1);
    instance.samples = thinned;
  }
}

function startInstance(meter, resetsAt, utilization, now) {
  const windowMs = (meter.windowMinutes || 0) * 60000;
  // The true window start is derived from the reset time, so the very first
  // window Ember sees is already measurable — usage history reaches back
  // further than the ledger does.
  const startedAt = resetsAt && windowMs ? resetsAt - windowMs : now;
  return {
    resetsAt,
    windowMinutes: meter.windowMinutes || 0,
    startedAt,
    firstSeenAt: now,
    lastSeenAt: now,
    firstUtil: utilization,
    peakUtil: utilization,
    lastUtil: utilization,
    // A window observed from its first moments is measured end to end. One
    // joined midstream still reports real usage, because `startedAt` is the
    // provider's own boundary rather than the moment Ember started looking.
    joinedLate: !(resetsAt && windowMs),
    samples: [[now, utilization]],
    closed: false,
  };
}

function observe(meter, reading, now) {
  const utilization = reading.utilization;
  if (utilization == null) return false;
  const resetsAt = reading.resetsAt || 0;
  const instances = meter.instances;
  const current = instances[instances.length - 1];

  if (current && !current.closed && isSameInstance(current, resetsAt, utilization)) {
    const changed = utilization !== current.lastUtil;
    current.lastSeenAt = now;
    current.lastUtil = utilization;
    if (utilization > current.peakUtil) current.peakUtil = utilization;
    pushSample(current, now, utilization);
    return changed;
  }

  if (current && !current.closed) {
    current.closed = true;
    // A window ends at its published reset time; without one, the last moment
    // it was still observed is the honest boundary.
    current.endedAt = current.resetsAt || current.lastSeenAt;
  }
  instances.push(startInstance(meter, resetsAt, utilization, now));
  if (instances.length > MAX_INSTANCES) instances.splice(0, instances.length - MAX_INSTANCES);
  return true;
}

function record(limits, now = Date.now()) {
  const readings = [
    ...claudeMeters(limits && limits.claude),
    ...codexMeters(limits && limits.codex),
  ];
  let dirty = false;
  for (const reading of readings) {
    let meter = meters.get(reading.id);
    if (!meter) {
      meter = {
        id: reading.id,
        provider: reading.provider,
        kind: reading.kind,
        label: reading.label,
        windowMinutes: reading.windowMinutes,
        instances: [],
      };
      meters.set(reading.id, meter);
      dirty = true;
    }
    // Labels follow the provider's current wording; the identity does not.
    if (meter.label !== reading.label) { meter.label = reading.label; dirty = true; }
    if (reading.windowMinutes && meter.windowMinutes !== reading.windowMinutes) {
      meter.windowMinutes = reading.windowMinutes;
      dirty = true;
    }
    if (observe(meter, reading, now)) dirty = true;
  }
  if (dirty) schedulePersist();
}

// Renderer view: the current window plus every completed one, newest first.
// Utilization only — the renderer pairs each window with its own usage.
function snapshot(now = Date.now()) {
  const out = [];
  for (const meter of meters.values()) {
    const instances = meter.instances;
    if (!instances.length) continue;
    const last = instances[instances.length - 1];
    // A window whose reset time has passed is finished even if no newer
    // reading has arrived yet (the app may have been asleep).
    const liveNow = !last.closed && (!last.resetsAt || last.resetsAt > now);
    const history = (liveNow ? instances.slice(0, -1) : instances)
      .map((i) => ({
        resetsAt: i.resetsAt,
        startedAt: i.startedAt,
        endedAt: i.endedAt || i.resetsAt || i.lastSeenAt,
        windowMinutes: i.windowMinutes || meter.windowMinutes,
        peakUtil: i.peakUtil,
        firstUtil: i.firstUtil,
        joinedLate: !!i.joinedLate,
        observedFor: Math.max(0, i.lastSeenAt - i.firstSeenAt),
      }))
      .reverse();
    out.push({
      id: meter.id,
      provider: meter.provider,
      kind: meter.kind,
      label: meter.label,
      windowMinutes: meter.windowMinutes,
      current: liveNow ? {
        resetsAt: last.resetsAt,
        startedAt: last.startedAt,
        endedAt: now,
        windowMinutes: last.windowMinutes || meter.windowMinutes,
        peakUtil: last.peakUtil,
        firstUtil: last.firstUtil,
        joinedLate: !!last.joinedLate,
        samples: last.samples,
      } : null,
      history,
    });
  }
  return { meters: out, generatedAt: now };
}

// Test seam: drive the ledger without touching the filesystem or the clock.
function _reset(state = null) {
  meters = new Map();
  if (state) for (const meter of state) meters.set(meter.id, normalizeStoredMeter(meter));
}

module.exports = {
  init,
  record,
  snapshot,
  claudeMeters,
  codexMeters,
  scopedModelKey,
  _reset,
  CLAUDE_SESSION_MINUTES,
  CLAUDE_WEEK_MINUTES,
};
