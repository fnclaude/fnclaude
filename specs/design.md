# fnclaude — locked-in technical requirements

Behaviors where the Go reference implementation dictates the exact mechanism and the rewrite has no leeway. Every item in this document is derived directly from the Go source; the file:line references are authoritative.

The rewrite's *choice of Bun primitive* (PTY backend, signal mechanism, async model) is not constrained here — only the externally-observable behavior and protocol the rewrite must replicate.

> **MCP mechanics live in their own subdoc.** This file's sections 5–8, 12–14, 20, 25, and 29 each cover one slice of the MCP wiring; [`design.mcp.md`](design.mcp.md) is the unified, OS-level narrative — participants, lifecycle, wire format, the four tools, override semantics, handoff trigger, cleanup, failure modes. Read it before implementing any of those sections.

---

## Table of contents

1. [Argument parsing — magic positionals](#1-argument-parsing--magic-positionals)
2. [Short-flag parsing — cluster mechanics](#2-short-flag-parsing--cluster-mechanics)
3. [Name sanitization — exact regex and collapse rules](#3-name-sanitization--exact-regex-and-collapse-rules)
4. [Cross-cwd resume — detection regex and ring buffer](#4-cross-cwd-resume--detection-regex-and-ring-buffer)
5. [Env vars injected into claude's child environment](#5-env-vars-injected-into-claudes-child-environment)
6. [AF_UNIX socket protocol — wire format](#6-af_unix-socket-protocol--wire-format)
7. [MCP tools — request/response shapes](#7-mcp-tools--requestresponse-shapes)
8. [Handoff IPC mechanism](#8-handoff-ipc-mechanism)
9. [Live permission-mode capture — JSONL read](#9-live-permission-mode-capture--jsonl-read)
10. [Prompts directory resolution](#10-prompts-directory-resolution)
11. [Config precedence and env var mappings](#11-config-precedence-and-env-var-mappings)
12. [transferDenyFlags and transferDenyBareOK — verbatim](#12-transferdenyflags-and-transferdenybareok--verbatim)
13. [preserveArgs and applyOverrides mechanics](#13-preserveargs-and-applyoverrides-mechanics)
14. [handoffContentPath and handoffSocketPath patterns](#14-handoffcontentpath-and-handoffsocketpath-patterns)
15. [repoSettings — four-tier merge](#15-reposettings--four-tier-merge)
16. [Repo reference forms — parser rules](#16-repo-reference-forms--parser-rules)
17. [Cross-org bare-name resolution](#17-cross-org-bare-name-resolution)
18. [Auto-name generation — LLM call and heuristic fallback](#18-auto-name-generation--llm-call-and-heuristic-fallback)
19. [Noop session seeding](#19-noop-session-seeding)
20. [Spawn env cleanup](#20-spawn-env-cleanup)
21. [Session JSONL path encoding](#21-session-jsonl-path-encoding)
22. [cloneTemplate placeholder vocabulary](#22-clonetemplate-placeholder-vocabulary)
23. [Host alias LUT paths](#23-host-alias-lut-paths)
24. [Windows relaunch — no syscall.Exec](#24-windows-relaunch--no-syscallexec)
25. [Clipboard backends — detection and fallback](#25-clipboard-backends--detection-and-fallback)
26. [ensureCWD — phantom-directory fabrication](#26-ensurecwd--phantom-directory-fabrication)
27. [Warnings — deferred flush model](#27-warnings--deferred-flush-model)
28. [Prompt fragments — 5 files, exact selection logic](#28-prompt-fragments--5-files-exact-selection-logic)
29. [MCP config injection shape](#29-mcp-config-injection-shape)
30. [Extra-dir injection order](#30-extra-dir-injection-order)

---

## 1. Argument parsing — magic positionals

**Source:** `src/main.go:106–343`

The magic scanner uses a three-state machine (`magicState`). Effort is ONLY recognized at position 2 when position 1 was a model alias. This is enforced strictly:

```
magicState 0 → position 1:
  token ∈ modelAliases → magicModel = token; magicState = 1; continue
  otherwise            → magicState = 2 (done); token is CWD

magicState 1 → position 2 (model matched):
  token ∈ effortLevels → magicEffort = token; magicState = 2; continue
  otherwise            → magicState = 2 (done); token is CWD

magicState 2 → no more magic scanning
```

`modelAliases` (src/main.go:50–54): `opus`, `sonnet`, `haiku`

`effortLevels` (src/main.go:57–63): `low`, `medium`, `high`, `xhigh`, `max`

Note: `auto` is NOT in `effortLevels` in the Go source and `claude --effort auto` is rejected by the claude CLI. The rewrite must add `auto` as a recognized effort level and implement the "effort-only at position 1 implies opus" behavior — neither of these is in the Go source.

Subcommand tokens (`resume`, `res`, `continue`, `con`, `fork`, `fk`) are recognized at any positional slot, are order-independent with magic, and do not advance `magicState`. `fork` expands to two flags: `["--resume", "--fork-session"]`. At most one subcommand per invocation.

Magic words prepended to `passthrough` are emitted as flag pairs (`--model`, `--effort`), not bare positional tokens, and are prepended before any flags the user also provided.

---

## 2. Short-flag parsing — cluster mechanics

**Source:** `src/main.go:350–423`

Three maps govern short-flag expansion:

```go
shortNoValue = map[byte]string{
  'B': "--brief", 'C': "--chrome", 'D': "--dangerously-skip-permissions",
  'F': "--fork-session", 'I': "--ide", 'V': "--verbose",
}
shortRequired = map[byte]string{
  'G': "--agent", 'M': "--permission-mode", 'W': "--allowedTools",
}
shortOptional = map[byte]string{
  'P': "--from-pr", 'R': "--remote-control", 'T': "--tmux",
}
```

Cluster walking (`parseShortFlag`):
- Each character in the cluster body walks independently.
- A `shortRequired` flag that is NOT the last character in the cluster is an error: `"fnclaude: flag -%c cannot be in middle of collapsed group, requires a value"`.
- A `shortRequired` flag at the last position consumes the next argv token as its value. If the next token starts with `-` or there is no next token, error: `"fnclaude: -%c requires a value"`.
- A `shortOptional` flag at the last position greedily consumes the next token if it does NOT start with `-`; otherwise emits just the long flag with no value.
- `-X=val` form (equals in the token itself, only for single-char flags): handled first. Emits `--long=val` as a single token.
- Unknown short flags are passed through verbatim as `-<char>` for claude to handle.

---

## 3. Name sanitization — exact regex and collapse rules

**Source:** `src/sanitize.go:1–50`

```go
rePathSafeBad = regexp.MustCompile(`[^A-Za-z0-9._/-]+`)
reDashRun     = regexp.MustCompile(`-{2,}`)
reSlashRun    = regexp.MustCompile(`/{2,}`)
```

`sanitizeForPath(s)` pipeline:
1. Empty input → invalid.
2. Input starting with `/` → invalid (path-escape risk).
3. Replace all chars NOT in `[A-Za-z0-9._/-]` with `-` (via `rePathSafeBad`, replaces RUNS).
4. Collapse `--` runs to single `-` (via `reDashRun`).
5. Collapse `//` runs to single `/` (via `reSlashRun`).
6. `strings.TrimLeft(s, "-.")` — strips leading dashes and dots.
7. `strings.TrimRight(s, "-/")` — strips trailing dashes and slashes.
8. Empty result → invalid.
9. Result contains `..` → invalid (git ref-format; path-escape prevention).

`/` is intentionally permitted so nested git refs (`feat/foo`, `team/x/y`) pass through and produce nested worktree paths.

On invalid result: original value passed through unchanged with a deferred warning.
On changed-but-valid result: sanitized value replaces original with a deferred warning naming both old and new values.

`sanitizeNamesInPassthrough` handles: `--name <val>`, `--name=<val>`, `-n <val>`, `-n=<val>`.

---

## 4. Cross-cwd resume — detection regex and ring buffer

**Source:** `src/pty_run.go:17–99`

Ring buffer capacity: `64 * 1024` bytes (64 KB). Earlier versions used 4 KB; increased after claude 2.1.143 emitted more trailing cleanup and rotated the message out of the tail.

Detection regex (compiled once at package init):
```go
crossCwdRe = regexp.MustCompile(
    `To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})`,
)
```

The "This conversation is from a different directory." sentence is NOT anchored on because claude's TUI emits cursor-right escape sequences (`\x1b[1C`) between words instead of literal spaces. The "To resume, run:" and `cd <path> && claude --resume <uuid>` lines are rendered as plain ASCII and survive the TUI.

When multiple matches appear in the tail (unexpected but defensive), the LAST match wins.

`reconstructArgv` shape for cross-cwd relaunch:
```
[leading-magic-words...] <dest> --resume <uuid> [rest-of-original-flags...]
```
No denylist applied — all original flags preserved for cross-cwd resume. This differs from transfer (which strips `transferDenyFlags`).

---

## 5. Env vars injected into claude's child environment

**Source:** `src/handoff.go:86–91`, `src/spawn.go:132–151`

On every interactive session:

| Var | Value | Purpose |
|---|---|---|
| `FNCLAUDE_HANDOFF` | resolved `auto.handoff` value (`"never"`, `"ask"`, or integer string) | Tells claude's noop prompt what UX to use for project-switch proposals |
| `FNC_SOCKET` | absolute path to the AF_UNIX socket | MCP subprocess dials this for every tool invocation |

These are appended AFTER `os.Environ() + envFromConfig(cfg)`, so they win against any same-name entries from user config.

Additional vars stripped from the spawned sibling's env (`cleanEnvForSpawn`):
- `FNC_SOCKET` — sibling must compute its own socket path
- `FNCLAUDE_HANDOFF` — scoped to the spawning session
- `CLAUDE_CODE_SESSION_ID` — scoped to the spawning session

`FNC_PID` and `FNC_HANDOFF_PATH` are NOT injected by the Go source. Those are not real env vars in this implementation.

---

## 6. AF_UNIX socket protocol — wire format

**Source:** `src/mcp_protocol.go:1–204`

The MCP subprocess dials the parent's AF_UNIX socket. Each connection carries exactly one Request and receives exactly one Response, then closes. No persistent state; each call is independent.

Wire format: newline-delimited JSON (`\n`-terminated). `WriteRequest` and `WriteResponse` append a literal `\n`. `ReadRequest` and `ReadResponse` use `bufio.Reader.ReadBytes('\n')`.

Connection mechanics (from `callSocket`, `src/mcp.go:444–464`):
- Dial timeout: 10 seconds (`net.DialTimeout("unix", path, 10*time.Second)`)
- Deadline after dial: 10 seconds (`conn.SetDeadline(time.Now().Add(10 * time.Second))`)
- One request written, one response read, connection closed.

The listener accepts one request per connection (`handleConn`), dispatches, writes one response, closes.

**Request JSON fields:**

| Field | Go type | JSON key |
|---|---|---|
| `Op` | `string` | `"op"` — `"restart"`, `"switch"`, `"spawn"`, `"copy_to_clipboard"` |
| `SessionID` | `string` | `"session_id"` |
| `Destination` | `string` | `"destination"` |
| `Name` | `string` | `"name"` |
| `Summary` | `string` | `"summary"` |
| `Confirmed` | `bool` | `"confirmed"` — deprecated, tolerated, ignored by server |
| `Text` | `string` | `"text"` |
| `Model` | `string` | `"model"` |
| `Effort` | `string` | `"effort"` |
| `PermissionMode` | `string` | `"permission_mode"` |
| `AllowedTools` | `string` | `"allowed_tools"` |
| `Agent` | `string` | `"agent"` |
| `Brief` | `*bool` | `"brief"` |
| `Chrome` | `*bool` | `"chrome"` |
| `IDE` | `*bool` | `"ide"` |
| `Verbose` | `*bool` | `"verbose"` |

**Response JSON fields:**

| Field | Go type | JSON key |
|---|---|---|
| `Action` | `string` | `"action"` — `"done"`, `"paste_flow"`, `"error"` |
| `Message` | `string` | `"message"` |
| `Command` | `string` | `"command"` |
| `ClipboardOK` | `bool` | `"clipboard_ok"` |
| `CountdownSeconds` | `int` | `"countdown_seconds"` — deprecated, not emitted |
| `Error` | `string` | `"error"` |

Action values `"needs_confirmation"` and `"auto_countdown"` are defined in the Go constants but are no longer emitted by the server. They existed in a prior protocol-side confirmation dance that was replaced by prompt-side UX. The constants remain for backward compatibility with older test fixtures.

---

## 7. MCP tools — request/response shapes

**Source:** `src/mcp.go:537–622`

Tool availability by session mode:

| Tool | Non-noop | Noop (`--noop`) |
|---|---|---|
| `fnc_restart` | yes | no |
| `fnc_switch_project` | yes | yes |
| `fnc_spawn_session` | yes | yes |
| `fnc_copy_to_clipboard` | no | yes |

**`fnc_restart`** — required: `session_id` (UUID). Optional overrides: `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief` (bool), `chrome` (bool), `ide` (bool), `verbose` (bool).

UUID validation: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` (compiled in `src/mcp.go:18`). Invalid UUID → tool-level error response, not JSON-RPC error.

The model reads `$CLAUDE_CODE_SESSION_ID` via Bash because Claude Code does not propagate that env var to MCP stdio subprocess environments (upstream issue #24371, closed "not planned").

**`fnc_switch_project`** — required: `destination`, `name`, `summary`. Optional: same override fields as restart plus `session_id` (for live permission-mode capture) and `confirmed` (deprecated, tolerated).

**`fnc_spawn_session`** — required: `destination`, `name`, `summary`. Optional: same override fields as restart plus `confirmed` (deprecated, tolerated). Does NOT have `session_id` — spawn is a fresh start; it does not preserve any flags from the current session.

**`fnc_copy_to_clipboard`** — required: `text`. Always returns `ActionDone` with `clipboard_ok` set.

MCP transport is JSON-RPC 2.0 over stdio. Protocol version reported at `initialize`: `"2024-11-05"`. Server info: `{name: "fnclaude", version: <build-version>}`. Notifications (no `id` field) are silently accepted; `notifications/initialized` sets `initialized = true`.

Tool results are returned as a single text content item containing JSON-marshalled `Response`. This allows the prompt to interpret `Action`, `Message`, `Command`, `ClipboardOK` fields.

---

## 8. Handoff IPC mechanism

**Source:** `src/pty_run_unix.go`, `src/pty_run_windows.go`, `src/socket_listener.go`

The Go implementation uses AF_UNIX socket + `Triggered` channel, not SIGUSR1. The prior README reference to SIGUSR1 was a description of an earlier implementation; the current code does not use signals for handoff.

**Kill sequence on handoff trigger:**
- Unix: `SIGTERM` → 200ms sleep → `SIGKILL` (goroutine spawned on `Triggered` close)
- Windows: `cmd.Process.Kill()` → maps to `TerminateProcess`

The contract the rewrite must implement:
1. Parent starts an AF_UNIX listener before spawning claude.
2. Parent injects `FNC_SOCKET=<path>` and `FNCLAUDE_HANDOFF=<mode>` into claude's env.
3. The self-MCP subprocess (spawned by claude) dials the socket for each tool call.
4. When `OpRestart` or `OpSwitch` (non-never mode) arrives and is dispatched, the parent stashes a relaunch argv, fires a signal/event, and kills claude.
5. After claude exits, parent re-executes itself with the stashed argv.

On Unix, re-exec is `syscall.Exec` (process image replacement, defers skipped). On Windows, it is a new child process that the parent waits on, then exits with the child's exit code.

---

## 9. Live permission-mode capture — JSONL read

**Source:** `src/session_state.go:44–95`

**JSONL path formula:**
```
~/.claude/projects/<encoded-cwd>/<sessionID>.jsonl
```

CWD encoding (`encodeCWDForProjects`): every character NOT in `[A-Za-z0-9-]` is replaced with `-`. Applied character-by-character. `/home/tom/src/fnclaude@fnrhombus` → `-home-tom-src-fnclaude-fnrhombus`.

Scanner buffer: `bufio.NewScanner` with buffer `make([]byte, 1<<20)` and max token size `16<<20` (16 MB). Needed because claude can serialize large tool-result bodies in JSONL.

Record type filter: only records with `"type": "permission-mode"` are considered. Other record types that incidentally contain a `permissionMode` field (user/assistant/system messages) are ignored — they are cached snapshots, not authoritative.

Scan discipline: forward linear, last-wins (file is append-only; last occurrence is most recent).

Values observed in the wild: `"acceptEdits"`, `"auto"`, `"bypassPermissions"`, `"default"`, `"dontAsk"`, `"plan"`.

Returns `""` on: file not found, open error, no `permission-mode` records.

Callers (`handleRestart`, `handleSwitch`) inject `--permission-mode <live>` into the relaunch argv when:
- No explicit `permission_mode` override in the MCP tool call, AND
- `--permission-mode` is not already in the preserved flags.

---

## 10. Prompts directory resolution

**Source:** `src/prompts.go:43–101`

Search order:
1. `$FNC_PROMPTS_DIR` (env override) — if set, must exist or fnclaude errors with the path.
2. `<exe-dir>/prompts/` — dev workflow; `mise run build` copies into here.
3. `<exe-dir>/../share/fnclaude/prompts/` — FHS/AUR install layout.

Symlinks in the exe path are resolved via `filepath.EvalSymlinks(os.Executable())` before searching. On resolution failure, the unresolved path is used as fallback.

If the prompts directory is missing entirely (typical for `go install` which does not ship data files), a deferred warning is queued and an empty `PromptSet` is returned — no fragments are injected, but the session still launches.

The five fragment files: `agent-pitfall.md`, `project-switch.md`, `spawn.md`, `restart.md`, `noop-router.md`.

Fragment selection (`selectFragments`):

| Fragment | Condition |
|---|---|
| `agent-pitfall.md` | Every interactive (non `-p`/`--print`) session |
| `spawn.md` | Every interactive session |
| `noop-router.md` | Noop fallback session ONLY |
| `project-switch.md` | Non-noop interactive session only |
| `restart.md` | Non-noop interactive session only |

`-p`/`--print` sessions receive zero fragments.

Multiple fragments are joined with `"\n\n"` and passed as a single `--append-system-prompt` argument. If the passthrough args already contain `--append-system-prompt`, the joined fragments are appended to the existing value (not a new flag).

---

## 11. Config precedence and env var mappings

**Source:** `src/config.go:1–258`

Precedence (high → low): CLI flag > env var > config file > built-in default

Config file path: `$XDG_CONFIG_HOME/fnclaude/config.toml` (fallback: `~/.config/fnclaude/config.toml`)

| Config key (TOML) | Env var | Default |
|---|---|---|
| `name.model` | `FNCLAUDE_NAME_MODEL` | `"claude-haiku-4-5"` |
| `name.timeout` | `FNCLAUDE_NAME_TIMEOUT` | `3s` (API path) / `15s` (CLI path) |
| `name.quiet_missing_api_key` | `FNCLAUDE_QUIET_MISSING_API_KEY` | `false` (deprecated no-op) |
| `auto.tmux` | `FNCLAUDE_TMUX` | `"never"` |
| `auto.handoff` | `FNCLAUDE_HANDOFF` | `"ask"` |
| `auto.spawn_command` | `FNCLAUDE_SPAWN_COMMAND` | `""` |

`ANTHROPIC_API_KEY` (standard env var) is read by the auto-name machinery.

Normalization (`normalizeTmuxMode`): values other than `"never"` or `"worktree"` (including the deprecated `"always"`) normalize to `"never"` with a deferred warning.

Normalization (`normalizeHandoffMode`): values other than `"never"`, `"ask"`, or a non-negative integer string normalize to `"ask"` with a deferred warning.

`FNCLAUDE_QUIET_MISSING_API_KEY` is parsed as: `"1"`, `"true"`, `"yes"` (case-insensitive) → `true`; everything else → `false`.

`[exec.env]` entries are injected into claude's env after `os.Environ()`. Go's last-wins rule means configured keys override same-name inherited keys. Entries are sorted by key before injection for deterministic ordering.

---

## 12. transferDenyFlags and transferDenyBareOK — verbatim

**Source:** `src/preserve_args.go:95–117`

These are the exact flag sets stripped from `origArgs` on `OpSwitch` (project transfer):

```go
transferDenyFlags = map[string]bool{
    "-A": true, "--also": true,
    "--add-dir":    true,
    "--mcp-config": true,
    "--settings":   true,
    "-w": true, "--worktree": true,
    "-P": true, "--from-pr": true,
    "-r": true, "--resume": true,
    "-c": true, "--continue": true,
    "-F": true, "--fork-session": true,
    "-n": true, "--name": true,
}

transferDenyBareOK = map[string]bool{
    "-w": true, "--worktree": true,
    "-r": true, "--resume": true,
    "-c": true, "--continue": true,
    "-F": true, "--fork-session": true,
    "-P": true, "--from-pr": true,
}
```

Flags in `transferDenyBareOK` appear in both bare and value-bearing forms. When stripping: the following token is consumed as the flag's value ONLY if it does not start with `-`. If the next token starts with `-`, it is treated as a new flag and left in place (bare form only was consumed).

`OpRestart` applies NO denylist — all startup flags are preserved.

`OpSpawn` (sibling session): spawn does NOT preserve any startup flags — it calls `applyOverrides(nil, req)` on an empty slice. Only the override fields from the tool call arguments appear in the spawned argv.

---

## 13. preserveArgs and applyOverrides mechanics

**Source:** `src/preserve_args.go:18–85`, `src/preserve_args.go:119–171`

`preserveArgs(origArgs, deny, bareOK)` three-phase algorithm:

1. **Phase 1:** collect contiguous leading magic words (tokens in `modelAliases` or `effortLevels`) into `out`.
2. **Phase 2:** skip contiguous non-flag, non-magic positional tokens (the CWD and optional worktree-name slot).
3. **Phase 3:** walk the flag region. For each token:
   - `--flag=value` form: match against deny by the flag-prefix-before-`=`. If denied, skip the whole token.
   - Bare token: if in deny, skip it; also consume the following value token unless `bareOK` allows the bare form AND the next token looks like a flag.

`applyOverrides(preserved, req)` three-state semantics:

- String override non-empty: strip any existing form of the corresponding flag (including bare-magic-positional for `--model`/`--effort`) and append `"--flag", "value"` at the end.
- `*bool` nil: preserve existing occurrences.
- `*bool` true: strip existing + append `"--flag"`.
- `*bool` false: strip existing, do NOT append.

For `--model` and `--effort`, stripping recognizes BOTH the bare magic-positional form (e.g., `"opus"`, `"max"`) AND the flag form (`--model X`, `--model=X`). Overrides always emit flag form; never bare-magic-positional form.

`splitLeadingMagic(args)` divides at the first non-magic token. Magic = token ∈ `modelAliases` ∪ `effortLevels`.

---

## 14. handoffContentPath and handoffSocketPath patterns

**Source:** `src/handoff.go:55–109`

`handoffBaseDir()` preference:
1. `$XDG_RUNTIME_DIR` (Linux/systemd tmpfs, mode 700, auto-cleared on logout)
2. `os.TempDir()` — honors `$TMPDIR` then `/tmp` on Unix; `%TMP%`/`%TEMP%`/`%USERPROFILE%` on Windows

Socket path:
```
<handoffBaseDir>/fnclaude-mcp-<pid>.sock
```
PID prevents collisions between concurrent fnclaude sessions. AF_UNIX path limit is ~108 bytes on Linux/Darwin and Windows (Win10 17063+); this formula stays well under that.

Content path (summary file for handoff):
```
<handoffBaseDir>/fnclaude-handoff-content-<16-hex-chars>.md
```
16 hex chars = 8 bytes from `crypto/rand.Read`. On `crypto/rand` failure (extremely unlikely), falls back to:
```
<handoffBaseDir>/fnclaude-handoff-content-<pid>-<nanosecond-timestamp>.md
```

Files are written with mode `0o600`. The `@<summaryPath>` reference in the relaunch argv triggers claude's automatic file-read.

The listener best-effort removes any stale socket file at startup (`os.Remove(spec.SocketPath)` before `net.Listen`).
On `Close()`, removes the socket file after the accept loop exits.

---

## 15. repoSettings — four-tier merge

**Source:** `src/repo_settings.go:51–89`

Four tiers, shallow-merged per field (later wins):

| Tier | Path |
|---|---|
| User | `~/.claude/settings.json` |
| Project | `<projectRoot>/.claude/settings.json` |
| Local | `<projectRoot>/.claude/settings.local.json` |
| Managed | platform-specific (see below) |

Managed settings paths:

| Platform | Path |
|---|---|
| Linux | `/etc/claude-code/managed-settings.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Windows | `%ProgramData%\ClaudeCode\managed-settings.json` |

Fields in `repoSettings` (JSON schema key names):
- `cloneTemplate` — used by fnclaude for clone destination
- `worktreeTemplate` — used by the claude-code-worktree-paths plugin (fnclaude reads it but does not act on it)
- `branchTemplate` — plugin-only
- `gateEnvVar` — plugin-only

`projectRoot` for settings resolution is `os.Getwd()` (the shell CWD at fnclaude startup), not the resolved launch CWD.

The merge is shallow (per-field, not per-key within a field). A higher-tier non-empty value for any field replaces the entire lower-tier value for that field.

---

## 16. Repo reference forms — parser rules

**Source:** `src/repo_ref.go:1–166`

Two compiled regexes handle URL forms:

```go
// https:// or http:// or ssh://[user@]
urlRe = regexp.MustCompile(
    `^(?:(?:https?|ssh)://(?:[^@/]+@)?)([^:/]+)/([^/]+)/([^/]+?)(?:\.git)?/?$`,
)
// git@host:owner/name[.git]
scpRe = regexp.MustCompile(
    `^git@([^:]+):([^/]+)/([^/]+?)(?:\.git)?/?$`,
)
```

Parse ladder (evaluated in order):
1. `urlRe` match → `{Host, Owner, Name}`. Matches `https://`, `http://`, `ssh://[user@]host/owner/name[.git]`.
2. `scpRe` match → `{Host, Owner, Name}`. Matches `git@host:owner/name[.git]`.
3. `gh:` prefix → `{Host="github.com", Owner, Name}`.
4. Single `/`, no scheme → `{Owner, Name}`. Multiple slashes → error.
5. Single `@`, no scheme → `{Name, Owner}` (Tom's local-convention form; `name@owner` not `owner@name`).
6. No special chars → `{Name}` (bare name; resolver searches orgs).

`+workspace` suffix: split at the FIRST `+`. The workspace is everything after it. Empty workspace after `+` is an error. Workspace is parsed before the URL/form dispatch.

Inputs starting with `/` or `~/` are NOT routed to `parseRepoRef` — the caller short-circuits on those as filesystem paths.

---

## 17. Cross-org bare-name resolution

**Source:** `src/resolver.go:183–213`

`userOwnerCandidates()` calls the gh CLI via two sequential API calls:

1. `gh api user --jq .login` → authenticated user's login
2. `gh api /user/orgs --jq '.[].login'` → org logins, one per line

Candidates are tried in that order: user login first, then orgs in the order the API returns them. The first owner for whom `gh api repos/<owner>/<name>` returns HTTP 200 wins; `ref.Owner` is set to that owner.

On gh error (no auth, no network): `userOwnerCandidates()` returns nil. The resolver treats this as "no candidates" and surfaces a clean resolution error.

For references that already have an explicit owner (`name@owner`, `owner/name`, `gh:owner/name`, URL forms): only that owner is tried; `userOwnerCandidates()` is not called.

The two lookups (path and repo) run sequentially in the Go code but are logically independent. If both succeed, the resolver errors with a disambiguation message. If neither succeeds and `repoErr` is non-nil (parse error), the parse error is included in the resolution failure message.

---

## 18. Auto-name generation — LLM call and heuristic fallback

**Source:** `src/autoname.go:1–253`

`shouldAutoName` conditions (all must be true):
- `--` appears in passthrough with at least one non-empty token after it
- `--name`, `-n`, `--name=*`, `-n=*` NOT in passthrough
- `-p`, `--print` NOT in passthrough
- `-r`, `--resume`, `-r=*`, `--resume=*` NOT in passthrough
- `-c`, `--continue` NOT in passthrough
- `--from-pr`, `--from-pr=*`, `-P`, `-P=*` NOT in passthrough

Client selection:

| Condition | Client | Timeout |
|---|---|---|
| `ANTHROPIC_API_KEY` set | Anthropic SDK (`claude-haiku-4-5` default) | `name.timeout` (default 3s) |
| `ANTHROPIC_API_KEY` unset | `claude -p --model <model> <combined-prompt>` | `name.timeout` if >0, else 15s |

System prompt: `"Generate a 1-3 word lowercase hyphen-separated label for this user's request. Output ONLY the label — no punctuation, no quotes, no explanation, no leading 'Label:'. Examples: 'fix-login-bug', 'add-dark-mode', 'refactor-auth'."`

SDK call: `client.Messages.New` with `MaxTokens: 30`.

CLI path: `claude -p --model <model> <nameSystemPrompt + "\n\nUser request: " + prompt>` via `exec.CommandContext`.

LLM output sanitization (`sanitizeName`):
1. `strings.TrimSpace`
2. `strings.ToLower`
3. Replace whitespace runs with `-` (`reWhitespace = \s+`)
4. Strip chars not in `[a-z0-9-]` (`reNonSlug = [^a-z0-9-]+`)
5. Collapse `--` runs (`reMultiDash = -{2,}`)
6. `strings.Trim(s, "-")`
7. `strings.SplitN(s, "-", 4)` → take first 3 segments → rejoin with `-`
8. `strings.Trim(s, "-")` again
9. Empty result → fall through to heuristic

Heuristic fallback (`heuristicName`):
1. Lowercase the prompt
2. `strings.Fields` split
3. Drop tokens in `stopWords` set: `{a, an, the, is, are, was, were, do, does, did, of, for, to, in, on, at, with, this, that, please, can, could, would, should}`
4. Strip non-alphanumeric chars from each remaining word
5. Take first 3 non-empty results
6. Join with `-`
7. If nothing remains → `"session"`

---

## 19. Noop session seeding

**Source:** `src/noop.go:1–58`

`seedNoop(noopDir)`:
1. `os.MkdirAll(noopDir, 0o755)` — creates dir if missing
2. Reads `noopDir/handoff.template.md` from disk
3. Computes SHA-256 of both the on-disk content and the embedded template
4. Writes the embedded template iff: on-disk file is missing OR SHA-256 differs

Only `handoff.template.md` is seeded. `CLAUDE.md` and all other files in the noop directory are user-owned and are never touched by fnclaude.

The `handoff.template.md` template is embedded via `//go:embed noop_templates/handoff.template.md`. Its content is a Markdown file with `<!-- BURN AFTER READING -->` framing and placeholder sections for the receiving session. See `src/noop_templates/handoff.template.md` for the canonical content.

Noop dir path: `$XDG_CONFIG_HOME/fnclaude/noop` (fallback: `~/.config/fnclaude/noop`).

---

## 20. Spawn env cleanup

**Source:** `src/spawn.go:121–151`

`cleanEnvForSpawn` removes these keys from the environment passed to the spawn launcher:

- `FNC_SOCKET` — must not inherit the spawning session's socket path
- `FNCLAUDE_HANDOFF` — scoped to the spawning session
- `CLAUDE_CODE_SESSION_ID` — scoped to the spawning session

All other env vars pass through (PATH, XDG vars, `[exec.env]` contributions).

Spawn launcher argv construction (`buildSpawnArgv`): template is whitespace-tokenized with `strings.Fields`, then each token has `{bin}`, `{dest}`, `{name}`, `{summary}` substituted via `strings.ReplaceAll`. No shell involved — each token becomes one argv entry directly, preserving paths with spaces as single tokens.

After the template-expanded argv, `extraArgs` (the override flag tokens from `applyOverrides(nil, req)`) are appended.

The spawned process is started with `cmd.Start()` then `cmd.Process.Release()` (no `Wait`). The launcher (tmux, or whatever the user configured) typically returns in milliseconds after dispatching the new window; its exit code is not needed.

Auto-detection: only `$TMUX` is checked. If set, template is `"tmux new-window -d {bin} {dest} --name {name} @{summary}"`. No other terminals are auto-detected.

---

## 21. Session JSONL path encoding

**Source:** `src/session_state.go:18–43`

`sessionJSONLPath(launchCWD, sessionID)`:
```
~/.claude/projects/<encodeCWDForProjects(launchCWD)>/<sessionID>.jsonl
```

`encodeCWDForProjects(cwd)`: character-by-character scan. For each rune `r`:
- `r ∈ [a-zA-Z0-9-]` → emit `r`
- otherwise → emit `-`

Example: `/home/tom/src/fnclaude@fnrhombus` → `-home-tom-src-fnclaude-fnrhombus`

Home directory: `os.UserHomeDir()`, fallback `os.Getenv("HOME")`.

---

## 22. cloneTemplate placeholder vocabulary

**Source:** `src/template.go:64–84`

Available placeholders for `cloneTemplate` expansion:

| Placeholder | Value |
|---|---|
| `{repo}` | Repository name |
| `{owner}` | Repository owner |
| `{host}` | Full hostname (e.g., `"github.com"`) |
| `{host-plain}` | Hostname up to first `.` (e.g., `"github"`) |
| `{host-short}` | Alias from host-aliases LUT (see §23) |

Placeholders `{repo-dir}`, `{clone-path}`, `{input}`, `{cwd}` are NOT available for `cloneTemplate` (they require an already-existing repo) and produce a hard error: `"unknown placeholder {%s} in template %q"`.

Unterminated `{` (no matching `}`) is passed through literally — not an error.

Unknown placeholders produce: `"unknown placeholder {%s} in template %q"`.

---

## 23. Host alias LUT paths

**Source:** `src/host_aliases.go:25–95`

Two-layer alias LUT:

| Layer | Path | Precedence |
|---|---|---|
| System | `/usr/share/fnrhombus/host-aliases.json` | lower |
| User | `~/.local/share/fnrhombus/host-aliases.json` | higher (wins on conflict) |

Both files are JSON objects: `{ "github.com": "gh", "gitlab.com": "gl" }`.

Merge: both files loaded, user-level keys overwrite system-level keys. Missing file, malformed JSON, non-object root, and non-string values all degrade silently to empty contributions.

If a template uses `{host-short}` and no alias is configured for the resolved host, fnclaude errors naming both file paths and a copy-pasteable JSON example.

The same LUT is read by the claude-code-worktree-paths plugin (`src/host-aliases.ts`). The two implementations mirror each other exactly for consistent behavior across both consumers.

---

## 24. Windows relaunch — no syscall.Exec

**Source:** `src/pty_run_windows.go:107–136`

Windows has no `syscall.Exec`. `silentRelaunchHandoff` on Windows:
1. `os.Executable()` to get self path
2. `exec.Command(self, argv...)` with inherited stdio
3. `cmd.Run()` — blocks until the new fnclaude exits
4. Exit with the child's exit code

`silentRelaunch` (cross-cwd resume) on Windows: `runWithPTY` returns nil tail, so `detectCrossCwd` never matches, and `silentRelaunch` is never called. The stub emits: `"fnclaude: cross-cwd-resume relaunch is not supported on Windows"`. This is the README divergence Tom identified — Windows IS a first-class platform for the AF_UNIX handoff mechanism (fully implemented in `pty_run_windows.go`), but cross-cwd resume (the ring-buffer scan path) is not yet implemented for Windows because Windows has no PTY.

The rewrite requirement: Windows must get full cross-cwd resume parity. Whatever Bun primitive enables PTY output capture on Windows is the implementation choice; the observable behavior (ring-buffer scan, regex match, silent relaunch into the new cwd) is the requirement.

AF_UNIX on Windows: Go's `net.Listen("unix", path)` works on Windows 10 build 17063+ via the OS's AF_UNIX support. The same `SocketListener` implementation runs unchanged on all three platforms — no build constraints on `socket_listener.go`.

---

## 25. Clipboard backends — detection and fallback

**Source:** `src/clipboard.go:42–122`

`pickClipboardTool(goos, env)` — pure function of GOOS and env vars:

| Platform | Condition | Tool | Args |
|---|---|---|---|
| `linux` | `$WAYLAND_DISPLAY` set | `wl-copy` | none |
| `linux` | `$DISPLAY` set | `xclip` | `"-selection", "clipboard"` |
| `linux` | neither set | none | returns false |
| `darwin` | always | `pbcopy` | none |
| `windows` | always | `clip` | none |
| other | always | none | returns false |

X11 fallback: if `xclip` exec fails, `xselFallback` tries `xsel --clipboard --input`. If both fail, combined error is returned.

Text is written via stdin (`StdinPipe`) — no per-tool length or quoting concerns.

`fnc_copy_to_clipboard` always returns `ActionDone` (not `ActionError`) even on clipboard failure; the response carries `clipboard_ok: false` so claude can inform the user.

---

## 26. ensureCWD — phantom-directory fabrication

**Source:** `src/pty_run.go:154–237`

Motivation: when resuming a session whose stored cwd no longer exists, Go reports ENOENT against the binary path (`fork/exec /…/claude: no such file or directory`), which falsely blames the claude binary.

Algorithm:
1. If dir exists and is a directory → return noop cleanup, nil.
2. If dir exists but is not a directory → error.
3. Walk up the tree recording each missing level (shallowest first).
4. `os.Mkdir` each missing level in order, recording each created level.
5. Return a cleanup function that calls `os.Remove` on each created level (deepest first).

Cleanup timing:
- Unix: called immediately after `pty.Start` returns (kernel holds cwd by inode reference after `chdir`).
- Windows: deferred until `cmd.Wait` returns (no PTY spawn boundary).

If cleanup encounters a directory that's unexpectedly non-empty, returns an error (treated as a bug — no writes should have happened in an auto-created phantom dir before cleanup).

---

## 27. Warnings — deferred flush model

**Source:** `src/warnings.go:1–29`

Global `deferredWarnings []string` accumulates non-fatal warnings during startup. `flushWarnings()` prints them all to stderr after claude exits.

`flushWarnings()` is called via `defer` in `run()`. Because `syscall.Exec` skips defers, cross-cwd-resume (`silentRelaunch`) and MCP-triggered handoff (`silentRelaunchHandoff`) on Unix do NOT flush warnings from the terminating process. The relaunched fnclaude re-evaluates and re-queues any still-applicable warnings.

On Windows (no `syscall.Exec`, process spawn instead), the deferred flush runs normally when the parent exits. The child inherits stdout/stderr, so warnings from the child are visible.

---

## 28. Prompt fragments — 5 files, exact selection logic

**Source:** `src/prompts.go:152–188`

The five canonical prompt fragments are:

1. `agent-pitfall.md` — warns against naming the main repo's absolute path in an agent spawn prompt when using worktree isolation, as the agent will cd there and silently bypass its isolated worktree.
2. `project-switch.md` — documents `fnc_switch_project` trigger conditions, the continuity summary format, destination resolution, and `Action` handling.
3. `spawn.md` — documents `fnc_spawn_session` trigger conditions, the sibling-scoped summary format, and `Action` handling including the "current session continues" contract.
4. `restart.md` — lists unambiguous restart trigger phrases that override the WHEN-IN-DOUBT rule, and the `fnc_restart` call mechanics.
5. `noop-router.md` — the noop session's full decision tree, bucket taxonomy, permitted exceptions (user-prefs, one-off system changes), escalation rules, and redirect flow.

These fragments are the canonical UX contract between fnclaude and the claude model. The rewrite must ship them verbatim alongside the binary and inject them with the same selection logic.

`isInteractiveSession(passthrough)`: returns false if `-p` or `--print` appears anywhere in passthrough.

---

## 29. MCP config injection shape

**Source:** `src/main.go:745–790`, `src/main.go:826–829`

Injected as `--mcp-config <inline-JSON>` (a literal JSON string argument, not a file path).

```json
{"mcpServers":{"fnclaude":{"command":"/abs/path/to/fnclaude","args":["mcp"]}}}
```

For noop sessions: `"args": ["mcp", "--noop"]`.

The exe path is resolved via `filepath.EvalSymlinks(os.Executable())`. On symlink resolution failure, unresolved path is used.

Gate: injected only for interactive sessions (`isInteractiveSession(a.Passthrough)`). `-p`/`--print` sessions do not receive the MCP config injection.

---

## 30. Extra-dir injection order

**Source:** `src/main.go:797–825`

For each dir in `ExtraDirs` (from `-A`/`--also`), the following are appended to the claude argv in this exact order:

1. `--add-dir <abs-dir>` — always
2. `--mcp-config <dir>/.mcp.json` — only if the file exists at launch time
3. `--settings <dir>/.claude/settings.json` — only if the file exists AND `--setting-sources` is NOT already in passthrough

Relative extra-dir paths are resolved against the shell CWD (not the resolved launch CWD) via `filepath.Join(shellCWD, d)`.

The `--setting-sources` suppression check scans passthrough for the exact token `"--setting-sources"` or any token with prefix `"--setting-sources="`. When found, ALL `--settings` injections across ALL extra dirs are suppressed.
