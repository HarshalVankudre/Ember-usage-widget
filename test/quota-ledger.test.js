'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/providers/quota-ledger');

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 6, 24, 23, 0, 0);

function claudeSnapshot({ session = 23, weekly = 56, scoped = null, sessionResets = T0 + 5 * HOUR, weeklyResets = T0 + 5 * HOUR, stale = false } = {}) {
  const data = {
    five_hour: { utilization: session, resets_at: new Date(sessionResets).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(weeklyResets).toISOString() },
    limits: [
      { kind: 'session', percent: session, resets_at: new Date(sessionResets).toISOString(), scope: null },
      { kind: 'weekly_all', percent: weekly, resets_at: new Date(weeklyResets).toISOString(), scope: null },
    ],
  };
  if (scoped) {
    data.limits.push({
      kind: 'weekly_scoped',
      percent: scoped.percent,
      resets_at: new Date(scoped.resetsAt || weeklyResets).toISOString(),
      scope: { model: { id: null, display_name: scoped.name } },
    });
  }
  return { ok: true, fetchedAt: T0, data, stale, plan: { label: 'Max (5x)' } };
}

test('meters are read from both the named fields and the generic limits array', () => {
  const meters = ledger.claudeMeters(claudeSnapshot({ scoped: { name: 'Fable', percent: 81 } }));
  const ids = meters.map((m) => m.id);

  assert.deepEqual(ids, ['claude|session', 'claude|weekly', 'claude|weekly:fable']);
  assert.equal(meters[0].windowMinutes, 300);
  assert.equal(meters[1].windowMinutes, 7 * 24 * 60);
  assert.equal(meters[2].utilization, 81);
  assert.equal(meters[2].label, 'Claude weekly · Fable 5');
});

test('a scoped meter keeps one identity when the provider renames the model', () => {
  assert.equal(ledger.scopedModelKey('Fable'), ledger.scopedModelKey('Fable 5'));
  assert.equal(ledger.scopedModelKey('Opus'), 'opus');
  assert.notEqual(ledger.scopedModelKey('Opus'), ledger.scopedModelKey('Sonnet'));
});

test('a snapshot Ember could not refresh is not replayed as a new reading', () => {
  assert.deepEqual(ledger.claudeMeters(claudeSnapshot({ stale: true })), []);
  assert.deepEqual(ledger.claudeMeters({ ok: false, reason: 'http-429' }), []);
});

test('Codex meters are keyed by window length, not by the plan-dependent row name', () => {
  const before = ledger.codexMeters({
    ok: true,
    windows: [{ name: 'Weekly limit', windowMinutes: 10080, utilization: 91, resetsAt: new Date(T0).toISOString() }],
  });
  const afterPlanChange = ledger.codexMeters({
    ok: true,
    windows: [{ name: '7-day limit', windowMinutes: 10080, utilization: 12, resetsAt: new Date(T0).toISOString() }],
  });

  assert.equal(before[0].id, afterPlanChange[0].id);
  assert.equal(before[0].kind, 'weekly');
});

test('a window start comes from the provider reset time, so the first window seen is measurable', () => {
  ledger._reset();
  ledger.record({ claude: claudeSnapshot({ session: 23 }) }, T0 + HOUR);

  const meter = ledger.snapshot(T0 + HOUR).meters.find((m) => m.id === 'claude|session');
  assert.equal(meter.current.startedAt, T0, 'five hours before the reset, not when Ember first looked');
  assert.equal(meter.current.peakUtil, 23);
  assert.equal(meter.current.joinedLate, false);
  assert.deepEqual(meter.history, []);
});

test('utilization climbing inside one window updates the peak without opening another', () => {
  ledger._reset();
  ledger.record({ claude: claudeSnapshot({ session: 23 }) }, T0 + HOUR);
  ledger.record({ claude: claudeSnapshot({ session: 61 }) }, T0 + 2 * HOUR);
  ledger.record({ claude: claudeSnapshot({ session: 58 }) }, T0 + 3 * HOUR);

  const meter = ledger.snapshot(T0 + 3 * HOUR).meters.find((m) => m.id === 'claude|session');
  assert.equal(meter.history.length, 0);
  assert.equal(meter.current.peakUtil, 61, 'the peak survives a lower later reading');
  assert.ok(meter.current.samples.length >= 3);
});

test('a new reset time closes the finished window and keeps it in history', () => {
  ledger._reset();
  ledger.record({ claude: claudeSnapshot({ session: 23 }) }, T0 + HOUR);
  ledger.record({ claude: claudeSnapshot({ session: 97 }) }, T0 + 4 * HOUR);
  // window rolled over: new reset five hours later, meter back near zero
  const next = T0 + 10 * HOUR;
  ledger.record({ claude: claudeSnapshot({ session: 4, sessionResets: next }) }, T0 + 5.5 * HOUR);

  const meter = ledger.snapshot(T0 + 5.5 * HOUR).meters.find((m) => m.id === 'claude|session');
  assert.equal(meter.history.length, 1);
  assert.equal(meter.history[0].peakUtil, 97);
  assert.equal(meter.history[0].startedAt, T0);
  assert.equal(meter.history[0].endedAt, T0 + 5 * HOUR, 'a window ends at its published reset time');
  assert.equal(meter.current.peakUtil, 4);
  assert.equal(meter.current.startedAt, next - 5 * HOUR);
});

test('a window whose reset time has passed is reported as finished, not as still open', () => {
  ledger._reset();
  ledger.record({ claude: claudeSnapshot({ session: 88 }) }, T0 + HOUR);

  const stillOpen = ledger.snapshot(T0 + 2 * HOUR).meters.find((m) => m.id === 'claude|session');
  assert.ok(stillOpen.current);

  // Ember slept through the reset and no newer reading has arrived.
  const afterReset = ledger.snapshot(T0 + 6 * HOUR).meters.find((m) => m.id === 'claude|session');
  assert.equal(afterReset.current, null);
  assert.equal(afterReset.history.length, 1);
  assert.equal(afterReset.history[0].peakUtil, 88);
});

test('readings within the sampling gap replace rather than flood the burn curve', () => {
  ledger._reset();
  for (let i = 0; i < 12; i += 1) {
    ledger.record({ claude: claudeSnapshot({ session: 10 + i }) }, T0 + HOUR + i * 1000);
  }

  const meter = ledger.snapshot(T0 + HOUR + 12000).meters.find((m) => m.id === 'claude|session');
  assert.equal(meter.current.samples.length, 1);
  assert.equal(meter.current.samples[0][1], 21);
  assert.equal(meter.current.peakUtil, 21);
});

test('both providers are tracked side by side without colliding', () => {
  ledger._reset();
  ledger.record({
    claude: claudeSnapshot({ session: 30 }),
    codex: {
      ok: true,
      windows: [{ name: 'Weekly limit', windowMinutes: 10080, utilization: 91, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() }],
    },
  }, T0 + HOUR);

  const ids = ledger.snapshot(T0 + HOUR).meters.map((m) => m.id).sort();
  assert.deepEqual(ids, ['claude|session', 'claude|weekly', 'codex|10080']);
});

test('a meter filed under a label by an early build is dropped instead of shadowing the real one', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ledger-'));
  fs.writeFileSync(path.join(dir, 'quota-ledger.json'), JSON.stringify({
    v: 1,
    meters: [
      { id: 'codex|Weekly limit', provider: 'codex', kind: 'weekly', label: 'stale', windowMinutes: 0,
        instances: [{ startedAt: T0, lastSeenAt: T0, firstSeenAt: T0, firstUtil: 5, peakUtil: 5, lastUtil: 5, samples: [] }] },
      { id: 'codex|10080', provider: 'codex', kind: 'weekly', label: 'Codex · Weekly limit', windowMinutes: 10080,
        instances: [{ startedAt: T0, lastSeenAt: T0, firstSeenAt: T0, firstUtil: 5, peakUtil: 5, lastUtil: 5, samples: [] }] },
    ],
  }));

  ledger.init(dir);
  const ids = ledger.snapshot(T0 + 1000).meters.map((m) => m.id);

  assert.deepEqual(ids, ['codex|10080']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Codex row with no window length is skipped rather than filed under its label', () => {
  assert.deepEqual(
    ledger.codexMeters({ ok: true, windows: [{ name: 'Weekly limit', utilization: 91 }] }),
    [],
  );
});
