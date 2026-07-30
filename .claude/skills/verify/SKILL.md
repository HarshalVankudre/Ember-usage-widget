---
name: verify
description: Launch Ember in an isolated Electron profile and verify usage attribution in the rendered widget.
---

# Verify Ember

1. Launch the real app with an isolated profile so an installed tray instance does not take the single-instance lock:

```bash
WIDGET_SHOT="$TEMP/ember-verify/ember.png" npm start -- --user-data-dir="$TEMP/ember-verify/userdata" --remote-debugging-port=9237
```

2. Use `http://127.0.0.1:9237/json/list` and the returned CDP websocket to inspect/click the rendered provider and model chips.
3. For attribution changes, verify all official `gpt-*`, `chatgpt-*`, `codex-*`, and `oN*` model chips have `Codex · <model>` titles, disappear under the Claude-only filter, and remain under the Codex-only filter.
4. Expand the affected project row and capture its token/cost breakdown. `WIDGET_SHOT` also writes full-window screenshots after startup.
5. Stop the Electron process when capture is complete.

The app reads the user's real `~/.claude` and `~/.codex` logs; only Electron settings/cache data is isolated by `--user-data-dir`.
