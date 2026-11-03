<div align="center">

<img src="src/renderer/assets/logo-mark.png" width="116" alt="Ember flame and usage-meter mark" />

# Ember

### Your AI coding burn, without the blind spots.

One private desktop ledger for **Claude Code + Codex + OpenCode + Oh My Pi** usage, plan headroom,<br />
and honest API-equivalent cost — updated live from the logs already on your machine.

[![Latest release](https://img.shields.io/github/v/release/HarshalVankudre/Ember-usage-widget?style=flat-square&label=latest&color=ff7547)](https://github.com/HarshalVankudre/Ember-usage-widget/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/HarshalVankudre/Ember-usage-widget/total?style=flat-square&label=downloads&color=f4b35f)](https://github.com/HarshalVankudre/Ember-usage-widget/releases)
[![Windows 11](https://img.shields.io/badge/Windows-11-38c98b?style=flat-square&logo=windows11&logoColor=white)](#install)
[![Tauri](https://img.shields.io/badge/Tauri-2-ffc131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![MIT](https://img.shields.io/badge/license-MIT-a0968d?style=flat-square)](LICENSE)

**[Download Ember](https://github.com/HarshalVankudre/Ember-usage-widget/releases/latest)** · [What it shows](#why-ember) · [Session burn](#session-burn--what-a-percent-of-your-plan-actually-buys) · [How it works](#how-it-works) · [Build from source](#build-from-source)

<br />

<img src="docs/ember.png" width="470" alt="Ember showing API-equivalent value, Claude and Codex plan headroom, rolling windows, month projection, and the session burn panel with a live 5-hour window and its per-window history" />

<sub>Local data, live limits, official API rates.</sub>

</div>

---

## Why Ember

Subscriptions make AI coding feel unlimited right up until a session meter turns red. At the same time, millions of input, output, and cached tokens make it almost impossible to understand the value of what you used.

Ember turns those invisible meters into one calm, always-available desktop view.

| 🔥 Live headroom | ◉ Honest cost | ⏱ Complete history |
|---|---|---|
| Claude and Codex session and weekly limits—including Claude's separate Fable 5 quota—with reset countdowns. | Request-level pricing using each provider's official published rates, and nothing else. | Durable local history, even after the original session logs are deleted. |

### Everything important, at a glance

- **Session burn** — what one 5-hour window costs, and what a percent of plan buys
- **One headline number** for combined Claude Code and Codex API-equivalent value
- **5-hour, 7-day and month-to-date windows**, with a month-end projection
- **Period comparison** against the equivalent stretch before it
- **Provider and model filters** for instant isolation of any slice
- **Interactive burn history** with daily drill-downs and custom date-and-time ranges
- **Model and project breakdowns** with screen-share privacy controls
- **Agent working time per project and model**: every finished Claude Code and Codex turn, from the prompt to the agent's final reply
- **Compact mode**, tray residency, always-on-top, autostart, and Windows 11 acrylic
- **Export** to CSV or JSON, and a copy-ready Markdown summary

> [!IMPORTANT]
> Ember shows the **API-equivalent value** of subscription usage. It is not your Claude or ChatGPT invoice.

## Session burn — what a percent of your plan actually buys

Both providers publish a single "you are N% through your quota" number and nothing else. There is no history, and no record of what that percent used to buy — so an allowance that quietly moves looks exactly like one that never changed. Claude Code's 5-hour caps doubled on 6 May 2026; before that they tightened. Neither is visible in any meter.

Ember keeps the record the meters do not.

**Two independent sources, and they check each other.**

- **Reconstruction.** A Claude session window opens on the first call and closes five hours later, anchored to the top of the hour. Replaying that rule across your local logs measures *every* 5-hour block you have ever worked — available the moment you install, with no waiting.
- **Observation.** Ember samples each plan meter it can see and remembers every window it watched, with the peak utilization the provider reported. Pairing a window with the usage recorded inside it produces the figure neither provider publishes: **tokens, and API-equivalent value, per one percent of plan.**

Where the two overlap, the observed window wins outright — its boundaries are the provider's own, so the percentage and the usage it is divided by are measured over the same interval. Windows Ember never watched keep their tokens and value and simply carry no percentage, rather than borrowing a neighbour's.

Switch between **Value**, **Tokens** and **Per 1%** to compare windows in the chart. Bars are stacked by model, so a shift you can explain by model mix looks different from one you cannot. Weekly quotas get the same treatment, anchored to your account's own reset time.

## Compact mode

Collapse Ember to a strip that keeps the live window on screen while you work — value spent, quota consumed, and time left. Double-click to expand, or use the tray.

<div align="center"><img src="docs/ember-compact.png" width="420" alt="Ember collapsed to a compact strip showing the live session value, quota bar and time remaining" /></div>

## Built to show its work

Ember prices every request under its own provider before combining totals. Official pricing documents refresh daily and are cached for offline use.

**A model is priced only when its provider publishes a price for that exact model.** Model ids carry an optional dated snapshot suffix and nothing more; a trailing `-pro`, `-fast` or `-spark` is a different product with its own rate, so those never inherit the base model's number. Where no published row exists, the dollar value is omitted and the calls are marked **Unpriced** — their tokens and calls stay in every total.

| Billing detail | Claude | Codex |
|---|---|---|
| Input and output | Official per-model rates, including date-aware introductory pricing | Official per-model rates |
| Cache reads | Discounted prompt-cache rate | Discounted cached-input rate |
| Cache writes | Logged 5-minute and 1-hour writes | Measured when present; otherwise a clearly labeled estimate range |
| Other modifiers | Fast mode, US inference geography, and logged web-search fees | Long-context tiers, applied only to the models OpenAI publishes in context tiers |
| Unknown pricing | Dollar value omitted and marked **Unpriced** | Dollar value omitted and marked **Unpriced** |

<details>
<summary><strong>More about attribution and accuracy</strong></summary>

OpenAI model IDs used through Claude Code compatibility gateways or OpenCode's OpenAI provider are reattributed to Codex and repriced with OpenAI rules before aggregation. Oh My Pi's first-party `anthropic`, `openai`, and `openai-codex` request statistics are read directly from the SQLite database behind `omp stats`, then folded into those same Claude and Codex model rows rather than shown as a third provider; every other OMP provider is ignored. OMP rows retain the token counts and recorded cost shown by its own dashboard. Codex reasoning is reported as a subset of output when the source exposes it and is never counted twice. Non-Claude/OpenAI gateway models (such as Qwen) and internal `nexus-gpt-*` traffic are excluded from totals, charts, filters, projects, and model breakdowns.

The long-context surcharge is read from the provider's own table rather than assumed from a model family: a model whose published price is flat is billed flat however large the request.

When a Codex log omits cache-write counts, Ember presents the conservative estimate alongside the lower bound. The coverage line under the headline tells you exactly how much traffic was priced and how many calls remain unpriced.

The session-burn panel deliberately ignores the date, provider and model filters. A plan meter counts everything, so a filtered view would not be comparable to one. Ember also reads only your editor logs — usage from the web apps is inside the provider's percentage but outside Ember's token totals, which makes a measured rate a floor rather than a ceiling.

</details>

## Export

The footer's export menu writes whatever is currently on screen, and only where you choose to put it.

| Export | Contents |
|---|---|
| Copy summary | Markdown block with headline, rolling windows and the recent session table |
| Session windows · CSV | One row per window: tokens, value, quota percent, value per 1%, projected full window |
| Current view · CSV | Day × model rows under the active filters |
| Current view · JSON | Totals, models, projects and windows in one structured file |

## Install

Ember supports **Windows 11**. Windows 11 22H2 or newer is recommended for the acrylic material.

1. Open the **[latest release](https://github.com/HarshalVankudre/Ember-usage-widget/releases/latest)**.
2. Run `Ember_2.0.2_x64-setup.exe` — a one-click per-user install with shortcuts, tray, and autostart.
3. Launch Ember. Existing local Claude Code, Codex, OpenCode, and Oh My Pi sessions appear automatically.

No API keys. No account setup. No database to configure. Upgrading from an Electron-era Ember (1.x)? Usage history, quota history, and settings carry over automatically on first launch.

Since 2.0, Ember is a native [Tauri](https://tauri.app/) app on Windows 11's built-in WebView2 — the Rust backend parses logs faster, and there is no bundled Chromium or Node runtime, so the installer and memory footprint are a fraction of the Electron build's.

## How it works

```text
Claude Code logs ─┐
Codex rollouts ───┼─► normalize ─► price per request ─► local history ─► Ember
OpenCode DB ──────┤                                          ▲
Oh My Pi logs ────┘                                          │
                                                             │
plan meters ──────► quota ledger (every window Ember watched)─┘
```

| Source | Claude | Codex |
|---|---|---|
| Usage | `~/.claude/projects/**/*.jsonl` plus Anthropic rows in `~/.omp/stats.db` | `~/.codex/sessions`, `archived_sessions`, OpenAI requests in `~/.local/share/opencode/opencode.db`, and OpenAI/OpenAI-Codex rows in `~/.omp/stats.db` |
| Plan limits | Read-only Anthropic account API using Claude Code's existing OAuth token | Local `rate_limits` snapshots from rollout logs |
| Updates | Debounced filesystem watcher plus periodic reconciliation | Debounced filesystem watcher plus periodic reconciliation |

A write to a log reaches the screen in about a tenth of a second, and reconciliation sweeps every few seconds behind it. An unchanged sweep costs a parallel `stat` pass rather than a full re-price, so the cadence stays cheap. When new usage lands, Ember schedules one catch-up read of the plan meters so headroom tracks the burn without hammering an endpoint that rate-limits hard.

Working time is recorded per turn. For Claude Code, a turn runs from the prompt to the final reply; Claude Code's own `turn_duration` is used whenever the log has one. For Codex, a turn runs from `task_started` to `task_complete`. Each turn counts toward the project, model and day it finished on, so per-model times add up to the project's total. Subagent work is already inside the turn that called it. A turn that's still running adds nothing until it finishes. A session closed mid-turn counts up to its last call once its log has been quiet for 30 minutes. Oh My Pi, OpenCode and ZCode record requests but not turns, so they add no time.

Parsed records live in Ember's own local cache, so cleaning up old session logs does not erase your history. Projects whose source logs are gone stay out of the project list, and visible projects can be blurred and excluded from totals before a screen share.

> [!NOTE]
> Ember reads your usage sources in place. Usage history, quota history, settings, and pricing caches remain on your machine; Ember adds no telemetry or cloud account.

## Build from source

Requires [Node.js](https://nodejs.org/) with npm, and a [Rust](https://rustup.rs/) toolchain.

```bash
git clone https://github.com/HarshalVankudre/Ember-usage-widget.git
cd Ember-usage-widget
npm install
npm start      # tauri dev
```

Useful commands:

```bash
npm test       # renderer checks (node) + pricing, limits, quota math, attribution, parsing (cargo)
npm run dist   # tauri build — NSIS installer plus a standalone executable
```

The backend lives in `src-tauri/` (Rust); the renderer in `src/renderer/` (plain HTML/CSS/JS over the `window.api` bridge).

## Author

Created and maintained by **[Harshal Vankudre](https://github.com/HarshalVankudre)**.

The Ember mark combines a flame with rising usage-meter bars (`src/assets/logo.png`; regenerate the in-app and Windows icons with `scripts/render-logo.ps1`). Ember grew from the original Claude and Codex usage widgets into a single, provider-aware ledger.

## License

[MIT](LICENSE) © Harshal Vankudre
