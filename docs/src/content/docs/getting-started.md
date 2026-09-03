---
title: Getting Started
description: Install fnclaude, start your first session, and learn the repo references fnc understands.
---

**fnclaude** wraps Claude Code with session control. You can move a running session
to another repository, or open a second one beside it, and neither has to start from
a cold context — fnclaude carries a written continuity summary across the boundary.

The binary is called `fnc`. Everything below assumes it is on your `PATH`.

## Install

fnclaude publishes to npm. Install it globally and you get the `fnc` binary:

```sh
npm i -g fnclaude
```

Confirm it resolved:

```sh
fnc --version
```

:::note
`-v` and `--version` print *fnclaude's* version. `fnc` claims the flag before claude
sees it, so reach claude's own version with `claude --version` directly.
:::

See [Installation](/installation/) for the other package managers, the runtime
requirements, and the platforms that are actually exercised.

## Your first session

Point `fnc` at a repository and it launches claude there:

```sh
fnc arch-setup
```

You are not limited to where your terminal happens to be. The reference is resolved
independently of the current directory, so any repository is one word away from any
prompt.

To pick work back up rather than start fresh, `fnc resume`, `fnc continue`, and
`fnc fork` cover the three shapes — see [Resuming & continuing](/sessions/resuming/).

## Repo reference forms

You never have to spell out a path. `fnc` resolves any of these, cloning the
repository if it is not on disk yet:

| Form | Example |
| --- | --- |
| Short name, searched across your GitHub orgs | `fnc arch-setup` |
| `name@owner` | `fnc arch-setup@fnrhombus` |
| `owner/name` | `fnc fnrhombus/arch-setup` |
| `gh:owner/name` | `fnc gh:fnrhombus/arch-setup` |
| HTTPS or SSH URL | `fnc https://github.com/fnrhombus/arch-setup` |
| A path you already have | `fnc ~/src/dots` |
| Any of the above plus a `+workspace` suffix | `fnc arch-setup+fix-lid-sync` |

Clones land at the `cloneTemplate` path from `~/.claude/settings.json`, which
fnclaude shares with the claude-code-worktree-paths plugin. Full rules on
[Repo resolution](/reference/repo-resolution/).

The `+workspace` suffix resolves the base repository and adds a worktree beside it,
branched and ready to commit. See [Worktrees](/sessions/worktrees/).

## What a session handoff is

A handoff is the continuity summary fnclaude carries from one session to the next.
When you ask to switch projects, the model writes a summary of the conversation —
what you asked for, decisions made and why, files touched, work still in flight, open
questions — and fnclaude hands that to the session it launches at the destination.

The receiving session starts already knowing what it is there for, so the first
message you send it is a continuation rather than a re-briefing. The same mechanism
backs spawning a sibling session; the difference is only whether the current session
survives.

## Where to go next

- [Switching projects](/sessions/switching-projects/) — replace this session with one elsewhere.
- [Spawning siblings](/sessions/spawning-siblings/) — keep this one and open a second.
- [Tool reference](/reference/tools/) — every tool fnclaude exposes to the model.
- [CLI flags](/reference/cli-flags/) — the full `fnc` surface.
