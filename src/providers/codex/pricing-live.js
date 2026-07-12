'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setLivePrices } = require('./pricing');

// OpenRouter carries exact Codex model names (e.g. openai/gpt-5.6-sol). It is
// used only as a fallback for models not yet present in our official table.
const SOURCE_URL = 'https://openrouter.ai/api/v1/models';
const REFRESH_MS = 24 * 3600 * 1000; // daily
const RETRY_MS = 60 * 60 * 1000; // failed fetch: try again hourly
const CACHE_VERSION = 1;

let cachePath = null;
let state = { live: false, fetchedAt: 0, models: 0 };

function status() {
  return { ...state, source: state.live ? 'OpenRouter' : 'built-in table' };
}

// OpenRouter prices are USD per token; the widget prices are USD per million.
function buildMap(models) {
  const map = {};
  for (const m of models || []) {
    const id = String(m.id || '');
    if (!id.startsWith('openai/') || id.includes(':')) continue; // skip :free/:extended variants
    const p = m.pricing || {};
    const input = Number(p.prompt) * 1e6;
    const output = Number(p.completion) * 1e6;
    if (!isFinite(input) || !isFinite(output) || (input === 0 && output === 0)) continue;
    const cacheRead = Number(p.input_cache_read) * 1e6;
    map[id.slice('openai/'.length).toLowerCase()] = {
      input,
      output,
      // 0 = not published; setLivePrices substitutes the static table's rate
      cached: isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0,
    };
  }
  return map;
}

function apply(prices, fetchedAt) {
  const n = Object.keys(prices).length;
  if (!n) return false;
  setLivePrices(prices);
  state = { live: true, fetchedAt, models: n };
  return true;
}

async function refresh() {
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(SOURCE_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const prices = buildMap(body.data);
    if (!apply(prices, Date.now())) throw new Error('empty price list');
    if (cachePath) {
      await fsp
        .writeFile(cachePath, JSON.stringify({ v: CACHE_VERSION, fetchedAt: state.fetchedAt, prices }))
        .catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('live pricing fetch failed:', err.message);
    return false;
  } finally {
    clearTimeout(kill);
  }
}

// Loads cached prices immediately (so a cold offline start still has the last
// good data), then refreshes from the network now and daily after. onUpdated
// fires after every successful refresh so the UI can recompute costs.
function init(userDataDir, onUpdated) {
  cachePath = path.join(userDataDir, 'pricing-live.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed.v === CACHE_VERSION) apply(parsed.prices, parsed.fetchedAt || 0);
  } catch {
    /* no cache yet */
  }

  let timer = null;
  const cycle = async () => {
    const fresh = state.live && Date.now() - state.fetchedAt < REFRESH_MS;
    let ok = fresh;
    if (!fresh) {
      ok = await refresh();
      if (ok && onUpdated) onUpdated();
    }
    timer = setTimeout(cycle, ok ? REFRESH_MS : RETRY_MS);
    if (timer.unref) timer.unref();
  };
  return cycle();
}

module.exports = { init, refresh, status };
