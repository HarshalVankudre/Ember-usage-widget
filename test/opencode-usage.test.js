'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const opencodeUsage = require('../src/providers/opencode/usage');

test('maps OpenCode OAuth requests into Codex billing buckets', () => {
  const time = new Date(2026, 6, 19, 10, 37).getTime();
  const buckets = opencodeUsage.parseRows([{
    id: 'msg_1', session_id: 'ses_1', time_created: time,
    directory: 'C:/Users/dev/Desktop/widget', model: 'gpt-5.6-sol',
    input: 100, output: 20, reasoning: 5, cache_read: 50, cache_write: 0,
  }], () => true);

  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].model, 'gpt-5.6-sol');
  assert.equal(buckets[0].project, 'Desktop/widget');
  assert.equal(buckets[0].session, 'ses_1');
  assert.equal(buckets[0].input, 100);
  assert.equal(buckets[0].cached, 50);
  assert.equal(buckets[0].output, 25, 'reasoning is folded into billed output');
  assert.equal(buckets[0].reasoning, 5);
  assert.equal(buckets[0].msgs, 1);
  assert.equal(buckets[0].estimated, false, 'OpenCode reports cache writes explicitly');
});

test('ignores unfinished and non-OpenAI OpenCode messages', () => {
  const time = Date.now();
  const buckets = opencodeUsage.parseRows([
    {
      id: 'msg_empty', session_id: 'ses_1', time_created: time,
      directory: 'C:/repo', model: 'gpt-5.6-sol',
      input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0,
    },
    {
      id: 'msg_claude', session_id: 'ses_1', time_created: time,
      directory: 'C:/repo', model: 'claude-sonnet-5',
      input: 100, output: 20, reasoning: 0, cache_read: 0, cache_write: 0,
    },
  ], () => true);

  assert.deepEqual(buckets, []);
});

test('OpenCode query selects only content-free OpenAI usage fields', () => {
  assert.match(opencodeUsage.QUERY, /providerID/);
  assert.match(opencodeUsage.QUERY, /tokens\.cache\.read/);
  assert.doesNotMatch(opencodeUsage.QUERY, /SELECT\s+m\.data/i);
  assert.doesNotMatch(opencodeUsage.QUERY, /error|content|system/i);
});
