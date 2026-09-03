---
title: Repo resolution
description: Every reference form fnc accepts for a destination, and how it turns one into a directory.
---

`fnc` takes a repository reference the way you would say it, and turns it into a
directory to launch in. You never resolve a path yourself, and neither does the model —
references are passed through verbatim and fnclaude's resolver does the work.

## Accepted forms

| Form | Example | How it resolves |
| --- | --- | --- |
| Absolute path | `/home/tom/src/proj` | Used as-is. |
| Home-relative | `~/src/proj` | Expanded, then used as-is. |
| Explicitly relative | `./proj` | Relative to the current directory. Also the escape hatch for a directory named like a magic word. |
| Bare repo name | `arch-setup` | Looked for among your existing clones, then searched across your GitHub orgs. |
| `name@owner` | `arch-setup@fnrhombus` | Owner is known directly, no org search. |
| `owner/name` | `fnrhombus/arch-setup` | Same. |
| `gh:owner/name` | `gh:fnrhombus/arch-setup` | Same. |
| HTTPS URL | `https://github.com/fnrhombus/arch-setup` | Host, owner, and name read from the URL. |
| SSH URL | `git@github.com:fnrhombus/arch-setup` | Same. |

Any of them may carry a `+workspace` suffix — `arch-setup+fix-lid-sync` — which
resolves the base repository and then adds a worktree beside it. See
[Worktrees](/sessions/worktrees/).

## Resolution order

1. **No argument.** Falls back to the marker directory (below).
2. **An explicit path** — anything starting `/`, `~`, `~/`, `.`, `..`, `./`, or `../` —
   short-circuits everything else and launches there. Existence is not checked: you
   said go here, so it goes here.
3. **Anything else** is checked two ways at once: as a directory named `<input>` inside
   your current directory, and as a repo reference.
   - The reference does not parse: the local directory is used if it exists, otherwise
     you get a parse error.
   - **A bare name with a local directory of the same name** is ambiguous, and fnclaude
     says so rather than guessing. Write `./name` for the local directory.
   - **A bare name with no local directory** is matched against your existing clones
     under `cloneTemplate`. Exactly one match launches it. More than one is ambiguous
     and fnclaude lists them. None falls through to a GitHub org lookup, then a clone.
   - **An owner-qualified reference** goes straight to its clone destination. If both
     that and a local directory of the same name exist and are genuinely different
     places, that is ambiguous too; if they are the same place, it just launches.

## Cloning

If the repository is not on disk, fnclaude clones it. The destination comes from
`cloneTemplate` under `repoSettings` in `~/.claude/settings.json`, the same setting the
claude-code-worktree-paths plugin reads, so clones and worktrees land in a consistent
layout.

## When the repo does not exist

A clone can fail because the remote genuinely is not there — a repository you meant to
create rather than one you meant to fetch. fnclaude classifies that case and offers to
bootstrap instead of hard-failing:

1. **Local first.** Create the directory, `git init`, and add the origin remote. Fully
   reversible, so it is a single prompt.
2. **Then the remote,** behind its own separate prompt, defaulting to `--private`.
   Creating a GitHub repository is outward-facing and hard to undo, so it never happens
   as a side effect of the first answer.

In a non-interactive context — CI, a pipe, anything without a TTY — the prompts return
their default of "no" without blocking, so nothing is ever bootstrapped by surprise.

Errors that are not unambiguously "not found", such as auth and network failures, still
fail hard exactly as before.

## No argument at all

With no positional path, `fnc` falls back to a marker directory at
`$XDG_CONFIG_HOME/fnclaude/noop`, so a bare `fnc` starts somewhere neutral rather than
wherever your shell happened to be.
