'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setLivePrices } = require('./pricing');

const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing.md';
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 60 * 60 * 1000;
// v3 records whether a row is priced in context tiers, so the surcharge comes
// from the official table instead of a bundled assumption.
const CACHE_VERSION = 3;

let cachePath = null;
let state = { live: false, fetchedAt: 0, models: 0 };

function cleanModelName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s*\(<272k context length\)\s*/i, '')
    .trim();
}

// The official MDX contains several arrays (standard, batch, flex). Standard
// appears first, so first occurrence wins. A row is either
// [model,input,cached,output] or [model,input,cached,cacheWrite,output].
function buildMap(markdown) {
  const map = {};
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(/(\["[^"]+"\s*,[^\]]+\])/);
    if (!match) continue;
    let row;
    try {
      row = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(row) || (row.length !== 4 && row.length !== 5)) continue;
    // OpenAI labels the context-tiered rows "(<272K context length)". That
    // marker is the only statement that a model carries a long-context
    // surcharge, so it is recorded rather than inferred from the family.
    const longContext = /<\s*272k context length/i.test(String(row[0]));
    const id = cleanModelName(row[0]);
    if (!/^(?:gpt|chatgpt|chat-|codex|o\d)/.test(id) || map[id]) continue;
    const numeric = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const input = numeric(row[1]);
    const cached = numeric(row[2]);
    const write = row.length === 5 ? numeric(row[3]) : null;
    const output = numeric(row[row.length - 1]);
    if (input == null || output == null) continue;
    map[id] = {
      input,
      cached: cached == null ? input : cached,
      write: write == null ? undefined : write,
      output,
      longContext,
    };
  }
  return map;
}

function apply(prices, fetchedAt) {
  const models = Object.keys(prices || {}).length;
  if (!models) return false;
  setLivePrices(prices);
  state = { live: true, fetchedAt, models };
  return true;
}

function status() {
  return {
    ...state,
    provider: 'OpenAI',
    source: state.live ? 'Official pricing · live' : 'Official pricing · bundled',
    url: SOURCE_URL,
  };
}

async function refresh() {
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal, headers: { accept: 'text/markdown' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const prices = buildMap(await res.text());
    if (!apply(prices, Date.now())) throw new Error('empty standard price table');
    if (cachePath) {
      await fsp.writeFile(cachePath, JSON.stringify({ v: CACHE_VERSION, fetchedAt: state.fetchedAt, prices })).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('OpenAI pricing refresh failed:', err.message);
    return false;
  } finally {
    clearTimeout(kill);
  }
}

function init(userDataDir, onUpdated) {
  cachePath = path.join(userDataDir, 'openai-pricing.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed.v === CACHE_VERSION) apply(parsed.prices, parsed.fetchedAt || 0);
  } catch {
    /* first run or old cache */
  }

  const cycle = async () => {
    const fresh = state.live && Date.now() - state.fetchedAt < REFRESH_MS;
    const ok = fresh || await refresh();
    if (!fresh && ok && onUpdated) onUpdated();
    const timer = setTimeout(cycle, ok ? REFRESH_MS : RETRY_MS);
    if (timer.unref) timer.unref();
  };
  return cycle();
}

module.exports = { SOURCE_URL, buildMap, init, refresh, status };
