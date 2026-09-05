# fnclaude — Functional Requirements Document

## 1. Overview

fnclaude (`fnc`) is a launcher that wraps the Claude Code CLI (`claude`). You invoke `fnc` instead of `claude` and it adds features on top: magic shorthand words for common flags, automatic directory/repository resolution, worktree navigation, session name generation, context-budget notices, and in-session tools for restarting or switching projects.

Supported platforms: Linux and macOS. Windows has a partial fallback but is untested and likely broken.

---

## 2. Command Syntax

```
fnc [MODEL] [EFFORT] [SUBCOMMAND] [CWD [WORKTREE]] [FLAGS...] [-- PROMPT]
```

All five categories of leading tokens are optional and position-independent (among magic words), as described in the sections below.

### 2.1 Help and Version

`fnc -h` or `fnc --help` prints the full help text and exits.

`fnc -v` or `fnc --version` prints `fnc <version>` and exits.

Both short-circuit before any other work. Anything after `--` is treated as a prompt body and does not trigger these.

`-v` is the only lowercase short flag fnclaude claims; it shadows claude's own `-v`. To reach claude's version, run `claude --version` directly.

### 2.2 Magic Model Words

The following words, when they appear at the leading positional positions (before any flag-shaped token), select the model:

| Word | Effect |
|---|---|
| `opus` | `--model opus` |
| `sonnet` | `--model sonnet` |
| `haiku` | `--model haiku` |
| `fable` | `--model fable` |

Example: `fnc opus ~/src/proj` launches in `~/src/proj` with `--model opus`.

### 2.3 Magic Effort Words

The following words select the effort level. They may appear immediately after a model word (or alone if no model is given):

| Word | Effect |
|---|---|
| `low` | `--effort low` |
| `medium` | `--effort medium` |
| `high` | `--effort high` |
| `xhigh` | `--effort xhigh` |
| `max` | `--effort max` |
| `auto` | `--effort auto` |
| `ultracode` | `--model opus` + special ultracode mode (see §8) |

**Bare effort word implies `opus`**: typing `fnc high` is the same as `fnc opus high`. A model and effort word together emit both flags.

`ultracode` does not emit `--effort ultracode` (that flag value is not accepted by claude). Instead it activates a special mode described in §8.

To use a directory literally named one of these magic words, prefix with `./` (e.g., `fnc ./resume`).

### 2.4 Subcommand Words

The following words can appear at any positional slot (order-independent with model/effort) and map to session-selection flags:

| Word(s) | Effect |
|---|---|
| `resume`, `res` | `--resume` (open session picker) |
| `continue`, `con` | `--continue` (resume most-recent session) |
| `fork`, `fk` | `--resume --fork-session` (open session picker, then fork) |

Only one subcommand may appear per invocation. Combining two (e.g., `resume fork`) is an error.

Example: `fnc opus resume ~/src/proj` opens the session picker for `~/src/proj` using opus.

### 2.5 Short Flags (Capital-Letter Shortcuts)

fnclaude translates capital-letter short flags into claude's long-form equivalents:

| Short | Long flag |
|---|---|
| `-B` | `--brief` |
| `-C` | `--chrome` |
| `-D` | `--dangerously-skip-permissions` |
| `-F` | `--fork-session` |
| `-G <agent>` | `--agent <agent>` |
| `-I` | `--ide` |
| `-M <mode>` | `--permission-mode <mode>` |
| `-P [value]` | `--from-pr [value]` |
| `-R [name]` | `--remote-control [name]` |
| `-T [classic]` | `--tmux [classic]` |
| `-V` | `--verbose` |
| `-W <tools>` | `--allowedTools <tools>` |

**POSIX clustering**: multiple short flags may be combined into one token, e.g. `-BVC` expands to `--brief --verbose --chrome`. Only the last flag in a cluster may take a value. Flags that require values (`-G`, `-M`, `-W`) must appear last in a cluster.

### 2.6 fnclaude-Owned Flags

These flags are consumed by fnclaude and are **not** forwarded to claude:

- `-A <dir>` / `--also <dir>`: add an extra directory context. Repeatable.
- `-w <name>` / `--worktree <name>`: worktree intercept (see §5).
- `--no-tmux`: suppress auto-tmux injection for this invocation (see §6).
- `-h` / `--help` / `-v` / `--version`: described above.

### 2.7 Passthrough Flags

All other flags (not listed above) are passed to claude verbatim. Run `claude --help` for the full reference.

### 2.8 Positional Argument Limits

After magic words, subcommands, and flags are consumed, at most **two** bare positional arguments are accepted:

1. The CWD to launch in (see §3).
2. The worktree name, equivalent to `-w <name>` (see §5).

A third positional is an error. Use `-A <dir>` for additional directories.

### 2.9 Prompt Body

`-- PROMPT` appends a prompt body. Everything after `--` is the prompt, passed to claude as an initial message.

---

## 3. Where fnclaude Launches (CWD Resolution)

### 3.1 No Argument → Noop Session

When no path is given, fnclaude launches in a placeholder "noop" directory (`$XDG_CONFIG_HOME/fnclaude/noop`, defaulting to `~/.config/fnclaude/noop`). The directory is created if missing.

On the first noop launch, fnclaude seeds a `handoff.template.md` file into that directory (copied from a template bundled with fnclaude). If the file already exists it is never overwritten — you can edit it freely.

In a noop session, fnclaude injects different system prompt fragments than a normal session (see §7).

### 3.2 Absolute Paths

An absolute path (starting with `/`) is used as-is. fnclaude does not check whether the path exists — it passes it to claude and claude will error if the directory is absent.

### 3.3 Home-Relative Paths (`~` and `~/...`)

`~` resolves to your home directory. `~/foo` resolves to `$HOME/foo`. These do not go through repository lookup.

### 3.4 Explicit Relative Paths (`.`, `..`, `./...`, `../...`)

Paths starting with `.` or `..` resolve relative to your current working directory. They are never treated as repository references. No existence check is performed.

### 3.5 Bare Names (Repository Resolution)

A word that isn't a path or magic token is treated as a repository reference. fnclaude resolves it in this order:

1. **Local clone already on disk**: if exactly one directory matching `<name>@<owner>` (or the pattern from your `cloneTemplate` setting) exists on disk, launch there directly.
2. **Multiple matching local clones**: error — "ambiguous reference — multiple local clones named `<name>`" — you must disambiguate with `<name>@<owner>`.
3. **No local clone**: look up the owner via `gh` (requires GitHub CLI authentication), then clone the repository.
4. **Ambiguous (bare name + same-named local directory)**: error — explains how to disambiguate with `./name` for the local path.

### 3.6 Qualified Repository References

These forms have the owner explicitly, skipping the GitHub owner lookup:

| Form | Example |
|---|---|
| `name@owner` | `fnclaude@fnrhombus` |
| `owner/name` | `fnrhombus/fnclaude` |
| `gh:owner/name` | `gh:fnrhombus/fnclaude` |
| Full HTTPS URL | `https://github.com/owner/name` |
| SSH URL | `git@github.com:owner/name` |

For all of these, fnclaude computes the local clone destination from your `cloneTemplate` setting:
- If the destination **exists on disk**: launch there.
- If both the destination **and** a same-path local directory exist: error (ambiguous).
- If only a local relative path exists (not the clone destination): launch in that local path.
- If neither exists: clone the repository (see §3.8).

### 3.7 Workspace Suffix (`+workspace`)

Any repository reference may have a `+<workspace>` suffix (e.g., `fnclaude+fix-auth`). This passes the workspace name through to the worktree intercept (see §5) as if you had also typed `-w fix-auth`.

### 3.8 Cloning

When a repository needs to be cloned, fnclaude:
1. Prints `fnclaude: cloning <url> → <destination>` to stderr.
2. Runs `gh repo clone` to clone the repository.
3. On success, launches in the cloned directory.
4. On failure with a "repository not found" error, offers to bootstrap a new repository instead (see §3.9).
5. On other clone failures (auth, network, etc.), prints the error and exits.

The clone destination path is computed from your `cloneTemplate` setting in repo settings (see §10).

### 3.9 Bootstrap (Repository Not Found)

When a clone fails because the repository doesn't exist on GitHub, fnclaude offers to bootstrap a new one:
- **Ask confirmation**: prompts whether to create a new local repo and optionally a private GitHub remote.
- If accepted: creates the directory, runs `git init`, and optionally `gh repo create` for a private remote, then launches there.
- If declined: prints the original clone error and exits.

### 3.10 Error Cases

| Situation | Error |
|---|---|
| Bare name + same-named local dir | Ambiguous — use `./name` or `name@owner` |
| Multiple local clones for bare name | Ambiguous — use `name@owner` |
| `owner/name` where both local path and clone destination exist | Ambiguous — explained with both paths |
| `a/b/c` (multi-slash, no local match) | Ambiguous/unparseable |
| `name+` (empty workspace suffix) | Error: empty workspace |
| `cloneTemplate` not configured + repo ref | Error naming missing config |
| `cloneTemplate` uses `{host-short}` but alias missing | Error naming the host |
| `claude` not found on PATH | Error with install hint, exit 127 |
| Parse error (too many positionals, duplicate subcommand) | Error message, exit 2 |

---

## 4. Auto-Name

When you provide a prompt body via `--` and have **not** explicitly provided `--name` or `-n`, and the session is not a print (`-p`/`--print`), resume, continue, or from-PR session, fnclaude automatically generates a session name.

The generated name is 1–3 meaningful words derived from your prompt. fnclaude calls a language model to produce it:
- If `ANTHROPIC_API_KEY` is set: calls the API directly (fast, no separate process).
- Otherwise: shells out to `claude -p` (uses your existing subscription).

Falls back silently to a simple heuristic (first 3 non-stop-words from the prompt) on timeout (15 seconds) or any error. The session name is sanitized to be path-safe.

---

## 5. Worktree Intercept

`-w <name>` (or the second positional argument after the CWD) activates the worktree intercept.

fnclaude searches the repository at the launch CWD for existing git worktrees matching `<name>` using this ladder:

1. A worktree whose **branch name** exactly matches `<name>`.
2. A worktree whose **directory name** (the basename of its path) exactly matches `<name>`.
3. A worktree whose **branch name** starts with `<name>` (longest prefix match).

**On a match**: fnclaude changes the launch CWD to that worktree's path. `--name <name>` is injected so the session label reflects the worktree.

**No match**: fnclaude passes `--worktree <name>` and `--name <name>` to claude, which creates a new worktree.

Any characters in `<name>` that are illegal in a branch name are sanitized (replaced with `-`). A deferred warning is shown after claude exits if sanitization occurred.

---

## 6. Auto-Tmux

When the config has `[auto] tmux = "worktree"` **and** `-w <name>` (or a 2nd positional) was given **and** no matching worktree was found (i.e., a new worktree is being created), fnclaude automatically injects `--tmux` into the claude arguments.

**Suppressed by**:
- `--no-tmux` flag to `fnc`.
- `--tmux` already present in the passthrough flags.
- The worktree already exists (matched during intercept).
- Config set to `never` or absent.

---

## 7. System Prompt Injection

fnclaude injects additional system prompt content into every session. The content depends on the session type:

**Standard interactive session** (not noop, not print mode):
- `agent-pitfall.md`, `spawn.md`, `budget.md`, `project-switch.md`, `restart.md`

**Noop interactive session** (no path given):
- `agent-pitfall.md`, `spawn.md`, `budget.md`, `noop-router.md`

**One-shot print session** (`-p`/`--print` without stream-json):
- `one-shot.md`

**Programmatic stream-json session** (`-p` with `--output-format stream-json` and/or `--input-format stream-json`):
- No fragments injected.

If a fragment file is missing, fnclaude skips it and shows a deferred warning after claude exits.

Fragment files are located relative to the fnclaude binary. Override with `FNC_PROMPTS_DIR`.

---

## 8. Ultracode Mode

When you type `fnc ultracode [path] [-- prompt]`:

1. fnclaude launches claude with `--model opus`.
2. The first thing sent to claude is `/effort ultracode` (as an initial message, not via `--effort`).
3. If you also provided a `-- prompt`, it is delivered as a **follow-up** turn after claude processes the effort command.

---

## 9. Configuration File

Location: `$XDG_CONFIG_HOME/fnclaude/config.toml` (default: `~/.config/fnclaude/config.toml`).

### 9.1 `[auto]` Section

```toml
[auto]
tmux = "never" | "worktree"        # when to inject --tmux (default: unset/never)
handoff = "never" | "ask" | <seconds>  # handoff behavior for session transfers
spawn_command = "..."              # command to open new terminal windows for spawn
```

**`tmux`**: controls auto-tmux injection (see §6).

**`handoff`**: controls how `fnc_switch_project` and `fnc_restart` transfer the session:
- `"never"`: paste-flow only (shows the command to run manually).
- `"ask"`: prompts before executing the transfer. (⚠ not covered by tests)
- A number (seconds): auto-executes the transfer after that delay. (⚠ not covered by tests)

**`spawn_command`**: template for opening a new terminal window when `fnc_spawn_session` is called. Placeholders: `{bin}` (fnclaude path), `{dest}` (destination), `{name}` (session name), `{summary}` (handoff summary file path with `@` prefix). If not set, falls back to `tmux new-window -d` when `$TMUX` is set, otherwise enters paste-flow.

### 9.2 `[exec.env]` Section

```toml
[exec.env]
FOO = "bar"
```

Keys and values injected into every claude child process's environment. Your shell environment is the base; these keys override shell values; `FNCLAUDE_HANDOFF` and `FNC_SOCKET` are then set on top of these.

`FNC_ARGS_JSON` is always stripped from the child environment regardless of config or shell.

### 9.3 `[context]` Section

```toml
[context]
notice_threshold = 150000    # tokens at which first notice fires (default: 150000)
notice_tiers = [...]         # custom tier labels
notice_repeat = 50000        # repeat interval after all tiers (default: 50000)
```

Controls the context-budget notices (see §13).

### 9.4 `[name]` Section (⚠ not covered by tests)

```toml
[name]
model = "claude-haiku-4-5"   # model used for auto-name generation
timeout = "3s"               # timeout for auto-name LLM call
```

---

## 10. Repo Settings (`~/.claude/settings.json`)

fnclaude reads the `repoSettings` block from claude's standard settings files. Four tiers, highest-precedence first:

1. **Managed** (`/etc/claude-code/managed-settings.json`) — org policy
2. **Local** (`<project>/.claude/settings.local.json`)
3. **Project** (`<project>/.claude/settings.json`)
4. **User** (`~/.claude/settings.json`)

Each tier contributes individual fields; missing fields from a higher tier do not blank out lower-tier values.

**Fields**:

| Field | Purpose |
|---|---|
| `cloneTemplate` | Path template for clone destinations. Placeholders: `{repo}`, `{owner}`, `{host}`, `{host-short}` (requires host alias). Example: `~/src/{repo}@{owner}` |
| `worktreeTemplate` | Path template for worktree siblings. Used to exclude them when searching for local clones. (⚠ not directly acted on) |
| `branchTemplate` | Branch naming template. (⚠ read by fnclaude, not otherwise acted on) |
| `gateEnvVar` | Environment variable name used as a gate. (⚠ read by fnclaude, not otherwise acted on) |

Malformed JSON in a tier is silently skipped; that tier is treated as absent. Non-string field values are dropped (that field treated as empty for that tier).

---

## 11. Environment Variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | When set, auto-name calls the Anthropic API directly instead of shelling out to `claude -p` |
| `XDG_CONFIG_HOME` | Base for config and noop directories (default: `~/.config`) |
| `FNC_PROMPTS_DIR` | Override the system prompt fragments directory |
| `FNC_NOOP_TEMPLATE_PATH` | Override the source path for `handoff.template.md` seeded on first noop launch |
| `FNC_LOG` | Log level override (`debug`, `info`, `warn`, `error`) |
| `FNCLAUDE_HANDOFF` | Override handoff mode for this session (`never`, `ask`, or seconds); set automatically from config |
| `FNC_ENABLE_SLASH_TOOL` | When set to `1`, enables the `fnc_run_slash_command` in-session tool (see §12.8) |

---

## 12. In-Session Tools

During a session, fnclaude provides the following tools to the claude agent, accessible via the agent's tool-use interface.

### 12.1 `fnc_restart`

Restarts the current fnclaude session in place. fnclaude terminates claude, then re-execs itself with the same arguments (plus any overrides). The current session state is preserved through claude's native session resume.

**What is preserved across restart**: all original launch flags, the working directory, the model/effort settings, and the current permission mode (read from the live session state).

**Override parameters** (all optional):
- `model`: use a different model for the restarted session
- `effort`: change the effort level
- `permission_mode`: change the permission mode
- `allowed_tools`: change which tools are allowed
- `agent`, `brief`, `chrome`, `ide`, `verbose`: toggle these settings

**Excluded flags on restart**: `--resume` is not duplicated if already present.

### 12.2 `fnc_switch_project`

Terminates the current session and re-launches fnclaude at a different project/directory.

**Parameters**:
- `destination`: where to switch to (same forms as the CLI positional: path, repo ref, etc.)
- `name`: session label for the new session (3–6 words, hyphen-separated)
- `summary`: continuity context written to a handoff file and read by the new session

**What is stripped from the forwarded argv** (not carried to the new session): `--resume`, `--continue`, `--fork-session`, `--from-pr`, `--name`, `--add-dir`, `--mcp-config`, `--session-id`. All other flags are preserved.

**The permission mode** is read live from the current session's state and carried forward automatically.

**How the transfer happens** depends on the `handoff` config:
- If auto-launch is available: kills claude, re-execs fnclaude in the new destination.
- If not available (`FNCLAUDE_HANDOFF=never`): returns `paste_flow` with the command the user should run manually. If clipboard is available, the command is copied to the clipboard.

### 12.3 `fnc_spawn_session`

Opens a sibling fnclaude in a new terminal window while the current session continues running.

**Parameters**:
- `destination`: where to open the sibling
- `name`: session label
- `summary`: continuity context for the sibling (written to a handoff file)
- Override flags (same as `fnc_restart`): `model`, `effort`, `permission_mode`, `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`

**Launcher selection** (priority order):
1. `spawn_command` from config (with `{bin}`, `{dest}`, `{name}`, `{summary}` placeholders)
2. `tmux new-window -d` when `$TMUX` is set
3. Paste-flow fallback (same as `fnc_switch_project`)

The handoff summary is written to a temporary file and passed to the sibling automatically.

### 12.4 `fnc_copy_to_clipboard`

Copies text to the system clipboard.

**Backend selection** (in order): `wl-copy` (Wayland), `xclip -selection clipboard` (X11), `pbcopy` (macOS). Uses the first one found on PATH.

### 12.5 `request_compact`

Injects `/compact` into the session as if you had typed it. Optionally includes a follow-up message after the compact completes.

**Parameters**:
- `instructions` (optional): context to include with the compact
- `follow_up` (optional): a message to send after compaction; if longer than ~500 characters, written to a temp file and referenced by path

### 12.6 `fnc_set_effort`

Injects `/effort <level>` into the session. Accepted levels: those supported by claude's `/effort` command.

### 12.7 `fnc_set_model`

Injects `/model <model>` into the session. The model name is passed verbatim.

### 12.8 `fnc_run_slash_command`

**Requires opt-in**: only available when `FNC_ENABLE_SLASH_TOOL=1` is set in the environment.

Injects an arbitrary `/command [args...]` into the session. The command name (with or without leading `/`) and optional arguments are joined and submitted.

Returns immediately — the command output is not captured or returned.

Returns an error if the command name is missing, empty, or not a string.

### 12.9 `get_usage`

Returns session token usage and cost information.

**Parameters**: `session_id` (the current session's UUID, read from the session environment).

**Returns**:
- `session.cost_usd`: accumulated cost in USD
- `session.by_model`: per-model breakdown of `input`, `output`, `cache_read`, `cache_write` token counts and `cost`
- `context.used`: current context window size in tokens (from the most recent assistant turn)
- `limits`: subscription quota data (currently always `null` — not yet observable)

---

## 13. Context-Budget Notices

When the session's context window fills up, fnclaude injects a notice into the conversation automatically. The notice text instructs the agent to call `request_compact` at the appropriate time.

**Default thresholds and tier labels**:

| Threshold | Tier |
|---|---|
| 150,000 tokens | `consider` — no rush yet; note a clean compact point for later |
| 200,000 tokens | `plan` — plan your compact point now, work toward it |
| 250,000 tokens | `now` — find a stopping point as soon as possible |
| Every 50,000 tokens after that | `urgent` — compaction is overdue; finish queued prompts only |

Each tier fires **once**. After a compact (`/compact`) is detected (context drops), the watermark resets and all tiers re-arm — you get a fresh set of notices on the next fill cycle.

**Configurable** via `[context]` in `config.toml`: `notice_threshold` (first tier), `notice_tiers` (labels), `notice_repeat` (repeat interval).

---

## 14. Cross-CWD Resume

When claude exits cleanly and its output contains the message "To resume, run: cd `<path>` && claude --resume `<uuid>`", fnclaude automatically re-launches itself at the new path with `--resume <uuid>`.

**This happens transparently**: you don't have to do anything. fnclaude detects the message and re-execs.

**Conditions for this to fire** (all must be true):
- claude exited with code 0
- A valid resume hint was found in the terminal output
- The CWD in the hint is a safe path (no shell metacharacters)
- The session UUID exists in the hint CWD (prevents infinite loops when the session file isn't there)
- No `fnc_restart`/`fnc_switch_project` was already triggered (they take priority)

**Multiple hints**: the last one in the output wins.

**Original flags preserved**: model, effort, verbosity flags, etc. The old path/directory is replaced by the hint's path. The `fork` subcommand is dropped (you're resuming an already-forked session).

---

## 15. Deferred Warnings

Some non-fatal issues are not shown immediately (they would appear before claude starts and get lost). Instead they are buffered and printed to stderr **after claude exits**, so they're visible.

Examples of deferred warnings:
- Worktree name was sanitized (bad characters replaced with `-`)
- A system prompt fragment file was missing
- The prompts directory could not be found

Terminal errors (reasons fnclaude did not launch at all) bypass the buffer and print immediately.

---

## 16. Session Logging

fnclaude writes a structured log file for every session. Logging is always-on at INFO level; set `FNC_LOG=debug` for more detail.

Log files are stored under the OS state directory (e.g., `~/.local/state/fnclaude/` on Linux) as JSON Lines (`.jsonl`), one file per launch. Log writes are best-effort and never block the session.

The log captures boot fields (argv, CWD, parent PID), the claude spawn, and any errors. Log output never appears in the terminal — the terminal belongs to claude.

---

## 17. (removed — Renderer)

The visual TUI renderer and its `FNC_RENDERER` selector were excised from the
project on 2026-09-05. Its design and behavior are preserved as history under
[`specs/renderer/`](renderer/). Section numbering is left as-is so existing
cross-references keep pointing at the right sections.

---

## 18. `mcp` Subcommand (Internal)

`fnc mcp [--noop]` starts fnclaude's internal server. This is invoked automatically during a session and is not intended for direct use.

To use a directory literally named `mcp`, prefix with `./mcp`.
