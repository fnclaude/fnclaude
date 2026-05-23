# stream-json findings

Empirical notes from two spikes against `claude --print --verbose --input-format stream-json --output-format stream-json`. This file is the provenance record behind [event-spec.md](event-spec.md) and [`src/types/events.ts`](../src/types/events.ts).

## Headline

`claude --print --verbose --input-format stream-json --output-format stream-json` accepts multi-turn conversation over one stdin pipe, retains context across turns, and needs no `--resume`. Clean exit on stdin close (~250ms).

## Required flags

| Flag | Notes |
|---|---|
| `--print` | required |
| `--verbose` | required for stream-json output |
| `--input-format stream-json` | required |
| `--output-format stream-json` | required |

Optional, useful:

- `--include-partial-messages` — token-streaming deltas
- `--include-hook-events` — surfaces hook firings
- `--replay-user-messages` — echoes the user turns back

## Stdin must be a pipe

`claude < file.json` silently produces nothing and exits 0. ~10 min lost in the spike. Stdin **must** be a real pipe, not a regular file. Use `Bun.spawn` with `stdin: "pipe"`.

## Input event shape (renderer → claude stdin)

One JSON object per line, `\n` terminated:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

Typed as `UserTurn` in `src/types/events.ts`.

## Output event types (claude stdout → renderer)

NDJSON, `\n` terminated. Lines can be ~3KB or larger — line buffer must tolerate that.

- **`system`** subtype `init` — session metadata: `session_id`, `cwd`, `model`, `tools[]`, `slash_commands[]`, `permissionMode`, `memory_paths[]`, `claude_code_version`. **Repeats per turn**, not just at startup.
- **`assistant`** — wraps an Anthropic-style message: `id`, `model`, `role:"assistant"`, `content[]`, `stop_reason`, `stop_sequence`, `usage`. Content blocks include `text`, `tool_use`, and `thinking`. `model: "<synthetic>"` indicates a slash-command response (no LLM call; `input_tokens=0`, `output_tokens=0`, `num_turns=0`).
- **`user`** — replays `tool_result` blocks for tool-using turns. Same shape the renderer writes for user input, but produced by claude itself when surfacing tool results.
- **`result`** subtype `success | error` — per-turn terminator. Carries `result` (string — the visible answer), `num_turns`, `duration_ms`, `ttft_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage`, `stop_reason`, `terminal_reason`, `is_error`.
- **`rate_limit_event`** — intermittent.

## Slash commands

Sending `/usage` or any built-in slash command as the text field works: claude executes locally (no LLM call), emits a synthetic assistant + result. The `init` event's `slash_commands[]` enumerates what's available in the current environment.

**`/help` is not available in `--print` mode** — claude rejects it.

**Unknown slash commands** produce no assistant event. The failure message lives on `result.result` (e.g. `"Unknown command: /foo"`), and `is_error` is `false` despite the failure. Detection requires string-matching `result.result`.

## Multi-turn

After receiving a `result` event, send another user JSON object on stdin. Same `session_id`, context retained. No `--resume` needed. Each user turn counts as a fresh `num_turns: 1` run inside the result event — counting per turn, not per session.

## Gotchas

- `--output-format stream-json` requires `--verbose` — fails otherwise.
- `system/init` repeats per turn. Informational, not a "new session" signal.
- Each user turn counts as a fresh `num_turns: 1`.
- No partial deltas by default — add `--include-partial-messages` if you want token-level streaming.
- Lines can be very large. Any `readline`-equivalent must use a generous max-line setting (default in Bun's stream APIs is fine; if rolling your own, allocate megabytes, not kilobytes).
- Clean exit takes ~250ms after stdin close.
