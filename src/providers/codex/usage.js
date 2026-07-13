'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { costOf } = require('./pricing');
const { isOpenAIModel } = require('../model-attribution');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSION_DIRS = [
  path.join(CODEX_DIR, 'sessions'),
  path.join(CODEX_DIR, 'archived_sessions'),
];

const CACHE_VERSION = 4; // v4: local minute precision appended to cached entries
const LEGACY_ENTRY_LENGTH = 11;

let cachePath = null; // set via init()
let fileCache = {}; // filePath -> { mtimeMs, size, entries, limits }
let cacheNeedsReparse = false;
let cacheWrite = Promise.resolve();

function upgradeV3Files(files) {
  const upgraded = {};
  for (const [file, rec] of Object.entries(files || {})) {
    const entries = Array.isArray(rec.entries)
      ? rec.entries.map((entry) => (
        Array.isArray(entry) && entry.length === LEGACY_ENTRY_LENGTH ? [...entry, null] : entry
      ))
      : rec.entries;
    upgraded[file] = { ...rec, entries };
  }
  return upgraded;
}

function saveCache() {
  if (!cachePath) return;
  const target = cachePath;
  const temp = `${target}.tmp`;
  const snapshot = JSON.stringify({ v: CACHE_VERSION, files: fileCache });
  cacheWrite = cacheWrite.then(async () => {
    try {
      await fsp.writeFile(temp, snapshot);
      await fsp.rename(temp, target);
    } catch {
      try { await fsp.unlink(temp); } catch { /* ignore cleanup failures */ }
    }
  });
}

function init(userDataDir) {
  cachePath = path.join(userDataDir, 'codex-usage-cache.json');
  cacheNeedsReparse = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed.v === CACHE_VERSION) {
      fileCache = parsed.files || {};
    } else if (parsed.v === 3) {
      fileCache = upgradeV3Files(parsed.files);
      cacheNeedsReparse = true;
    } else {
      fileCache = {};
    }
  } catch {
    fileCache = {};
  }
}

async function listJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJsonlFiles(full)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// "C:\Users\you\Desktop\my-app" -> "Desktop/my-app"
function projectOfCwd(cwd) {
  if (!cwd) return 'unknown';
  const norm = String(cwd).replace(/\//g, '\\').replace(/^[A-Za-z]:\\/, '');
  const parts = norm.split('\\').filter(Boolean);
  if (parts[0] && parts[0].toLowerCase() === 'users' && parts.length >= 2) parts.splice(0, 2);
  return parts.length ? parts.join('/') : '~ (home)';
}

function sessionOf(file) {
  return path.basename(file, '.jsonl');
}

function localParts(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { date: `${y}-${m}-${day}`, hour: d.getHours(), minute: d.getMinutes() };
}

// A rollout file is a stream of records; we care about three kinds:
//   session_meta  -> cwd (project) + session id (dedup across resume files)
//   turn_context  -> current model (applies to following token_count events)
//   event_msg/token_count -> per-call usage (last_token_usage) + rate_limits
// entry: [dedupKey, date, hour, model, input, output, cached, reasoning,
//         cacheWrite, cacheWriteKnown, totalInput, minute]
function parseContent(text) {
  const entries = [];
  let model = 'unknown';
  let project = 'unknown';
  let sessionId = null;
  let limits = null; // newest { ts, rateLimits } in this file
  for (const line of text.split('\n')) {
    if (!line) continue;
    const isMeta = line.indexOf('"session_meta"') !== -1;
    const isTurn = line.indexOf('"turn_context"') !== -1;
    const isCount = line.indexOf('"token_count"') !== -1;
    if (!isMeta && !isTurn && !isCount) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj && obj.payload;
    if (!p) continue;
    if (obj.type === 'session_meta') {
      if (p.cwd) project = projectOfCwd(p.cwd);
      if (p.id || p.session_id) sessionId = p.id || p.session_id;
      continue;
    }
    if (obj.type === 'turn_context') {
      if (p.model) model = p.model;
      continue;
    }
    if (obj.type !== 'event_msg' || p.type !== 'token_count') continue;

    const rl = p.rate_limits;
    if (rl && (rl.primary || rl.secondary || rl.plan_type)) {
      const t = new Date(obj.timestamp).getTime();
      if (!isNaN(t) && (!limits || t >= limits.ts)) limits = { ts: t, rateLimits: rl };
    }

    const info = p.info;
    const u = info && info.last_token_usage;
    if (!u) continue;
    const parts = localParts(obj.timestamp);
    if (!parts) continue;
    // token_count events carry no id, and a resume/fork replays the parent's
    // history into a new file with RE-STAMPED timestamps — only the session
    // id and the running totals survive the copy. Key on those so replayed
    // calls dedup across files (timestamp fallback if session_meta is absent).
    const total = info.total_token_usage || {};
    const hasCumulative = Number(total.total_tokens) > 0;
    const cumulative = [
      total.input_tokens || 0,
      total.cached_input_tokens || 0,
      total.output_tokens || 0,
      total.reasoning_output_tokens || 0,
      total.total_tokens || 0,
    ].join(':');
    const last = [
      u.input_tokens || 0,
      u.cached_input_tokens || 0,
      u.output_tokens || 0,
      u.reasoning_output_tokens || 0,
      u.total_tokens || 0,
    ].join(':');
    const key = `${sessionId || 'no-session'}|${hasCumulative ? cumulative : obj.timestamp}|${last}`;
    const totalInput = Math.max(0, Number(u.input_tokens) || 0);
    const cached = Math.min(totalInput, Math.max(0, Number(u.cached_input_tokens) || 0));
    const details = u.input_tokens_details || u.input_token_details || {};
    const rawWrite = u.cache_write_tokens ?? u.cache_write_input_tokens ?? details.cache_write_tokens ?? details.cache_write_input_tokens;
    const cacheWriteKnown = rawWrite != null && isFinite(Number(rawWrite));
    const cacheWrite = cacheWriteKnown
      ? Math.min(Math.max(0, totalInput - cached), Math.max(0, Number(rawWrite) || 0))
      : 0;
    const input = Math.max(0, totalInput - cached - cacheWrite);
    entries.push([
      key,
      parts.date,
      parts.hour,
      model,
      input,
      u.output_tokens || 0,
      cached,
      u.reasoning_output_tokens || 0, // subset of output — informational
      cacheWrite,
      cacheWriteKnown,
      totalInput,
      parts.minute,
    ]);
  }
  // stamp the project on each entry via the cache record instead of per-entry
  return { entries, project, limits };
}

async function aggregate() {
  const files = [];
  for (const dir of SESSION_DIRS) files.push(...(await listJsonlFiles(dir)));
  const liveCache = {};
  const forceReparse = cacheNeedsReparse;
  let cacheDirty = forceReparse;

  for (const file of files) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    const prev = fileCache[file];
    if (!forceReparse && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      if (prev.gone) {
        // a previously deleted file came back (restore from backup)
        const { gone, ...rest } = prev;
        liveCache[file] = rest;
        cacheDirty = true;
      } else {
        liveCache[file] = prev;
      }
      continue;
    }
    let parsed = null;
    try {
      parsed = parseContent(await fsp.readFile(file, 'utf8'));
    } catch {
      /* preserve cached history at legacy precision if a file is unreadable */
    }
    if (parsed) {
      liveCache[file] = { mtimeMs: st.mtimeMs, size: st.size, ...parsed };
    } else if (prev) {
      const { gone, ...rest } = prev;
      liveCache[file] = { ...rest, mtimeMs: st.mtimeMs, size: st.size };
    } else {
      liveCache[file] = {
        mtimeMs: st.mtimeMs, size: st.size, entries: [], project: 'unknown', limits: null,
      };
    }
    cacheDirty = true;
  }
  // Files that vanished from disk (deleted session logs, pruned history) keep
  // their parsed records forever — usage history survives log deletion. They
  // are flagged `gone` so the UI can group their projects separately.
  for (const [file, rec] of Object.entries(fileCache)) {
    if (liveCache[file]) continue;
    if (rec.gone) {
      liveCache[file] = rec;
    } else {
      liveCache[file] = { ...rec, gone: true };
      cacheDirty = true;
    }
  }
  fileCache = liveCache;
  cacheNeedsReparse = false;
  if (cacheDirty) saveCache();

  // Global dedup, then bucket by date|hour|minute|model|project|session.
  const seen = new Set();
  const buckets = new Map();
  const projectLive = new Map(); // project -> still has at least one on-disk file
  let newestLimits = null;
  for (const file of Object.keys(fileCache).sort()) {
    const { entries, project, limits, gone } = fileCache[file];
    if (limits && (!newestLimits || limits.ts >= newestLimits.ts)) newestLimits = limits;
    projectLive.set(project, projectLive.get(project) || !gone);
    if (!entries || !entries.length) continue;
    const session = sessionOf(file);
    for (const [key, date, hour, model, inp, out, cached, reasoning, cacheWrite = 0, cacheWriteKnown = false, totalInput = inp + cached + cacheWrite, minute = null] of entries) {
      // Do not let an early replay event with no turn_context poison the
      // dedup key and hide the later copy that has a real model attached.
      if (!isOpenAIModel(model)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const bk = `${date}|${hour}|${minute}|${model}|${project}|${session}`;
      let b = buckets.get(bk);
      if (!b) {
        b = {
          date, hour, minute, model, project, session,
          input: 0, output: 0, cached: 0, reasoning: 0, cacheWrite: 0, totalInput: 0, msgs: 0,
          cost: 0, costMin: 0, costMax: 0,
          cIn: 0, cOut: 0, cCached: 0, cReasoning: 0, cWrite: 0, cacheSavings: 0,
          pricedCalls: 0, unpricedCalls: 0, estimated: false, longContextCalls: 0,
          pricingSource: '',
        };
        buckets.set(bk, b);
      }
      b.input += inp;
      b.output += out;
      b.cached += cached;
      b.reasoning += reasoning;
      b.cacheWrite += cacheWrite;
      b.totalInput += totalInput;
      b.msgs += 1;

      const c = costOf(model, {
        input: inp,
        output: out,
        cached,
        reasoning,
        cacheWrite,
        cacheWriteKnown,
        totalInput,
      });
      b.cost += c.total || 0;
      b.costMin += c.costMin || 0;
      b.costMax += c.costMax || 0;
      b.cIn += c.input || 0;
      b.cOut += c.output || 0;
      b.cCached += c.cached || 0;
      b.cReasoning += c.reasoning || 0;
      b.cWrite += c.cacheWrite || 0;
      b.cacheSavings += c.cacheSavings || 0;
      b.estimated = b.estimated || !!c.estimated;
      b.longContextCalls += c.longContext ? 1 : 0;
      b.pricingSource = c.source || b.pricingSource;
      if (c.known) b.pricedCalls += 1;
      else b.unpricedCalls += 1;
    }
  }

  const list = [];
  for (const b of buckets.values()) {
    b.priced = b.pricedCalls > 0 && b.unpricedCalls === 0;
    b.projectDeleted = !projectLive.get(b.project);
    list.push(b);
  }
  return { buckets: list, generatedAt: Date.now(), fileCount: files.length, limits: newestLimits };
}

module.exports = { init, aggregate, parseContent, SESSION_DIRS };
