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

### 3.1 No Argument → Starting Directory

When no path is given, fnclaude launches in its starting directory: `noopDir` from the config when set, otherwise `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop` (default `~/.config/rhombus.rocks/fnclaude/noop`). The directory is created if missing.

On the first such launch, fnclaude seeds a `handoff.template.md` file into that directory (copied from a template bundled with fnclaude). If the file already exists it is never overwritten — you can edit it freely.

In a starting-directory session, fnclaude injects different system prompt fragments than a normal session (see §7).

### 3.2 Absolute Paths

An absolute path (starting with `/`) is used as-is. fnclaude does not check whether the path exists — it creates the tree if missing and launches there.

### 3.3 Home-Relative Paths (`~` and `~/...`)

`~` resolves to your home directory. `~/foo` resolves to `$HOME/foo`. These do not go through repository lookup.

### 3.4 Explicit Relative Paths (`.`, `..`, `./...`, `../...`)

Paths starting with `.` or `..` resolve relative to your current working directory. They are never treated as repository references. No existence check is performed.

### 3.5 Repository References

Anything that is not one of the path forms above, and does not name a directory sitting in your current working directory, is a repository reference. fnclaude does not resolve it itself — it runs:

```
fngit clone <reference>
```

and launches in the absolute path fngit prints. fngit does the whole job: parsing the reference, expanding your clone template, searching your source directories, resolving a bare name's owner through `gh`, and cloning if there is nothing on disk yet. A repository that is already cloned resolves without touching the network.

A bare word that names an existing directory in your current working directory launches in that directory instead. `./name` forces the path reading; `name@owner` forces the repository reading.

fngit is configured through the shared `$XDG_CONFIG_HOME/rhombus.rocks/config.json` — clone template, worktree template, additional source directories, host aliases. fnclaude does not read that file.

Reference forms fngit accepts:

| Form | Example |
|---|---|
| bare name | `fnclaude` |
| `name@owner` | `fnclaude@fnclaude` |
| `owner/name` | `fnclaude/fnclaude` |
| `gh:owner/name` | `gh:fnclaude/fnclaude` |
| Full HTTPS URL | `https://github.com/owner/name` |
| SSH URL | `git@github.com:owner/name` |

### 3.6 fngit Is Optional

fngit is not required. Without it on `PATH`, fnclaude accepts only real paths — absolute, `~`-anchored, or `./`-relative — and any repository reference produces an error naming `fnc install`, the wizard that sets fngit up.

### 3.7 Workspace Suffix (`+workspace`)

Any reference may carry a `+<workspace>` suffix (e.g., `fnclaude+fix-auth`). fnclaude strips it before calling fngit and passes the name through to the worktree intercept (see §5) as if you had also typed `-w fix-auth`. A trailing `+` with nothing after it is ignored.

### 3.8 Error Cases

| Situation | Error |
|---|---|
| Repository reference with no fngit installed | Names `fnc install` and what still works |
| fngit cannot resolve the reference | fngit's own reason, relayed verbatim |
| `+workspace` with no reference before it | Error: empty repo reference |
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

Claude Code has no persistent setting for `--tmux`, so fnclaude supplies the default from `auto.tmux` in its config:

| Setting | Effect |
|---|---|
| `never` (or absent) | Never inject `--tmux`. |
| `always` | Inject on every launch. |
| `worktree` | Inject only when a NEW worktree is being created: `-w <name>` (or a 2nd positional) was given and no matching worktree was found. |

**Suppressed under every setting by**:
- the `--no-tmux` flag to `fnc`;
- `--tmux` already present in the passthrough flags.

Explicit intent always wins, so `--no-tmux` remains usable under `always`.

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

Fragment files are located relative to the fnclaude binary. Override the packaged directory with `FNC_PROMPTS_DIR`.

**User overrides**: a file in `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/` replaces the packaged fragment of the same name. This is per fragment — overriding `noop-router.md` leaves the others packaged. `fnc install` creates that directory with a `README.txt` listing the recognised names and where to copy the packaged originals from. Nothing is copied there on install, and nothing there is ever overwritten by an update.

---

## 8. Ultracode Mode

When you type `fnc ultracode [path] [-- prompt]`:

1. fnclaude launches claude with `--model opus`.
2. The first thing sent to claude is `/effort ultracode` (as an initial message, not via `--effort`).
3. If you also provided a `-- prompt`, it is delivered as a **follow-up** turn after claude processes the effort command.

---

## 9. Configuration File

Location: `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json` (default: `~/.config/rhombus.rocks/fnclaude/config.json`).

Any of `config.json`, `config.jsonc`, `config.toml`, or `config.yaml` is read — whichever exists, in that order. fnclaude always **writes** JSON, because JSON's `$schema` key is the one form every editor honours without extra setup:

```json
{
  "$schema": "https://json.schemastore.org/rhombus-rocks-fnclaude-config.json",
  "noOobe": true,
  "noopDir": "~/.config/rhombus.rocks/fnclaude/noop",
  "auto": { "tmux": "never", "handoff": "3", "spawnCommand": "ghostty -e {bin} {dest} --name {name} @{summary}" },
  "claude": { "defaultArgs": ["--chrome", "--brief"] },
  "exec": { "env": { "NAME": "value" } },
  "context": { "noticeThreshold": 150000, "noticeTiers": [], "noticeRepeat": { "every": 50000, "level": "urgent" } }
}
```

There is **no runtime schema validation**. The schema exists for editor completion, not gatekeeping: the loader degrades per field, so a wrong-shaped `auto` costs you `auto` and the rest of the file still loads. Rewriting the file drops comments.

**Migration**: if no file exists at that location, the pre-restructure `$XDG_CONFIG_HOME/fnclaude/config.toml` is read once and rewritten as JSON at the new path, with `spawn_command` → `spawnCommand` and `notice_*` → `notice*`. Keys fnclaude doesn't read ride along rather than being dropped.

### 9.1 Top level

**`noOobe`**: when falsy or absent — including the whole file being absent — an interactive launch runs the first-run interview. `fnc install` sets it after a successful Apply.

**`noopDir`**: fnclaude's starting directory. A leading `~` is expanded.

### 9.2 `auto`

**`tmux`**: `never` | `always` | `worktree`. See §6.

**`handoff`**: controls how `fnc_switch_project` and `fnc_restart` transfer the session:
- `"never"`: paste-flow only (shows the command to run manually).
- `"ask"`: prompts before executing the transfer. (⚠ not covered by tests)
- A number of seconds as a string: auto-executes the transfer after that delay. (⚠ not covered by tests)

**`spawnCommand`**: template for opening a new terminal window when `fnc_spawn_session` is called. Placeholders: `{bin}` (fnclaude path), `{dest}` (destination), `{name}` (session name), `{summary}` (handoff summary file path with `@` prefix). If not set, falls back to `tmux new-window -d` when `$TMUX` is set, otherwise enters paste-flow.

### 9.3 `claude`

**`defaultArgs`**: an array of flags appended to every claude launch, for flags Claude Code has no persistent setting for. Inserted before the prompt sentinel.

### 9.4 `exec.env`

Keys and values injected into every claude child process's environment. Your shell environment is the base; these keys override shell values; `FNCLAUDE_HANDOFF` and `FNC_SOCKET` are then set on top of these.

`FNC_ARGS_JSON` is always stripped from the child environment regardless of config or shell.

### 9.5 `context`

**`noticeThreshold`**, **`noticeTiers`**, **`noticeRepeat`** control the context-budget notices (see §13). Each threshold is a positive number of tokens or an `"NN%"` string measured against the derived auto-compact point.

---

## 10. Repository Settings

fnclaude no longer reads Claude Code's `settings.json` for anything.

Clone template, worktree template, branch template, additional source directories, and host aliases live in the shared `$XDG_CONFIG_HOME/rhombus.rocks/config.json`, and are read by **fngit** (repository location) and the **worktree-paths** plugin (worktree creation) — not by fnclaude. fnclaude reaches all of it indirectly, by running `fngit clone` and letting fngit apply the settings.

See `specs/rhombus-rocks-config.md` for the shared file's shape.

---

## 11. Environment Variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | When set, auto-name calls the Anthropic API directly instead of shelling out to `claude -p` |
| `XDG_CONFIG_HOME` | Base for the config, prompt-override, and starting directories (default: `~/.config`) |
| `XDG_STATE_HOME` | Base for session logs (default: `~/.local/state`) |
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

**Configurable** via `context` in the config file: `noticeThreshold` (first tier), `noticeTiers` (the ladder), `noticeRepeat` (repeat interval).

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
