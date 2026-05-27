# fnclaude — MCP mechanics

OS-level description of how the parent `fnclaude` process, the launched `claude` process, and the in-process MCP subprocess wire themselves together at runtime. Language-agnostic — it talks about file descriptors, sockets, env vars, signals, and paths, not about how any particular runtime expresses them.

For the user-facing semantics of the four MCP-backed features, see [`prd.in-session.md`](prd.in-session.md). For locked-in implementation facts adjacent to MCP (env-var injection, handoff path formulas, the deny-list applied to transfer arg preservation, etc.), see the relevant numbered sections in [`design.md`](design.md) — this doc cross-references rather than duplicates.

---

## 1. Participants and roles

Three processes participate in MCP communication during a fnclaude-launched claude session:

| Process | Role |
|---|---|
| **Parent** (`fnclaude` / `fnc`) | Owns the AF_UNIX listening socket. Dispatches incoming requests. Stashes a relaunch argv on handoff. Re-executes itself after killing claude. |
| **`claude`** | The interactive child. Spawned by the parent under a controlling terminal. Discovers the fnclaude MCP server via an injected `--mcp-config` argument. Does not itself dial the socket; it spawns the MCP subprocess and routes its tool calls over stdio. |
| **MCP subprocess** (`fnclaude mcp` or `fnclaude mcp --noop`) | Spawned by `claude` per the `--mcp-config` it received. Implements the JSON-RPC 2.0 MCP server contract over stdio. On every tool invocation, dials the parent's AF_UNIX socket and relays the request, then proxies the response back to claude. Reads `$FNC_SOCKET` for the path. |

The MCP subprocess is a separate OS process, but it is fully ephemeral — it exists only as long as `claude` is running, is owned by `claude` (parent in the OS sense), and inherits its env from `claude` (which in turn inherited from the fnclaude parent). The subprocess never receives signals from fnclaude directly; everything fnclaude wants to communicate to it travels via the socket.

---

## 2. Lifecycle

### 2.1. Parent startup, before claude is spawned

1. **Resolve the handoff base directory.** `$XDG_RUNTIME_DIR` wins if set (Linux/systemd tmpfs, mode 700, cleared on logout); otherwise the OS temp dir (`$TMPDIR` → `/tmp` on Unix; `%TMP%` / `%TEMP%` / `%USERPROFILE%` on Windows). Details: [`design.md` §14](design.md).
2. **Compute the socket path:** `<base>/fnclaude-mcp-<pid>.sock`. PID isolates concurrent fnclaude sessions; the formula stays well under the 108-byte AF_UNIX `sun_path` limit.
3. **Remove any stale socket file** at that path (best-effort `unlink` — covers the case where a prior crashed run left one behind).
4. **Open the listening socket** with `socket(AF_UNIX, SOCK_STREAM)` + `bind` + `listen`. The file is created with the process's `umask`-respecting default permissions; effective access is per-user on a typical `umask` of `022`.
5. **Construct the `--mcp-config` argument.** Inline JSON containing one server entry:
   ```json
   {"mcpServers":{"fnclaude":{"command":"<resolved absolute path to the fnclaude binary>","args":["mcp"]}}}
   ```
   When the session is the noop fallback, `args` is `["mcp","--noop"]`. Path resolution: `os.Executable()` then `EvalSymlinks` on the result. Full shape: [`design.md` §29](design.md).
6. **Compose the env block** for the claude child:
   - Inherit from `os.Environ()`.
   - Append `[exec.env]` keys from `~/.config/fnclaude/config.toml`.
   - Append the two handoff env vars (these win against any same-name inherited keys):
     - `FNC_SOCKET=<absolute path to the socket>`
     - `FNCLAUDE_HANDOFF=<resolved auto.handoff value>` — one of `"never"`, `"ask"`, or a non-negative integer string (`"0"`, `"3"`, `"5"`, …)
   - Details: [`design.md` §5](design.md).
7. **Spawn `claude`** under a controlling terminal, with the env above. The exact PTY mechanism is a runtime choice — not a tech requirement.

### 2.2. The MCP subprocess starts

`claude` reads `--mcp-config`, sees the `fnclaude` server entry, and spawns the subprocess (`fnclaude mcp` or `fnclaude mcp --noop`) with three stdio pipes. The subprocess:

1. Reads `$FNC_SOCKET` from its inherited env.
2. Initializes its own MCP server state.
3. Waits on stdin for JSON-RPC 2.0 messages.

When `claude` invokes a tool (e.g. the model asks to call `fnc_restart`), the subprocess receives a `tools/call` request on stdin, performs the work, and writes the result back on stdout.

### 2.3. Per-tool-call flow

For each tool invocation, the subprocess:

1. Validates input. If the tool's required args are missing or malformed, returns a tool-level error response (not a JSON-RPC protocol error).
2. Builds a `Request` object whose `op` field is the tool's wire name (see §4).
3. Opens an AF_UNIX connection to `$FNC_SOCKET` with a **10-second dial timeout**.
4. Sets a **10-second deadline** on the connection (covers the combined write+read window).
5. Writes one `Request` as newline-terminated JSON.
6. Reads one `Response` (newline-terminated JSON).
7. Closes the connection.
8. Marshals the `Response` JSON as a single text content item and returns it via the MCP `tools/call` result. The model interprets the embedded `action`, `message`, `command`, and `clipboard_ok` fields.

The parent's accept loop reads exactly one request per connection (no pipelining), dispatches synchronously per request, writes exactly one response, and closes. Each connection is handled in its own goroutine so a slow handler can't block subsequent dispatches.

### 2.4. Teardown

When `claude` exits (either naturally on user `/quit` / `Ctrl-D`, or because the parent killed it as part of a handoff):

1. The MCP subprocess is reaped by `claude` (its parent in the OS sense).
2. The parent's accept loop receives a "closed listener" notification when its socket is closed during shutdown.
3. The parent calls `unlink` on the socket file. (`os.Remove` is best-effort — some platforms remove it automatically on `close`; the explicit `unlink` covers the rest.)
4. Handoff content files (`<base>/fnclaude-handoff-content-<hex>.md`) are NOT removed. They live in tmpfs and are cleared on logout (or on next reboot for `os.TempDir()` fallbacks). The relaunched fnclaude reads the file on startup via the `@<path>` argv reference; after that, the file is dead weight that the OS reaps.

---

## 3. Wire format

Newline-delimited JSON over the AF_UNIX stream socket. One JSON object per line. Each line is exactly one request or one response. Connections are not reused; each tool call gets a fresh dial.

### 3.1. Request shape

| Field | JSON key | Type | Notes |
|---|---|---|---|
| Op | `op` | string | `"restart"`, `"switch"`, `"spawn"`, `"copy_to_clipboard"` |
| SessionID | `session_id` | string | UUID 8-4-4-4-12 hex; required for `restart`, optional on `switch`/`spawn` for live permission-mode capture |
| Destination | `destination` | string | New cwd for `switch` and `spawn` (absolute path or repo reference) |
| Name | `name` | string | New session name for `switch` / `spawn` |
| Summary | `summary` | string | Markdown content for the destination session's auto-loaded context |
| Confirmed | `confirmed` | bool | Deprecated. Tolerated on the wire; ignored by the server. Older prompt fragments still send it. |
| Text | `text` | string | Clipboard payload for `copy_to_clipboard` |
| Model | `model` | string | Override — see §5 |
| Effort | `effort` | string | Override — see §5 |
| PermissionMode | `permission_mode` | string | Override — see §5 |
| AllowedTools | `allowed_tools` | string | Override — see §5 |
| Agent | `agent` | string | Override — see §5 |
| Brief | `brief` | bool / null | Override — see §5 |
| Chrome | `chrome` | bool / null | Override — see §5 |
| IDE | `ide` | bool / null | Override — see §5 |
| Verbose | `verbose` | bool / null | Override — see §5 |

Pointer-to-bool fields use three-state JSON semantics: missing or `null` → preserve any existing form of the flag from the original argv; `true` → ensure the bare flag is present in the relaunch argv (strip duplicates, append once); `false` → ensure the flag is absent (strip all forms).

String override fields use two-state semantics: empty string → preserve; non-empty → strip any existing form of the flag (including bare-magic-positional `opus`/`max`/etc. for `model`/`effort`) and append `--<flag> <value>` to the relaunch argv. Override values always emit flag form, never bare-magic form. Full algorithm: [`design.md` §13](design.md).

### 3.2. Response shape

| Field | JSON key | Type | Notes |
|---|---|---|---|
| Action | `action` | string | `"done"`, `"paste_flow"`, or `"error"` |
| Message | `message` | string | User-facing prose the model surfaces to the user |
| Command | `command` | string | Paste-flow text (the relaunch command line) when `action == "paste_flow"` |
| ClipboardOK | `clipboard_ok` | bool | Whether the clipboard write succeeded — set by `paste_flow` responses and by `copy_to_clipboard` |
| CountdownSeconds | `countdown_seconds` | int | Deprecated. Not emitted by current server. |
| Error | `error` | string | Diagnostic message when `action == "error"` |

Two further `action` constants (`"needs_confirmation"`, `"auto_countdown"`) exist for backward compatibility with older test fixtures but are never emitted by the current server.

### 3.3. Timeouts and errors

- **Dial timeout**: 10 seconds. If the socket doesn't accept within 10 seconds (parent gone, socket file removed, OS overloaded) the subprocess returns a tool-level error response to claude.
- **Per-call deadline**: 10 seconds on the open connection covers write + read. If either side stalls, both sides error and tear down their end of the connection.
- **Malformed request**: parent writes a `Response{action: "error", error: "malformed request: …"}` and closes.
- **Premature client disconnect** (subprocess dies after dialing, before sending a full request): parent treats `EOF` before a newline as a no-op; nothing to respond to. No retry attempted.

---

## 4. The four tools — args, wiring, side effects

The four tools mirror the four `op` values. Availability differs by session mode:

| Tool | Session mode |
|---|---|
| `fnc_restart` | non-noop only |
| `fnc_switch_project` | both |
| `fnc_spawn_session` | both |
| `fnc_copy_to_clipboard` | noop only |

The noop-only listing for `fnc_copy_to_clipboard` reflects a deliberate constraint: in a non-noop session, claude can put the user's selection on the clipboard via its built-in tools; the standalone clipboard tool is only useful inside the noop router. The "clipboard is a fallback" framing in the PRD refers to the *paste-flow* responses (the rendered relaunch command landing on the clipboard when the auto-handoff path isn't taken), not to this tool — those use the OS clipboard via the same mechanism but happen as side effects of `switch`/`spawn` in `never` mode or when the spawn launcher isn't available.

### 4.1. `fnc_restart` → `op: "restart"`

**Required args:** `session_id` (UUID, 8-4-4-4-12 hex). Validated via regex; invalid UUID returns a tool-level error response without dialing.

**Optional args:** all the override fields above.

**Wire flow:**
1. Subprocess dials, sends request with `op: "restart", session_id: <uuid>`, plus any overrides.
2. Parent rebuilds the relaunch argv (see §5).
3. Parent stashes the argv and fires the handoff trigger (see §6).
4. Parent responds `Action: "done"`.
5. Subprocess returns the response to claude; claude renders the "restarting…" message; meanwhile the parent kills claude (§6) and re-executes itself.

The model reads `$CLAUDE_CODE_SESSION_ID` via a `Bash` tool call to populate `session_id`. Claude Code does not propagate `$CLAUDE_CODE_SESSION_ID` into MCP-stdio subprocess environments ([upstream #24371](https://github.com/anthropics/claude-code/issues/24371), closed "not planned"). The bare `Bash($CLAUDE_CODE_SESSION_ID)` runs in claude's own shell, where it IS set, then the model passes the value as a tool arg.

### 4.2. `fnc_switch_project` → `op: "switch"`

**Required args:** `destination`, `name`, `summary`.

**Optional args:** override fields + `session_id` (for live permission-mode capture).

**Wire flow:**
1. Subprocess dials and sends request.
2. Parent writes `summary` to a fresh `<base>/fnclaude-handoff-content-<hex>.md` file (mode 0600).
3. Parent rebuilds the relaunch argv:
   - Preserves user-supplied flags from the original invocation, **minus the transfer denylist** ([`design.md` §12](design.md)).
   - Applies any MCP-supplied overrides (§5).
   - Auto-captures the live permission mode from the session JSONL if no override was provided and no preserved flag carries one ([`design.md` §9](design.md)).
   - Emits: `[magic words] <destination> [rest] --name <name> @<summary-path>` — the `@<path>` is claude's own auto-read convention.
4. Parent stashes argv, fires trigger, responds `Action: "done"`.
5. Kill + re-exec as above.

In `never` mode, the parent takes a different path: write the summary, render the relaunch command, attempt to put it on the clipboard, return `Action: "paste_flow"` with `message`, `command`, `clipboard_ok`. The current session keeps running.

### 4.3. `fnc_spawn_session` → `op: "spawn"`

**Required args:** `destination`, `name`, `summary`.

**Optional args:** override fields only. **No `session_id`** — spawn starts fresh, with no preservation of flags or session state from the spawning session.

**Wire flow:**
1. Subprocess dials and sends request.
2. Parent writes `summary` to a content file (same shape as switch).
3. Parent builds an argv from `applyOverrides(nil, req)` — no preserved args. Only the override-derived flags appear.
4. Parent invokes the spawn launcher:
   - If `auto.spawnCommand` is set in config, tokenize on whitespace, substitute `{bin}` / `{dest}` / `{name}` / `{summary}` per token, and `exec` the result detached.
   - Otherwise, if `$TMUX` is set in the env, use the built-in template `tmux new-window -d {bin} {dest} --name {name} @{summary}`.
   - Otherwise, no launcher: fall back to paste-flow (`Action: "paste_flow"`, command on clipboard, message tells user to paste in a new terminal).
5. On successful launcher dispatch: `Action: "done"` with a confirmation message. The current session keeps running. The spawned sibling is its own independent fnclaude process — it computes its own socket path, has its own MCP env, etc. `cleanEnvForSpawn` strips `FNC_SOCKET`, `FNCLAUDE_HANDOFF`, and `CLAUDE_CODE_SESSION_ID` from the env handed to the sibling so it doesn't inherit the spawning session's wiring.

### 4.4. `fnc_copy_to_clipboard` → `op: "copy_to_clipboard"`

**Required args:** `text`.

**Wire flow:**
1. Subprocess dials and sends request.
2. Parent invokes the clipboard backend (see [`design.md` §25](design.md) for backend detection order — `wl-copy` → `xclip` → `xsel` → `pbcopy` → `clip.exe`).
3. Parent responds `Action: "done"` with `clipboard_ok: true|false`. Never errors — clipboard absence is reported via the flag, not raised as a failure.

---

## 5. Override semantics — flag-region rewrite

For `restart` and `switch` (not `spawn`, which preserves nothing), the parent constructs the relaunch argv by:

1. **Preserving** user-supplied flags from the original invocation — `[leading magic words] + [non-magic positional skip] + [flag region, minus the denylist for transfer]`. The denylist for transfer covers destination-bound and session-state-bound flags ([`design.md` §12](design.md)); restart uses no denylist (everything carries). Cross-cwd resume also uses no denylist.
2. **Applying overrides** in fixed order: `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, then the `*bool` overrides for `brief`, `chrome`, `ide`, `verbose`. Each string override strips the existing form (flag, `flag=value`, AND bare-magic-positional for `model`/`effort`) and appends `--<flag> <value>`. Pointer-bool overrides strip the bare flag, then conditionally append.
3. **Auto-capturing the live permission mode** when no override or preserved flag carries one. Reads the session JSONL for the latest `permission_mode` value the user set via `/permission-mode` inside claude ([`design.md` §9](design.md)).
4. **Composing the final argv shape:**
   - Restart: `[bareMagic] <launchCWD> --resume <session_id> [rest of flags]`
   - Switch: `[bareMagic] <destination> [rest] --name <name> @<summary-path>`
   - Spawn: `[bareMagic-from-overrides] <destination> [rest] --name <name> @<summary-path>` — no preservation, so `bareMagic` is whatever overrides emitted.

Full mechanics, including the `preserveArgs` / `applyOverrides` algorithms: [`design.md` §13](design.md).

---

## 6. Handoff trigger and parent re-execution

The parent's handoff machinery has two halves:

### 6.1. The trigger signal

When a `restart` or non-`never`-mode `switch` arrives and is dispatched, the parent does three things, in order, atomically from the per-call goroutine's perspective:

1. Stashes the relaunch argv into a shared field (mutex-protected, first-stash wins).
2. Closes a one-shot `Triggered` channel (no-op on repeat close — the `sync.Once` semantics make multiple dispatches safe).
3. Writes the `Action: "done"` response back to the MCP subprocess and closes the connection.

A separate goroutine in the parent has been awaiting `Triggered` close since startup. When it fires:

1. Send `SIGTERM` to claude.
2. Sleep 200ms.
3. Send `SIGKILL` (covers the case where claude doesn't handle SIGTERM in time).

On Windows, the equivalent is `cmd.Process.Kill()` which maps to `TerminateProcess` — no graceful path, no SIGTERM-then-SIGKILL distinction.

### 6.2. Process image replacement

The parent's main loop has been blocked in the PTY's output-read loop. When claude exits (because of the kill above, or naturally), the read loop returns. The parent:

1. Calls `Wait()` to reap claude and capture its exit code.
2. Checks the stashed handoff argv.
3. If a handoff was stashed: replaces the running parent process with a fresh `fnclaude <stashed-argv>` invocation. On Unix this is `execve` — same PID, same controlling terminal, fresh address space, deferred cleanup actions skipped. On Windows this is a new child process the parent waits on, then exits with the child's code (no `execve` equivalent in a way that preserves the controlling terminal cleanly).
4. If no handoff was stashed: scans the PTY output ring buffer for the cross-cwd resume marker. If found, also re-executes (with a reconstructed argv that swaps the destination cwd and adds `--resume <uuid>`).
5. Otherwise, exits with claude's exit code.

This is the load-bearing reason the parent runs as a foreground process: it has to outlive `claude` to perform the re-execution. Any rewrite must keep that invariant.

---

## 7. Cleanup and persistence

| Resource | Cleanup trigger | Persistence |
|---|---|---|
| Socket file (`fnclaude-mcp-<pid>.sock`) | Parent's listener close → explicit `unlink` | None — gone with the listener |
| Handoff content file (`fnclaude-handoff-content-<hex>.md`) | Logout (tmpfs) or next reboot (OS temp dir) | Read once by the relaunched fnclaude; dead weight afterward |
| `[exec.env]` injected env vars | Process exit | None |
| Live permission mode in session JSONL | Persisted by claude itself | Survives fnclaude restart; that's why we read it |
| Auto-named session label | Persisted by claude (it's `--name`) | Survives across restart/transfer |

The parent does not attempt to garbage-collect old handoff content files. Tmpfs handles it on logout; for non-tmpfs fallback (`os.TempDir`), the file lifetime is at the OS's discretion. Both are acceptable — the files are private (mode 0600), small, and not security-sensitive beyond their 0600 ACL.

---

## 8. Failure modes and edge cases

| Scenario | Behavior |
|---|---|
| `$FNC_SOCKET` unset in subprocess | Subprocess returns a tool-level error response — "FNC_SOCKET not set; this MCP server requires fnclaude as its parent". |
| Socket file removed mid-session | Dial fails with "no such file or directory"; tool-level error response. The parent is likely also gone in this case. |
| Parent crashed but socket file still exists | Dial fails with "connection refused" (kernel-side cleanup of the bind hasn't propagated); tool-level error response. |
| `Action: "error"` from parent | Subprocess surfaces it as a tool-level error to claude; the model decides how to react. |
| Concurrent `restart` + `switch` requests racing | First to call `stashArgv` wins; second's stash is silently ignored; second still gets a successful response. Kill + re-exec proceeds with the first stash. Rare in practice. |
| Subprocess dies mid-call | Parent's accept loop sees EOF; logs nothing (no response to write); moves on. Claude reaps the subprocess and may or may not spawn a fresh one per its own internal retry. |
| Same-PID handoff path collision | Not possible at runtime — sockets and content files include the PID; only one fnclaude per PID. After a crash, the next fnclaude with the same PID best-effort-removes the stale socket on startup. |
| Permission-mode capture finds no JSONL | Skip the auto-capture step. Whatever the user had at session start carries through (or whatever the override specifies). |
| Spawn launcher template substitution emits empty argv | Returns an error response — "spawn template produced empty argv". User sees the error, can fix their config. |

---

## 9. Tech requirements summary (the OS-level invariants the rewrite must satisfy)

The rewrite has freedom in language, runtime, async pattern, and PTY backend. It does NOT have freedom in:

- The two env var names (`FNC_SOCKET`, `FNCLAUDE_HANDOFF`) and their semantics.
- The handoff base directory preference order (`$XDG_RUNTIME_DIR` → OS temp dir).
- The socket path formula (`<base>/fnclaude-mcp-<pid>.sock`) and the 108-byte AF_UNIX `sun_path` ceiling.
- The handoff content path formula (`<base>/fnclaude-handoff-content-<16-hex>.md`, mode 0600).
- The newline-delimited JSON wire format on the socket.
- The 10-second dial timeout and 10-second per-call deadline.
- The four `op` values and the field shape of `Request` / `Response`.
- The override semantics (string two-state, bool three-state).
- The kill sequence (`SIGTERM` → 200ms → `SIGKILL` on Unix; `TerminateProcess` on Windows).
- The relaunch argv shapes (restart, switch, spawn).
- Cleanup behavior (socket unlink on close, content files left to the OS).

Anything else — the specific socket library, the PTY library, the async primitive, the JSON codec, the IPC pattern between the listener and the PTY-reader thread — is a runtime choice and belongs in [`decisions.md`](decisions.md), not here.
