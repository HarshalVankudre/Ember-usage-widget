'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codexLimits = require('../src/providers/codex/limits');

test('maps ClaudeX shared-account limits into the Codex limit shape', () => {
  const limits = codexLimits.fromClaudexPayload({
    fetched_at: 1_784_329_364,
    plan_type: 'prolite',
    rate_limit: {
      primary_window: {
        used_percent: 34,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: 1_784_780_961,
      },
      secondary_window: null,
    },
    additional_rate_limits: [{
      limit_name: 'GPT-5.3-Codex-Spark',
      rate_limit: { primary_window: { used_percent: 0 } },
    }],
  });

  assert.equal(limits.ok, true);
  assert.equal(limits.source, 'claudex');
  assert.equal(limits.fetchedAt, 1_784_329_364_000);
  assert.deepEqual(limits.plan, { type: 'prolite', label: 'Pro Lite' });
  assert.equal(limits.windows.length, 1);
  assert.equal(limits.windows[0].name, 'Weekly limit');
  assert.equal(limits.windows[0].utilization, 34);
  assert.equal(limits.windows[0].resetsAt, new Date(1_784_780_961_000).toISOString());
});

test('uses the freshest Codex account snapshot without adding another limit group', () => {
  const native = {
    ok: true,
    source: 'codex',
    fetchedAt: 1_000,
    windows: [{ name: 'Weekly limit', utilization: 20 }],
  };
  const claudex = {
    ok: true,
    source: 'claudex',
    fetchedAt: 2_000,
    windows: [{ name: 'Weekly limit', utilization: 34 }],
  };

  assert.equal(codexLimits.newest(native, claudex), claudex);
  assert.equal(codexLimits.newest(claudex, native), claudex);
});

test('a snapshot cached before window lengths were recorded reads its length back from the row name', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-limits-'));
  fs.writeFileSync(path.join(dir, 'codex-limits-cache.json'), JSON.stringify({
    ok: true,
    fetchedAt: 1_784_929_328_566,
    plan: { type: 'prolite', label: 'Pro Lite' },
    // the pre-upgrade shape: no windowMinutes
    windows: [
      { name: 'Current session (5h)', style: 'countdown', utilization: 12 },
      { name: 'Weekly limit', style: 'day', utilization: 91 },
    ],
    source: 'codex',
  }));

  codexLimits.init(dir);
  const cached = codexLimits.loadCached();

  assert.equal(cached.windows[0].windowMinutes, 300);
  assert.equal(cached.windows[1].windowMinutes, 7 * 24 * 60);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh scan already carries the window length used to identify the meter', () => {
  const limits = codexLimits.fromSnapshot({
    ts: 1_000,
    rateLimits: {
      plan_type: 'prolite',
      primary: { used_percent: 12, window_minutes: 300, resets_at: 1_784_780_961 },
      secondary: { used_percent: 91, window_minutes: 10080, resets_at: 1_784_980_961 },
    },
  });

  assert.equal(limits.windows[0].windowMinutes, 300);
  assert.equal(limits.windows[1].windowMinutes, 10080);
});
