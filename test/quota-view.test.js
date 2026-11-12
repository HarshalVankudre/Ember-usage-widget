'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../src/renderer/quota-view');

const HOUR = 3600 * 1000;

function at(date, hour, minute) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute).getTime();
}

function bucket(date, hour, minute, over = {}) {
  return {
    provider: 'claude',
    date,
    hour,
    minute,
    model: 'claude-opus-5',
    project: 'app',
    session: 'sess-1',
    msgs: 1,
    input: 1000,
    output: 500,
    cacheRead: 4000,
    cacheWrite: 0,
    reasoning: 0,
    cost: 1,
    costMin: 1,
    costMax: 1,
    priced: true,
    pricedCalls: 1,
    unpricedCalls: 0,
    estimated: false,
    ...over,
  };
}

test('a session block is anchored to the top of its first call hour', () => {
  const buckets = [bucket('2026-07-20', 9, 42)];
  const [block] = Q.sessionBlocks(buckets, { now: at('2026-07-20', 10, 0) });

  assert.equal(block.startedAt, Q.floorToHour(at('2026-07-20', 9, 42)));
  assert.equal(block.endsAt - block.startedAt, 5 * HOUR);
  assert.equal(block.firstCallAt, at('2026-07-20', 9, 42));
  assert.equal(block.active, true);
});

test('calls inside the five-hour window join the same block; a later call opens the next', () => {
  const buckets = [
    bucket('2026-07-20', 9, 5),
    bucket('2026-07-20', 13, 30),  // 9:00 block runs to 14:00 — still inside
    bucket('2026-07-20', 14, 10),  // first call after it closes
  ];
  const blocks = Q.sessionBlocks(buckets, { now: at('2026-07-20', 23, 0) });

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].totals.msgs, 2);
  assert.equal(blocks[1].totals.msgs, 1);
  assert.equal(blocks[1].startedAt, Q.floorToHour(at('2026-07-20', 14, 10)));
  // A closed block reports as closed even while the next one is live.
  assert.equal(blocks[0].active, false);
});

test('blocks separate the providers so one plan meter never counts the other', () => {
  const buckets = [
    bucket('2026-07-20', 9, 0),
    bucket('2026-07-20', 9, 30, { provider: 'codex', model: 'gpt-5.6' }),
  ];

  const claude = Q.sessionBlocks(buckets, { provider: 'claude', now: at('2026-07-20', 10, 0) });
  const codex = Q.sessionBlocks(buckets, { provider: 'codex', now: at('2026-07-20', 10, 0) });

  assert.equal(claude.length, 1);
  assert.equal(claude[0].totals.msgs, 1);
  assert.equal(codex[0].totals.msgs, 1);
  assert.equal(codex[0].totals.models.get('codex|gpt-5.6').msgs, 1);
});

test('records recovered without minute precision stay inside their billed hour', () => {
  const buckets = [bucket('2026-07-20', 9, null)];
  const [block] = Q.sessionBlocks(buckets, { now: at('2026-07-20', 12, 0) });

  assert.equal(Q.bucketTime(buckets[0]), at('2026-07-20', 9, 0));
  assert.equal(block.startedAt, Q.floorToHour(at('2026-07-20', 9, 0)));
});

test('window usage is measured over the provider boundaries, not when Ember started looking', () => {
  const start = at('2026-07-20', 9, 0);
  const buckets = [
    bucket('2026-07-20', 9, 10),   // before Ember first saw the meter
    bucket('2026-07-20', 12, 0),
  ];
  const meter = {
    provider: 'claude',
    current: {
      startedAt: start,
      resetsAt: start + 5 * HOUR,
      peakUtil: 40,
      joinedLate: false,
    },
    history: [],
  };

  const [win] = Q.quotaWindows(buckets, meter, { now: at('2026-07-20', 13, 0) });

  assert.equal(win.totals.msgs, 2, 'usage before the first meter reading is still inside the window');
  assert.equal(win.percent, 40);
  assert.equal(win.rate.costPerPct, 2 / 40);
  assert.equal(win.rate.projectedCost, (2 / 40) * 100);
});

test('a reported zero-percent window stays observed without dividing by zero', () => {
  const start = at('2026-07-20', 9, 0);
  const meter = {
    provider: 'claude',
    current: { startedAt: start, resetsAt: start + 5 * HOUR, peakUtil: 0 },
    history: [],
  };

  const [win] = Q.quotaWindows([bucket('2026-07-20', 9, 10)], meter, { now: at('2026-07-20', 10, 0) });

  assert.equal(win.percent, 0);
  assert.equal(win.rate, null);

  const block = {
    startedAt: start,
    endsAt: start + 5 * HOUR,
    totals: win.totals,
  };
  Q.attachObserved([block], [win], { now: at('2026-07-20', 10, 0) });
  assert.equal(block.observed, true);
  assert.equal(block.percent, 0);
  assert.equal(block.rate, null);
});

test('an absent utilization remains distinct from a real zero-percent reading', () => {
  const start = at('2026-07-20', 9, 0);
  const meter = {
    provider: 'claude',
    current: { startedAt: start, resetsAt: start + 5 * HOUR },
    history: [],
  };
  const [win] = Q.quotaWindows([], meter, { now: at('2026-07-20', 10, 0) });
  assert.equal(win.percent, null);
  assert.equal(win.rate, null);
});

test('back-to-back windows never count the same call twice', () => {
  const start = at('2026-07-20', 9, 0);
  const boundary = start + 5 * HOUR; // 14:00
  const buckets = [bucket('2026-07-20', 14, 0)];
  const meter = {
    provider: 'claude',
    current: { startedAt: boundary, resetsAt: boundary + 5 * HOUR, peakUtil: 10 },
    history: [{ startedAt: start, resetsAt: boundary, endedAt: boundary, peakUtil: 100 }],
  };

  const [live, previous] = Q.quotaWindows(buckets, meter, { now: at('2026-07-20', 15, 0) });

  assert.equal(live.totals.msgs, 1, 'a call at the boundary belongs to the window it opens');
  assert.equal(previous.totals.msgs, 0);
});

test('weekly periods walk back from the account reset anchor', () => {
  const anchor = at('2026-07-25', 4, 0); // the account's weekly reset
  const buckets = [
    bucket('2026-07-20', 9, 0),   // current week
    bucket('2026-07-15', 9, 0),   // previous week
  ];

  const periods = Q.fixedPeriods(buckets, {
    anchorMs: anchor,
    periodMs: 7 * 24 * HOUR,
    now: at('2026-07-22', 12, 0),
  });

  assert.equal(periods.length, 2);
  assert.equal(periods[1].endsAt, anchor, 'the newest period ends at the next reset');
  assert.equal(periods[1].active, true);
  assert.equal(periods[0].endsAt, anchor - 7 * 24 * HOUR);
  assert.equal(periods[0].active, false);
});

test('a stale anchor is walked forward onto the period containing now', () => {
  const staleAnchor = at('2026-06-06', 4, 0);
  const buckets = [bucket('2026-07-20', 9, 0)];

  const periods = Q.fixedPeriods(buckets, {
    anchorMs: staleAnchor,
    periodMs: 7 * 24 * HOUR,
    now: at('2026-07-22', 12, 0),
  });

  const live = periods[periods.length - 1];
  assert.equal(live.active, true);
  assert.ok(live.startedAt <= at('2026-07-22', 12, 0) && live.endsAt > at('2026-07-22', 12, 0));
  // The anchor's weekly phase is preserved across the walk.
  assert.equal((live.endsAt - staleAnchor) % (7 * 24 * HOUR), 0);
});

test('trend compares the recent half against the older half', () => {
  const shrinking = [100, 104, 96, 100, 62, 58, 60, 60];
  const result = Q.trend(shrinking);

  assert.equal(result.ok, true);
  assert.equal(result.perSide, 4);
  assert.equal(result.direction, 'down');
  assert.ok(result.change < -0.3, `expected a clear drop, got ${result.change}`);
});

test('trend stays silent until there are enough windows to compare', () => {
  const result = Q.trend([100, 90, 110, 95]);

  assert.equal(result.ok, false);
  assert.equal(result.needed, 6);
});

test('a run of similar windows reads as steady rather than as a change', () => {
  const result = Q.trend([100, 103, 98, 101, 99, 102, 100, 104]);

  assert.equal(result.direction, 'steady');
});

test('variability reports spread relative to the size of a typical window', () => {
  assert.equal(Q.variability([50, 50, 50, 50]), 0);
  assert.ok(Q.variability([10, 90, 10, 90]) > 0.5);
  assert.equal(Q.variability([42]), null);
});

test('a watched window overrides the boundary the replay rule would have guessed', () => {
  // Replay alone chains 20:00–01:00 and then 01:00–06:00. The account actually
  // opened its window at 23:00, from work Ember cannot see.
  const buckets = [
    bucket('2026-07-24', 20, 10),
    bucket('2026-07-25', 1, 30),
  ];
  const anchors = [{
    startedAt: at('2026-07-24', 23, 0),
    endsAt: at('2026-07-25', 4, 0),
    percent: 35,
  }];

  const blocks = Q.sessionBlocks(buckets, { now: at('2026-07-25', 2, 0), anchors });

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].endsAt, at('2026-07-24', 23, 0), 'the guessed block stops where the measured one begins');
  assert.equal(blocks[0].measured, false);
  assert.equal(blocks[1].startedAt, at('2026-07-24', 23, 0));
  assert.equal(blocks[1].endsAt, at('2026-07-25', 4, 0));
  assert.equal(blocks[1].measured, true);
  assert.equal(blocks[1].totals.msgs, 1, 'the 01:30 call belongs to the measured window only');
});

test('a neighbouring window never lends its percentage to a block it only half covers', () => {
  const block = {
    startedAt: at('2026-07-25', 1, 0),
    endsAt: at('2026-07-25', 6, 0),
    totals: Q.newTotals(),
  };

  Q.attachObserved([block], [{
    startedAt: at('2026-07-24', 23, 0),
    endsAt: at('2026-07-25', 4, 0),
    percent: 35,
  }], { now: at('2026-07-25', 2, 0) });

  assert.equal(block.observed, false);
  assert.equal(block.percent, null);
  assert.equal(block.rate, null);
});

test('a reset spent mid-week leaves the week whole and counts what it handed back', () => {
  // Seen in the field on 12 Nov 2026: the weekly meter fell to 30% when a
  // reset was spent, and the published reset time stayed where it was.
  const reset = at('2026-11-14', 5, 0);
  const weekStart = reset - 7 * 24 * HOUR;
  const rows = Q.timeline([
    bucket('2026-11-09', 10, 0, { cost: 720 }),  // before the reset was spent
    bucket('2026-11-12', 17, 0, { cost: 110 }),  // after it
  ], 'claude');
  const now = at('2026-11-12', 18, 0);
  const meter = {
    provider: 'claude',
    // 72% before the reset, 41 - 30 = 11% since: 83% consumed, meter at 41%.
    current: { startedAt: weekStart, resetsAt: reset, peakUtil: 83, lastUtil: 41, credited: 42, refills: 1 },
    history: [],
  };
  const windows = Q.quotaWindows(null, meter, { rows, now });
  const periods = Q.fixedPeriods(null, { rows, periodMs: 7 * 24 * HOUR, anchors: windows, now });
  Q.attachObserved(periods, windows, { rows, now });

  assert.equal(periods.length, 1);
  const [live] = periods;
  assert.equal(live.active, true);
  assert.equal(live.startedAt, weekStart, 'the week still starts where the provider started it');
  assert.equal(live.totals.cost, 830, 'and still holds everything used in it');
  assert.equal(live.percent, 83);
  assert.equal(live.reading, 41, 'the bar shows what the meter reads');
  assert.equal(live.refills, 1);
  assert.equal(live.rate.costPerPct, 10, 'one percent buys the same before and after');
  assert.equal(live.rate.projectedCost, 1000);
});

test('a window an earlier build restarted is shown whole and rated on what it kept', () => {
  // The build before this one answered the same drop by discarding the week
  // so far. The 72% is gone; the stretch after the drop is still measurable.
  const reset = at('2026-11-14', 5, 0);
  const weekStart = reset - 7 * 24 * HOUR;
  const drop = at('2026-11-12', 16, 38);
  const rows = Q.timeline([
    bucket('2026-11-09', 10, 0, { cost: 720 }),
    bucket('2026-11-12', 17, 0, { cost: 40 }),
  ], 'claude');
  const now = at('2026-11-12', 18, 0);
  const meter = {
    provider: 'claude',
    current: {
      startedAt: weekStart, resetsAt: reset, peakUtil: 34, lastUtil: 34,
      restarted: true, measuredFrom: drop, baseline: 30,
    },
    history: [],
  };
  const windows = Q.quotaWindows(null, meter, { rows, now });
  const periods = Q.fixedPeriods(null, { rows, periodMs: 7 * 24 * HOUR, anchors: windows, now });
  Q.attachObserved(periods, windows, { rows, now });

  const [live] = periods;
  assert.equal(live.startedAt, weekStart);
  assert.equal(live.totals.cost, 760, 'the whole week, not only the hours since the drop');
  assert.equal(live.percent, null, 'what the week consumed in all is no longer known');
  assert.equal(live.reading, 34);
  assert.equal(live.measuredFrom, drop);
  assert.equal(live.rate.costPerPct, 40 / 4, 'usage since the drop over the 4% consumed since');
});

test('a reset that opens a new week ends the old one there, and both keep their figures', () => {
  // Codex answers a spent reset with a fresh window: 0% and a reset time a
  // full week away from that moment, off the cadence of every week before it.
  const firstStart = at('2026-10-29', 22, 35);
  const spentAt = at('2026-11-01', 1, 40);
  const week = 7 * 24 * HOUR;
  const rows = Q.timeline([
    bucket('2026-10-26', 12, 0, { provider: 'codex', cost: 5 }),   // before Ember watched
    bucket('2026-10-30', 12, 0, { provider: 'codex', cost: 400 }),
    bucket('2026-11-02', 12, 0, { provider: 'codex', cost: 60 }),
  ], 'codex');
  const now = at('2026-11-03', 12, 0);
  const ledger = {
    provider: 'codex',
    kind: 'weekly',
    windowMinutes: 10080,
    current: { startedAt: spentAt, resetsAt: spentAt + week, peakUtil: 20, lastUtil: 20 },
    history: [
      { startedAt: firstStart, resetsAt: firstStart + week, endedAt: spentAt, peakUtil: 100 },
    ],
  };
  const meter = Q.reconcileCodexMeter(ledger, {
    windowMinutes: 10080,
    resetsAt: new Date(spentAt + week).toISOString(),
  }, { now });
  assert.equal(meter.history.length, 1, 'the week before the reset is history, not a foreign schedule');

  const windows = Q.quotaWindows(null, meter, { rows, now });
  const periods = Q.fixedPeriods(null, { rows, periodMs: week, anchors: windows, now });
  Q.attachObserved(periods, windows, { rows, now });

  assert.equal(periods.length, 3);
  const [unwatched, cutShort, live] = periods;
  assert.equal(unwatched.endsAt, firstStart, 'unwatched weeks are counted back from the first watched one');
  assert.equal(unwatched.percent, null);
  assert.equal(cutShort.startedAt, firstStart);
  assert.equal(cutShort.endsAt, spentAt, 'the old week ends where the reset was spent');
  assert.equal(cutShort.percent, 100);
  assert.equal(cutShort.rate.costPerPct, 4);
  assert.equal(live.startedAt, spentAt);
  assert.equal(live.endsAt, spentAt + week);
  assert.equal(live.active, true);
  assert.equal(live.percent, 20);
  assert.equal(live.rate.costPerPct, 3);
});

test('a session window that ends off the hour is not overlapped by the block after it', () => {
  // A reset spent at 22:29 puts every following window on :29.
  const window = { startedAt: at('2026-11-08', 15, 25), endsAt: at('2026-11-08', 20, 25), percent: 12 };
  const rows = Q.timeline([
    bucket('2026-11-08', 16, 0),
    bucket('2026-11-08', 20, 26),
  ], 'claude');
  const now = at('2026-11-08', 21, 0);
  const blocks = Q.sessionBlocks(null, { rows, now, anchors: [window] });
  Q.attachObserved(blocks, [window], { rows, now });

  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].startedAt, at('2026-11-08', 20, 25));
  assert.equal(blocks[1].percent, null, 'and does not borrow the finished window\'s percentage');
});

test('an exactly matching window supplies both the percentage and the rate', () => {
  const window = { startedAt: at('2026-07-25', 1, 0), endsAt: at('2026-07-25', 6, 0), percent: 20 };
  const rows = Q.timeline([bucket('2026-07-25', 1, 0, { cost: 4 })], 'claude');
  const blocks = Q.sessionBlocks(null, { rows, now: at('2026-07-25', 2, 0), anchors: [window] });

  Q.attachObserved(blocks, [window], { rows, now: at('2026-07-25', 2, 0) });

  assert.equal(blocks[0].measured, true);
  assert.equal(blocks[0].percent, 20);
  assert.equal(blocks[0].rate.costPerPct, 4 / 20);
  assert.equal(blocks[0].rate.projectedCost, 20);
});

test('Codex session burn follows the active account window, not the last reading filed', () => {
  const hour = 3600 * 1000;
  const week = 7 * 24 * hour;
  const now = at('2026-07-20', 12, 0);
  const accountReset = now + 2 * hour;
  const foreignReset = now + week;
  const meter = {
    provider: 'codex',
    kind: 'weekly',
    windowMinutes: 10080,
    // Another quota's reading, filed last, so the ledger calls it current.
    current: {
      startedAt: foreignReset - week,
      resetsAt: foreignReset,
      endedAt: now,
      peakUtil: 0,
    },
    history: [
      { startedAt: accountReset - week, resetsAt: accountReset, endedAt: now - hour, peakUtil: 68, observedFor: 30 * hour },
      { startedAt: accountReset - week, resetsAt: accountReset, endedAt: now, peakUtil: 69, observedFor: 20 * hour },
    ],
  };
  const fixed = Q.reconcileCodexMeter(meter, {
    windowMinutes: 10080,
    resetsAt: new Date(accountReset).toISOString(),
  }, { now });

  assert.equal(fixed.current.resetsAt, accountReset);
  const windows = Q.quotaWindows([], fixed, { now });
  assert.equal(windows.length, 1, 'sightings of one window fold together, and the foreign one has no hours');
  assert.equal(windows[0].live, true);
  assert.equal(windows[0].percent, 69);
  assert.equal(windows[0].endsAt, accountReset);
  assert.equal(
    Q.reconcileCodexMeter(meter, null, { now }),
    null,
    'a retained 5h meter cannot create a scope absent from current account telemetry',
  );
});

test('a quota read for two minutes cannot break up the week it was read in', () => {
  const start = at('2026-08-14', 1, 0);
  const week = 7 * 24 * HOUR;
  const blip = at('2026-08-19', 22, 8);
  const meter = {
    provider: 'codex',
    current: null,
    history: [
      // The real week, read before and after the stray reading.
      { startedAt: start, resetsAt: start + week, endedAt: blip, peakUtil: 40, observedFor: 100 * HOUR },
      { startedAt: blip, resetsAt: blip + week, endedAt: blip + week, peakUtil: 0, observedFor: 2 * 60 * 1000 },
      { startedAt: start, resetsAt: start + week, endedAt: start + week, peakUtil: 76, observedFor: 30 * HOUR },
    ],
  };
  const windows = Q.quotaWindows([], meter, { now: at('2026-09-10', 12, 0) });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].startedAt, start);
  assert.equal(windows[0].endsAt, start + week);
  assert.equal(windows[0].percent, 76);
});

test('a verified Ultra account has no five-hour limit, and only real telemetry can say so', () => {
  const weekly = { utilization: 40, resets_at: '2026-11-14T03:59:59Z' };

  // Unverified (or any other plan): the session window is published.
  const metered = Q.claudeSessionLimit({
    ok: true,
    data: { five_hour: { utilization: 12, resets_at: '2026-11-10T19:59:59Z' }, seven_day: weekly },
  });
  assert.deepEqual(metered, {
    known: true,
    window: { utilization: 12, resets_at: '2026-11-10T19:59:59Z' },
  });

  // An idle account still has the limit, just no open window.
  assert.equal(Q.claudeSessionLimit({
    ok: true, data: { five_hour: { utilization: 0, resets_at: null }, seven_day: weekly },
  }).window.utilization, 0);

  // The generic limits array alone is enough.
  assert.deepEqual(Q.claudeSessionLimit({
    ok: true,
    data: { five_hour: null, limits: [{ kind: 'session', percent: 7, resets_at: 'x' }] },
  }), { known: true, window: { utilization: 7, resets_at: 'x' } });

  // Verified Ultra: weekly limits only.
  assert.deepEqual(Q.claudeSessionLimit({
    ok: true,
    data: { five_hour: null, seven_day: weekly, limits: [{ kind: 'weekly_all', percent: 40 }] },
  }), { known: true, window: null });
  assert.deepEqual(Q.claudeSessionLimit({
    ok: true, data: { limits: [{ kind: 'weekly_all', percent: 40 }] },
  }), { known: true, window: null });

  // Missing, failed or empty telemetry proves nothing about the limit.
  for (const unknown of [null, undefined, { ok: false, reason: 'network' }, { ok: true }, { ok: true, data: {} }]) {
    assert.deepEqual(Q.claudeSessionLimit(unknown), { known: false, window: null });
  }
});

test('Codex rolling session history is not forced onto the current five-hour cadence', () => {
  const now = at('2026-07-20', 12, 0);
  const activeReset = now + HOUR;
  const oldReset = activeReset - 7 * HOUR; // deliberately not a multiple of 5h
  const meter = {
    provider: 'codex',
    kind: 'session',
    windowMinutes: 300,
    current: { startedAt: activeReset - 5 * HOUR, resetsAt: activeReset, peakUtil: 12 },
    history: [{ startedAt: oldReset - 5 * HOUR, resetsAt: oldReset, peakUtil: 88 }],
  };
  const fixed = Q.reconcileCodexMeter(meter, {
    windowMinutes: 300,
    resetsAt: new Date(activeReset).toISOString(),
  }, { now });

  assert.equal(fixed.current.peakUtil, 12);
  assert.equal(fixed.history.length, 1);
  assert.equal(fixed.history[0].peakUtil, 88);
});

test('a window the provider replaced before its reset hands the shared hours to its successor', () => {
  // Seen in the field: the account published a 19:50–00:50 window at 2%, then
  // an hour later a fresh 20:50–01:50 window that climbed to 89%. Every call
  // after 20:50 belongs to the second window, and the second window is the
  // live one.
  const meter = {
    provider: 'claude',
    current: { startedAt: at('2026-09-01', 20, 50), resetsAt: at('2026-09-02', 1, 50), peakUtil: 89 },
    history: [
      // An older ledger let the replaced window run on to its published reset.
      { startedAt: at('2026-09-01', 19, 50), resetsAt: at('2026-09-02', 0, 50), endedAt: at('2026-09-02', 0, 50), peakUtil: 2 },
    ],
  };
  const buckets = [
    bucket('2026-09-01', 19, 55),
    bucket('2026-09-01', 21, 0),
    bucket('2026-09-01', 23, 0, { cost: 40 }),
  ];
  const now = at('2026-09-02', 0, 20);
  const rows = Q.timeline(buckets, 'claude');
  const windows = Q.quotaWindows(null, meter, { rows, now });
  const blocks = Q.sessionBlocks(null, { rows, now, anchors: windows });
  Q.attachObserved(blocks, windows, { rows, now });

  assert.equal(blocks.length, 2);
  const [old, live] = blocks;
  assert.equal(old.active, false);
  assert.equal(old.totals.msgs, 1);
  assert.equal(live.active, true);
  assert.equal(live.startedAt, at('2026-09-01', 20, 50));
  assert.equal(live.percent, 89);
  assert.equal(live.totals.msgs, 2);
  assert.equal(live.totals.cost, 41);
});

test('a finished window ends where the ledger says, not at the reset it never reached', () => {
  const meter = {
    provider: 'claude',
    current: null,
    history: [
      { startedAt: at('2026-09-01', 19, 50), resetsAt: at('2026-09-02', 0, 50), endedAt: at('2026-09-01', 20, 50), peakUtil: 2 },
    ],
  };
  const [win] = Q.quotaWindows([], meter, { now: at('2026-09-02', 3, 0) });
  assert.equal(win.endsAt, at('2026-09-01', 20, 50));
});
