# Claude Code control protocol (`control_request` / `control_response`)

A reference for the bidirectional NDJSON control channel that `claude --print
--input-format stream-json --output-format stream-json` speaks over
stdin/stdout — its frame shape, the full subtype vocabulary, which subtypes
the CLI actually handles, and what each one does. Written against **v2.1.200**
of the Bun-compiled ELF at
`~/.local/share/mise/installs/node/<ver>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
(251 MB, not-stripped), cross-checked against fnclaude's own working
stream-json client at `packages/renderer/src/claude-process.ts`.

> Minified symbol names and byte offsets are **version-specific and will not
> match other builds** — see [`claude-code-binary-internals.md`](claude-code-binary-internals.md)
> for the `grep -aboF` + `dd`-window technique used to pull them. Anchor
> re-verification on the string literals (subtype names, the "REPL bridge does
> not handle control_request subtype" log line), not the offsets.

> Cross-references (do not duplicate): [`claude-code-render-modes.md`](claude-code-render-modes.md)
> for the render-mode context this channel lives in (`--print` forces plain
> streaming, non-TTY stdout); [`claude-remote-control.md`](claude-remote-control.md)
> for the cloud-relay path that tunnels this same protocol over HTTPS instead
> of local stdio; [`claude-code-rewind.md`](claude-code-rewind.md) for the
> `rewind_files`/`rewind_conversation` subtypes' own behavior (this doc only
> places them in the vocabulary table below).

---

## Frame shape

A request:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
```

The reply:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>"}}
```

This is not a proposal — it's what fnclaude's renderer already writes and
parses today. `subscribeToClaude()`'s `interrupt()` method
(`packages/renderer/src/claude-process.ts:98-108`) constructs exactly this
frame to abort an in-flight turn without ending the session, and
`packages/renderer/src/claude-process.test.ts:140-158` asserts the shape:
`type: "control_request"`, a non-empty `request_id`, `request.subtype ===
"interrupt"`.

---

## CLI-side receiver

Extracted from the installed binary (v2.1.200): the receiver switch spans
byte offsets @244332956–@244337800 and logs under the `[bridge:repl]` prefix
(the same prefix used by the Remote Control tunnel — see below). Handled
subtypes, as callee and effect:

| Subtype | Offset | Effect |
|---|---|---|
| `initialize` | @244332700 | Handshake — returns commands/agents/models/pid |
| `set_model` | @244332956 | **Live model switch** (`l?.(e.request.model)`) |
| `set_max_thinking_tokens` | @244333376 | **The effort/thinking handle** (`c?.(e.request.max_thinking_tokens, e.request.thinking_display)`) |
| `set_permission_mode` | @244333376 | **Live permission-mode switch** (`u?.(y_(e.request.mode))`) |
| `rename_session` / `set_color` / `set_cwd` | — | Session title / UI color / cwd |
| `file_suggestions` / `read_file` / `get_context_usage` / `get_usage` / `get_settings` / `list_models` | — | Queries |
| `mcp_status` / `mcp_authenticate` / `mcp_oauth_callback_url` / `mcp_reconnect` / `mcp_toggle` / `mcp_set_servers` | — | MCP management |
| `apply_flag_settings` | sender @244445xxx | **Arbitrary settings object** — `{subtype:"apply_flag_settings",settings:e}`; related UI strings at @140133248 (`userSettings`, `focus`, `off`, "(this session only)") |
| `interrupt` | @244337800 | Aborts the in-flight turn |

Default case (unrecognized subtype) logs:

```
REPL bridge does not handle control_request subtype: <x>
```

There is **no `set_effort`/`set_thinking` subtype** — effort maps onto
`set_max_thinking_tokens`.

## Full subtype vocabulary

The Zod-literal enum (@248540500+) lists every subtype the schema accepts,
not just the ones the local REPL bridge switch handles above:

```
interrupt, set_model, set_max_thinking_tokens, set_permission_mode,
set_mcp_permission_mode_override, set_cwd, set_color, rename_session,
list_models, get_settings, get_context_usage, get_usage, get_session_cost,
get_plan, get_workspace_diff, get_binary_version, can_use_tool,
hook_callback, mcp_message, mcp_toggle, mcp_set_servers, mcp_reconnect,
reload_plugins, reload_skills, register_repo_root, rewind_files,
cancel_async_message, seed_read_state, initialize
```

`rewind_files` is the file-checkpoint restore subtype — see
[`claude-code-rewind.md`](claude-code-rewind.md#the-programmatic-surface-agent-sdk)
for its payload (`{subtype:"rewind_files", user_message_id, dry_run?}`) and
its sibling `rewind_conversation`, which appears in the SDK's type union but
isn't in this enum dump — treat it as unconfirmed the same way that doc does.

## SDK sender methods

The Agent SDK's public sender methods (@244444459–@244445545) confirm the
wire shape for each request:

| Method | Frame |
|---|---|
| `interrupt()` | `{subtype:"interrupt"}` |
| `setModel(e)` | `{subtype:"set_model", model:e}` |
| `setMaxThinkingTokens(e,t)` | `{subtype:"set_max_thinking_tokens", max_thinking_tokens:e, thinking_display:t}` |
| `setPermissionMode(e)` | `{subtype:"set_permission_mode", mode:e}` |
| `applyFlagSettings(e)` | `{subtype:"apply_flag_settings", settings:e}` |
| `getSettings()` | `{subtype:"get_settings"}` |

---

## How fnclaude talks to the child — two mutually-exclusive modes

`packages/cli/src/main.ts` picks one of two launch shapes; only one of them
has this channel.

### 1. Default PTY passthrough — no control channel

`Bun.spawn([claudeBin, ...claudeArgs], { terminal })` (`main.ts:750`). stdin
is a raw-mode PTY carrying keystrokes (`process.stdin.setRawMode(true)` /
`.on('data', …)` at `main.ts:799-802`); the only input handle is
`term.write(payload)`, bound as `slashWriter` (`main.ts:760-762`). **There is
no stream-json/control channel in this mode** — claude's stdin is the literal
terminal. This is why `fnc_set_model` and `fnc_set_effort` inject `/model`
and `/effort` keystrokes via `injectSubmittedLine`
(`packages/cli/src/mcp/handlers/slash-tools.ts:211,239`) instead of writing a
control frame.

### 2. Renderer mode — a live duplex control channel

Gated by `FNC_RENDERER` (`main.ts:640-668`), fnclaude spawns `claude --print
--verbose --input-format stream-json --output-format stream-json
--include-partial-messages` (`packages/renderer/src/claude-process.ts:55-67`)
— a live duplex NDJSON channel. fnclaude **already writes a `control_request`
/`interrupt` frame over it** (`claude-process.ts:98-108`). The control
channel exists and is exercised today, just only in this mode.

The comment at `main.ts:646-651` ("`/effort`,`/model` are TUI-only and can't
be forwarded") is about a different, already-abandoned approach: sending
`/effort`/`/model` as slash-command **text turns** over stream-json, which
claude does not execute as commands in that mode. It is not a statement about
the control-protocol path below — fnclaude has not yet tried
`set_model`/`set_max_thinking_tokens` control frames.

---

## Remote Control tunnels the same protocol

[`claude-remote-control.md`](claude-remote-control.md) documents the
`[bridge:repl]` layer that tunnels this exact `control_request`/
`control_response` envelope over Anthropic's cloud relay so claude.ai/mobile
can drive a local session. Its observed tunneled subtype list — `initialize,
read_file, get_usage, get_context_usage, file_suggestions, local_command,
set_model, set_permission_mode, mcp_authenticate, mcp_oauth_callback_url,
mcp_reconnect, mcp_status` — is a **subset** of the local vocabulary above; it
notably doesn't list `set_max_thinking_tokens` or `apply_flag_settings` as
observed-tunneled. Unconfirmed whether that's an intentional narrower
allow-list on the bridge side or just an artifact of what that doc's
extraction pass happened to anchor on — flag it as an open question rather
than assume either way.

---

## Drop-in frames for fnclaude

In renderer/stream-json mode there is a clean non-keystroke handle for each
of these, and fnclaude already writes to the exact same channel (the
`interrupt` frame). These would be a few-line change alongside the existing
writer in `claude-process.ts:98-108`:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_model","model":"<model>"}}
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_max_thinking_tokens","max_thinking_tokens":<n>,"thinking_display":<...>}}
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"set_permission_mode","mode":"<mode>"}}
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"apply_flag_settings","settings":{...}}}
```

**Critical caveat:** this handle exists **only** in `--print --input-format
stream-json` (renderer) mode. In default PTY passthrough mode — which is
what `fnc_set_model`/`fnc_set_effort` currently target — claude's stdin is
the raw terminal; there is no stdin control channel there, so keystroke
injection remains the only purely-local mechanism until fnclaude either
adopts renderer as the primary launch mode or wires up Remote Control.

---

## Flagged uncertainties

- The `set_model`/`set_max_thinking_tokens`/`set_permission_mode` receiver
  switch is confirmed from the binary, and fnclaude's `interrupt` frame is
  known to work over the same channel — but a live `set_model` frame was
  **not** run end-to-end against a real renderer-mode session.
- `apply_flag_settings` accepts a `settings` object tied to the
  `--prompt-suggestions`/`promptSuggestions` config surface, but the exact
  accepted key names (e.g. whether `promptSuggestionEnabled` is a valid key)
  could **not** be recovered from the minified strings — plausible but
  unconfirmed.

---

## See also

- [`claude-code-binary-internals.md`](claude-code-binary-internals.md) — the `grep -aboF` + `dd`-window technique used to pull the offsets above.
- [`claude-code-render-modes.md`](claude-code-render-modes.md) — why `--print` stream-json forces plain-streaming render mode.
- [`claude-remote-control.md`](claude-remote-control.md) — the cloud-relay tunnel for this same protocol.
- [`claude-code-rewind.md`](claude-code-rewind.md) — `rewind_files`/`rewind_conversation` behavior in detail.
- `packages/renderer/src/claude-process.ts`, `packages/renderer/src/claude-process.test.ts` — fnclaude's own client for this channel.
