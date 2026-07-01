# Claude Code remote control

A behavior-level reference for how Claude Code's Remote Control feature works — how a local `claude` session registers with the Anthropic API and accepts input from claude.ai or the mobile app. Includes two empirically verified findings about print/stream-json mode that are directly relevant to fnc's renderer mode. Minified symbol names and byte offsets are intentionally omitted; all findings are anchored on durable string literals from `claude --help`, `claude remote-control --help`, and live session output.

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
| Renderer (`FNC_RENDERER=1`) | Does not work | `claude --print` stream-json is excluded by claude's own gate (Findings 1 and 2 above). |

---

## See also

- `claude --help` — `--remote-control [name]` flag documented there.
- `claude remote-control --help` — headless server subcommand flags.
- Official Claude Code docs "Connection and security" section for the outbound-only transport and Trusted Devices details.
- [`claude-code-render-modes.md`](claude-code-render-modes.md) — the `--print` mode context.
