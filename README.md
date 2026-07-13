<div align="center">

<img src="scripts/fire.svg" width="110" alt="Ember logo" />

# Ember

**One little flame that watches your entire AI coding spend.**

Claude Code + ChatGPT Codex usage, transparent API-equivalent cost, and plan limits — in a single precision desktop widget.

[![Release](https://img.shields.io/github/v/release/HarshalVankudre/Ember-usage-widget?color=ff5a1f&label=release)](https://github.com/HarshalVankudre/Ember-usage-widget/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/HarshalVankudre/Ember-usage-widget/total?color=ffc24d&label=downloads)](https://github.com/HarshalVankudre/Ember-usage-widget/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2011-0a84ff)](#install)
[![Electron](https://img.shields.io/badge/built%20with-Electron-19c37d)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-98989d)](LICENSE)

<img src="docs/ember.png" width="560" alt="Ember widget showing combined Claude + Codex spend, plan limit trackers, and token stats" />

</div>

---

## Why Ember?

You code with **Claude Code** *and* **Codex**. Each has its own invisible meters — a 5-hour session limit, a weekly limit, tokens quietly burning in the background. Ember puts all of it on your desktop in one always-on-top, frosted-glass widget that reacts **live** to changes in the local session logs. No accounts, no telemetry, nothing leaves your machine.

## ✨ Features

### 🔥 Two providers, one flame
- **Combined API-equivalent spend** — hero total, today's burn, rolling *Last 5 hours* and *Last 7 days* windows across both tools
- **Provider & model filter chips** — isolate Claude or Codex, or any single model, with one click
- **Stacked daily spend chart** with hover breakdowns, weekly grouping for long ranges, and clickable days that open the complete token, project, model, and cost breakdown for that date
- Clicking a daily spike moves the range control to **Custom**, so the detailed day being viewed is always unambiguous

### ⏱️ Plan limits, per provider — the meters that actually matter
- **Claude**: 5-hour session + weekly trackers (plus per-model weekly rows when active), fetched with Claude Code's own token — terracotta bars
- **Codex**: 5-hour session + weekly trackers read *locally* from rollout logs, zero extra network — green bars
- Live "resets in…" countdowns, plan badges (Max, Pro, Plus…), color shift at 80% / 95%
- The flame itself reacts: calm flicker → faster & brighter past 80% → pulsing red past 95% 🔴

### 🧾 Costs you can trust
Every request is priced with **its own provider's official billing rules** before anything is merged. Ember refreshes both providers' official pricing documents daily, caches them for offline use, and keeps uncertainty visible instead of fabricating precision:

| | Claude | Codex |
|---|---|---|
| Input / output | official per-model rates, date-aware intro pricing | official per-model rates; historical long-context tiers applied per request |
| Cache reads | 0.1× input | discounted cached-input rate |
| Cache writes | official 5-minute / 1-hour rates from real log counts | measured when present; otherwise a labeled lower-to-conservative range |
| Reasoning tokens | — | subset of output — shown, **never double-counted** |
| Modifiers | fast mode, US inference geography, and logged web-search fees | GPT-5.4+ / 5.5 / 5.6 long-context multipliers |
| Unpublished models | shown as **Unpriced**, excluded from the dollar total | shown as **Unpriced**, never guessed |

The headline is an API-equivalent value, not a subscription invoice. When Codex omits GPT-5.6 cache-write counts, Ember shows the conservative estimate alongside the lower bound. In Codex-only views, the token ledger adapts to show measured **Reasoning** instead of an empty Cache write card; reasoning remains part of Output and is not added twice. Pricing coverage beside the headline reports any calls excluded because no official public rate exists.

OpenAI model IDs surfaced inside Claude Code by compatibility gateways such as Claudex/Ultracode are reattributed to Codex and repriced with OpenAI rules before the providers are merged. That keeps GPT-5.6 Sol, Terra, and Luna in one model row without dropping their Claude Code project usage.

Internal `nexus-gpt-*` compatibility models are excluded before aggregation, so they do not appear in totals, charts, filters, projects, or model breakdowns.

### 🗂️ Your history is permanent
- Parsed usage lives in Ember's own cache — **deleting session logs never erases your numbers**
- Live records retain minute-level timestamps for time-range filtering. Existing caches migrate forward without losing legacy history; if a deleted legacy log no longer retains an exact timestamp, Ember does not invent minute precision for it
- Projects whose logs are gone move to a tidy collapsed **Deleted projects** group at the bottom
- Right-click any project to **blur it & exclude it from totals** (privacy mode for screen shares)
- Expand any project for a per-model token & cost breakdown

### 🖥️ A widget that behaves
- Calm matte “burn ledger” theme over Windows acrylic, always-on-top toggle, remembers its position
- Lives in the tray (flame icon) — close just hides it; autostart optional
- Cache savings, burn per active day, session count, cache-hit rate insights
- Today / 7D / 30D / Month / All / custom date-and-time ranges
- Custom ranges use strict 24-hour `HH:MM` times (for example `19:45`) and support either **start → now** or an explicit end date and time
- Debounced filesystem updates, shared aggregation work, selective rendering, and periodic reconciliation keep interaction and live refreshes responsive without dropping history or calculations

## 📦 Install

Grab **[Ember v1.2.0](https://github.com/HarshalVankudre/Ember-usage-widget/releases/tag/v1.2.0)**, or check **[Releases](https://github.com/HarshalVankudre/Ember-usage-widget/releases/latest)** for the newest package:

| File | What it is |
|---|---|
| `Ember Setup 1.2.0.exe` | One-click installer — per-user, tray + autostart, no admin needed |
| `Ember Portable 1.2.0.exe` | Single portable exe — no install at all |

> Requires Windows 11 (22H2+ for the acrylic blur) and local sessions of [Claude Code](https://claude.com/claude-code) and/or [Codex](https://openai.com/codex/).

## 🔍 Where the data comes from

| | Claude | Codex |
|---|---|---|
| Usage logs | `~/.claude/projects/**/*.jsonl` | `~/.codex/sessions` + `archived_sessions` |
| Plan limits | Anthropic account API (Claude Code's own OAuth token, read-only) | `rate_limits` snapshots inside the rollout logs |
| Refresh | filesystem watcher with debounced updates and periodic reconciliation | same |

Everything is read-only and stays on your machine. Plan-limit meters are each provider's own measure of work done — the dollar figures are API-equivalent *estimates* of what your subscription usage would have cost at pay-as-you-go rates (a fun number to watch next to a flat-rate plan 😄).

## 🛠️ Build from source

```bash
git clone https://github.com/HarshalVankudre/Ember-usage-widget.git
cd Ember-usage-widget
npm install
npm start          # dev run
npm test           # pricing + attribution checks
npm run dist       # build installer + portable exe
```

Debug tip: `WIDGET_SHOT=shot.png npm start` saves screenshots of the rendered widget.

## 🙏 Credits

- Flame logo: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) "Fire" by Microsoft (MIT), rasterized to the app/tray icons at build time by `scripts/render-icon.js`
- Grew out of [Claude-usage-widget](https://github.com/HarshalVankudre/Claude-usage-widget) and [Codex-usage-widget](https://github.com/HarshalVankudre/Codex-usage-widget), now merged into one

## 📄 License

[MIT](LICENSE) © Harshal Vankudre
