# Ember — Claude + Codex usage widget

A little flame that flickers while you code and heats up as you burn through your plan limits. Ember combines the Claude Usage Widget and the Codex Usage Widget into one app:

- **Plan usage limits stay per provider** — Claude and Codex each get their own 5-hour session tracker and weekly tracker (plus Claude's per-model weekly rows when active), with live reset countdowns and color-coded bars (terracotta for Claude, green for Codex).
- **Everything else is combined** — API-equivalent spend, token stat cards, rolling 5-hour / 7-day windows, the daily spend chart, the by-model table, and the projects list merge both providers into one view.
- **Usage history survives log deletion** — parsed records are kept in Ember's own cache, so deleting a project's session logs (or Codex pruning old sessions) never erases its numbers. Such projects move to a collapsed **Deleted projects** group at the bottom of the Projects panel.
- **Filters** — date presets, provider chips (Claude / Codex), and per-model chips to slice any view.
- The Ember flame reacts to the worst limit window across both providers: amber when calm, hot orange past 80%, pulsing red past 95%. Click it.

## How costs are calculated

Each usage bucket is priced with **its own provider's billing rules** before anything is merged — combined figures are sums of exact per-provider dollars, never a shared formula:

- **Claude**: `input × rate + output × rate + cacheRead × 0.1 × input-rate + 5m-writes × 1.25 × input-rate + 1h-writes × 2 × input-rate`, with date-aware intro pricing (e.g. Sonnet 5 before Sep 2026).
- **Codex**: `non-cached input × rate + output × rate + cached input × cached-rate`. Reasoning tokens are a subset of output — shown for information, **never added twice**. GPT-5.6+ cache writes (1.25× input) aren't logged by Codex, so the 25% surcharge is estimated from non-cached input and shown as "Cache write (est.)".

## Data sources

| | Claude | Codex |
|---|---|---|
| Usage logs | `~/.claude/projects/**/*.jsonl` | `~/.codex/sessions` + `~/.codex/archived_sessions` |
| Plan limits | Anthropic account API (Claude Code's own OAuth token, read-only) | `rate_limits` snapshots inside the rollout logs (no network) |
| Pricing | Bundled official Anthropic rates | Bundled official OpenAI rates + OpenRouter fallback for new models |

## Run / build

```
npm install
npm start          # dev run
npm run dist       # installer + portable exe (Windows)
```

Debug screenshot: set `WIDGET_SHOT=<path>.png` before `npm start` to capture the rendered window.

Closing the window hides to the tray (flame icon); quit from the tray menu.

## Credits

Flame logo: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) "Fire" by Microsoft, MIT license (`scripts/fire.svg`, rasterized to the app/tray icons at build time).

