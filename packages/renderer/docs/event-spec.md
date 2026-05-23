# Event types — contract for slices A and B

The TypeScript event types live at [`src/types/events.ts`](../src/types/events.ts). That file is the source of truth; this doc is the high-level overview.

## Discriminated union: `ClaudeEvent`

Top-level: `{ type: "system" | "assistant" | "user" | "result" | "rate_limit_event", ... }`. All events share `session_id` and (where present) `uuid`.

## Variants

- **SystemEvent** — `subtype: "init"` is the only observed subtype. Carries session metadata, `slash_commands` array, model, tools, cwd, memory_paths. Repeats per turn.
- **AssistantEvent** — wraps a `message` object containing `content[]` blocks (text, tool_use, thinking). `model: "<synthetic>"` indicates a slash-command response.
- **UserEvent** — typically wraps `tool_result` blocks claude replays. The renderer also **writes** this shape to claude's stdin as a user turn (see `UserTurn` in the types file).
- **ResultEvent** — per-turn terminator. `subtype: "success" | "error"`. `is_error: false` even for "Unknown command" failures — detect via string-match on `result`.
- **RateLimitEvent** — intermittent rate-limit info.

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
