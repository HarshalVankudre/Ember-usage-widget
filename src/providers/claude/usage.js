'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { costOf } = require('./pricing');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const CACHE_VERSION = 2; // v2: entries carry the hour of day

let cachePath = null; // set via init()
let fileCache = {}; // filePath -> { mtimeMs, size, entries }

function init(userDataDir) {
  cachePath = path.join(userDataDir, 'claude-usage-cache.json');
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

function projectOf(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const slug = rel.split(path.sep)[0] || 'unknown';
  // "C--Users-you-Desktop-my-app" -> "Desktop/my/app" style readable name
  let name = slug.replace(/^C--Users-[^-]+-?/, '').replace(/-/g, '/');
  if (!name) name = '~ (home)';
  return name;
}

function sessionOf(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const parts = rel.split(path.sep);
  // <project>/<session>.jsonl  OR  <project>/<session>/subagents/.../*.jsonl
  if (parts.length === 2) return path.basename(parts[1], '.jsonl');
  return parts[1];
}

function localParts(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { date: `${y}-${m}-${day}`, hour: d.getHours() };
}

// entry: [dedupKey, date, hour, model, input, output, cacheRead, cacheW5m, cacheW1h]
function parseContent(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj && obj.message;
    const u = msg && msg.usage;
    if (!u || !msg.model || msg.model === '<synthetic>') continue;
    const parts = localParts(obj.timestamp);
    if (!parts) continue;
    const key = msg.id ? `${msg.id}:${obj.requestId || ''}` : obj.uuid || Math.random().toString(36);
    const cc = u.cache_creation || {};
    const cw5 = cc.ephemeral_5m_input_tokens;
    const cw1 = cc.ephemeral_1h_input_tokens;
    // Older logs only have the combined figure; treat it as 5m-TTL writes.
    const hasSplit = cw5 != null || cw1 != null;
    entries.push([
      key,
      parts.date,
      parts.hour,
      msg.model,
      u.input_tokens || 0,
      u.output_tokens || 0,
      u.cache_read_input_tokens || 0,
      hasSplit ? cw5 || 0 : u.cache_creation_input_tokens || 0,
      hasSplit ? cw1 || 0 : 0,
    ]);
  }
  return entries;
}

async function aggregate() {
  const files = await listJsonlFiles(PROJECTS_DIR);
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
    let entries = [];
    try {
      entries = parseContent(await fsp.readFile(file, 'utf8'));
    } catch {
      /* unreadable file — skip */
    }
    liveCache[file] = { mtimeMs: st.mtimeMs, size: st.size, entries };
    cacheDirty = true;
  }
  // Files that vanished from disk (deleted project folders, pruned logs) keep
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

  // Global dedup (resumed sessions copy older messages into new files),
  // then bucket by date|model|project|session.
  const seen = new Set();
  const buckets = new Map();
  const projectLive = new Map(); // project -> still has at least one on-disk file
  for (const file of Object.keys(fileCache).sort()) {
    const { entries, gone } = fileCache[file];
    const project = projectOf(file);
    projectLive.set(project, projectLive.get(project) || !gone);
    if (!entries || !entries.length) continue;
    const session = sessionOf(file);
    for (const [key, date, hour, model, inp, out, cr, cw5, cw1] of entries) {
      if (seen.has(key)) continue;
      seen.add(key);
      const bk = `${date}|${hour}|${model}|${project}|${session}`;
      let b = buckets.get(bk);
      if (!b) {
        b = { date, hour, model, project, session, input: 0, output: 0, cacheRead: 0, cacheW5m: 0, cacheW1h: 0, msgs: 0 };
        buckets.set(bk, b);
      }
      b.input += inp;
      b.output += out;
      b.cacheRead += cr;
      b.cacheW5m += cw5;
      b.cacheW1h += cw1;
      b.msgs += 1;
    }
  }

  const list = [];
  for (const b of buckets.values()) {
    const c = costOf(b.model, b);
    b.cost = c.total;
    b.cIn = c.input || 0;
    b.cOut = c.output || 0;
    b.cCr = c.cacheRead || 0;
    b.cCw = c.cacheWrite || 0;
    b.cacheSavings = c.cacheSavings || 0;
    b.priced = c.known;
    b.projectDeleted = !projectLive.get(b.project);
    list.push(b);
  }
  return { buckets: list, generatedAt: Date.now(), fileCount: files.length };
}

module.exports = { init, aggregate, PROJECTS_DIR };
