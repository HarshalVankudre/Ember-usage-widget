'use strict';

// OpenCode keeps its request-level token accounting in opencode.db. Its
// bundled `opencode db` command is the safest read-only bridge for Electron:
// it understands the live SQLite WAL and avoids shipping another native
// SQLite binary. Only non-sensitive usage columns are selected here.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { costOf } = require('../codex/pricing');
const { isOpenAIModel } = require('../model-attribution');

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const DB_PATH = path.join(DATA_DIR, 'opencode.db');
const CACHE_VERSION = 1;
const QUERY = `
SELECT
  m.id,
  m.session_id,
  m.time_created,
  s.directory,
  json_extract(m.data, '$.modelID') AS model,
  json_extract(m.data, '$.tokens.input') AS input,
  json_extract(m.data, '$.tokens.output') AS output,
  json_extract(m.data, '$.tokens.reasoning') AS reasoning,
  json_extract(m.data, '$.tokens.cache.read') AS cache_read,
  json_extract(m.data, '$.tokens.cache.write') AS cache_write
FROM message AS m
JOIN session AS s ON s.id = m.session_id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(m.data, '$.providerID') = 'openai'
`;

let cachePath = null;
let rowCache = {};
let cacheWrite = Promise.resolve();
let aggregatePromise = null;

function init(userDataDir) {
  cachePath = path.join(userDataDir, 'opencode-usage-cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    rowCache = parsed && parsed.v === CACHE_VERSION && parsed.rows ? parsed.rows : {};
  } catch {
    rowCache = {};
  }
}

function saveCache() {
  if (!cachePath) return;
  const target = cachePath;
  const temp = `${target}.tmp`;
  const snapshot = JSON.stringify({ v: CACHE_VERSION, rows: rowCache });
  cacheWrite = cacheWrite.then(async () => {
    try {
      await fsp.writeFile(temp, snapshot);
      await fsp.rename(temp, target);
    } catch {
      try { await fsp.unlink(temp); } catch { /* ignore cleanup failures */ }
    }
  });
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

function localParts(timestamp) {
  const d = new Date(Number(timestamp));
  if (isNaN(d)) return null;
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

// Keep project labels consistent with native Codex rollouts.
function projectOfDirectory(directory) {
  if (!directory) return 'unknown';
  const norm = String(directory).replace(/\//g, '\\').replace(/^[A-Za-z]:\\/, '');
  const parts = norm.split('\\').filter(Boolean);
  if (parts[0] && parts[0].toLowerCase() === 'users' && parts.length >= 2) parts.splice(0, 2);
  return parts.length ? parts.join('/') : '~ (home)';
}

function addCost(bucket, model, usage) {
  const c = costOf(model, usage);
  bucket.cost += c.total || 0;
  bucket.costMin += c.costMin || 0;
  bucket.costMax += c.costMax || 0;
  bucket.cIn += c.input || 0;
  bucket.cOut += c.output || 0;
  bucket.cCached += c.cached || 0;
  bucket.cReasoning += c.reasoning || 0;
  bucket.cWrite += c.cacheWrite || 0;
  bucket.cacheSavings += c.cacheSavings || 0;
  bucket.estimated = bucket.estimated || !!c.estimated;
  bucket.longContextCalls += c.longContext ? 1 : 0;
  bucket.pricingSource = c.source || bucket.pricingSource;
  if (c.known) bucket.pricedCalls += 1;
  else bucket.unpricedCalls += 1;
}

function parseRows(rows, exists = fs.existsSync) {
  const buckets = new Map();
  for (const row of rows || []) {
    const model = String(row.model || '');
    if (!isOpenAIModel(model)) continue;
    const parts = localParts(row.time_created);
    if (!parts) continue;

    const input = nonNegative(row.input);
    const cached = nonNegative(row.cache_read);
    const cacheWrite = nonNegative(row.cache_write);
    const reasoning = nonNegative(row.reasoning);
    // OpenCode/AI SDK reports reasoning beside visible output, whereas Codex
    // rollouts report it as a subset. Fold it into output for Ember's unified
    // billing shape, then retain `reasoning` as the informational subset.
    const output = nonNegative(row.output) + reasoning;
    if (input + cached + cacheWrite + output === 0) continue;

    const project = projectOfDirectory(row.directory);
    const session = String(row.session_id || 'unknown');
    const bk = `${parts.date}|${parts.hour}|${parts.minute}|${model}|${project}|${session}`;
    let b = buckets.get(bk);
    if (!b) {
      b = {
        ...parts, model, project, session,
        input: 0, output: 0, cached: 0, reasoning: 0, cacheWrite: 0, totalInput: 0, msgs: 0,
        cost: 0, costMin: 0, costMax: 0,
        cIn: 0, cOut: 0, cCached: 0, cReasoning: 0, cWrite: 0, cacheSavings: 0,
        pricedCalls: 0, unpricedCalls: 0, estimated: false, longContextCalls: 0,
        pricingSource: '', projectDeleted: !!row.directory && !exists(row.directory),
      };
      buckets.set(bk, b);
    }
    b.input += input;
    b.output += output;
    b.cached += cached;
    b.reasoning += reasoning;
    b.cacheWrite += cacheWrite;
    b.totalInput += input + cached + cacheWrite;
    b.msgs += 1;
    addCost(b, model, {
      input, output, cached, reasoning, cacheWrite,
      cacheWriteKnown: row.cache_write != null,
      totalInput: input + cached + cacheWrite,
    });
  }

  return [...buckets.values()].map((b) => ({
    ...b,
    priced: b.pricedCalls > 0 && b.unpricedCalls === 0,
  }));
}

function findOpenCodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
        path.join(home, '.opencode', 'bin', 'opencode.exe'),
        path.join(home, '.local', 'bin', 'opencode.exe'),
      ]
    : [path.join(home, '.opencode', 'bin', 'opencode'), path.join(home, '.local', 'bin', 'opencode')];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
    || (process.platform === 'win32' ? 'opencode.exe' : 'opencode');
}

async function queryRows() {
  if (!fs.existsSync(DB_PATH)) return [];
  const { stdout } = await execFileAsync(
    findOpenCodeBin(),
    ['db', QUERY, '--format', 'json'],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

async function aggregateOnce() {
  try {
    const rows = await queryRows();
    let dirty = false;
    for (const row of rows) {
      if (!row || !row.id) continue;
      const previous = rowCache[row.id];
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) {
        rowCache[row.id] = row;
        dirty = true;
      }
    }
    if (dirty) saveCache();
  } catch (err) {
    // A locked/migrating database or absent CLI must not take Ember down.
    // The last successful, content-free usage snapshot remains available.
    console.error('OpenCode usage scan failed:', err.message);
  }
  const buckets = parseRows(Object.values(rowCache));
  return { buckets, generatedAt: Date.now(), fileCount: fs.existsSync(DB_PATH) ? 1 : 0 };
}

function aggregate() {
  if (!aggregatePromise) {
    aggregatePromise = aggregateOnce().finally(() => { aggregatePromise = null; });
  }
  return aggregatePromise;
}

module.exports = {
  init,
  aggregate,
  parseRows,
  projectOfDirectory,
  findOpenCodeBin,
  DATA_DIR,
  DB_PATH,
  QUERY,
};
