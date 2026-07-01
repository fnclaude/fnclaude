# Claude Code remote control

A behavior-level reference for how Claude Code's Remote Control feature works — how a local `claude` session registers with the Anthropic API and accepts input from claude.ai or the mobile app. Includes empirically verified findings about the server subcommand and the print/stream-json gate, both directly relevant to fnc's renderer mode. Minified symbol names and byte offsets are intentionally omitted; all findings are anchored on durable string literals from `claude --help`, `claude remote-control --help`, and live session output.

> See [`claude-code-render-modes.md`](claude-code-render-modes.md) for the `--print` stream-json mode that renderer-mode fnc uses, and [`claude-code-agent-ui-internals.md`](claude-code-agent-ui-internals.md) for how the interactive TUI session is structured.

---

## What Remote Control is

Remote Control connects a local `claude` session to the claude.ai web interface or the Claude mobile app. The remote UI shows the **synced conversation state** — not an ANSI frame mirror — so the web/mobile client can both read the transcript and inject new turns into the running agent loop.

From the user's perspective: the local session appears in the claude.ai/code session list with a computer icon and green dot; clicking it opens a full conversation view. Input submitted from the web/mobile client lands in the local claude process's agent loop exactly as if the user had typed it locally.

---

## Transport and auth

The transport is **outbound HTTPS only**, to `api.anthropic.com` on port 443. The local claude process never opens an inbound port. On activation it registers a session with the Anthropic API and enters a streaming poll loop; the API server routes messages between the remote client and the local session.

Auth requirements:
- Requires a full-scope **claude.ai OAuth session** (`claude /login` → claude.ai).
- API keys, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry configs, and any `ANTHROPIC_BASE_URL` that is not `api.anthropic.com` all **disable Remote Control**.
- Optionally enforced by org-level **Trusted Devices** (device enrollment + biometric step-up).

---

## Entry surfaces

There are two distinct entry surfaces, serving different use cases.

### Interactive flag — `--remote-control` / `-R` / `/remote-control`

Enables remote control for an interactive `claude` session:

- **Flag:** `claude --remote-control [name]` (alias: `-R`, `--rc`). Help text: `"Start an interactive session with Remote Control enabled"`. The optional `[name]` sets a display label in the session list.
- **In-session slash command:** `/remote-control [name]` enables it inside a running interactive session. This is a **client-side handler** — it is not routed to the model as text.

On activation, claude registers the session, begins the outbound poll loop, and (in TTY mode) displays a session URL and QR code in the status area.

### Headless server subcommand — `claude remote-control`

A standalone subcommand for managing many remote sessions without a terminal:

```
claude remote-control --spawn same-dir|worktree|session --capacity N
```

Help text: `"Control local sessions from claude.ai/code or the Claude mobile app"`.

Key differences from the interactive flag:
- **No TTY required.** Runs headlessly — suitable for background processes, CI, or system services.
- **Multiplexed.** A single server process can accept multiple incoming sessions (`--capacity N`).
- **`--spawn` controls what each connection gets:** `same-dir` reuses the server's working directory; `worktree` creates an isolated worktree per connection; `session` resumes an existing session.

Same transport and auth requirements apply.

#### Server subcommand — verified working headless

Empirically verified against a live session with `claude remote-control --verbose` (no TTY):

```
Environment ID: env_01Ep4GUC6awEHXEa9vf1v984
·✔︎· Connected · fnclaude · main
https://claude.ai/code/session_...
Continue coding in the Claude mobile app.
```

The session URL was reachable from a phone; "fnclaude · main" appeared in the environment list on claude.ai. No local socket or port was opened (`ss`, `/tmp`, `$XDG_RUNTIME_DIR` all empty) — sync is entirely cloud-routed (outbound HTTPS), using the same `env_…` identity model as the Claude Code Remote MCP tools.

This confirms the server subcommand is a viable headless bridge for renderer-mode integration work. The `--print` gate (below) only blocks the interactive "attach current session" path — it does not affect the server subcommand.

---

## The print/stream-json gate — remote control is categorically excluded

`claude --print --input-format stream-json --output-format stream-json` (the mode fnc's renderer uses) is **categorically excluded** from Remote Control. Two empirical findings confirm this.

### Finding 1 — `--remote-control` flag no-ops in print mode

Running `claude --print --input-format stream-json --output-format stream-json --remote-control <name>` and leaving it alive for ~5 minutes produced:

- **Zero registration output.** No session URL, no QR code, no confirmation that Remote Control activated.
- **No session entry.** The session did not appear in the claude.ai/code session list during the observation window.

The flag is accepted by the process without error, but the registration and poll loop that activate Remote Control do not start.

### Finding 2 — `/remote-control` slash command returns "isn't available in this environment"

Injecting a stream-json user turn containing `/remote-control` into a running `claude --print --input-format stream-json --output-format stream-json` process (no `--remote-control` flag) produced this response verbatim:

```
/remote-control isn't available in this environment.
```

The `/remote-control` text was recognized as a **slash command** (claude's client-side handler), not routed to the model as literal text. The response confirms claude itself gates the command against the active session type.

Additionally: the `slash_commands` array in the session `init` event under print mode **does not include `remote-control`**. The command is absent from the list, consistent with the runtime rejection.

### Why this matters for fnc

PTY-mode fnc (`fnc -R` or `/remote-control` typed inside a normal session) works today — the `--remote-control` flag passes through to the real claude process, which runs its full interactive TUI in a real pty and handles registration natively.

Renderer-mode fnc (`FNC_RENDERER=1`) drives a `claude --print` stream-json child. That child is categorically excluded by claude itself: the flag no-ops (Finding 1) and the slash command is explicitly rejected (Finding 2). This is not a missing feature in fnc — it is a hard gate in the claude process.

---

## Implications for fnc mode coverage

| Mode | Remote Control support | Notes |
|---|---|---|
| PTY (default) | Works, ~native | `--remote-control`/`-R` passes through; claude owns the pty and runs the outbound bridge. Registration, QR code, and session sync all work. |
| Inherit (non-TTY / Windows) | Works | claude owns the inherited tty; flag passes through. |
| Renderer (`FNC_RENDERER=1`) — interactive attach | Does not work | `claude --print` stream-json is excluded by claude's own gate (Findings 1 and 2 above). |
| Renderer — via server subcommand | Viable integration path | `claude remote-control` runs headless with no TTY, connects successfully, and spawns sessions on demand. See "Server subcommand — verified working headless" above. The integration work is in making those server-spawned sessions render inside fnc's Ink UI rather than in a separate claude TUI. |

---

## Wire protocol (reverse-engineered)

> Reverse-engineered from claude 2.1.197; endpoint paths and string anchors are durable, minified identifiers are not — grep the strings.

This section is spec-level detail for a future fnc renderer-mode integration with the server subcommand (see "Implications for fnc mode coverage" above). It's broad strokes plus pointers into the source, not an exhaustive dump.

### Big picture

Remote Control is **outbound-HTTPS-only** to `api.anthropic.com` — no inbound port, no control-channel websocket (the only websocket in the binary is the unrelated `/api/ws/speech_to_text/voice_stream`). The local `claude` process is a **bridge / worker host**: it registers an environment, long-polls an HTTP endpoint for inbound work (remote user turns and tunneled control requests), and posts the agent's output back on a separate events endpoint, persisting the transcript through a session-ingress endpoint.

Three log-prefix namespaces split the concerns:

| Prefix | Concern |
|---|---|
| `[bridge:api]` / `[bridge:poll]` / `[bridge:session]` / `[bridge:shutdown]` / `[bridge:worktree]` | Transport + lifecycle |
| `[bridge:repl]` | Tunnels the SDK **control protocol** (the same `control_request`/`control_response` shape used by `--print` stream-json) over the bridge |
| `[session-ingress]` / `[teleport]` | Transcript persistence + remote-viewer mirror |

Logs also reference `CCR v2` (`[bridge:session] CCR v2: registered worker`) — the cloud-runner backend the bridge registers against.

### Endpoint map

| Purpose | Method + path |
|---|---|
| Register environment/host | `POST /v1/environments/bridge` |
| Reconnect session | `POST /v1/environments/bridge/reconnect` |
| Deregister | `DELETE /v1/environments/bridge/{environmentId}` |
| Poll for work (inbound) | `GET /v1/environments/{id}/work/poll?reclaim_older_than_ms=` |
| Ack work | `POST /v1/environments/{id}/work/{workId}/ack` |
| Stop work | `POST /v1/environments/{id}/work/{workId}/stop` (`force=`) |
| Heartbeat | `POST /v1/environments/{id}/heartbeat` |
| Outbound events | `POST /v1/sessions/{id}/events` (+ `/events/stream`) |
| Thread events | `POST /v1/sessions/{id}/threads/{tid}/events` (+ `/stream`) |
| Transcript persist/fetch | `/v1/session_ingress/session/…` |
| Teleport (remote mirror) | `/teleport-events` |
| Archive session | `POST /v1/sessions/{sessionId}/archive` |

`/v1/environment_providers/cloud/create` and `/v1/code/*` (`agent-proxy`, `sessions`) are the **opposite direction** — this CLI dispatching a job to a cloud runner ("CCR" / `task_remote_agent`) — not hosting a bridge. Don't conflate them with RC hosting.

### Auth

- `Authorization: Bearer <token>` — the standard **claude.ai OAuth access token**, not an API key. Same credential minted by `/login`; scope `environments:manage`.
- `anthropic-version: 2023-06-01`, `Content-Type: application/json`, `x-environment-runner-version: <ver>`.
- **401 refresh loop:** on a 401 the bridge retries once after a token refresh (`[bridge:api]` logs `401 received, attempting token refresh` → `Token refreshed, retrying request`, or `Retry after refresh also got 401` / `Token refresh failed`). Success emits a `token_update` / `auth_401_result` event.
- **`X-Trusted-Device-Token`** is conditionally present — only under orgs that enforce Trusted Devices. Error surfaced when required and missing: `This session requires a trusted device. Run /login to enroll this device, then retry.` This is the one potentially-opaque piece (enrollment shows attestation-flavored literals: `device_token`, `enroll`, `attest`, `signature`, `nonce`).

### Message envelope

**Inbound work items** (from `work/poll`) discriminate on `type`, carrying `workId` + `sessionId`:
- **Remote user turn** — `text` or `image` + `base64`, plus `user`, `uuid`, `client_platform` (enum: `android`, `ios`, `web_claude_ai`, `desktop_app`, `claude_in_slack`), `inbound_origin`. This is the routed remote prompt that enters the agent loop.
- **Tunneled control request** — `control_request { subtype, request_id, … }`, answered `control_response { request_id, response }` (the `[bridge:repl]` layer). Handled subtypes: `initialize`, `read_file`, `get_usage`, `get_context_usage`, `file_suggestions`, `local_command`, `set_model`, `set_permission_mode`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_reconnect`, `mcp_status`, plus permission-response handling. `initialize` builds the capabilities payload (commands / agents / models / account, `thinking_display`, `permission_mode`).

**Outbound SDK events** (to `sessions/{id}/events`) carry the agent's SDK message `type`s: `assistant`, `result` (+ `resultSubtype`), `system`, `user`, `stream_event` (+ `stream_request_start`), `tool_result`, `rate_limit_event`, `error`.

### Lifecycle & server flags

`claude remote-control` (multi-session host):
- `--spawn same-dir|worktree|session` — spawn strategy per remote session; `worktree` manages an ephemeral worktree per session.
- `--capacity N` — max concurrent sessions, ties to `max_sessions`/`maxSessions` on register.
- `--name`, `--remote-control-session-name-prefix` — session display naming.
- `--create-session-in-dir` / `--no-create-session-in-dir`, `--permission-mode`.

`claude --remote-control [name]` (interactive) is **`single-session`** mode (contrast the server's `external_poll_sessions`).

**Shutdown** (`[bridge:shutdown]`): `Shutting down N active session(s)` → `Sending SIGTERM to sessionId=` (or `Force-killing stuck sessionId=`) → either `Environment deregistered, bridge offline` or, if preserving, `Environment preserved. Restart 'claude remote-control' to reconnect existing sessions.` Session-level: `Remote Control session expired.` / `Remote Control disconnected.` / `Re-run 'claude remote-control' to try again`.

### Prior art + cross-verification

Three third-party sources reverse-engineered earlier CLI versions before this first-party pass against 2.1.197:

- [Origin Technology — "All Your Claude Are Belong To Us: Reversing Claude Code's Remote Control Protocol"](https://www.originhq.com/research/reversing-remote-control) — binary RE of the local `--sdk-url` control-protocol layer (the `control_request`/`control_response` envelope, `can_use_tool` flow).
- [ly0/cc-remote-control-server](https://github.com/ly0/cc-remote-control-server) — working self-hosted reimplementation of the bridge/relay layer, with version-drift binary-patching notes.
- [frr.dev — "Anatomy of Claude Code's Remote Control: The Hidden API You Can't Use Yet"](https://www.frr.dev/posts/claude-code-remote-control-hidden-api/) — trace-based writeup of the same bridge/relay layer.

Cross-checked against the first-party 2.1.197 findings above:
- **Corroborated:** the `/v1/environments/bridge` registration endpoint and the `work/poll` → `ack`/`stop` shape match across all three sources and the 2.1.197 binary.
- **Corrected:** frr.dev and ly0 both describe the bridge/relay transport as websocket-primary (`wss://.../session_ingress/ws/{session_id}` or `/v2/session_ingress/ws/:sessionId`). The 2.1.197 binary shows **long-poll + optional SSE** (`/events/stream`) — no control-channel websocket. Prior art is either describing an older CLI version or a proposed/experimental path that didn't ship.
- **Resolved:** frr.dev and ly0 disagree on `/v1/` vs `/v2/` for the session-ingress path. The 2.1.197 binary anchors resolve this to **`/v1/`**.

Treat the web sources as multi-version, cross-checked prior art — useful for corroboration and for understanding how the protocol evolved, not as the current wire format on their own.

### Re-implementability

The transport and envelope are fully re-implementable by a third party (e.g. fnc): plain HTTPS JSON on stable `/v1/…` paths, a small fully-enumerated header set, and `type`/`subtype` discriminators — nothing in the request framing is signed or obfuscated. The only gate is auth material: the Bearer token is a reusable, non-per-request-signed OAuth access token fnc can already mint via the existing `/login` flow, and `X-Trusted-Device-Token` only becomes a blocker under orgs that enforce Trusted Devices.

---

## See also

- `claude --help` — `--remote-control [name]` flag documented there.
- `claude remote-control --help` — headless server subcommand flags.
- Official Claude Code docs "Connection and security" section for the outbound-only transport and Trusted Devices details.
- [`claude-code-render-modes.md`](claude-code-render-modes.md) — the `--print` mode context.
