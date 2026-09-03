---
title: Worktrees
description: The + suffix, the -w intercept, and where fnclaude puts worktrees on disk.
---

A git worktree is a destination like any other. Add `+` and a workspace name to any
repository reference:

```sh
fnc arch-setup+fix-lid-sync
```

That resolves the repository, cloning it first if needed, and adds a worktree beside
it on its own branch. The same suffix works as the `destination` of
`fnc_switch_project` and `fnc_spawn_session`.

## The `-w` intercept

`-w <name>`, or a second positional after the directory, does the same job with one
extra step. fnclaude checks the name against the repository's existing worktrees:

- **It matches one.** fnclaude launches in that worktree.
- **It matches nothing.** The name goes to claude as a new-worktree request.

Either way `--name` is set, so the session is labelled with the workspace.

```sh
fnc ~/src/proj feature      # second positional, same as -w feature
fnc -w fix-lid-sync ~/src/proj
```

A name matches on the branch, on the branch with a `worktree-` prefix removed, or
on the last segment of the worktree's path, in that order.

## Where worktrees land

Paths come from `repoSettings` in `~/.claude/settings.json`: `worktreeTemplate` for
the directory and `branchTemplate` for the branch. fnclaude shares both with the
claude-code-worktree-paths plugin. The user, project, local, and managed settings
files layer in the usual claude order, so one repository can override the default
placement.

## Auto-tmux

A new worktree is a natural moment for a new tmux session. With this in
`config.toml`:

```toml
[auto]
tmux = "worktree"
```

fnclaude adds `--tmux` whenever `-w <name>` creates a new worktree. Pass `--no-tmux`
to skip it once without touching config. The default is `tmux = "never"`.
