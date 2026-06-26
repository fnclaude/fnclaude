# @fnclaude/cli

`claude`, with the rough edges filed off.

```sh
fnc opus max ~/src/myproject -- "refactor the auth module"
```

No `--model claude-opus-4-5`, no `--effort max`, no `--print` gymnastics. `@fnclaude/cli` (the `fnc` binary) sits in front of `claude` and translates short, readable invocations into the full-form flags `claude` expects. Magic positional words for model and effort, capital-letter short flags for everything claude makes you spell out, and a config file for the auto-features you want on every launch. Bun-runtime; install via `bun add -g fnclaude` (or `npm i -g fnclaude`).

## Platform support

Supported on **Linux** and **macOS**. The codebase has a Windows fallback path (`spawn + process.exit` instead of `process.execve`) but it has never been exercised — treat it as untested. If you run on Windows, expect breakage.

## Install

```sh
bun add -g fnclaude
# or
npm install -g fnclaude
```

Requires the **Bun runtime** for terminal session management. Node.js is supported for installation, but session execution runs via Bun.

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- [claude](https://github.com/anthropics/claude-code) CLI installed and on your `$PATH`

## Quick start

```sh
# Launch in the current directory
fnc .

# Specific model in a specific project
fnc sonnet ~/src/myproject

# High-effort opus session
fnc opus high ~/src/myproject

# Attach a shared tools directory
fnc ~/src/myproject -A ~/src/shared-tools

# Pass a prompt inline
fnc . -- "refactor the auth module"

# Collapse multiple short flags
fnc -BVC .
```

## Features

### Magic positional words

The first two positional slots can be a model alias and an effort level. `fnc` intercepts them before `claude` ever sees the args.

```sh
fnc opus max ~/src/proj          # --model claude-opus-4-5 --effort max
fnc sonnet ~/src/proj            # --model claude-sonnet-4-5
fnc haiku ~/src/proj             # --model claude-haiku-4-5
fnc ~/src/proj                   # no model flag — claude picks the default
```

Supported model aliases: `opus`, `sonnet`, `haiku`.
Supported effort levels: `low`, `medium`, `high`, `xhigh`, `max`.

A directory that happens to be named `opus`? Prefix it: `fnc ./opus`.

### Capital-letter short flags

`claude`'s long options are the right thing to pass and a chore to type. `fnc` maps each one to a capital-letter short flag that collapses with standard POSIX rules.

```sh
fnc -BVC ~/src/proj     # --brief --verbose --chrome
fnc -T ~/src/proj       # --tmux
fnc -D ~/src/proj       # --dangerously-skip-permissions
```

Full mapping in the [flag reference](#short-translations-fnc--claude) below.

### Prompt after `--`

Pass a prompt inline without `--print` or redirection — just drop a `--` and write the prompt. When `--name`/`-n` isn't already set, `fnc` generates a 1–3-word session label from the prompt via Haiku (see [Auto-name from prompt](#auto-name-from-prompt) below).

```sh
fnc sonnet src/ -- "add integration tests for the payments module"
```

### Multi-directory MCP injection

Need claude to see a second project's MCP config and settings? Pass it as an extra positional or with `-A`/`--also`. `fnc` injects `--add-dir`, `--mcp-config`, and `--settings` for each extra dir automatically.

```sh
fnc src/ -A tools/ -A shared/
# or equivalently:
fnc src/ tools/ shared/
```

Each extra dir gets `--mcp-config <dir>/.mcp.json` (if the file exists) and `--settings <dir>/.claude/settings.json` (if it exists). The primary dir is launched in; extra dirs are attached.

### Auto-features you configure once

Tired of typing `--tmux` every launch? Set it once in config and forget it.

```toml
# ~/.config/fnclaude/config.toml
[auto]
tmux = "worktree"   # inject --tmux when you're creating a worktree via -w
```

Off by default. The per-invocation override `--no-tmux` lets you escape for a single run without touching config.

`auto.tmux = "worktree"` is the only valid non-default value: it injects `--tmux` only when you're explicitly creating a new worktree via `-w` (which claude requires for `--tmux` anyway). `fnc` never spawns worktrees on its own — that's always a user-initiated action.

> **What about `--dangerously-skip-permissions` and `--ide`?** Use claude's own settings: `permissions.defaultMode` and `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`, plus `autoConnectIde` in `~/.claude.json`. The CLI flags themselves (`-D`, `--dangerously-skip-permissions`, `-I`, `--ide`) still pass through verbatim for per-invocation use.

### Auto-name from prompt

When you pass a prompt after `--` (and aren't resuming an existing session), `fnc` generates a short hyphenated session label via Haiku and injects it as `--name`. The call has a 3-second timeout; on timeout, missing API key, or any error, it falls back to a heuristic that strips stop-words and takes the first three meaningful tokens.

```sh
fnc . -- "refactor the auth module"
# → --name refactor-auth-module
```

Skipped for `-p`/`--print`, `-r`/`--resume`, `-c`/`--continue`, and `--from-pr` — those don't create new named sessions. Requires `ANTHROPIC_API_KEY`; suppress the missing-key warning with `FNCLAUDE_QUIET_MISSING_API_KEY=1` (or the config equivalent) if you'd rather just rely on the heuristic.

### Cross-cwd `--resume`

`claude --resume` normally exits with a "this conversation is from a different directory" message when you pick a session from elsewhere via the picker. `fnc` scans the last 4 KB of claude's output, catches that message after exit, and transparently re-execs a fresh `fnc` in the destination directory. The picker just works across all your projects — no flicker, no manual `cd`.

Linux and macOS only; on Windows `fnc` falls back to a plain exec (no PTY, no detection).

### Worktree intercept

`fnc -w <name>` looks up `<name>` against the existing git worktrees of the project repo. If it matches, `fnc` swaps its cwd to that worktree and drops the `-w` flag — no new worktree is created, no duplicate. If it doesn't match, the flag passes through and the name doubles as the session `--name`.

```sh
fnc -w feature-branch    # cds to the feature-branch worktree if it exists
fnc -w new-thing         # passes -w new-thing through; sets --name new-thing
```

### Auto-handoff from noop sessions

When `fnc` is launched with no positional path, it drops into a "noop" session whose system prompt makes claude act as a router: classify the user's prompt into general-Q&A, read-shaped, or action-on-a-project. Action requests get written as a handoff file to a temp path and the relaunch command fires automatically (or with a confirmation, depending on `auto.handoff`).

`auto.handoff` controls how the noop router proposes the relaunch:

- `"never"` — paste-flow only. claude renders the relaunch command and copies it to the clipboard.
- `"ask"` (default) — claude asks "Want me to switch you over now?" before doing anything.
- `"<N>"` (seconds, e.g. `"5"`) — countdown auto-switch. `"0"` means instant.

## Reference

### Argument grammar

The first two positional arguments may be "magic" shorthands:

- **Position 1**: if the value is exactly `opus`, `sonnet`, or `haiku`, it is translated to `--model <alias>` and consumed. Otherwise treated as a path.
- **Position 2**: only checked when position 1 was a model alias. If the value is exactly `low`, `medium`, `high`, `xhigh`, or `max`, it is translated to `--effort <level>` and consumed. Otherwise treated as a path.
- **Position 3+**: never magic.

To pass a literal directory named `opus`, prefix with `./`: `fnc ./opus`

After magic slots resolve, the first remaining positional is the directory to launch `claude` in. Subsequent positionals are "extra dirs" that each receive `--add-dir`, `--mcp-config`, and `--settings` injection (files must exist for the latter two).

Use `--` to separate `fnc` args from the prompt string:

```sh
fnc sonnet src/ -- "do the thing"
```

### Flag reference

#### fnc-owned flags

| Flag | Long | Description |
|---|---|---|
| | `--no-tmux` | Suppress auto-`--tmux` for this invocation |
| `-A <dir>` | `--also <dir>` | Add an extra dir (repeatable) |
| `-h` | `--help` | Print the flag reference and exit |
| `-v` | `--version` | Print `fnc`'s version and exit |

#### Short translations (fnc → claude)

| Short | Long | Value |
|---|---|---|
| `-A` | `--also` | required (fnc-owned) |
| `-B` | `--brief` | none |
| `-C` | `--chrome` | none |
| `-D` | `--dangerously-skip-permissions` | none |
| `-F` | `--fork-session` | none |
| `-G` | `--agent` | required |
| `-I` | `--ide` | none |
| `-M` | `--permission-mode` | required |
| `-P` | `--from-pr` | optional |
| `-R` | `--remote-control` | optional |
| `-T` | `--tmux` | optional |
| `-V` | `--verbose` | none |
| `-W` | `--allowedTools` | required |

Short flags follow standard POSIX collapsing: `-BVC` expands to `-B -V -C`. Only the last flag in a collapsed group may take a value. All other flags pass through to `claude` verbatim.

### Config file

Location: `$XDG_CONFIG_HOME/fnclaude/config.toml` (fallback `~/.config/fnclaude/config.toml`). A missing file is not an error — all defaults apply.

Precedence: **CLI flag > env var > config file > built-in default**

```toml
[name]
model = "claude-haiku-4-5"   # model for auto-generated session names
timeout = "3s"               # timeout for the name-generation API call
quiet_missing_api_key = false

[auto]
tmux = "never"      # "never" | "worktree"
handoff = "ask"     # "never" | "ask" | non-negative integer seconds
```

#### Env var mapping

| Config key | Env var |
|---|---|
| `name.model` | `FNCLAUDE_NAME_MODEL` |
| `name.timeout` | `FNCLAUDE_NAME_TIMEOUT` |
| `name.quiet_missing_api_key` | `FNCLAUDE_QUIET_MISSING_API_KEY` |
| `auto.tmux` | `FNCLAUDE_TMUX` |
| `auto.handoff` | `FNCLAUDE_HANDOFF` |

`ANTHROPIC_API_KEY` is read (standard) for the auto-name LLM call.

## Status

The CLI is a recent TypeScript rewrite of the original Go binary. It is actively maintained and published to npm under `@latest`. See the [main fnclaude repository](https://github.com/fnrhombus/fnclaude) for release notes and version history.

File bugs and feature requests on [GitHub Issues](https://github.com/fnrhombus/fnclaude/issues).
