'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codexUsage = require('../src/providers/codex/usage');
const claudeUsage = require('../src/providers/claude/usage');

test('parses Codex cached input as a subset without double-counting', () => {
  const timestamp = new Date(2026, 6, 1, 10, 37, 0, 0).toISOString();
  const lines = [
    { type: 'session_meta', payload: { id: 'session-1', cwd: 'C:\\Users\\dev\\work' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg', timestamp,
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
      } },
    },
  ].map(JSON.stringify).join('\n');
  const parsed = codexUsage.parseContent(lines);
  const entry = parsed.entries[0];
  assert.equal(entry[4], 60); // ordinary input
  assert.equal(entry[6], 40); // cache read
  assert.equal(entry[8], 0);  // no measured write count
  assert.equal(entry[9], false);
  assert.equal(entry[10], 100);
  assert.equal(entry[11], 37); // local minute, appended for cache compatibility
});

test('uses measured Codex cache-write details when a future log exposes them', () => {
  const lines = [
    { type: 'session_meta', payload: { id: 'session-2' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    {
      type: 'event_msg', timestamp: '2026-07-01T10:00:00Z',
      payload: { type: 'token_count', info: {
        total_token_usage: { total_tokens: 130 },
        last_token_usage: {
          input_tokens: 110, cached_input_tokens: 40, output_tokens: 20, total_tokens: 130,
          input_tokens_details: { cache_write_tokens: 10 },
        },
      } },
    },
  ].map(JSON.stringify).join('\n');
  const entry = codexUsage.parseContent(lines).entries[0];
  assert.equal(entry[4], 60);
  assert.equal(entry[6], 40);
  assert.equal(entry[8], 10);
  assert.equal(entry[9], true);
  assert.equal(entry[10], 110);
});

test('parses Claude cache TTLs and request-level pricing modifiers', () => {
  const timestamp = new Date(2026, 6, 1, 10, 42, 0, 0).toISOString();
  const line = JSON.stringify({
    timestamp, requestId: 'request-1',
    message: { id: 'message-1', model: 'claude-opus-4-8', usage: {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
      speed: 'fast', inference_geo: 'us', service_tier: 'standard',
      server_tool_use: { web_search_requests: 1 },
    } },
  });
  const entry = claudeUsage.parseContent(line)[0];
  assert.deepEqual(entry.slice(4, 13), [10, 5, 20, 30, 40, 'fast', 'us', 1, 'standard']);
  assert.equal(entry[13], 42); // local minute, appended for cache compatibility
});

test('Claude fallback dedup keys are deterministic across reparses', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-01T10:00:00Z',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
  });
  assert.equal(claudeUsage.parseContent(line)[0][0], claudeUsage.parseContent(line)[0][0]);
});
