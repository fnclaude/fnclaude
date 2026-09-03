# Claude Code cloud-session protocol (CCR v2, `/v1/code/*`)

A wire-level reference for the protocol behind Claude Code **cloud sessions** —
the `cse_…` session objects created by `claude --cloud` / the "Cloud" mode of
the desktop app, backed by Anthropic's cloud runner. This is the branch
[`claude-remote-control.md`](claude-remote-control.md) explicitly parks and
tells you not to conflate with local Remote Control hosting:

> `/v1/environment_providers/cloud/create` and `/v1/code/*` (`agent-proxy`,
> `sessions`) are the **opposite direction** — this CLI dispatching a job to a
> cloud runner ("CCR" / `task_remote_agent`) — not hosting a bridge. Don't
> conflate them with RC hosting.

This doc opens that branch. See below for how the two relate.

> **Everything in this document is static analysis of extracted client
> bundles. Nothing was executed against the live API** — no cloud session was
> created, attached to, or messaged during this research. Treat every claim as
> "the code says this is what should happen," not "this was observed to
> happen." Gaps and unconfirmed points are called out inline and summarized in
> [Gaps / not yet verified](#gaps--not-yet-verified) at the end.
> **A live probe against a real cloud session must be run to confirm the
> inferred parts of this protocol before any fnc client code is built against
> it** — a hard prerequisite, not an optional cross-check. See
> [Required next step: run the live probe](#gaps--not-yet-verified).
>
> Minified symbol names and byte offsets are intentionally omitted. Every
> claim below is anchored on durable string literals — endpoint paths, header
> names, log prefixes (`[SessionsV2Client]`, `[bridge:repl] CCR v2:`), enum
> values, and error-message text.

---

## Why this matters for fnc

The goal this doc serves: **fnc chatting with a Claude Code cloud agent at
full parity with a local session** — interactive, multi-turn, streamed
straight into the renderer, not a second TUI shelled out and screen-scraped.

Cloud sessions run on Anthropic's infrastructure instead of the user's
machine. If fnc can speak the client half of this protocol directly, a cloud
session becomes just another conversation source feeding the same renderer
pipeline fnc already has for local `--print` stream-json sessions — same
message envelope, same `stream_event` partials, same control-request shape.
See [Liftability verdict for fnc](#liftability-verdict-for-fnc) below.

---

## Sources

- **Claude desktop app, build `1.34493.1`** (official Linux build:
  `https://claude.ai/api/desktop/linux/x64/deb/latest/redirect` →
  `downloads.claude.ai/releases/linux/x64/1.34493.1/…deb`). Electron bundle
  extracted from `app.asar`.

  **Structural finding: the desktop app is a session HOST/WORKER, not a
  cloud-chat client.** Its Electron main process embeds the Claude Agent SDK
  query loop and registers as a CCR *worker*; the chat UI itself is the
  claude.ai web app running in a `BrowserView`, driving *local* sessions over
  an IPC bridge. Durable anchors: `claude.web_$_LocalSessions_$_sendMessage`,
  `claude.web_$_LocalSessions_$_teleportToCloud`,
  `claude.web_$_LocalSessions_$_toggleRemoteControl`,
  `claude.web_$_LocalSessions_$_enableCliRemoteControl`, a
  `RemoteControlServing` namespace. The desktop bundle is high-fidelity for
  the **worker** half of the protocol (below), because that's the half the
  app actually implements locally.

- **Claude CLI `2.1.239`** — used only to recover the **client** half of the
  protocol; the desktop bundle omits it (the desktop app never plays the
  client role — the web BrowserView does, and its bundle wasn't obtained; see
  gaps). Client implementation log prefix: `[SessionsV2Client]`.

  **Note:** the CLI is not a usable cloud-chat client for fnc's purposes —
  `claude --cloud` drives its own interactive TUI, which would mean fnc
  screen-scraping a second terminal app instead of holding the conversation.
  It was used here purely as a protocol reference for the client-side wire
  format, not as something fnc should shell out to.

- Worker half (desktop) and client half (CLI) are mirror images over the same
  `cse_…` session object — reading both together yields a complete protocol
  picture even though neither source alone would.

- **claude.ai web bundle: not obtained** (Cloudflare timeout during
  extraction). It's the authoritative *third* implementation of the client
  half (the one actually used in production, since the desktop app's chat UI
  is the same web app in a `BrowserView`). Its absence is the largest gap in
  this document — see [Gaps](#gaps--not-yet-verified).

---

## Wire protocol — CCR v2

All plain HTTPS JSON, host `https://api.anthropic.com` (`BASE_API_URL`). **No
websocket anywhere** in this protocol — same "outbound HTTPS only, no control
websocket" shape as CCR v2 in the RC-hosting direction (see
[claude-remote-control.md's protocol-history section](claude-remote-control.md#protocol-history--versioning)
for that transport's own CCRv1→CCRv2 migration). The two CCR v2s share a
transport style and a backend name but are separate endpoint families for
separate directions — RC hosts a local session for a remote viewer; `/v1/code/*`
creates and drives a session that lives entirely on Anthropic's cloud runner.

### Session lifecycle

| Purpose | Method + path |
|---|---|
| Create code session | `POST /v1/code/sessions` |
| Get session | `GET /v1/code/sessions/{id}` |
| Rename session | `PUT /v1/code/sessions/{id}` |
| Archive session | `POST /v1/code/sessions/{id}/archive` |
| List sessions | `GET /v1/code/sessions` |
| Create cloud environment | `POST /v1/environment_providers/cloud/create` |

**Create session** body:

```json
{
  "title": "…",
  "bridge": {},
  "tags": ["…"],
  "session_grouping_id": "…",
  "config": {
    "cwd": "/home/user",
    "model": "…",
    "sources": ["…"],
    "outcomes": ["…"],
    "reuse_outcome_branches": true
  }
}
```

→ `{"session": {"id": "cse_…"}}`. The `cse_` id prefix is validated
client-side before the id is used elsewhere.

**Create cloud environment** — provider literal `anthropic_cloud`; image
anchor `ccr-byoc-2025-07-29`; default workdir `/home/user`; runtimes `python
3.11` / `node 20`. Gated by the literal string: `"Remote environments are
only available on the first-party Anthropic API provider."` — i.e. this whole
feature is unavailable through Bedrock/Vertex/Foundry-backed accounts, same
restriction pattern as Remote Control's OAuth-only gate.

**Rename** body: `{"title": "…"}`.

### Client half (this is what fnc would speak)

This is the surface fnc needs to implement to converse with a cloud session.

- **Receive (SSE)** — `GET /v1/code/sessions/{id}/events/stream`,
  `Accept: text/event-stream`. Resume support: pass `?from_sequence_num=N`
  **and** `Last-Event-ID: N` together.
- **Send** — `POST /v1/code/sessions/{id}/events`, body
  `{"session_id": "…", "events": [{"payload": {…}}]}` →
  `{"results": [{"sequence_num": N}]}`.
- **Presence** — `POST /v1/code/sessions/{id}/client/presence`, body
  `{"client_id": "…", "clear": false}` → `{"refresh_after_seconds": N}`.
- **Read receipt** — `POST /v1/code/sessions/{id}/mark_read`, body
  `{"event_id": "…"}` (optional field — presumably marks-all-read when
  omitted; not confirmed).

### SSE frame shape

SSE event name: `client_event`. The SSE `id:` line carries the sequence
number. Parsed JSON payload:

```json
{
  "event_type": "…",
  "sequence_num": 412,
  "source": "worker",
  "payload": {
    "type": "assistant",
    "message": { }
  }
}
```

`payload.type` is an ordinary Claude Agent SDK message discriminator —
`user`, `assistant`, `control_response`, `control_request`,
`control_cancel_request`, `system`, `result`, `stream_event`.

**This is the same envelope fnc's renderer already consumes from `claude
--print --output-format stream-json`.** The adapter from a cloud SSE stream
onto fnc's existing renderer ingest is nearly free — same discriminator, same
message shapes, same `stream_event` partial-token framing.

Trust rule: the client only trusts `source: "worker"` frames for tool results
and execution output, and rejects `control_response` frames claiming to
answer its own `request_id` if they arrive from a non-worker source. This is
the client's defense against another party on the session (e.g. a second
attached client) spoofing a control-request answer.

**Sending a user turn** is the same envelope in reverse:

```json
{
  "type": "user",
  "uuid": "…",
  "client_platform": "desktop_app",
  "message": {
    "role": "user",
    "content": [ ]
  }
}
```

`client_platform` is drawn from the enum `ios | android | web_claude_ai |
desktop_app`.

Control RPCs (`set_model`, `set_permission_mode`, `get_usage`, permission
responses) ride the same POST as:

```json
{
  "type": "control_request",
  "request_id": "…",
  "request": { },
  "uuid": "…"
}
```

> **Gap:** the exact JSON a client sends for a plain-text user turn was
> **inferred** from the envelope shape, the `client_platform` enum, and SDK
> message types — it was **not read verbatim** off the wire or out of a
> client bundle that constructs it directly. Treat the shape above as
> plausible-and-typed, not confirmed. A ~10-minute live probe (open a stream,
> send one message, capture the exact request body) would settle it.

### Worker half (from the desktop bundle — included for symmetry/completeness)

Not the surface fnc needs, but documented here because it's the mirror image
of the client half above and clarifies what "worker" means in the trust rule
and `source` field.

- `POST /v1/code/sessions/{id}/bridge` → `{worker_jwt, expires_in,
  api_base_url, worker_epoch}`
- `POST …/worker/register`
- `GET …/worker/events/stream` (SSE)
- `POST …/worker/events` — batched, `{worker_epoch, events: […]}`, capped at
  100 events / 10 MB per batch
- `POST …/worker/internal-events`
- `POST …/worker/events/delivery` — `{event_id, status}`
- `PUT …/worker`
- periodic heartbeats

Conflict signalling via response header `x-ccr-conflict-reason`, observed
values: `superseded_by_worker`, `epoch_stale`, `session_not_active`.

Log anchors: `[bridge:repl] CCR v2:`, `[sessions-api]`, `CCRClient:`.

### Auth

Request headers:

```
Authorization: Bearer <claude.ai OAuth access token>
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-client-platform: <platform>
x-organization-uuid: <org uuid>
User-Agent: <client ua>
X-Trusted-Device-Token: <td token>   # only when the org enforces Trusted Devices
```

- Cookie auth is an accepted alternative on the stream endpoint —
  `Authorization` is dropped when a `Cookie` header is present. This is the
  web client's path (claude.ai's own session cookie), not one fnc would use.
- `401` → refresh the token once and retry.
- `403` with `resource: "untrusted_device"` → enroll the device and retry.
- `session_stale_relogin` → terminal, no retry.
- **Required OAuth scope: `user:sessions:claude_code`.** The desktop app
  mints its own token for this purpose: OAuth client id
  `89355bc3-cbfd-4382-905b-976645cad410`, redirect
  `https://claude.ai/desktop/callback`, scopes `user:inference user:profile
  user:sessions:claude_code`.

---

## Liftability verdict for fnc

**MODERATE, closer to easy than expected.**

- **Auth is not a blocker on this setup.** `~/.claude/.credentials.json`
  (plaintext, mode `0600`) already holds an access + refresh token pair whose
  granted scopes include `user:sessions:claude_code` — full granted set on
  the inspected machine: `user:file_upload, user:inference,
  user:mcp_servers, user:profile, user:sessions:claude_code`. fnc runs as the
  same user on the same machine, so it can read that file directly and send
  `Authorization: Bearer <accessToken>`, refreshing via the existing
  claude.ai OAuth flow when `expiresAt` passes. No new OAuth client to
  register, no token minting, no keychain crypto to reverse — the desktop app
  locks its *own* token cache behind Electron `safeStorage`, but that's the
  desktop app's problem, not fnc's; fnc has its own plaintext credential file
  already. The Trusted-Devices header is org-enforced only — a personal Max
  account never sends it.

- **Live streaming?** Yes. SSE, one `client_event` frame per SDK message
  including `stream_event` partials — token-by-token rendering works the
  same way it does for a local `--print` stream-json session.

- **Persistent multi-turn against one session id?** Yes. One long-lived SSE
  connection plus repeated `POST …/events` — no per-turn handshake. Dropped
  connections resume via `from_sequence_num` + `Last-Event-ID`, with the
  server deduping on sequence number. This is a designed-for reconnection
  path, not something fnc would be hacking around.

- **What fnc must build:**
  1. An SSE reader with sequence-number tracking, reconnect/backoff, and
     liveness/clock-drift detection (the reference client reconnects after a
     machine suspend — the same class of problem fnc already handles for
     local sessions).
  2. A JSON POST sender with 401-refresh-then-retry.
  3. A presence heartbeat honoring the server's `refresh_after_seconds`.
  4. Session create/list/attach against `/v1/code/sessions*`.
  5. A small adapter mapping `client_event.payload` onto fnc's existing
     stream-json ingest — this is the "nearly free" part, since the
     discriminated-union shape is the same one fnc already parses.

- **Don't drive `claude --cloud`.** Beyond being a confirmed non-starter (the
  CLI's cloud mode is an interactive TUI, not scriptable), it's structurally
  wrong for the goal: fnc's renderer would end up parsing *another* TUI's
  output instead of holding the conversation directly. Speaking the protocol
  gives fnc the session object, sequence numbers, control RPCs, and interrupt
  — full local-session parity, not a shelled-out mirror.

- **Hard parts, stated honestly:**
  1. **Version drift is the real risk.** `/v1/code/sessions/*` is
     undocumented and unversioned beyond the blanket `anthropic-version:
     2023-06-01` header. `claude-remote-control.md`'s own history section
     records one full transport migration (CCRv1 websocket → CCRv2 SSE+POST)
     inside the 2.1.x line over roughly two months, in the *other* CCR
     direction — there's no reason to expect `/v1/code/*` is more stable.
     Pin a known-good claude/desktop build and re-verify the endpoint map on
     each meaningful version bump, using the string anchors in this doc
     (`[SessionsV2Client]`, `cse_`, `x-ccr-conflict-reason`, `CCR v2`) as the
     re-verification handles.
  2. **Event reassembly and trust rules** — turning a stream of
     `stream_event` partials into a coherent message, and enforcing the
     `source: "worker"` trust rule for tool output — is the fiddliest part
     of the implementation, though fnc's renderer already does the
     partial-reassembly half of this for local stream-json sessions.
  3. **Nothing here is signed or obfuscated.** Re-implementation is ordinary
     client engineering against a private-but-plain HTTP API, not a fight
     against anti-tampering.

---

## Relation to `claude-remote-control.md`

Both docs describe a "CCR v2" backend, and it's the same name for a reason —
but the two are opposite directions over disjoint endpoint families, and
conflating them will produce a broken mental model:

| | Remote Control (`claude-remote-control.md`) | Cloud sessions (this doc) |
|---|---|---|
| Direction | Local `claude` process is the **worker**, hosting a session for a remote viewer (claude.ai / mobile) | This CLI/app is the **client**, driving a session that runs entirely on Anthropic's cloud runner |
| Where the agent loop runs | On the user's machine | On Anthropic's infrastructure |
| Endpoint family | `/v1/environments/bridge*`, `/v1/environments/{id}/work/*`, `/v1/sessions/{id}/events*` | `/v1/code/sessions*`, `/v1/environment_providers/cloud/create` |
| Session id prefix | `env_…` | `cse_…` |
| fnc's use case | Let a remote client attach to a **local** fnc-hosted session | Let fnc **be** the client for a session that already lives in the cloud |

Practical consequence: if you're implementing either side, first confirm
which endpoint family and session-id prefix you're reading logs for — `env_`
+ `/v1/environments/*` is RC hosting, `cse_` + `/v1/code/*` is this doc.

---

## Gaps / not yet verified

> **Required next step — run the live probe.** Before any fnc client code is
> written against this protocol, a live probe against a real cloud session
> **must** be run to close the unconfirmed points below — this is a
> prerequisite for implementation, not an optional cross-check. Minimum probe:
> authenticate with a `user:sessions:claude_code`-scoped token, `POST
> /v1/code/sessions` to create a `cse_…` session, open the SSE stream at
> `…/events/stream`, `POST` one user turn to `…/events`, and capture the exact
> request/response bodies. That single pass confirms both the inferred
> user-turn payload and the attach-to-existing-session behavior. Until it has
> run, treat everything in this document as unverified.

- **Nothing in this document was executed against the live API.** No cloud
  session was created, attached to, or messaged. Every claim is static
  analysis of extracted client bundles (desktop Electron `app.asar` for the
  worker half, CLI `2.1.239` for the client half).
- **Plain-text user-turn payload is inferred, not read verbatim** — see the
  callout in [Client half](#client-half-this-is-what-fnc-would-speak) above.
  ~10 minutes against a live session would confirm the exact body.
- **Attaching to an existing cloud session is unconfirmed.** It's unclear
  whether a client may simply open the SSE stream on any owned `cse_…` id, or
  whether an attach/claim call is required first. The presence endpoint's
  existence hints at the former (nothing about it looks like a
  claim/handshake step), but this wasn't confirmed against a real session.
- **The claude.ai web bundle was not obtained** (Cloudflare timeout during
  extraction). It's the authoritative third implementation of the client
  half — the desktop app's own chat UI is that same web bundle running in a
  `BrowserView`, so the CLI's `[SessionsV2Client]` is currently the *only*
  client-half source this doc has actually read. Obtaining the web bundle
  would settle both gaps above and provide independent cross-verification of
  everything in [Client half](#client-half-this-is-what-fnc-would-speak).

## Redo-for-a-new-version checklist

1. Re-pull the current desktop `.deb` from
   `https://claude.ai/api/desktop/linux/x64/deb/latest/redirect`, extract
   `app.asar`, and re-grep for the IPC bridge anchors
   (`claude.web_$_LocalSessions_$_*`, `RemoteControlServing`) to confirm the
   host/worker split still holds.
2. Re-grep the CLI for `[SessionsV2Client]` and diff the endpoint list
   against the table in [Session lifecycle](#session-lifecycle) and
   [Client half](#client-half-this-is-what-fnc-would-speak).
3. Re-check `x-ccr-conflict-reason` values and the SSE frame shape
   (`client_event`, `sequence_num`, `source`) for drift.
4. Attempt the claude.ai web bundle extraction again — if it succeeds, use it
   to close the two gaps above and cross-verify the inferred user-turn
   payload.
5. If a live account with `user:sessions:claude_code` scope is available, run
   the minimal live probe: create a `cse_…` session, open the SSE stream,
   send one message, capture the exact request/response bodies.
