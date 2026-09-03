---
title: Repo resolution
description: Every reference form fnc accepts for a destination, and the order it tries them in.
---

`fnc` takes a repository reference the way you would say it and turns it into a
directory. You never work out the path, and neither does the model. The reference
goes through verbatim and fnclaude's resolver does the rest.

## Accepted forms

| Form | Example | How it resolves |
| --- | --- | --- |
| Absolute path | `/home/tom/src/proj` | Used as is. |
| Home-relative | `~/src/proj` | Expanded, then used as is. |
| Explicitly relative | `./proj` | Relative to the current directory. Also the escape hatch for a directory named like a magic word. |
| Bare name | `arch-setup` | Matched against your existing clones, then your GitHub user and orgs. |
| `name@owner` | `arch-setup@fnrhombus` | Owner is known. No search. |
| `owner/name` | `fnrhombus/arch-setup` | Same. |
| `gh:owner/name` | `gh:fnrhombus/arch-setup` | Same. |
| HTTPS URL | `https://github.com/fnrhombus/arch-setup` | Host, owner, and name come from the URL. |
| SSH URL | `git@github.com:fnrhombus/arch-setup` | Same. |

Any of them may carry a `+workspace` suffix, as in `arch-setup+fix-lid-sync`. That
resolves the repository, then adds a worktree beside it. See
[Worktrees](/sessions/worktrees/).

## Resolution order

1. **No argument.** fnclaude launches in the noop directory, described below.
2. **An explicit path.** Anything starting with `/`, `~`, `.`, or `..` is a path and
   nothing else. fnclaude launches there without checking that it exists. You said
   go here, so it goes here.
3. **Anything else** is checked two ways at once: as a directory of that name inside
   your current directory, and as a repository reference.
   - If it does not parse as a reference, the local directory is used when it
     exists. Otherwise you get the parse error.
   - **A bare name with a local directory of the same name** is ambiguous. fnclaude
     says so instead of guessing. Write `./name` for the directory.
   - **A bare name with no local directory** is matched against your clones under
     `cloneTemplate`. One match launches. More than one is ambiguous, and fnclaude
     lists them. None, and fnclaude asks GitHub which of your user and orgs has a
     repository by that name, then clones it. Two owners with the same name is
     ambiguous too. Pass the owner.
   - **A reference with an owner** goes straight to its clone destination. If that
     and a local directory of the same name both exist and are different places, that
     is ambiguous. If they are the same place, it launches.

## Cloning

A repository that is not on disk gets cloned. The destination comes from
`cloneTemplate` under `repoSettings` in `~/.claude/settings.json`, the same setting
the claude-code-worktree-paths plugin reads, so clones and worktrees share one
layout.

## When the repo does not exist

A clone can fail because the remote is not there. Maybe you meant to create the
repository, not fetch it. fnclaude recognises that failure and offers to bootstrap
instead of stopping:

1. **Local first.** Create the directory, run `git init`, and add the origin remote.
   Fully reversible, so it is one prompt.
2. **Then the remote,** behind a second prompt, created private. Creating a GitHub
   repository is hard to undo, so it never happens as a side effect of the first
   answer.

Without a TTY, in CI or a pipe, both prompts answer no without blocking. Nothing is
bootstrapped by surprise.

Any other clone failure, such as auth or network, still fails hard.

## No argument at all

A bare `fnc` launches in `$XDG_CONFIG_HOME/fnclaude/noop`, a neutral directory, rather
than wherever your shell happened to be. On the first such launch fnclaude copies a
handoff template into it. Everything else in that directory is yours and never
touched.
