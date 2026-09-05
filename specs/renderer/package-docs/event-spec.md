# Event types — contract for slices A and B

The TypeScript event types live at [`src/types/events.ts`](../src/types/events.ts). That file is the source of truth; this doc is the high-level overview.

## Discriminated union: `ClaudeEvent`

Top-level: `{ type: "system" | "assistant" | "user" | "result" | "rate_limit_event" | "stream_event" | "parse_error", ... }`. All wire events share `session_id` and (where present) `uuid`.

## Variants

- **SystemEvent** — `subtype: "init"` (session metadata: `slash_commands`, model, tools, cwd, memory_paths; repeats per turn) or `"status"` (between-turn working indicator, carries `status` e.g. `"requesting"`). Other subtypes (`compact_boundary`, `can_use_tool`, `error`) are surfaced raw rather than dropped.
- **AssistantEvent** — wraps a `message` object containing `content[]` blocks (text, tool_use, thinking). `model: "<synthetic>"` indicates a slash-command response.
- **UserEvent** — typically wraps `tool_result` blocks claude replays. The renderer also **writes** this shape to claude's stdin as a user turn (see `UserTurn` in the types file).
- **ResultEvent** — per-turn terminator. `subtype: "success" | "error"`. `is_error: false` even for "Unknown command" failures — detect via string-match on `result`. Its `result` text is a verbatim copy of the final assistant text block; the renderer suppresses the duplicate body rather than printing it twice.
- **RateLimitEvent** — intermittent rate-limit info.
- **StreamEvent** — token-level partial-message envelope, emitted only with `--include-partial-messages` (the driver always passes it). `event` is the verbatim Anthropic Messages-API SSE event; see "Token-level streaming" below.
- **ParseErrorEvent** — synthetic, not a wire type. The parser emits `{type:"parse_error", raw}` for any line it cannot `JSON.parse` (or that lacks a `type`), so corruption is surfaced (dim raw) rather than silently dropped.

## Token-level streaming (`stream_event`)

`StreamEvent.event` is one Anthropic SSE event:
`message_start` → (`content_block_start` → `content_block_delta`* → `content_block_stop`)* → `message_delta` → `message_stop`.

The `content_block_delta.delta` carries one of: `text_delta` (`.text`), `thinking_delta` (`.thinking`), `signature_delta` (`.signature`, opaque), `input_json_delta` (`.partial_json`, a JSON-string fragment — accumulate raw, **never** `JSON.parse` mid-stream).

Critically, claude *also* emits a consolidated `assistant` event per content block, mid-stream, carrying the complete block. That consolidated event remains the source of truth. The renderer uses the deltas only for a transient live preview (`src/live-message.ts`), keyed by `(message.id, index)` since `index` resets per message, and drops each live block the frame its `assistant` event lands. See `docs/stream-json-findings.md`.

## Content blocks

Within `assistant.message.content` and `user.message.content`:

- **TextBlock** `{type:"text", text}`
- **ToolUseBlock** `{type:"tool_use", id, name, input: Record<string, unknown>}`
- **ToolResultBlock** `{type:"tool_result", tool_use_id, content: string | TextBlock[], is_error?}`
- **ThinkingBlock** `{type:"thinking", thinking, signature?}`

## Input shape (renderer → claude stdin)

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

Typed as `UserTurn`. One JSON object per line, `\n` terminated.

## Slice contracts

- **Slice A** implements `subscribeToClaude(args): AsyncIterable<ClaudeEvent>` + `sendUserTurn(text: string): void`. Returns typed events; no consumer parses raw JSON.
- **Slice B** imports `ClaudeEvent`, content-block types, and filter types; dispatches on type discriminators to slice C's components.
- **Slice C** receives a typed block + display options; returns JSX. Each element-renderer accepts a `visibility: Visibility` prop.

## Stability

This contract is frozen for v0. If a slice needs an addition (e.g. a new block type observed in the wild), the change lands as a `feat:` PR to the types file plus this doc, *not* an ad-hoc cast on the consumer side.
