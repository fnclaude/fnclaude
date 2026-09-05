---
title: Getting Started
description: Install fnc, launch a session by repo name, and see what the session can do from inside.
---

**fnclaude** is a launcher for Claude Code. The binary is `fnc`. Give it a repo
reference instead of a directory and it finds the clone, or makes one, and starts
claude there. The session it launches gets tools to switch to another repo, open a
sibling, and restart while it runs.

Everything below assumes `fnc` is on your `PATH`.

## Install

```sh
npm i -g fnclaude
```

Check it:

```sh
fnc --version
```

:::note
`-v` and `--version` print fnclaude's version. `fnc` claims the flag before claude
sees it. For claude's own version, run `claude --version`.
:::

`fnc` needs Bun and the `claude` CLI. See [Installation](/installation/).

## First session

Name a repository and `fnc` launches claude in it:

```sh
fnc arch-setup
```

Your shell's directory does not matter. The name is resolved on its own, so any
repository is one word away from any prompt. Run `fnc` with no argument and it
starts in a neutral scratch directory instead of wherever your shell happens to be.

To pick a session back up rather than start fresh, use `fnc resume`, `fnc continue`,
or `fnc fork`. See [Resuming & continuing](/sessions/resuming/).

## Repo reference forms

`fnc` accepts any of these, and clones the repository if it is not on disk:

| Form | Example |
| --- | --- |
| Bare name, matched against your clones, then your GitHub user and orgs | `fnc arch-setup` |
| `name@owner` | `fnc arch-setup@fnclaude` |
| `owner/name` | `fnc fnclaude/arch-setup` |
| `gh:owner/name` | `fnc gh:fnclaude/arch-setup` |
| HTTPS or SSH URL | `fnc https://github.com/fnclaude/arch-setup` |
| A path | `fnc ~/src/dots` |
| Any of the above plus `+workspace` | `fnc arch-setup+fix-lid-sync` |

Everything but the paths is resolved by [fngit](https://www.npmjs.com/package/@rhombus.rocks/fngit),
which fnclaude runs as a command. Clones land at the `repos.cloneTemplate` path in
the shared `~/.config/rhombus.rocks/config.json`, the same setting the
worktree-paths plugin reads. Without fngit installed, fnclaude accepts only paths.
The rules are on [Repo resolution](/reference/repo-resolution/).

The `+workspace` suffix resolves the repository, then adds a worktree beside it on
its own branch. See [Worktrees](/sessions/worktrees/).

## The summary that travels

When you ask the session to switch project or spawn a sibling, the model first
writes a continuity summary: what you asked for, the decisions made and why, the
files touched, the work still in flight, and the open questions. fnclaude hands that
summary to the session it launches.

The new session starts already briefed. Your first message to it continues the work
instead of re-explaining it. Switching and spawning share this mechanism. The
difference is whether the current session survives.

## Next

- [Switching projects](/sessions/switching-projects/) replaces this session with one elsewhere.
- [Spawning siblings](/sessions/spawning-siblings/) keeps this one and opens a second.
- [Tool reference](/reference/tools/) lists every tool the session gets.
- [CLI flags](/reference/cli-flags/) is the full `fnc` surface.
