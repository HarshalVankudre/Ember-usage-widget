'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { setLivePrices } = require('./pricing');

const SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const REFRESH_MS = 24 * 3600 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const CACHE_VERSION = 1;

let cachePath = null;
let state = { live: false, fetchedAt: 0, models: 0 };

function dollars(cell) {
  const hit = String(cell || '').match(/\$([\d.]+)/);
  return hit ? Number(hit[1]) : null;
}

function buildMap(markdown) {
  const map = {};
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!/^\|\s*Claude\s+/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((v) => v.trim());
    if (cells.length !== 6) continue;
    const match = cells[0].match(/Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)/i);
    if (!match) continue;
    const family = match[1].toLowerCase();
    const version = match[2].replace('.', '-');
    let key = `${family}-${version}`;
    if (key === 'sonnet-5') key += /starting september/i.test(cells[0]) ? '@standard' : '@intro';
    if (map[key]) continue;
    const [input, cacheW5m, cacheW1h, cacheRead, output] = cells.slice(1).map(dollars);
    if ([input, cacheW5m, cacheW1h, cacheRead, output].some((v) => v == null)) continue;
    map[key] = { input, cacheW5m, cacheW1h, cacheRead, output, family };
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
    provider: 'Anthropic',
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
    if (!apply(prices, Date.now())) throw new Error('empty model price table');
    if (cachePath) {
      await fsp.writeFile(cachePath, JSON.stringify({ v: CACHE_VERSION, fetchedAt: state.fetchedAt, prices })).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('Anthropic pricing refresh failed:', err.message);
    return false;
  } finally {
    clearTimeout(kill);
  }
}

function init(userDataDir, onUpdated) {
  cachePath = path.join(userDataDir, 'anthropic-pricing.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed.v === CACHE_VERSION) apply(parsed.prices, parsed.fetchedAt || 0);
  } catch {
    /* first run */
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
