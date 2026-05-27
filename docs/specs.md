# fnclaude canonical spec

Derived from the Go reference implementation at `github.com/fnrhombus/fnclaude`.
Every behavior in this document is verified against the Go source; where the README
description diverges from the code, that is noted with a `⚠ README divergence` callout.
The Go source wins in all such cases.

---

## Table of contents

1. [Argument grammar](#1-argument-grammar)
2. [Short-flag translation](#2-short-flag-translation)
3. [Subcommand positionals](#3-subcommand-positionals)
4. [Positional paths](#4-positional-paths)
5. [Extra-dir injection](#5-extra-dir-injection)
6. [Config file](#6-config-file)
7. [Auto-tmux](#7-auto-tmux)
8. [Auto-name from prompt](#8-auto-name-from-prompt)
9. [Name sanitization](#9-name-sanitization)
10. [Worktree intercept](#10-worktree-intercept)
11. [Cross-cwd resume](#11-cross-cwd-resume)
12. [System-prompt fragments](#12-system-prompt-fragments)
13. [Noop fallback session](#13-noop-fallback-session)
14. [Handoff and project-switch](#14-handoff-and-project-switch)
15. [Self-MCP server](#15-self-mcp-server)
16. [PTY execution model](#16-pty-execution-model)
17. [Warnings — deferred flush model](#17-warnings--deferred-flush-model)
18. [Undocumented behavior](#18-undocumented-behavior)

---

## 1. Argument grammar

### 1.1 Overall shape

```
fnclaude [MODEL] [EFFORT] [CWD [WORKTREE]] [SUBCOMMAND] [FLAGS...] [-- PROMPT]
```

Parsing is strictly left-to-right with three parallel scanners active
simultaneously: the magic scanner (positions 1–2), the subcommand scanner
(any positional slot), and the flag scanner (everything from the first
`-`-prefixed token onward). Once a flag-shaped token is seen, all subsequent
non-flag positionals are not treated as paths or magic words.

**Canonical source:** `src/main.go:106–343`

### 1.2 Magic positional words

Position 1 and 2 may be consumed as model/effort shorthands. The rules are
strictly positional — not last-wins.

| Position | Condition | Effect |
|---|---|---|
| 1 | token is exactly `opus`, `sonnet`, or `haiku` | Consumed; becomes `--model <token>`. Magic advances to position 2. |
| 2 | position 1 was a model alias AND token is exactly `low`, `medium`, `high`, `xhigh`, or `max` | Consumed; becomes `--effort <token>`. Magic done. |
| 2 | position 1 was a model alias AND token is NOT an effort level | Token becomes the CWD. Magic done. |
| 1 | token is NOT a model alias | Token becomes the CWD (or a subcommand; see §3). Magic done. |

`--model` and `--effort` are prepended to the passthrough slice before any
flags the user also provided.

To pass a literal directory named `opus`, `sonnet`, `haiku`, or an effort
level, prefix with `./`:

```sh
fnclaude ./opus          # passes ./opus as CWD, no --model
```

**Canonical source:** `src/main.go:130–210, 309–327`

### 1.3 `--` prompt separator

Everything after a bare `--` token is collected into claude's `--print` argument
(via passthrough). The auto-name machinery (§8) extracts the first non-empty
token after `--` as the prompt text.

---

## 2. Short-flag translation

fnclaude uses capital-letter short flags. Each is translated to the corresponding
`claude` long form before the subprocess is launched. The user's shell never
sees the short form.

| Short | Long | Value type |
|---|---|---|
| `-B` | `--brief` | none (boolean) |
| `-C` | `--chrome` | none |
| `-D` | `--dangerously-skip-permissions` | none |
| `-F` | `--fork-session` | none |
| `-I` | `--ide` | none |
| `-V` | `--verbose` | none |
| `-G` | `--agent` | required |
| `-M` | `--permission-mode` | required |
| `-W` | `--allowedTools` | required |
| `-P` | `--from-pr` | optional |
| `-R` | `--remote-control` | optional |
| `-T` | `--tmux` | optional |

fnclaude-owned flags (not forwarded to claude):

| Flag | Long | Notes |
|---|---|---|
| `-A` | `--also <dir>` | Repeatable; only way to add extra dirs after positional parsing |
| `-w` | `--worktree <name>` | Intercepted; see §10 |
| `--no-tmux` | | Suppresses auto-tmux for this invocation |
| `-h` | `--help` | Prints fnclaude flag reference; no claude invocation |
| `-v` | `--version` | Prints `fnclaude <version>`; shadows claude's `-v` |

**POSIX collapsing:** `-BVC` expands to `-B -V -C`. Only the rightmost flag in
a collapsed group may take a value. A required-value flag in a non-final position
is an error:

```
fnclaude: flag -G cannot be in middle of collapsed group, requires a value
```

Short flags that are not in any of the three maps are passed through verbatim as
`-<char>` for claude to handle.

**Supported forms for required/optional short flags:**
- `-G val` — space-separated
- `-G=val` — equals form (single token)
- Collapsed group where the value-taking flag is last: `-VG val`

**Canonical source:** `src/main.go:66–87, 350–423`

---

## 3. Subcommand positionals

Six special tokens expand into claude long flags when they appear in positional
territory (before the first `-`-prefixed token). They are order-independent with
respect to the magic scanner: `fnc resume opus xhigh` and `fnc opus xhigh resume`
produce identical argv.

| Token | Expands to | Notes |
|---|---|---|
| `resume` | `--resume` | Session picker |
| `res` | `--resume` | Alias |
| `continue` | `--continue` | Resume most-recent session |
| `con` | `--continue` | Alias |
| `fork` | `--resume --fork-session` | Picker; fork on select |
| `fk` | `--resume --fork-session` | Alias |

The expansion is prepended to the passthrough slice ahead of any `--` separator
so the flags land before any prompt text.

At most one subcommand token per invocation. A second subcommand is an error:

```
fnclaude: only one subcommand allowed (got "resume" and "continue")
```

Subcommands do not advance the magic scanner — after consuming a subcommand token,
the magic scanner continues at the same position it was at before.

To pass a literal directory named `resume`, `fork`, etc., prefix with `./`.

**Canonical source:** `src/main.go:89–103, 163–175`

---

## 4. Positional paths

After magic and subcommand tokens have been consumed, the remaining non-flag
positionals fill these slots in order:

| Slot | Meaning |
|---|---|
| 1st | CWD to launch claude in |
| 2nd | Worktree name (equivalent to `-w <name>`; later explicit `-w` overwrites this) |
| 3rd+ | Error: `fnclaude: too many positional arguments` |

Extra dirs (formerly accepted as 3rd+ positionals) are accepted only via `-A` /
`--also`.

### 4.1 CWD resolution

The CWD goes through several transformation stages in order:

1. **Tilde expansion** (`~` or `~/`): expanded to `os.UserHomeDir()` before any
   other check. Mid-token `~` is left literal.

2. **Resolver** (§18.1): if the CWD is not absolute and does not start with `~`,
   it is treated as a potential repo reference. Both a cwd-relative path lookup
   and a GitHub repo lookup are attempted in parallel. See §18.1 for the full
   resolver ladder.

3. **Worktree intercept** (§10): applied after resolver.

4. **Relative-to-shell-cwd expansion**: any remaining relative path is joined
   against `os.Getwd()`.

### 4.2 Noop fallback

When no positional path is given, CWD falls back to
`$XDG_CONFIG_HOME/fnclaude/noop` (fallback: `~/.config/fnclaude/noop`).
The `UsedNoopFallback` flag gates noop-specific behavior (seed, prompt fragments).

**Canonical source:** `src/main.go:327–332, 919–950`

---

## 5. Extra-dir injection

For each dir in `ExtraDirs` (populated by `-A` / `--also`), fnclaude appends to
the claude argv in this order:

1. `--add-dir <abs-dir>` — always.
2. `--mcp-config <dir>/.mcp.json` — only if the file exists at launch time.
3. `--settings <dir>/.claude/settings.json` — only if the file exists AND
   `--setting-sources` is NOT already in the passthrough args.

Relative extra-dir paths are resolved against the shell CWD at build time
(not the resolved launch CWD).

The `--setting-sources` suppression check scans the passthrough slice for the
exact token `--setting-sources` or any token starting with `--setting-sources=`.
When either is found, all `--settings` injections for all extra dirs are suppressed.

**Canonical source:** `src/main.go:797–825`

---

## 6. Config file

**Location:** `$XDG_CONFIG_HOME/fnclaude/config.toml` (fallback `~/.config/fnclaude/config.toml`)

A missing file is not an error. A malformed file emits a deferred warning and
falls back to built-in defaults for all keys.

**Precedence (high → low):** CLI flag > env var > config file > built-in default

### 6.1 Config schema

```toml
[name]
model = "claude-haiku-4-5"    # model for auto-name LLM call
timeout = "3s"                 # timeout for API path; CLI path uses 15s
quiet_missing_api_key = false  # deprecated no-op (warning was removed)

[auto]
tmux = "never"                 # "never" | "worktree"
handoff = "ask"                # "never" | "ask" | non-negative integer (seconds)
spawn_command = ""             # launcher template for fnc_spawn_session

[exec]
[exec.env]
MY_VAR = "value"               # injected into claude's environment (last-wins)
```

### 6.2 Env var mapping

| Config key | Env var | Default |
|---|---|---|
| `name.model` | `FNCLAUDE_NAME_MODEL` | `claude-haiku-4-5` |
| `name.timeout` | `FNCLAUDE_NAME_TIMEOUT` | `3s` (API) / `15s` (CLI) |
| `name.quiet_missing_api_key` | `FNCLAUDE_QUIET_MISSING_API_KEY` | `false` |
| `auto.tmux` | `FNCLAUDE_TMUX` | `never` |
| `auto.handoff` | `FNCLAUDE_HANDOFF` | `ask` |
| `auto.spawn_command` | `FNCLAUDE_SPAWN_COMMAND` | `""` |

`ANTHROPIC_API_KEY` (standard) is read for the auto-name LLM call.

`FNCLAUDE_QUIET_MISSING_API_KEY` is parsed as a boolean env var: `"1"`, `"true"`,
`"yes"` (case-insensitive) → `true`; everything else → `false`.

### 6.3 Normalization

`auto.tmux` values that are neither `"never"` nor `"worktree"` (including the
deprecated `"always"`) are normalized to `"never"` with a deferred warning.

`auto.handoff` values that are neither `"never"`, `"ask"`, nor a non-negative
integer string are normalized to `"ask"` with a deferred warning.

### 6.4 `[exec.env]`

`[exec.env]` entries are injected into claude's environment by appending them
after `os.Environ()`. Go's `exec.Command` last-wins rule means a configured key
overrides any same-name key inherited from the parent's environment.

Entries are sorted by key before injection so the order is deterministic.

**Canonical source:** `src/config.go:1–258`

---

## 7. Auto-tmux

Controlled by `auto.tmux` / `FNCLAUDE_TMUX`.

| Mode | Behavior |
|---|---|
| `"never"` (default) | No-op. |
| `"worktree"` | Injects `--tmux` when the user is creating a new worktree (i.e., `-w` was given and the worktree name did NOT match an existing worktree). `--worktree` is already in passthrough at that point so claude's constraint is satisfied. |

`--no-tmux` on the command line suppresses injection for that invocation
regardless of config.

`--tmux` is not injected if it is already in the passthrough args.

fnclaude never auto-creates worktrees on its own.

**Canonical source:** `src/main.go:847–851`, `src/config.go:194–202`

---

## 8. Auto-name from prompt

When all of the following are true, fnclaude generates a session `--name` and
prepends `--name <label>` to the passthrough slice before `buildArgv` runs:

- The passthrough slice contains `--` followed by at least one non-empty token.
- `--name` / `-n` (or their `=value` forms) are NOT in the passthrough slice.
- `-p` / `--print` is NOT in the passthrough slice.
- `-r` / `--resume` (or `=` forms) are NOT in the passthrough slice.
- `-c` / `--continue` is NOT in the passthrough slice.
- `--from-pr` / `-P` (or `=` forms) are NOT in the passthrough slice.

### 8.1 Name generation

**Input:** the first non-empty token after `--` in passthrough.

**System prompt sent to the LLM:**
> Generate a 1-3 word lowercase hyphen-separated label for this user's request.
> Output ONLY the label — no punctuation, no quotes, no explanation, no leading
> 'Label:'. Examples: 'fix-login-bug', 'add-dark-mode', 'refactor-auth'.

**Client selection:**

| Condition | Client used | Timeout |
|---|---|---|
| `ANTHROPIC_API_KEY` is set | Anthropic SDK direct call (`claude-haiku-4-5` by default) | `name.timeout` (default 3s) |
| `ANTHROPIC_API_KEY` unset | `claude -p --model <model> <combined-prompt>` subprocess | `name.timeout` if > 0, else 15s |

The `name.timeout` in config applies to both paths when explicitly set to a
positive value. When the timeout is 0 or negative, the API path uses 3s and the
CLI path uses 15s.

⚠ **README divergence:** The README says "The call has a 3-second timeout; on
timeout, missing API key, or any error, it falls back to a heuristic." The code
uses a 15-second timeout for the CLI path (`claudeCLIClient`) because `claude -p`
has a multi-second cold-start. The 3-second timeout only applies when
`ANTHROPIC_API_KEY` is set and the SDK path is used.

**Heuristic fallback** (any error, empty result, or timeout):

```
lower(prompt)
→ split on whitespace
→ drop stop words: a, an, the, is, are, was, were, do, does, did, of, for,
                   to, in, on, at, with, this, that, please, can, could,
                   would, should
→ strip non-alphanumeric chars from each word
→ take first 3 non-empty results
→ join with "-"
→ fallback "session" if nothing remains
```

**LLM output sanitization** (applied to any non-empty LLM response):

1. Trim whitespace.
2. Lowercase.
3. Replace whitespace runs with `-`.
4. Strip anything not in `[a-z0-9-]`.
5. Collapse consecutive dashes.
6. Trim leading/trailing dashes.
7. Take only the first 3 dash-delimited segments (truncating at the 4th).
8. Trim leading/trailing dashes again.
9. If result is empty, fall through to heuristic.

**Canonical source:** `src/autoname.go:1–253`

---

## 9. Name sanitization

After auto-name injection (or a user-supplied `--name`), fnclaude scans the
passthrough slice for `--name`/`-n` occurrences and rewrites the value to a
path-safe slug.

**`sanitizeForPath` rules:**

1. Empty input → invalid.
2. Input starting with `/` → invalid (would escape configured path prefix).
3. Replace any character NOT in `[A-Za-z0-9._/-]` with `-`.
4. Collapse runs of `--` to a single `-`.
5. Collapse runs of `//` to a single `/`.
6. Strip leading `-.` characters.
7. Strip trailing `-/` characters.
8. Empty result → invalid.
9. Result containing `..` → invalid (git ref-format rule; blocks path escape).

`/` is allowed so git-style nested refs (`feat/foo`, `team/x/y/z`) pass through
and produce nested worktree paths.

**On invalid result:** the original value is passed through unchanged with a
deferred warning. This preserves the literal input so claude (or a downstream
hook) can surface the real error rather than fnclaude silently substituting a
synthetic name.

**On changed (but valid) result:** the sanitized value replaces the original,
and a deferred warning reports the rewrite:
```
fnclaude: --name "my name!" sanitized to "my-name" (illegal path/branch chars)
```

**Handled token forms:** `--name <val>`, `--name=<val>`, `-n <val>`, `-n=<val>`.
In the space-separated form, the value slot is consumed and skipped.

**Canonical source:** `src/sanitize.go:1–117`

---

## 10. Worktree intercept

Triggered when `-w` / `--worktree` was set (either explicitly or via the 2nd
positional path slot).

**Bare `-w` (no value):** pushes `--worktree` back into passthrough unchanged.

**`-w <name>`:** runs `git worktree list --porcelain` in the resolved CWD. The
match strategy is tried in this exact order:

| Priority | Match condition |
|---|---|
| 1 | `branch == query` (exact branch name match) |
| 2 | `TrimPrefix(branch, "worktree-") == query` (Claude's default worktree branch prefix stripped) |
| 3 | `filepath.Base(path) == query` (last-resort: basename of worktree path) |

**On match:** swaps `a.CWD` to the matched worktree's absolute path. Sets
`WorktreeMatched = true`. Does NOT add `--worktree` or `--name` to passthrough.

**On no match** (or not a git repo): pushes `--worktree <name>` into passthrough,
and — if `--name` / `-n` is not already in passthrough — also pushes
`--name <name>`.

Git errors (not a repo, etc.) are treated silently as "no match."

**Canonical source:** `src/main.go:631–743`

---

## 11. Cross-cwd resume

When the user selects a session from a different directory via claude's Ctrl+A
picker, claude exits and prints a message of the form:

```
To resume, run:
cd <path> && claude --resume <uuid>
```

fnclaude captures the last 64 KB of PTY output in a ring buffer. After claude
exits, it scans the buffer with the regex:

```
To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})
```

When matched, fnclaude clears the terminal and calls `syscall.Exec` to replace
the current process with a fresh `fnclaude` in the destination directory,
resuming the selected session. The new argv is:

```
[leading-magic-words...] <dest> --resume <uuid> [rest-of-original-flags...]
```

Where "leading magic words" are the model alias / effort level tokens from the
original invocation (if any), and "rest of original flags" is everything after
stripping the original CWD and worktree-name positionals.

**Platform support:** Linux and macOS only. On Windows, `runWithPTY` returns a
nil tail, so `detectCrossCwd` never matches, and `silentRelaunch` emits a clear
error message.

⚠ **README divergence:** The README says the ring buffer is 4 KB ("scans the
last 4 KB of claude's output"). The code uses 64 KB (`ringBufferSize = 64 * 1024`).
The 4 KB value was the original size; it was increased after claude 2.1.143 emitted
more trailing cleanup before exit, causing the message to rotate out of the tail.

**Canonical source:** `src/pty_run.go:17–99`, `src/pty_run_unix.go:159–201`

---

## 12. System-prompt fragments

fnclaude injects system-prompt content via `--append-system-prompt`. Multiple
fragments are joined with a double newline (`\n\n`). If `--append-system-prompt`
is already in the passthrough args, the fragments are appended to its existing
value.

### 12.1 Fragment files

Fragments are `.md` files loaded from the prompts install directory.

**Search order for the prompts directory:**

1. `$FNC_PROMPTS_DIR` (override; env var)
2. `<exe-dir>/prompts/` (dev workflow)
3. `<exe-dir>/../share/fnclaude/prompts/` (FHS / AUR install)

Symlinks in the exe path are resolved via `filepath.EvalSymlinks` before the
search.

**If the prompts directory is missing entirely** (typical for `go install`
installs which do not ship data files), a deferred warning is queued and the
`PromptSet` is empty — no fragments are injected, but the session still launches.

### 12.2 Fragment selection

| Fragment file | Injected when |
|---|---|
| `agent-pitfall.md` | Every interactive (non `-p`/`--print`) session |
| `spawn.md` | Every interactive session |
| `noop-router.md` | Noop fallback session only |
| `project-switch.md` | Non-noop interactive session only |
| `restart.md` | Non-noop interactive session only |

`-p` / `--print` sessions get no fragments at all.

⚠ **README divergence:** The README lists `agent-pitfall.md`, `noop-router.md`,
and `project-switch.md` as the three fragment files. The code also loads and
injects `spawn.md` and `restart.md`. The README table is incomplete.

### 12.3 Missing fragments

Each missing fragment file emits a deferred warning naming the exact path that
was not found. The session still launches without that fragment.

**Canonical source:** `src/prompts.go:1–188`

---

## 13. Noop fallback session

When no positional path is given, `CWD` is set to `$XDG_CONFIG_HOME/fnclaude/noop`
(fallback `~/.config/fnclaude/noop`) and `UsedNoopFallback = true`.

### 13.1 Noop directory seeding

On each noop launch, fnclaude calls `seedNoop(noopDir)` which:

1. Creates `noopDir` with `MkdirAll(..., 0o755)` if it doesn't exist.
2. Computes SHA-256 of the embedded `handoff.template.md` and the on-disk copy.
3. Writes the embedded template iff the on-disk copy is missing or has a different
   checksum.

Only `handoff.template.md` is seeded. `CLAUDE.md` and all other files in the
noop directory are user-owned and are never touched.

⚠ **README divergence:** The README says fnclaude "embeds and lazy-seeds a
generic `CLAUDE.md` + a `handoff.template.md` into that directory on each
launch." The code no longer seeds `CLAUDE.md`. The noop-router instructions
(formerly seeded as `CLAUDE.md`) are now delivered via `--append-system-prompt`
from the `noop-router.md` fragment. Only `handoff.template.md` is seeded.

### 13.2 Noop personalization

Drop `CLAUDE.md` in the noop directory (`~/.config/fnclaude/noop/CLAUDE.md`) to
add personal instructions. Claude Code auto-loads it as project context alongside
the system prompt. fnclaude never touches it.

**Canonical source:** `src/noop.go:1–58`

---

## 14. Handoff and project-switch

### 14.1 Mechanism overview

On every interactive session, fnclaude:

1. Creates an AF_UNIX socket at `handoffSocketPath(os.Getpid())`.
2. Injects `FNCLAUDE_HANDOFF=<mode>` and `FNC_SOCKET=<path>` into claude's
   environment.
3. Starts the self-MCP server (`fnclaude mcp`) as a claude subprocess via
   `--mcp-config <inline-json>`.
4. Starts an AF_UNIX socket listener goroutine.

When claude's self-MCP server sends a Request to the socket, the listener
dispatches it, performs side effects, stashes the relaunch argv, and fires the
`Triggered` channel. The PTY goroutine kills claude (SIGTERM + 200ms grace +
SIGKILL on Unix; `TerminateProcess` on Windows) and `silentRelaunchHandoff`
replaces the process image via `syscall.Exec`.

Socket path formula: `<handoffBaseDir()>/fnclaude-mcp-<pid>.sock`

`handoffBaseDir()` preference order:
1. `$XDG_RUNTIME_DIR`
2. `os.TempDir()` (honors `$TMPDIR`, then `/tmp` on Unix; `%TMP%`/`%TEMP%` on Windows)

### 14.2 `auto.handoff` modes

`auto.handoff` controls the noop router's behavior when proposing a project
switch. It does NOT gate user-initiated project-switch (`fnc_switch_project`)
in non-noop sessions — that is always available.

| Mode | Noop router behavior |
|---|---|
| `"never"` | claude renders the relaunch command and copies it to the clipboard. |
| `"ask"` (default) | claude asks "Want me to switch you over now?". On yes, executes the switch. On no, falls back to paste-flow. |
| `"<N>"` (non-negative integer seconds) | claude announces a countdown and fires the switch after `sleep N`. Ctrl-C during sleep falls back to paste-flow. `"0"` is instant. |

### 14.3 Switch argv construction

When `handleSwitch` runs with `auto.handoff != "never"`:

1. Writes `req.Summary` to `handoffContentPath()` (random-token path in
   `handoffBaseDir()`, mode 0o600).
2. Applies `transferDenyFlags` (see §18.3) to strip destination-bound flags
   from the original argv.
3. Applies MCP-supplied overrides.
4. Auto-captures live permission-mode from the session JSONL if not explicitly
   overridden and `session_id` was provided.
5. Constructs argv: `[magic...] <destination> [rest...] --name <name> @<summaryPath>`

The `@<summaryPath>` reference triggers claude's automatic file-read in the
receiving session. Summary files live in tmpfs (or OS temp dir) and are not
committed to any project repo.

### 14.4 Restart argv construction

`handleRestart` constructs:

```
[magic...] <launchCWD> --resume <sessionID> [rest-of-flags...]
```

All original flags are preserved (no denylist for restart). Auto-captures live
permission-mode from session JSONL when not overridden.

### 14.5 Never-mode paste-flow

When `auto.handoff == "never"`, both switch and spawn produce `ActionPasteFlow`
responses. The summary is still written to a temp file. The rendered command is
attempted to be copied to the clipboard via `copyToClipboard` (see §18.5).

### 14.6 Listener startup failure

If the AF_UNIX socket listener fails to start, fnclaude aborts the session with
exit code 1 (it does NOT fall back to running without the socket). Handoff is
treated as core behavior, not optional.

**Canonical source:** `src/socket_listener.go:1–470`, `src/handoff.go:1–109`

---

## 15. Self-MCP server

### 15.1 Invocation

fnclaude registers itself as a claude MCP server subprocess via an inline
`--mcp-config` JSON value:

```json
{"mcpServers":{"fnclaude":{"command":"/abs/path/to/fnclaude","args":["mcp"]}}}
```

For noop sessions, `"args"` is `["mcp","--noop"]`.

The exe path is resolved via `filepath.EvalSymlinks(os.Executable())`. On symlink
resolution failure, the unresolved path is used as a fallback.

MCP injection is gated on interactive sessions only (`-p`/`--print` sessions
do not receive the `--mcp-config` injection).

### 15.2 Wire protocol (JSON-RPC 2.0)

The MCP server communicates over stdio (stdin/stdout). Each line is a
newline-terminated JSON object.

**Supported JSON-RPC methods:**

| Method | Notes |
|---|---|
| `initialize` | Returns protocol version `"2024-11-05"`, capabilities `{tools:{}}`, server info `{name:"fnclaude", version:<build-version>}` |
| `tools/list` | Returns the tool list for the current mode |
| `tools/call` | Dispatches to the named tool handler |

Notifications (requests with no `id` field) are accepted silently. Only
`notifications/initialized` is acted on (sets `initialized = true`).

Unknown methods return JSON-RPC error `-32601` (method not found).

### 15.3 Internal socket protocol

The MCP server proxies tool calls to the parent fnclaude via AF_UNIX socket
(`$FNC_SOCKET`). Each connection carries exactly one `Request` and receives
exactly one `Response`, then closes. The wire format is newline-delimited JSON.

**Request fields:**

| Field | Type | Notes |
|---|---|---|
| `op` | string | `"restart"`, `"switch"`, `"spawn"`, `"copy_to_clipboard"` |
| `session_id` | string | UUID; required for `restart`; optional for `switch`/`spawn` (for live permission-mode capture) |
| `destination` | string | For `switch` and `spawn` |
| `name` | string | For `switch` and `spawn` |
| `summary` | string | For `switch` and `spawn` |
| `text` | string | For `copy_to_clipboard` |
| `model` | string | Override; empty = preserve |
| `effort` | string | Override |
| `permission_mode` | string | Override |
| `allowed_tools` | string | Override |
| `agent` | string | Override |
| `brief` | *bool | nil = preserve; true/false = set/unset |
| `chrome` | *bool | nil = preserve |
| `ide` | *bool | nil = preserve |
| `verbose` | *bool | nil = preserve |
| `confirmed` | bool | Deprecated; tolerated on wire, ignored by server |

**Response fields:**

| Field | Type | Notes |
|---|---|---|
| `action` | string | `"done"`, `"paste_flow"`, `"error"` |
| `message` | string | Natural-language guidance for claude |
| `command` | string | Set for `paste_flow` |
| `clipboard_ok` | bool | Whether clipboard copy succeeded; `paste_flow` only |
| `error` | string | Set for `action = "error"` |

Note: `"needs_confirmation"` and `"auto_countdown"` action values are defined in
the constants but are no longer emitted by the server (they existed in the
protocol-side confirmation dance that has since been replaced by a
prompt-side UX).

### 15.4 Tool definitions

#### Tool availability by mode

| Tool | Non-noop | Noop (`--noop`) |
|---|---|---|
| `fnc_restart` | yes | no |
| `fnc_switch_project` | yes | yes |
| `fnc_spawn_session` | yes | yes |
| `fnc_copy_to_clipboard` | no | yes |

#### `fnc_restart`

Restarts the current session in place. Preserves all startup flags (no denylist).
Applies optional overrides.

**Required argument:** `session_id` (UUID from `$CLAUDE_CODE_SESSION_ID`).
The model must read it via Bash since Claude Code does not propagate
`CLAUDE_CODE_SESSION_ID` to MCP stdio subprocess environments (upstream issue
#24371, closed "not planned").

UUID is validated against the pattern `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`.

#### `fnc_switch_project`

Terminates the current session and re-launches fnclaude in a new project.
One-shot: the session is killed and re-launched after a single call. The
prompt supplies a cancellation-window UX (print + Bash sleep) before the tool
call.

**Required arguments:** `destination`, `name`, `summary`.

#### `fnc_spawn_session`

Spawns a sibling fnclaude in a new terminal window while leaving the current
session running. Does NOT preserve startup flags (fresh-start sibling).
Does NOT stash argv or fire `Triggered`.

**Required arguments:** `destination`, `name`, `summary`.

#### `fnc_copy_to_clipboard`

Copies `text` to the user's clipboard. Always returns `ActionDone` (the tool
reports `clipboard_ok` in the response rather than failing on clipboard absence).

**Required argument:** `text`.

**Canonical source:** `src/mcp.go:1–622`, `src/mcp_protocol.go:1–204`

---

## 16. PTY execution model

### 16.1 Unix path

`runWithPTY` (Linux/macOS):

1. Resolves `claude` via `exec.LookPath`.
2. Builds `cmd.Env = os.Environ() + envFromConfig(cfg) + handoffEnv(...)`.
3. Calls `ensureCWD(launchCWD)` to fabricate missing cwd components (see §18.6).
4. Starts `claude` under a PTY via `pty.Start(cmd)`.
5. After successful start, unwinds fabricated cwd components immediately
   (kernel holds cwd by inode reference after the child has `chdir`'d).
6. Sets PTY size to match the current terminal.
7. Sets controlling terminal to raw mode.
8. Forwards `SIGWINCH` to the PTY (terminal resize).
9. Starts goroutine: forwards stdin → PTY master.
10. Tees PTY output → `os.Stdout` + 64 KB ring buffer.
11. When `Triggered` fires: sends `SIGTERM`, waits 200ms, sends `SIGKILL`.
12. `cmd.Wait()` — propagates exit code.

The `[exec.env]` config entries are appended before handoff env vars, so handoff
vars win against any user-set duplicates with the same name.

### 16.2 Windows path

No PTY. `claude` is spawned with inherited stdio (`cmd.Stdin = os.Stdin`,
etc.). Returns nil tail (cross-cwd detection never fires). When `Triggered`
fires, kills via `cmd.Process.Kill()` (maps to `TerminateProcess`).
`silentRelaunchHandoff` on Windows spawns a new fnclaude process (no
`syscall.Exec`) and waits for it, then exits with its code.

### 16.3 `syscall.Exec` vs. process spawn

On Unix, both cross-cwd resume (`silentRelaunch`) and MCP-triggered handoff
(`silentRelaunchHandoff`) use `syscall.Exec` to replace the process image.
`defer flushWarnings()` in `run()` is intentionally skipped by `syscall.Exec`;
the relaunched fnclaude re-emits any still-applicable deferred warnings.

**Canonical source:** `src/pty_run_unix.go:1–202`, `src/pty_run_windows.go:1–137`

---

## 17. Warnings — deferred flush model

Non-fatal warnings are queued during startup via `warn(format, args...)` and
flushed to stderr after claude exits via `flushWarnings()`. This prevents
startup warnings from being overwritten by claude's TUI output.

Fatal errors (e.g., claude binary not on PATH) print directly to stderr before
fnclaude exits — they don't need deferring because there is no claude session to
scroll them off-screen.

`flushWarnings()` is called from `run()` via `defer`. Because `syscall.Exec`
skips defers, cross-cwd-resume and MCP-triggered handoff relaunches do not flush
warnings from the terminating process; the relaunched fnclaude will re-evaluate
and re-queue them if they still apply.

**Canonical source:** `src/warnings.go:1–29`

---

## 18. Undocumented behavior

### 18.1 Resolver — full lookup ladder

The resolver fires when the positional CWD is:
- not absolute
- does not start with `~`
- not the noop fallback
- not empty

It attempts two lookups **in parallel** (logically; the code is sequential but
treats them as independent):

**Path lookup:** `filepath.Join(shellCWD, input)` — if that path exists on disk,
it is the resolved path. Inputs that are already absolute and exist are also
accepted.

**Repo lookup:** parses `input` as a repo reference (see §18.2). Checks for
GitHub repo existence via `gh api repos/<owner>/<name>`. For bare names (no
explicit owner), tries the authenticated user's login then each of their org
logins in order.

**Ambiguity:** if both lookups succeed, fnclaude errors with a disambiguation
message naming both possibilities.

**No match:** if neither lookup succeeds, fnclaude errors.

**Absolute-path / tilde short-circuit:** inputs starting with `/`, `~/`, or
exactly `~` skip the repo lookup entirely.

**Clone behavior:** when a repo reference is found on GitHub but not on disk,
fnclaude clones it to the path computed from `cloneTemplate` in
`repoSettings` (see §18.7). `gh repo clone` is used; it inherits stdio so the
user sees live `git clone` output. Fails with a clear error if `cloneTemplate`
is not configured.

**`+workspace` suffix:** a `+<workspace>` suffix on the input is parsed as
a worktree name. After resolution, the workspace is propagated to the worktree
intercept layer if `-w` was not explicitly given.

**Canonical source:** `src/resolver.go:1–277`

### 18.2 Repo reference parsing (`RepoRef`)

Supported input forms (all optionally suffixed with `+<workspace>`):

| Form | Example | Parsed as |
|---|---|---|
| bare name | `arch-setup` | `{Name}` |
| `name@owner` | `arch-setup@fnrhombus` | `{Name, Owner}` — Tom's local convention |
| `owner/name` | `fnrhombus/arch-setup` | `{Owner, Name}` |
| `gh:owner/name` | `gh:fnrhombus/arch-setup` | `{Owner, Name, Host="github.com"}` |
| `https://host/owner/name[.git]` | `https://github.com/fnrhombus/fnclaude` | `{Host, Owner, Name}` |
| `git@host:owner/name[.git]` | `git@github.com:fnrhombus/fnclaude.git` | `{Host, Owner, Name}` |
| `ssh://[user@]host/owner/name[.git]` | `ssh://git@github.com/fnrhombus/fnclaude` | `{Host, Owner, Name}` |

Workspace suffix rules:
- Split at the first `+`; everything after is the workspace.
- Empty workspace after `+` is an error.

`HasResolvedOwner()` returns true when `Owner` is non-empty (no org search needed).

`EffectiveHost()` returns `Host` if set, else defaults to `"github.com"`.

**Canonical source:** `src/repo_ref.go:1–166`

### 18.3 `transferDenyFlags` — flags stripped on project transfer

These flags are stripped from `origArgs` when constructing the argv for a
`fnc_switch_project` transfer. They are destination-bound or session-state-bound
and would be wrong in the new session.

| Flag tokens stripped |
|---|
| `-A`, `--also`, `--add-dir`, `--mcp-config`, `--settings` |
| `-w`, `--worktree` |
| `-P`, `--from-pr` |
| `-r`, `--resume` |
| `-c`, `--continue` |
| `-F`, `--fork-session` |
| `-n`, `--name` |

Flags in `transferDenyBareOK` (`-w`/`--worktree`, `-r`/`--resume`,
`-c`/`--continue`, `-F`/`--fork-session`, `-P`/`--from-pr`) are handled
gracefully in both bare and value-bearing forms: the following token is consumed
as a value only if it doesn't start with `-`.

`fnc_restart` applies NO denylist — all startup flags are preserved.

**Canonical source:** `src/preserve_args.go:88–117`

### 18.4 `preserveArgs` — flag preservation across relaunch

`preserveArgs(origArgs, deny, bareOK)` reconstructs a relaunch argv from the
original command line:

1. **Phase 1:** collect leading magic words (model alias, effort level tokens)
   from the front.
2. **Phase 2:** skip contiguous non-flag, non-magic positional path tokens
   (the CWD and optional worktree-name slot).
3. **Phase 3:** keep the flag region, stripping any flag in `deny` (and its
   value token, respecting `bareOK`).

Both the `--flag value` (space-separated) and `--flag=value` (equals-form) are
handled for the denylist.

**Canonical source:** `src/preserve_args.go:1–85`

### 18.5 Clipboard backends

`copyToClipboard(text)` writes `text` to the clipboard via the first matching
backend. Text is piped via stdin (no shell quoting concerns).

| Platform | Condition | Tool | Args |
|---|---|---|---|
| Linux | `$WAYLAND_DISPLAY` set | `wl-copy` | none |
| Linux | `$DISPLAY` set | `xclip` | `-selection clipboard` |
| Linux | `$DISPLAY` set, xclip fails | `xsel` | `--clipboard --input` |
| macOS | always | `pbcopy` | none |
| Windows | always | `clip` | none |
| headless Linux / other OS | — | none | returns `(false, error)` |

`xsel` is a fallback tried only when `xclip` exec fails (PATH miss or non-zero
exit). If both fail, the combined error is returned.

**Canonical source:** `src/clipboard.go:1–122`

### 18.6 `ensureCWD` — phantom-cwd fabrication

Before spawning `claude`, fnclaude calls `ensureCWD(launchCWD)` to ensure the
target directory exists. This handles the edge case where a session is being
resumed whose stored cwd no longer exists on disk.

Without this, Go reports ENOENT against the binary path
(`fork/exec /…/claude: no such file or directory`), which falsely blames the
claude binary.

`ensureCWD` creates the entire missing directory tree with `os.Mkdir` per level
(recording each created level), returns a cleanup function, then after the
child has started (and thus `chdir`'d), the cleanup walks back the created
levels with `os.Remove` (deepest first).

On Unix, cleanup runs immediately after `pty.Start`. On Windows, cleanup is
deferred until `cmd.Wait` returns (no PTY-decoupled spawn boundary).

**Canonical source:** `src/pty_run.go:154–237`

### 18.7 `repoSettings` — per-tier settings merge

fnclaude reads the `repoSettings` block from Claude Code's settings files,
applying a shallow merge (later entries win per field) across four tiers:

| Tier | Path | Precedence |
|---|---|---|
| User | `~/.claude/settings.json` | lowest |
| Project | `<projectRoot>/.claude/settings.json` | — |
| Local | `<projectRoot>/.claude/settings.local.json` | — |
| Managed | Platform-specific (see below) | highest |

Managed-settings path by platform:

| Platform | Path |
|---|---|
| Linux | `/etc/claude-code/managed-settings.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Windows | `%ProgramData%\ClaudeCode\managed-settings.json` |

Keys read: `cloneTemplate`, `worktreeTemplate`, `branchTemplate`, `gateEnvVar`.
Only `cloneTemplate` is acted on by fnclaude (the others are read for
completeness but not used).

`projectRoot` for settings resolution is `os.Getwd()` (the shell CWD at fnclaude
startup), not the resolved launch CWD — this is evaluated before path resolution
runs.

**Canonical source:** `src/repo_settings.go:1–120`

### 18.8 `cloneTemplate` placeholder substitution

Templates are processed by `applyTemplate`, which substitutes `{placeholder}`
tokens. Unknown placeholders are a hard error (to catch typos). Unterminated `{`
is passed through literally.

Available placeholders for `cloneTemplate`:

| Placeholder | Value |
|---|---|
| `{repo}` | Repo name |
| `{owner}` | Repo owner |
| `{host}` | Full hostname (e.g., `github.com`) |
| `{host-plain}` | Hostname up to the first `.` (e.g., `github`) |
| `{host-short}` | Alias from host-aliases LUT (see §18.9) |

Placeholders like `{repo-dir}`, `{clone-path}`, `{input}`, `{cwd}` that require
an existing repo are not available for `cloneTemplate` and produce an error.

**Canonical source:** `src/template.go:1–84`

### 18.9 Host aliases

`{host-short}` in templates resolves via a two-layer alias LUT:

| Layer | Path | Precedence |
|---|---|---|
| System | `/usr/share/fnrhombus/host-aliases.json` | lower |
| User | `~/.local/share/fnrhombus/host-aliases.json` | higher (wins on conflict) |

Both files are JSON objects mapping fully-qualified hostname → short alias:

```json
{ "github.com": "gh", "gitlab.com": "gl" }
```

Missing files, malformed JSON, non-object root, and non-string values all
degrade silently to "no aliases from this file." If a template uses `{host-short}`
and no alias is configured for the resolved host, fnclaude errors with a message
naming both file paths and a copy-pasteable JSON example.

**Canonical source:** `src/host_aliases.go:1–96`

### 18.10 `session_state.go` — live permission-mode capture

`readLivePermissionMode(launchCWD, sessionID)` reads the most recent
permission-mode record from claude's per-session JSONL log:

**JSONL path:** `~/.claude/projects/<encoded-cwd>/<sessionID>.jsonl`

CWD encoding rule: every character NOT in `[A-Za-z0-9-]` is replaced with `-`.
An absolute path like `/home/tom/src/proj` becomes `-home-tom-src-proj`.

The function scans all records; last-wins semantics are correct because the file
is append-only. Only records with `type == "permission-mode"` are considered;
other record types that incidentally contain a `permissionMode` field are ignored.
Returns `""` on file-not-found, parse error, or no permission-mode record.

Callers (`handleRestart`, `handleSwitch`) auto-inject `--permission-mode <mode>`
into the relaunch argv when:
- No explicit `permission_mode` override was provided in the MCP tool call, AND
- `--permission-mode` is not already in the preserved flags.

**Canonical source:** `src/session_state.go:1–95`

### 18.11 `auto.spawn_command` template + `autoDetectSpawnCommand`

`auto.spawn_command` (config) / `FNCLAUDE_SPAWN_COMMAND` (env) is a whitespace-
tokenized launcher template. Each token is placeholder-substituted, then the
resulting slice becomes the exec argv for the spawner process.

**Supported placeholders:**

| Placeholder | Value |
|---|---|
| `{bin}` | Absolute, symlink-resolved path to the running fnclaude binary |
| `{dest}` | Destination string (verbatim from the `destination` tool arg) |
| `{name}` | Session label (verbatim from the `name` tool arg) |
| `{summary}` | Absolute path to the written continuity-summary file |

Example: `kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}`

**Auto-detection (when `auto.spawn_command` is empty):** only `$TMUX` is
detected. If `$TMUX` is set, the template is:

```
tmux new-window -d {bin} {dest} --name {name} @{summary}
```

Earlier versions also sniffed `$KITTY_WINDOW_ID`, `$TERM_PROGRAM=WezTerm`, and
`$WT_SESSION`. These were removed because they failed silently for all non-listed
terminals with no hint about the config knob; the paste-flow `Message` now
surfaces the knob directly.

**No match → paste-flow:** when neither configured nor auto-detected, the
`fnc_spawn_session` handler returns `ActionPasteFlow` with the rendered command
and a hint to set `auto.spawn_command`.

**Environment cleanup on spawn:** `FNC_SOCKET`, `FNCLAUDE_HANDOFF`, and
`CLAUDE_CODE_SESSION_ID` are stripped from the spawned process's environment so
the new fnclaude computes its own socket path and does not inherit this session's
state.

**Canonical source:** `src/spawn.go:1–152`

### 18.12 `mcp` subcommand — internal server

`fnclaude mcp [--noop]` is an internal subcommand dispatched by claude as an MCP
server subprocess. It is not intended for direct user invocation.

The `--noop` flag selects the noop tool profile (see §15.4).

The subcommand is checked before `parseArgs` runs (line 879 of `main.go`), so
positional tokens like `mcp` are never visible to the main arg parser. To use
a literal directory named `mcp` as a CWD, prefix with `./`.

**Canonical source:** `src/main.go:879–887`

### 18.13 MCP config injection gate

The inline `--mcp-config` JSON for the self-MCP server is injected only for
interactive sessions (`-p`/`--print` sessions are excluded). This is checked via
`isInteractiveSession(a.Passthrough)` inside `buildArgv`.

**Canonical source:** `src/main.go:826–829`

### 18.14 `wantsVersion` and `wantsHelp` sentinel behavior

Both `wantsVersion` and `wantsHelp` scan `os.Args[1:]` for their respective
flags (`-v`/`--version` and `-h`/`--help`) but stop scanning at a literal `--`
token. Tokens after `--` are part of the prompt to claude and are not fnclaude
flags.

`-v`/`--version` is the only lowercase short flag fnclaude claims. `claude`'s
own `-v` is shadowed; use `claude --version` directly.

**Canonical source:** `src/main.go:467–581`
