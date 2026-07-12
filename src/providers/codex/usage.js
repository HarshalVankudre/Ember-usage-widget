'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { costOf } = require('./pricing');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSION_DIRS = [
  path.join(CODEX_DIR, 'sessions'),
  path.join(CODEX_DIR, 'archived_sessions'),
];

const CACHE_VERSION = 2; // v2: dedup keys switched from timestamp to session id

// Only OpenAI models are shown; anything else in the logs (custom providers,
// experimental codenames) is skipped entirely.
const OPENAI_MODEL = /^(gpt|chatgpt|codex|o\d)/;

let cachePath = null; // set via init()
let fileCache = {}; // filePath -> { mtimeMs, size, entries, limits }

function init(userDataDir) {
  cachePath = path.join(userDataDir, 'codex-usage-cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    fileCache = parsed.v === CACHE_VERSION ? parsed.files : {};
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
  return { date: `${y}-${m}-${day}`, hour: d.getHours() };
}

// A rollout file is a stream of records; we care about three kinds:
//   session_meta  -> cwd (project) + session id (dedup across resume files)
//   turn_context  -> current model (applies to following token_count events)
//   event_msg/token_count -> per-call usage (last_token_usage) + rate_limits
// entry: [dedupKey, date, hour, model, input(non-cached), output, cached, reasoning]
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
    const total = (info.total_token_usage || {});
    const key = `${sessionId || obj.timestamp}|${total.total_tokens || 0}|${u.total_tokens || 0}|${u.output_tokens || 0}`;
    const cached = u.cached_input_tokens || 0;
    const input = Math.max(0, (u.input_tokens || 0) - cached); // cached is a subset of input
    entries.push([
      key,
      parts.date,
      parts.hour,
      model,
      input,
      u.output_tokens || 0,
      cached,
      u.reasoning_output_tokens || 0, // subset of output — informational
    ]);
  }
  // stamp the project on each entry via the cache record instead of per-entry
  return { entries, project, limits };
}

async function aggregate() {
  const files = [];
  for (const dir of SESSION_DIRS) files.push(...(await listJsonlFiles(dir)));
  const liveCache = {};
  let cacheDirty = false;

  for (const file of files) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    const prev = fileCache[file];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
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
    let parsed = { entries: [], project: 'unknown', limits: null };
    try {
      parsed = parseContent(await fsp.readFile(file, 'utf8'));
    } catch {
      /* unreadable file — skip */
    }
    liveCache[file] = { mtimeMs: st.mtimeMs, size: st.size, ...parsed };
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
  if (cacheDirty && cachePath) {
    fsp.writeFile(cachePath, JSON.stringify({ v: CACHE_VERSION, files: fileCache })).catch(() => {});
  }

  // Global dedup, then bucket by date|hour|model|project|session.
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
    for (const [key, date, hour, model, inp, out, cached, reasoning] of entries) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!OPENAI_MODEL.test(String(model).toLowerCase())) continue;
      const bk = `${date}|${hour}|${model}|${project}|${session}`;
      let b = buckets.get(bk);
      if (!b) {
        b = { date, hour, model, project, session, input: 0, output: 0, cached: 0, reasoning: 0, msgs: 0 };
        buckets.set(bk, b);
      }
      b.input += inp;
      b.output += out;
      b.cached += cached;
      b.reasoning += reasoning;
      b.msgs += 1;
    }
  }

  const list = [];
  for (const b of buckets.values()) {
    const c = costOf(b.model, b);
    b.cost = c.total;
    b.cIn = c.input || 0;
    b.cOut = c.output || 0;
    b.cCached = c.cached || 0;
    b.cReasoning = c.reasoning || 0;
    b.cWrite = c.cacheWrite || 0;
    b.cacheSavings = c.cacheSavings || 0;
    b.priced = c.known;
    b.projectDeleted = !projectLive.get(b.project);
    list.push(b);
  }
  return { buckets: list, generatedAt: Date.now(), fileCount: files.length, limits: newestLimits };
}

module.exports = { init, aggregate, SESSION_DIRS };
