# The status-line JSON payload

Claude Code hands its configured status-line command a JSON object on stdin
before every render. That object carries live session state that is **not
reachable anywhere else in the process tree** — including the context-window
percentage, the session id, the transcript path, both rate-limit windows, and
the current model and effort.

This matters to fnclaude because several things fnc currently derives by
parsing the session JSONL, or cannot derive at all, arrive here for free.

Captured against **v2.1.240** (2026-08-22) by temporarily teeing the payload
from a live status-line invocation. Field names are stable public contract
(they're what any status-line script consumes), not minified internals.

---

## Full payload

Every field observed in a single render, interactive session:

```jsonc
{
  "session_id":      "<uuid>",              // the live session's own id
  "transcript_path": "~/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
  "cwd":             "/abs/path",
  "prompt_id":       "<uuid>",              // changes per user turn
  "session_name":    "fnc skill notice config option",
  "version":         "2.1.240",             // Claude Code's version
  "model":   { "id": "claude-opus-5", "display_name": "Opus 5" },
  "effort":  { "level": "max" },
  "thinking": { "enabled": true },
  "output_style": { "name": "Proactive" },

  "workspace": {
    "current_dir": "/abs/path",
    "project_dir": "/abs/path",
    "added_dirs":  [],                      // --add-dir entries
    "repo": { "host": "github.com", "owner": "…", "name": "…" }
  },

  "cost": {
    "total_cost_usd":      3.151322,
    "total_duration_ms":   821903,
    "total_api_duration_ms": 438556,
    "total_lines_added":   0,
    "total_lines_removed": 0
  },

  "context_window": {
    "total_input_tokens":   132025,
    "total_output_tokens":  3,
    "context_window_size":  1000000,        // the denominator
    "used_percentage":      13,
    "remaining_percentage": 87,
    "current_usage": {
      "input_tokens":                2,
      "output_tokens":               3,
      "cache_creation_input_tokens": 499,
      "cache_read_input_tokens":     131524
    }
  },

  "rate_limits": {
    "five_hour":  { "used_percentage": 14.0, "resets_at": 1787448600 },
    "seven_day":  { "used_percentage": 42,   "resets_at": 1787796000 }
  }
}
```

`resets_at` values are Unix epoch seconds.

---

## What each cluster unlocks for fnclaude

### `context_window` — the percentage fnc cannot compute

`current_usage` sums exactly to `total_input_tokens`
(`2 + 499 + 131524 = 132025`), and that sum is the **same quantity** the
context-notice monitor already computes from the JSONL
(`input + cache_creation + cache_read`, `usage/session-usage.ts`). So swapping
sources changes nothing semantically.

What's new is the denominator. `computeSessionUsage` returns
`{ tokens, model }` and nothing else — there is no window size anywhere in the
CLI, which is why fnc can express notice thresholds only in raw tokens. Here,
`context_window_size` and `used_percentage` are published directly, and
`used_percentage` is *the same number the user reads off their own status
line* — so any fnc feature that needs to speak in percentages can be exact
rather than approximating Claude Code's accounting.

### `session_id` + `transcript_path` — identity without guessing

`planOwnSession` (`usage/own-session.ts`) already knows the id for fresh,
`--resume <uuid>`, and user-supplied-`--session-id` launches, because fnc mints
and injects it. It returns `null` for `--continue`, `--fork-session`, and the
bare `--resume` picker, where the reader falls back to the oldest-post-baseline
heuristic and its documented residual race.

The payload supplies both the id and the resolved absolute transcript path on
every render, for **every** launch shape — which is a direct answer to that
residual race without the proposed pre-spawn snapshot-diff.

### `rate_limits` — the quotas `get_usage` reports as null

`get_usage`'s contract says the subscription quotas can't be observed because
the `anthropic-ratelimit-unified-*` headers travel over claude's API connection
rather than the terminal fnc wraps. True of the headers — but both windows
arrive here, with reset timestamps.

### `model.id` and `effort.level` — live values fnc otherwise lacks

`restart.md` and `project-switch.md` both state that model has no env exposure;
fnc scrapes `CLAUDE_EFFORT` for effort and has no source at all for the live
model. Both are in the payload.

---

## Consuming it

The payload only reaches the process named by `statusLine.command` in
`settings.json`. Anything else that wants it must be in that command's path —
i.e. a wrapper that snapshots the payload and then execs the user's real
status-line script with the same JSON on stdin.

Constraints such a wrapper must respect:

- **Self-key off `session_id`** so concurrent sessions never collide and no
  coordination with fnc is needed.
- **Write via temp + rename** so a reader can never observe a partial file.
- **Never break the status line.** Pass through the inner command's stdout,
  stderr and exit code untouched; swallow every snapshot failure.
- **Freshness is render-bound.** The snapshot is only as current as the last
  render — a state file someone else updates, not a feed. Adequate for
  threshold monitoring (the existing poll is coarser than truth anyway), but
  JSONL parsing has to remain the fallback for sessions with no wrapper.

**Install has an ownership hazard.** Wrapping requires editing
`~/.claude/settings.json`, which fnc does not own and which is chezmoi-managed
on at least one developer's machine. An automatic rewrite there loses a fight
with `chezmoi apply` and shows as drift in the meantime, so installation must
be explicit rather than something that happens at launch.

---

## Reusable string seeds

| Seed | Leads to |
|---|---|
| `context_window` / `used_percentage` / `context_window_size` | the context cluster |
| `rate_limits` / `five_hour` / `seven_day` / `resets_at` | quota cluster |
| `transcript_path` / `session_id` | session identity |
| `statusLine` | the settings key naming the command |
