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
  const RESET_TOLERANCE_MS = 90 * 1000;

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
    // The timeline is sorted, so the first call inside the range is found by
    // halving rather than by walking the whole history for every window.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts < from) lo = mid + 1;
      else hi = mid;
    }
    // `to` is exclusive so back-to-back windows never double-count a call.
    for (let i = lo; i < rows.length && rows[i].ts < to; i++) addBucket(t, rows[i].b);
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
    // Newest first: when two observed windows overlap (the provider replaced
    // one before it reset), the later one is the window the account is
    // actually metering, so it owns the shared hours.
    const anchorAt = (ts) => {
      for (let i = anchors.length - 1; i >= 0; i--) {
        const a = anchors[i];
        if (ts >= a.startedAt && ts < a.endsAt) return a;
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
        // A watched window rarely ends on the hour, least of all after a spent
        // reset, so the call that follows it must not open a block reaching
        // back across that boundary.
        const opensAt = Math.max(floorToHour(ts), current && current.endsAt <= ts ? current.endsAt : 0);
        current = {
          startedAt: anchor ? anchor.startedAt : opensAt,
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

  /* ---------------- quota periods (weeks) ---------------- */

  // A weekly quota runs on the provider's clock, not on activity. Where the
  // ledger watched a period, that period is used exactly as it was metered: a
  // reset spent mid-week can end one early and start the next on a new
  // cadence, and a fixed seven-day grid would cut straight through both. The
  // stretches nobody watched are cut into rule-length periods, counted back
  // from the watched boundary that follows them.
  function fixedPeriods(buckets, opts = {}) {
    const periodMs = opts.periodMs || WEEK_MS;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || timeline(buckets, opts.provider);
    if (!rows.length) return [];
    const earliest = rows[0].ts;
    const anchors = (opts.anchors || [])
      .filter((a) => Number.isFinite(a.startedAt) && a.endsAt > a.startedAt)
      .sort((a, b) => a.startedAt - b.startedAt);

    const spans = []; // newest first
    const walkBack = (from, floor, clip) => {
      let end = from;
      for (let guard = 0; end > floor && guard < 520; guard++) {
        const start = end - periodMs;
        spans.push({ startedAt: clip ? Math.max(start, floor) : start, endsAt: end, measured: false });
        end = start;
      }
    };

    if (!anchors.length) {
      // No window was ever watched: walk a remembered reset time (or, failing
      // that, the top of this hour) onto the period that contains "now".
      let end = Number.isFinite(opts.anchorMs) && opts.anchorMs > 0
        ? opts.anchorMs
        : floorToHour(now) + periodMs;
      let guard = 0;
      while (end <= now && guard++ < 520) end += periodMs;
      while (end - periodMs > now && guard++ < 520) end -= periodMs;
      walkBack(end, earliest, false);
    } else {
      // The newest watched period may have reset with nothing read since; the
      // same rule then runs forward from it to the present.
      const tail = [];
      let start = anchors[anchors.length - 1].endsAt;
      for (let guard = 0; start <= now && guard < 520; guard++) {
        tail.push({ startedAt: start, endsAt: start + periodMs, measured: false });
        start += periodMs;
      }
      spans.push(...tail.reverse());
      let ceiling = Infinity;
      for (let i = anchors.length - 1; i >= 0; i--) {
        const a = anchors[i];
        const endsAt = Math.min(a.endsAt, ceiling);
        if (endsAt > a.startedAt) spans.push({ startedAt: a.startedAt, endsAt, measured: true });
        ceiling = Math.min(ceiling, a.startedAt);
        if (i > 0) walkBack(ceiling, anchors[i - 1].endsAt, true);
        else walkBack(ceiling, earliest, false);
      }
    }

    spans.reverse();
    const periods = spans.map((span) => ({
      ...span,
      active: now >= span.startedAt && now < span.endsAt,
      totals: newTotals(),
    }));
    // Periods and calls are both in time order, so one pass files every call.
    let at = 0;
    for (const { ts, b } of rows) {
      while (at < periods.length && ts >= periods[at].endsAt) at++;
      if (at >= periods.length) break;
      if (ts >= periods[at].startedAt) addBucket(periods[at].totals, b);
    }
    return periods
      .filter((p) => p.totals.msgs > 0 || p.active)
      .slice(-Math.max(1, opts.limit || 26));
  }

  /* ---------------- observed quota windows ---------------- */

  // What a window consumed. A reset spent inside it hands quota back and the
  // ledger counts that too, so the figure passes 100 when one was used.
  function pctConsumed(win) {
    if (!win || win.peakUtil == null) return null;
    const peak = Number(win.peakUtil);
    return Number.isFinite(peak) ? Math.max(0, peak) : null;
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

  const larger = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

  // The ledger files a reading under the window it names, so one provider
  // window can sit in several entries: it was read, another window was read
  // for a while, and then it came back. They are one window, known by its
  // reset time.
  function mergeByReset(entries) {
    const merged = [];
    for (const w of entries) {
      const twin = w.resetsAt
        ? merged.find((m) => Math.abs(m.resetsAt - w.resetsAt) <= RESET_TOLERANCE_MS)
        : null;
      if (!twin) {
        merged.push({ ...w });
        continue;
      }
      twin.startedAt = Math.min(twin.startedAt, w.startedAt);
      twin.endsAt = Math.max(twin.endsAt, w.endsAt);
      twin.consumed = larger(twin.consumed, w.consumed);
      // One fully measured sighting makes the whole window measured.
      twin.measuredFrom = twin.measuredFrom == null || w.measuredFrom == null
        ? null : Math.min(twin.measuredFrom, w.measuredFrom);
      if (w.live) twin.reading = w.reading;
      twin.live = twin.live || w.live;
      twin.joinedLate = twin.joinedLate && w.joinedLate;
      twin.refills = Math.max(twin.refills, w.refills);
      twin.observedFor += w.observedFor;
    }
    return merged;
  }

  // One meter cannot be in two windows at once, so where two still overlap
  // only one of them is right about those hours. The live window is, then
  // whichever was watched longest: a window read for days outranks one that
  // showed up for two minutes, which is what another quota's reading filed
  // under this meter looks like. With nothing else to go on, the later start
  // wins, because that is the window the provider moved to. A window that
  // starts inside a better one is dropped; one that merely runs into it ends
  // where the better one begins, and if that costs it more than a sliver its
  // percentage no longer describes the hours it has left.
  function settleOverlaps(windows) {
    const order = [...windows].sort((a, b) =>
      (Number(b.live) - Number(a.live))
      || (b.observedFor - a.observedFor)
      || (b.startedAt - a.startedAt));
    const kept = [];
    for (const w of order) {
      let endsAt = w.endsAt;
      let inside = false;
      for (const k of kept) {
        if (w.startedAt >= k.startedAt && w.startedAt < k.endsAt) { inside = true; break; }
        if (k.startedAt > w.startedAt && k.startedAt < endsAt) endsAt = k.startedAt;
      }
      if (inside || endsAt <= w.startedAt) continue;
      const cut = (endsAt - w.startedAt) < (w.endsAt - w.startedAt) * 0.9;
      kept.push(endsAt === w.endsAt ? w : { ...w, endsAt, cut });
    }
    return kept;
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

    const entries = [];
    for (const w of source) {
      const startedAt = Number(w.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      const resetsAt = Number(w.resetsAt) || 0;
      // A live window runs to its reset. A finished one ends where the ledger
      // says it ended, which is earlier than the reset when the provider
      // replaced it midstream, and it cannot still be running.
      const endsAt = w.live
        ? (resetsAt || now)
        : Math.min(Number(w.endedAt) || resetsAt || now, now);
      const peak = pctConsumed(w);
      // An earlier build threw away the start of a window whose meter dropped
      // and kept only what followed, counted up from the reading it fell to.
      const tail = w.measuredFrom != null && Number.isFinite(Number(w.measuredFrom));
      const lastUtil = w.lastUtil == null ? NaN : Number(w.lastUtil);
      entries.push({
        startedAt,
        endsAt,
        resetsAt,
        live: !!w.live,
        joinedLate: !!w.joinedLate,
        measuredFrom: tail ? Number(w.measuredFrom) : null,
        consumed: peak != null && tail ? Math.max(0, peak - (Number(w.baseline) || 0)) : peak,
        reading: !w.live ? null : Number.isFinite(lastUtil) ? lastUtil : peak,
        refills: Number(w.refills) || 0,
        observedFor: Number(w.observedFor) || 0,
      });
    }

    // Newest first for the list; charts reverse as needed.
    const windows = settleOverlaps(mergeByReset(entries))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts.limit || 60);
    return windows.map((w) => {
      const upTo = Math.min(w.endsAt, now);
      const totals = usageBetween(rows, w.startedAt, upTo);
      const tail = !w.cut && w.measuredFrom != null;
      // The tail still gives an honest rate: its own usage over the percent
      // it consumed.
      const rated = tail ? usageBetween(rows, w.measuredFrom, upTo) : totals;
      return {
        startedAt: w.startedAt,
        endsAt: w.endsAt,
        live: w.live,
        joinedLate: w.joinedLate,
        // Consumed percent of the whole window; unknown when only its tail
        // was measured, or when it lost most of its hours to another window.
        percent: tail || w.cut ? null : w.consumed,
        // What the meter reads right now. It parts from `percent` once a
        // reset has been spent.
        reading: w.reading,
        refills: w.refills,
        measuredFrom: tail ? w.measuredFrom : null,
        totals,
        rate: w.cut ? null : rateFor(rated, w.consumed),
      };
    });
  }

  /* The Codex ledger answers to whichever snapshot was read last, and an
     earlier parser filed model-specific meters (notably Spark) under the
     account-wide id. Current account telemetry therefore decides whether the
     scope exists at all and which window is the live one. Everything else is
     history, and quotaWindows settles whatever overlaps in it. History is not
     held to the live window's cadence: a spent reset starts the next window
     on the spot, and an idle account starts one at its next call. */
  function reconcileCodexMeter(meter, limitWindow, opts = {}) {
    if (!meter || !limitWindow) return null;
    const windowMinutes = Number(limitWindow.windowMinutes);
    const meterMinutes = Number(meter.windowMinutes);
    if (!(windowMinutes > 0) || meterMinutes !== windowMinutes) return null;

    const anchor = typeof limitWindow.resetsAt === 'number'
      ? limitWindow.resetsAt : Date.parse(limitWindow.resetsAt || '');
    if (!Number.isFinite(anchor) || anchor <= 0) return meter;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const instances = [meter.current, ...(meter.history || [])].filter(Boolean);
    const current = anchor > now
      ? instances.find((i) => Math.abs(Number(i.resetsAt) - anchor) <= RESET_TOLERANCE_MS) || null
      : null;
    return {
      ...meter,
      current,
      history: instances.filter((instance) => instance !== current),
    };
  }

  /* ---------------- pairing the two sources ---------------- */

  // A reconstructed block and an observed window describe the same stretch of
  // time from different directions. Where they line up, the observed window
  // wins outright: its boundaries are the provider's own, so the percentage
  // and the usage it is divided by are measured over the same interval.
  function attachObserved(blocks, windows, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const rows = opts.rows || [];
    const pool = (windows || []).filter((w) =>
      Number.isFinite(w.startedAt) && (Number.isFinite(w.percent) || w.measuredFrom != null));
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
      block.reading = Number.isFinite(best.reading) ? best.reading : null;
      block.refills = best.refills || 0;
      block.measuredFrom = best.measuredFrom == null ? null : best.measuredFrom;
      block.observed = true;
      block.observedFrom = best.startedAt;
      block.observedTo = best.endsAt;
      // Only the tail of this window was measured. The block keeps the whole
      // window's usage; the rate is the tail's own.
      if (block.measuredFrom != null) {
        block.rate = best.rate || null;
        continue;
      }
      // A block built on this window already has its boundaries — possibly cut
      // short where a newer window took over — so only a rule-built block is
      // re-measured over the provider's interval.
      if (rows.length && !block.measured
        && (best.startedAt !== block.startedAt || best.endsAt !== block.endsAt)) {
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

  /* ---------------- Claude's optional five-hour limit ---------------- */

  // Since 30 Oct 2026 a verified Ultra account (the plan that was Max 20x)
  // has no five-hour limit: the account API stops publishing a session window
  // and only the weekly ones remain. Returns:
  //   { known: false }               — no usable account telemetry
  //   { known: true, window: null }  — telemetry says there is no session limit
  //   { known: true, window: {...} } — the session limit, as { utilization, resets_at }
  function claudeSessionLimit(limits) {
    const d = limits && limits.ok && limits.data;
    if (!d || typeof d !== 'object') return { known: false, window: null };
    const list = Array.isArray(d.limits) ? d.limits.filter(Boolean) : [];
    if (d.five_hour) {
      return {
        known: true,
        window: { utilization: d.five_hour.utilization, resets_at: d.five_hour.resets_at },
      };
    }
    const entry = list.find((v) => v.kind === 'session');
    if (entry) {
      return { known: true, window: { utilization: entry.percent, resets_at: entry.resets_at } };
    }
    // Only a payload that still carries the weekly limit proves the session
    // one is gone; an empty or unfamiliar payload proves nothing.
    const hasWeekly = !!d.seven_day || list.some((v) => v.kind === 'weekly_all');
    return { known: hasWeekly, window: null };
  }

  return {
    HOUR_MS,
    SESSION_MS,
    claudeSessionLimit,
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
    reconcileCodexMeter,
    attachObserved,
    rateFor,
    trend,
    variability,
    mean,
  };
}));
