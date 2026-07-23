'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { costOf } = require('./pricing');
const { costOf: codexCostOf } = require('../codex/pricing');
const { isOpenAIModel } = require('../model-attribution');
const { PROJECTS_DIR: CLAUDEX_PROJECTS_DIR } = require('../claudex-paths');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROJECTS_DIRS = [CLAUDE_PROJECTS_DIR, CLAUDEX_PROJECTS_DIR];

const CACHE_VERSION = 4; // v4: local minute precision appended to cached entries
const LEGACY_ENTRY_LENGTH = 13;

let cachePath = null; // set via init()
let fileCache = {}; // filePath -> { mtimeMs, size, entries }
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
  cachePath = path.join(userDataDir, 'claude-usage-cache.json');
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

function projectsRootOf(file) {
  return PROJECTS_DIRS.find((dir) => file === dir || file.startsWith(`${dir}${path.sep}`))
    || CLAUDE_PROJECTS_DIR;
}

function projectOf(file) {
  const rel = path.relative(projectsRootOf(file), file);
  const slug = rel.split(path.sep)[0] || 'unknown';
  // "C--Users-you-Desktop-my-app" -> "Desktop/my/app" style readable name
  let name = slug.replace(/^C--Users-[^-]+-?/, '').replace(/-/g, '/');
  if (!name) name = '~ (home)';
  return name;
}

function sessionOf(file) {
  const rel = path.relative(projectsRootOf(file), file);
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
  return { date: `${y}-${m}-${day}`, hour: d.getHours(), minute: d.getMinutes() };
}

// entry: [dedupKey, date, hour, model, input, output, cacheRead, cacheW5m,
//         cacheW1h, speed, inferenceGeo, webSearches, serviceTier, minute]
function parseContent(text, source = 'claude') {
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
    const cc = u.cache_creation || {};
    const cw5 = cc.ephemeral_5m_input_tokens;
    const cw1 = cc.ephemeral_1h_input_tokens;
    // Older logs only have the combined figure; treat it as 5m-TTL writes.
    const hasSplit = cw5 != null || cw1 != null;
    const write5 = hasSplit ? cw5 || 0 : u.cache_creation_input_tokens || 0;
    const write1 = hasSplit ? cw1 || 0 : 0;
    const tools = u.server_tool_use || {};
    const webSearches = Math.max(0, Number(tools.web_search_requests || tools.web_searches || 0));
    const stableFallback = [
      source, obj.timestamp || '', msg.model,
      u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0,
      write5, write1, u.speed || '', u.inference_geo || '', webSearches,
    ].join(':');
    const key = msg.id ? `${msg.id}:${obj.requestId || ''}` : obj.uuid || stableFallback;
    entries.push([
      key,
      parts.date,
      parts.hour,
      msg.model,
      u.input_tokens || 0,
      u.output_tokens || 0,
      u.cache_read_input_tokens || 0,
      write5,
      write1,
      u.speed || 'standard',
      u.inference_geo || 'not_available',
      webSearches,
      u.service_tier || 'standard',
      parts.minute,
    ]);
  }
  return entries;
}

async function aggregate() {
  const files = (await Promise.all(PROJECTS_DIRS.map(listJsonlFiles))).flat();
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
    let entries = null;
    try {
      const source = projectsRootOf(file) === CLAUDEX_PROJECTS_DIR ? 'claudex' : 'claude';
      entries = parseContent(await fsp.readFile(file, 'utf8'), source);
    } catch {
      /* preserve cached history at legacy precision if a file is unreadable */
    }
    if (entries) {
      liveCache[file] = { mtimeMs: st.mtimeMs, size: st.size, entries };
    } else if (prev) {
      const { gone, ...rest } = prev;
      liveCache[file] = { ...rest, mtimeMs: st.mtimeMs, size: st.size };
    } else {
      liveCache[file] = { mtimeMs: st.mtimeMs, size: st.size, entries: [] };
    }
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
  cacheNeedsReparse = false;
  if (cacheDirty) saveCache();

  // Global dedup (resumed sessions copy older messages into new files),
  // then bucket by date|hour|minute|model|project|session.
  const seen = new Set();
  const buckets = new Map();
  const projectLive = new Map(); // project -> still has at least one on-disk file
  for (const file of Object.keys(fileCache).sort()) {
    const { entries, gone } = fileCache[file];
    const project = projectOf(file);
    projectLive.set(project, projectLive.get(project) || !gone);
    if (!entries || !entries.length) continue;
    const session = sessionOf(file);
    for (const [key, date, hour, model, inp, out, cr, cw5, cw1, speed = 'standard', inferenceGeo = 'not_available', webSearches = 0, serviceTier = 'standard', minute = null] of entries) {
      if (seen.has(key)) continue;
      seen.add(key);
      const bk = `${date}|${hour}|${minute}|${model}|${project}|${session}`;
      let b = buckets.get(bk);
      if (!b) {
        b = {
          date, hour, minute, model, project, session,
          input: 0, output: 0, cacheRead: 0, cacheW5m: 0, cacheW1h: 0, webSearches: 0, msgs: 0,
          cost: 0, costMin: 0, costMax: 0,
          cIn: 0, cOut: 0, cCr: 0, cCw: 0, cTool: 0, cacheSavings: 0,
          pricedCalls: 0, unpricedCalls: 0, estimated: false,
          fastCalls: 0, usRegionCalls: 0, longContextCalls: 0,
          pricingSource: '', serviceTiers: [],
        };
        buckets.set(bk, b);
      }
      b.input += inp;
      b.output += out;
      b.cacheRead += cr;
      b.cacheW5m += cw5;
      b.cacheW1h += cw1;
      b.webSearches += webSearches;
      b.msgs += 1;

      const gateway = isOpenAIModel(model);
      const c = gateway
        ? codexCostOf(model, {
          input: inp,
          output: out,
          cached: cr,
          cacheWrite: cw5 + cw1,
          cacheWriteKnown: true,
          totalInput: inp + cr + cw5 + cw1,
        })
        : costOf(model, { date, input: inp, output: out, cacheRead: cr, cacheW5m: cw5, cacheW1h: cw1, speed, inferenceGeo, webSearches, serviceTier });
      b.cost += c.total || 0;
      b.costMin += c.costMin || 0;
      b.costMax += c.costMax || 0;
      b.cIn += c.input || 0;
      b.cOut += c.output || 0;
      b.cCr += (gateway ? c.cached : c.cacheRead) || 0;
      b.cCw += c.cacheWrite || 0;
      b.cTool += c.toolFee || 0;
      b.cacheSavings += c.cacheSavings || 0;
      b.estimated = b.estimated || !!c.estimated;
      b.fastCalls += c.fast ? 1 : 0;
      b.usRegionCalls += c.usRegion ? 1 : 0;
      b.longContextCalls += c.longContext ? 1 : 0;
      b.pricingSource = c.source || b.pricingSource;
      if (!b.serviceTiers.includes(serviceTier)) b.serviceTiers.push(serviceTier);
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
  return { buckets: list, generatedAt: Date.now(), fileCount: files.length };
}

module.exports = {
  init,
  aggregate,
  parseContent,
  PROJECTS_DIR: CLAUDE_PROJECTS_DIR,
  PROJECTS_DIRS,
  CLAUDEX_PROJECTS_DIR,
};
