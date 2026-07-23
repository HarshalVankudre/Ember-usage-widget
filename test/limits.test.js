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
