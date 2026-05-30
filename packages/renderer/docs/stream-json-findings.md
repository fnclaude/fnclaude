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

## Slash-command interception (verified: claude 2.1.158, claude-haiku-4-5)

Slash commands sent as the `text` field are intercepted locally — they do NOT forward to the model as prompt text. Verified with `/compact`.

The intercepted response is a synthetic assistant event: `model: "<synthetic>"`, `input_tokens: 0`, `output_tokens: 0`, `num_turns: 0` — identical to the `/usage` response signature already noted under [Output event types](#output-event-types-claude-stdout--renderer). The `result` event follows immediately after.

`compact` is present in the `init` event's `slash_commands[]`. When claude is below its compaction threshold the synthetic `assistant.content[0].text` is `"Not enough messages to compact."`.

**Implication for the renderer:** `sendUserTurn("/compact …")` is sufficient to invoke compaction. No PTY keystroke injection or special out-of-band mechanism is needed.

**Not yet verified:** a successful above-threshold compaction round-trip. Every test run during this spike stayed below the threshold. The invocation path is proven; compaction behavior when the threshold is met is claude's internal logic and identical to the interactive-TUI path.

## Cross-mode resume (verified: claude 2.1.158)

A session established over `--print`/stream-json persists to the standard on-disk store. Verified: established context in a stream-json turn, let the process exit, then resumed via `claude --resume <session_id>` (itself a `--print` invocation) — the context was recalled.

Sessions are stored at `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` where `cwd-slug` is the working directory path with `/` replaced by `-`. Same location and format interactive sessions use. The `session_id` from the `system/init` event is a real bridge back to the conversation.

**Caveat:** the resume in this test was a `--print` resume, not a literal interactive-TUI launch. Both read the identical on-disk store, so interactive resume is low-risk, but it was not separately proven.

## `system/status` events

`system` events with `subtype: "status"` appear between turns in the stream. They are informational — safe to ignore. The event spec currently only enumerates `system/init`; `system/status` is an additional undocumented subtype.

`system/init` repeating per turn is already documented above.

## Gotchas

- `--output-format stream-json` requires `--verbose` — fails otherwise.
- `system/init` repeats per turn. Informational, not a "new session" signal.
- Each user turn counts as a fresh `num_turns: 1`.
- No partial deltas by default — add `--include-partial-messages` if you want token-level streaming.
- Lines can be very large. Any `readline`-equivalent must use a generous max-line setting (default in Bun's stream APIs is fine; if rolling your own, allocate megabytes, not kilobytes).
- Clean exit takes ~250ms after stdin close.
- **CLAUDE.md in the subprocess cwd.** A `claude` subprocess spawned under a directory with a `CLAUDE.md` inherits those project instructions, which shape its behavior. Observed: during a test run where cwd was inside a repo with a restrictive `CLAUDE.md`, the model refused a contrived test prompt citing project rules. When driving stream-json for testing, run in a CLAUDE.md-free directory or expect project-instruction influence on model responses.
