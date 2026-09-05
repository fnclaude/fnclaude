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
   With no path at all, fnclaude launches in its starting directory,
   `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop` unless `noopDir` says otherwise.
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

`$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json`:

```json
{
  "$schema": "https://json.schemastore.org/rhombus-rocks-fnclaude-config.json",
  "auto": {
    "tmux": "never",
    "handoff": "never",
    "spawnCommand": "ghostty -e {bin} {dest} --name {name} @{summary}"
  },
  "claude": { "defaultArgs": ["--chrome"] },
  "exec": { "env": { "NAME": "value" } }
}
```

`auto.tmux` is `never`, `always`, or `worktree`. `auto.handoff` is `never`, `ask`,
or a number of seconds as a string. `auto.spawnCommand` is split on whitespace and
each token may use `{bin}`, `{dest}`, `{name}`, and `{summary}` — see
[Spawning siblings](/sessions/spawning-siblings/). `claude.defaultArgs` is appended
to every launch.

`config.jsonc`, `config.toml`, and `config.yaml` are read too; fnclaude writes JSON
so the `$schema` line gives editors completion. There is no validation — a
wrong-shaped key costs you that key and the rest of the file still loads.

## Repo settings

Clone, worktree, and branch templates live in the shared
`$XDG_CONFIG_HOME/rhombus.rocks/config.json` under `repos`, read by fngit and the
worktree-paths plugin. fnclaude does not read that file. See
[Repo resolution](/reference/repo-resolution/).

## System prompt overrides

A file in `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/` replaces fnclaude's
packaged system prompt of the same name. `fnc install` creates that directory with
a `README.txt` listing the names.

## Logs

Each launch writes one JSONL log file under the platform's state directory:
`$XDG_STATE_HOME/rhombus.rocks/fnclaude` on Linux,
`~/Library/Logs/rhombus.rocks/fnclaude` on macOS. On
each launch fnclaude keeps the fifty newest and deletes the rest. Logging never
blocks a launch. If the filesystem refuses, it turns itself off.
