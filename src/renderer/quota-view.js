'use strict';

/* Quota view — what a session, and a percent of plan, actually bought.

   Two independent sources answer that, and they check each other:

   1. Reconstruction. A Claude session window opens on the first call and
      closes five hours later, anchored to the top of the hour — the account
      API's own reset times land exactly on the hour, which is what fixes the
      anchor here. That rule replays the entire local log history, so every
      past 5-hour block is measurable the moment Ember starts, with no waiting.

   2. Observation. The quota ledger remembers the windows Ember actually saw,
      each with the peak utilization the provider reported. Pairing a window
      with the usage recorded inside it gives the figure neither provider
      publishes: tokens, and API-equivalent value, per one percent of plan.

   Reconstruction covers all of history but knows nothing about percentages.
   Observation knows the percentages but only from the day Ember first ran.
   Together they show whether a plan's allowance is holding steady. */

(function initQuotaView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmberQuota = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const HOUR_MS = 3600 * 1000;
  const SESSION_MS = 5 * HOUR_MS;
  const WEEK_MS = 7 * 24 * HOUR_MS;

  // Both providers publish reset times on an exact hour boundary, so a window
  // starts at the top of the hour containing its first call.
  function floorToHour(ms) {
    return Math.floor(ms / HOUR_MS) * HOUR_MS;
  }

  // Buckets carry local wall-clock parts. Legacy cached records recovered from
  // deleted logs may only resolve to the hour; treating those as the top of
  // the hour keeps them inside the window they were billed in.
  function bucketTime(b) {
    const [year, month, day] = String(b && b.date).split('-').map(Number);
    if (!year || !month || !day) return NaN;
    const hour = Number.isInteger(b.hour) ? b.hour : 0;
    const minute = Number.isInteger(b.minute) ? b.minute : 0;
    return new Date(year, month - 1, day, hour, minute).getTime();
  }

  function newTotals() {
    return {
      cost: 0, costMin: 0, costMax: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      tokens: 0, msgs: 0, pricedCalls: 0, unpricedCalls: 0,
      estimated: false,
      models: new Map(),   // `provider|model` -> { provider, model, cost, tokens, msgs }
      sessions: new Set(),
    };
  }

  function addBucket(t, b) {
    const tokens = b.input + b.output + b.cacheRead + b.cacheWrite;
    t.cost += b.cost;
    t.costMin += b.costMin || 0;
    t.costMax += b.costMax || b.cost || 0;
    t.input += b.input;
    t.output += b.output;
    t.cacheRead += b.cacheRead;
    t.cacheWrite += b.cacheWrite;
    t.reasoning += b.reasoning || 0;
    t.tokens += tokens;
    t.msgs += b.msgs;
    t.pricedCalls += b.pricedCalls ?? (b.priced ? b.msgs : 0);
    t.unpricedCalls += b.unpricedCalls ?? (b.priced ? 0 : b.msgs);
    t.estimated = t.estimated || !!b.estimated;
    const key = `${b.provider}|${b.model}`;
    let m = t.models.get(key);
    if (!m) {
      m = { provider: b.provider, model: b.model, cost: 0, tokens: 0, msgs: 0 };
      t.models.set(key, m);
    }
    m.cost += b.cost;
    m.tokens += tokens;
    m.msgs += b.msgs;
    if (b.session) t.sessions.add(`${b.provider}|${b.session}`);
    return t;
  }

  // One pass, sorted once: every window view below reuses this timeline.
  function timeline(buckets, provider) {
    const rows = [];
    for (const b of buckets || []) {
      if (provider && b.provider !== provider) continue;
      const ts = bucketTime(b);
      if (!Number.isFinite(ts)) continue;
      rows.push({ ts, b });
    }
    rows.sort((a, z) => a.ts - z.ts);
    return rows;
  }

  function usageBetween(rows, from, to) {
    const t = newTotals();
    // `to` is exclusive so back-to-back windows never double-count a call.
    for (const { ts, b } of rows) {
      if (ts < from) continue;
      if (ts >= to) break;
      addBucket(t, b);
    }
    return t;
  }

  /* ---------------- reconstructed rolling session blocks ---------------- */

  // A block opens on its first call and runs a fixed length from the top of
  // that hour. Calls landing after it closes open the next one, which is why
  // idle time never produces empty blocks.
  //
  // That rule is the provider's, but replaying it drifts: Ember reads the
  // editor logs only, so a window the account opened from the web app starts
  // earlier than any call Ember can see, and every later boundary inherits the
  // error. Wherever the ledger actually watched a window, its boundaries
  // override the rule — reconstruction fills the past, observation corrects it.
  function sessionBlocks(buckets, opts = {}) {
    const windowMs = opts.windowMs || SESSION_MS;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || timeline(buckets, opts.provider);
    const anchors = (opts.anchors || [])
      .filter((a) => Number.isFinite(a.startedAt) && a.endsAt > a.startedAt)
      .sort((a, b) => a.startedAt - b.startedAt);
    const anchorAt = (ts) => {
      for (const a of anchors) {
        if (ts < a.startedAt) break;
        if (ts < a.endsAt) return a;
      }
      return null;
    };

    const blocks = [];
    let current = null;
    for (const { ts, b } of rows) {
      const anchor = anchorAt(ts);
      const anchorKey = anchor ? anchor.startedAt : null;
      if (!current || ts >= current.endsAt || current.anchorKey !== anchorKey) {
        // A rule-built block must not run past the moment a measured window
        // takes over, or the same call would sit in two windows.
        if (current && anchor && current.endsAt > anchor.startedAt) {
          current.endsAt = Math.max(current.startedAt + 1, anchor.startedAt);
        }
        current = {
          startedAt: anchor ? anchor.startedAt : floorToHour(ts),
          endsAt: anchor ? anchor.endsAt : floorToHour(ts) + windowMs,
          anchorKey,
          measured: !!anchor,
          firstCallAt: ts,
          lastCallAt: ts,
          totals: newTotals(),
        };
        blocks.push(current);
      }
      current.lastCallAt = ts;
      addBucket(current.totals, b);
    }
    for (const block of blocks) block.active = now < block.endsAt;
    const limit = opts.limit || 0;
    return limit > 0 ? blocks.slice(-limit) : blocks;
  }

  /* ---------------- anchored fixed periods (weeks) ---------------- */

  // Weekly quotas reset at a fixed hour assigned to the account, so periods
  // are walked back from a known reset rather than inferred from activity.
  function fixedPeriods(buckets, opts = {}) {
    const periodMs = opts.periodMs || WEEK_MS;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || timeline(buckets, opts.provider);
    if (!rows.length) return [];
    const anchor = Number.isFinite(opts.anchorMs) && opts.anchorMs > 0
      ? opts.anchorMs
      : floorToHour(now) + periodMs;
    const earliest = rows[0].ts;

    // Walk the anchor onto the period that contains "now" — a reset time can
    // be remembered from an older window, or point at a future reset.
    let end = anchor;
    let guard = 0;
    while (end <= now && guard++ < 520) end += periodMs;
    while (end - periodMs > now && guard++ < 520) end -= periodMs;
    const periods = [];
    const maxPeriods = Math.max(1, opts.limit || 26);
    while (end > earliest && periods.length < maxPeriods) {
      const start = end - periodMs;
      periods.push({
        startedAt: start,
        endsAt: end,
        active: now < end && now >= start,
        totals: usageBetween(rows, start, end),
      });
      end = start;
    }
    return periods.reverse().filter((p) => p.totals.msgs > 0 || p.active);
  }

  /* ---------------- observed quota windows ---------------- */

  function pctConsumed(win) {
    const peak = Number(win && win.peakUtil);
    return Number.isFinite(peak) ? Math.max(0, Math.min(100, peak)) : 0;
  }

  // Ember only reads Claude Code and Codex logs. A plan meter also counts the
  // web app and other surfaces, so a window's measured usage is a floor, and
  // the derived rate is "at least this much per percent".
  function rateFor(totals, percent) {
    if (!(percent > 0)) return null;
    return {
      percent,
      costPerPct: totals.cost / percent,
      tokensPerPct: totals.tokens / percent,
      projectedCost: (totals.cost / percent) * 100,
      projectedTokens: (totals.tokens / percent) * 100,
    };
  }

  // Each observed window is measured over the provider's own boundaries, so a
  // window Ember joined midstream still reports the whole window's usage.
  function quotaWindows(buckets, meter, opts = {}) {
    if (!meter) return [];
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || timeline(buckets, meter.provider);
    const source = [];
    if (meter.current) source.push({ ...meter.current, live: true });
    for (const w of meter.history || []) source.push({ ...w, live: false });

    const out = [];
    for (const w of source) {
      const startedAt = Number(w.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      const endsAt = Number(w.resetsAt) || Number(w.endedAt) || now;
      const totals = usageBetween(rows, startedAt, Math.min(endsAt, now));
      const percent = pctConsumed(w);
      out.push({
        startedAt,
        endsAt,
        live: !!w.live,
        joinedLate: !!w.joinedLate,
        percent,
        totals,
        rate: rateFor(totals, percent),
      });
    }
    // Newest first for the list; charts reverse as needed.
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, opts.limit || 60);
  }

  /* ---------------- pairing the two sources ---------------- */

  // A reconstructed block and an observed window describe the same stretch of
  // time from different directions. Where they line up, the observed window
  // wins outright: its boundaries are the provider's own, so the percentage
  // and the usage it is divided by are measured over the same interval.
  function attachObserved(blocks, windows, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || [];
    const pool = (windows || []).filter((w) => Number.isFinite(w.startedAt) && w.percent > 0);
    for (const block of blocks) {
      const span = Math.max(1, block.endsAt - block.startedAt);
      let best = null;
      let bestOverlap = 0;
      for (const w of pool) {
        const overlap = Math.min(block.endsAt, w.endsAt) - Math.max(block.startedAt, w.startedAt);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = w; }
      }
      // Blocks are already anchored to the windows Ember watched, so a real
      // pair overlaps almost exactly. Anything less is a neighbouring window,
      // and borrowing its percentage would invent a rate that was never real.
      if (!best || bestOverlap < span * 0.9) {
        block.percent = null;
        block.observed = false;
        block.rate = null;
        continue;
      }
      block.percent = best.percent;
      block.observed = true;
      block.observedFrom = best.startedAt;
      block.observedTo = best.endsAt;
      if (rows.length && (best.startedAt !== block.startedAt || best.endsAt !== block.endsAt)) {
        block.totals = usageBetween(rows, best.startedAt, Math.min(best.endsAt, now));
      }
      block.rate = rateFor(block.totals, best.percent);
    }
    return blocks;
  }

  /* ---------------- trend ---------------- */

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  // Split the series in half and compare the means. A single window is noisy;
  // a shifted allowance moves the whole recent half.
  function trend(values, opts = {}) {
    const clean = values.filter((v) => Number.isFinite(v) && v > 0);
    const minPerSide = opts.minPerSide || 3;
    if (clean.length < minPerSide * 2) {
      return { ok: false, samples: clean.length, needed: minPerSide * 2 };
    }
    const half = Math.floor(clean.length / 2);
    // `values` arrive oldest-first.
    const older = clean.slice(0, half);
    const recent = clean.slice(clean.length - half);
    const olderMean = mean(older);
    const recentMean = mean(recent);
    if (!(olderMean > 0)) return { ok: false, samples: clean.length, needed: minPerSide * 2 };
    const change = (recentMean - olderMean) / olderMean;
    return {
      ok: true,
      samples: clean.length,
      perSide: half,
      olderMean,
      recentMean,
      change,
      direction: Math.abs(change) < 0.08 ? 'steady' : change > 0 ? 'up' : 'down',
    };
  }

  // Spread of the series, as a share of its own mean — how repeatable a
  // session is, independent of its size.
  function variability(values) {
    const clean = values.filter((v) => Number.isFinite(v) && v > 0);
    if (clean.length < 2) return null;
    const avg = mean(clean);
    if (!(avg > 0)) return null;
    const varSum = clean.reduce((sum, v) => sum + (v - avg) * (v - avg), 0);
    return Math.sqrt(varSum / clean.length) / avg;
  }

  return {
    HOUR_MS,
    SESSION_MS,
    WEEK_MS,
    floorToHour,
    bucketTime,
    newTotals,
    addBucket,
    timeline,
    usageBetween,
    sessionBlocks,
    fixedPeriods,
    quotaWindows,
    attachObserved,
    rateFor,
    trend,
    variability,
    mean,
  };
}));
