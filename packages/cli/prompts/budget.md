# Budget visibility — the `get_usage` tool

The `get_usage` tool reports the current session's budget headroom from data fnclaude already holds — no extra API calls. It returns:

- **`session.cost_usd`** and **`session.by_model`** — accumulated cost (USD) and per-model token breakdown (`input`, `output`, `cache_read`, `cache_write`, `cost`) for this session.
- **`context.used`** — the latest assistant turn's context-window size, in tokens. Compare it against your working context budget when deciding whether to read more, spawn more, or compact.
- **`limits`** — the subscription quotas (5-hour, weekly all-models, weekly Sonnet-only). **Currently always `null`.** fnclaude can't yet observe the `anthropic-ratelimit-unified-*` headers that carry these (they travel over claude's API connection, not the terminal fnclaude wraps). Read `null` as **"not yet observed"** — never as "no limit" or "zero".

## When to call it

Call `get_usage` at **high-token decision points** where the answer would change what you do:

- before a parallel subagent fan-out,
- before large file reads or deep exploration,
- when weighing model tier (opus vs. sonnet vs. haiku) for delegated work.

Use the result to inform model-selection and parallelism trade-offs **per the user's preferences** — this tool surfaces the numbers; the user's prefs encode the policy. Don't draw hard conclusions the prefs don't license.

**Don't poll.** Only check at decision points; a query whose answer wouldn't change your next action is wasted.

## How to call it

`get_usage` needs a `session_id` argument. Claude Code doesn't expose the session id to MCP tool input directly, so read it from your shell env first:

```sh
echo "$CLAUDE_CODE_SESSION_ID"
```

Pass that value verbatim as `session_id` (a standard UUID, 8-4-4-4-12 hex).
