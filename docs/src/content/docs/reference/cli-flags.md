---
title: CLI flags
description: The full fnc argument surface. Magic words, fnc-owned flags, capital-letter shortcuts, environment, and config.
---

```
fnc [MODEL] [EFFORT] [SUBCOMMAND] [CWD [WORKTREE]] [FLAGS...] [-- PROMPT]
```

Anything fnclaude does not claim goes to claude untouched. `claude --help` covers
that side.

## Magic positional words

Model and effort are read left to right at the head of argv, before any flag. The
subcommand can sit anywhere among them.

| Kind | Words | Becomes |
| --- | --- | --- |
| Model alias | `opus`, `sonnet`, `haiku`, `fable` | `--model <alias>` |
| Effort level | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | `--effort <level>` |
| Subcommand | `resume`, `res` | `--resume` |
| Subcommand | `continue`, `con` | `--continue` |
| Subcommand | `fork`, `fk` | `--resume --fork-session` |

Effort alone in the first slot implies `opus`. A directory literally named one of
these words is reachable as `./<name>`.

## Positional paths

Two positionals survive after the magic words:

1. **The directory to launch claude in.** Any form on
   [Repo resolution](/reference/repo-resolution/). A missing repository is cloned.
   With no path at all, fnclaude launches in `$XDG_CONFIG_HOME/fnclaude/noop`.
2. **A worktree name.** Same meaning as `-w <name>`.

A third positional is an error.

## fnclaude-owned flags

The launcher consumes these. claude never sees them.

| Flag | Effect |
| --- | --- |
| `-A`, `--also <dir>` | Accepted and reserved. Not forwarded to claude yet. |
| `--no-tmux` | Skip auto-tmux for this invocation. |
| `-w`, `--worktree <name>` | Worktree intercept. An existing worktree of that name becomes the launch directory. No match, and the name goes to claude as a new-worktree request. |
| `-h`, `--help` | Print help and exit. |
| `-v`, `--version` | Print fnclaude's version and exit. This shadows claude's `-v`. Use `claude --version` for that. |

`-v` is the only lowercase short flag fnclaude takes. Everything else it claims is
uppercase.

## Capital-letter shortcuts

Each one is a claude long flag.

| Short | Long | Short | Long |
| --- | --- | --- | --- |
| `-B` | `--brief` | `-M` | `--permission-mode <mode>` |
| `-C` | `--chrome` | `-P` | `--from-pr [value]` |
| `-D` | `--dangerously-skip-permissions` | `-R` | `--remote-control [name]` |
| `-F` | `--fork-session` | `-T` | `--tmux [classic]` |
| `-G` | `--agent <agent>` | `-V` | `--verbose` |
| `-I` | `--ide` | `-W` | `--allowedTools <tools>` |

They collapse the POSIX way: `-BVC` is `-B -V -C`. Only the last flag in a cluster
may take a value, so `-G`, `-M`, and `-W` go at the end of one, never in the middle.

## Reserved subcommand

`fnc mcp` starts fnclaude's internal MCP server. claude runs it itself through the
injected `--mcp-config`. It is not for direct use. A directory literally named `mcp`
is reachable as `./mcp`.

## Behaviours worth knowing

**Cross-cwd resume.** Pick a session from another directory in claude's resume
picker and fnclaude relaunches itself there, with every flag from the original
invocation. See [Resuming & continuing](/sessions/resuming/).

**Auto-name.** Pass a prompt after `--` with no `--name` or `-n`, and fnclaude
generates a one-to-three-word session label with Haiku. With `ANTHROPIC_API_KEY` set
it calls the API directly. Without it, it shells out to `claude -p` on your
subscription. On failure or timeout it falls back to a heuristic, silently.

**Auto-tmux.** With `[auto] tmux = "worktree"` in config, fnclaude adds `--tmux`
whenever `-w <name>` creates a new worktree. `--no-tmux` skips that once.

## Environment variables

CLI beats environment, and environment beats the config file.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Direct-API auth for auto-naming. Without it, fnclaude shells out to `claude -p`. |
| `XDG_CONFIG_HOME` | Config directory base. Defaults to `~/.config`. |
| `FNC_PROMPTS_DIR` | Override where fnclaude looks for its prompt fragments. |
| `FNC_NOOP_TEMPLATE_PATH` | Override the handoff template copied into the noop directory on first launch. |
| `FNC_LOG` | Log level: `debug`, `info`, `warn`, `error`. `silent`, `off`, or `none` disables logging. Defaults to `info`. |

## Config file

`$XDG_CONFIG_HOME/fnclaude/config.toml`:

```toml
[auto]
tmux = "never"          # or "worktree"
handoff = "never"       # or "ask", or a number of seconds
spawn_command = "..."   # opens a new terminal window for a sibling session

[exec.env]
NAME = "value"          # injected into every claude child's environment
```

`spawn_command` is split on whitespace and each token may use `{bin}`, `{dest}`,
`{name}`, and `{summary}`. See [Spawning siblings](/sessions/spawning-siblings/).

## Repo settings

`~/.claude/settings.json` supplies `cloneTemplate`, `worktreeTemplate`, and
`branchTemplate` under `repoSettings`, shared with the claude-code-worktree-paths
plugin. The user, project, local, and managed settings files layer in the usual
claude order.

## Logs

Each launch writes one JSONL log file under the platform's state directory:
`$XDG_STATE_HOME/fnclaude/logs` on Linux, `~/Library/Logs/fnclaude` on macOS. On
each launch fnclaude keeps the fifty newest and deletes the rest. Logging never
blocks a launch. If the filesystem refuses, it turns itself off.
