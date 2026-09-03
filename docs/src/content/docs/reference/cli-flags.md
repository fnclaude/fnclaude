---
title: CLI flags
description: The full fnc argument surface — magic words, owned flags, capital-letter shortcuts, environment, and config.
---

```
fnc [MODEL] [EFFORT] [SUBCOMMAND] [CWD [WORKTREE]] [FLAGS...] [-- PROMPT]
```

Everything fnclaude does not claim passes through to claude verbatim. Run
`claude --help` for that side of the surface.

## Magic positional words

Order-independent for the subcommand. Model and effort are scanned left-to-right at
the head of argv, before any flags.

| Kind | Words | Becomes |
| --- | --- | --- |
| Model alias | `opus`, `sonnet`, `haiku`, `fable` | `--model <alias>` |
| Effort level | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | `--effort <level>` |
| Subcommand | `resume`, `res` | `--resume` |
| Subcommand | `continue`, `con` | `--continue` |
| Subcommand | `fork`, `fk` | `--resume --fork-session` |

Effort alone in the first slot implies `opus`. To use a directory literally named one
of these words, prefix it with `./`.

## Positional paths

At most two positionals survive after the magic words and subcommand:

1. **The cwd to launch claude in.** Any form from [Repo resolution](/reference/repo-resolution/).
   Missing repositories are cloned. With no path at all, fnclaude falls back to
   `$XDG_CONFIG_HOME/fnclaude/noop`.
2. **A worktree name,** with the same semantics as `-w <name>`.

A third positional is an error — use `-A`/`--also` for extra directories.

## fnclaude-owned flags

Consumed by the launcher and never forwarded to claude.

| Flag | Effect |
| --- | --- |
| `-A`, `--also <dir>` | Additional extra directory. Repeatable. |
| `--no-tmux` | Suppress auto-tmux injection for this invocation. |
| `-w`, `--worktree <name>` | Worktree intercept. Matches an existing worktree and fnclaude swaps cwd to it; no match and it forwards as a new-worktree request. |
| `-h`, `--help` | Show help and exit. |
| `-v`, `--version` | Print fnclaude's version and exit. This shadows claude's `-v` — use `claude --version` for that. |

`-v` is the only lowercase short flag fnclaude reserves. Everything else it claims is
uppercase.

## Capital-letter shortcuts

Each translates to a claude long-form flag.

| Short | Long | Short | Long |
| --- | --- | --- | --- |
| `-B` | `--brief` | `-M` | `--permission-mode <mode>` |
| `-C` | `--chrome` | `-P` | `--from-pr [value]` |
| `-D` | `--dangerously-skip-permissions` | `-R` | `--remote-control [name]` |
| `-F` | `--fork-session` | `-T` | `--tmux [classic]` |
| `-G` | `--agent <agent>` | `-V` | `--verbose` |
| `-I` | `--ide` | `-W` | `--allowedTools <tools>` |

POSIX collapsing works — `-BVC` is `-B -V -C` — and only the last flag in a collapsed
group may take a value. The value-taking flags `-G`, `-M`, and `-W` must be the final
character of a cluster, never in the middle.

## Reserved subcommand

`fnc mcp [--noop]` starts the internal MCP server. claude invokes it automatically via
the injected `--mcp-config`; it is not for direct use. A directory literally named
`mcp` is reachable as `./mcp`.

## Behaviours worth knowing

**Cross-cwd resume.** When claude shows the resume picker and you pick a session from a
different directory, fnclaude transparently re-launches there. Every flag from the
original invocation is preserved.

**Auto-name.** When a `--`, a prompt, and no `--name`/`-n` are all present, fnclaude
generates a one-to-three-word session label via Haiku. With `ANTHROPIC_API_KEY` set it
calls the Anthropic API directly; without it, it shells out to `claude -p` and uses
your subscription auth. Failures and timeouts fall back silently to a heuristic.

**Auto-tmux.** With `[auto] tmux = "worktree"` in config, `--tmux` is injected whenever
`-w <name>` creates a new worktree. `--no-tmux` skips it for one invocation.

## Environment variables

Precedence is CLI, then environment, then config file.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Direct-API auth for auto-naming. Without it, fnclaude shells `claude -p`. |
| `XDG_CONFIG_HOME` | Config directory base. Defaults to `~/.config`. |
| `FNC_PROMPTS_DIR` | Override the install-dir prompts location. |
| `FNC_NOOP_TEMPLATE_PATH` | Override the handoff template used when seeding the noop directory on first launch. |
| `FNC_LOG` | Log level: `debug`, `info`, `warn`, `error`, or `silent`/`off`/`none` to disable. Defaults to `info`. |

## Config file

`$XDG_CONFIG_HOME/fnclaude/config.toml`:

```toml
[name]
model = "claude-haiku-4-5"
timeout = "3s"

[auto]
tmux = "never"          # or "worktree"
handoff = "never"       # or "ask", or a number of seconds
spawn_command = "..."   # how to open a new terminal window

[exec.env]
NAME = "value"          # injected into every claude child's environment
```

## Repo settings

`~/.claude/settings.json` supplies `cloneTemplate`, `worktreeTemplate`, and
`branchTemplate` under `repoSettings`, shared with the claude-code-worktree-paths
plugin. They layer across the project, local, and managed tiers in standard
claude-settings precedence.

## Logs

fnclaude writes a structured JSONL log per launch under the platform state directory —
`$XDG_STATE_HOME/fnclaude/logs` on Linux, `~/Library/Logs/fnclaude` on macOS — one file
per process, pruned to the fifty most recent on each launch. Logging is best-effort and
degrades silently to a no-op if the filesystem refuses.
