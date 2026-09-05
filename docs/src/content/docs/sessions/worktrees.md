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

Paths come from `repos` in the shared `~/.config/rhombus.rocks/config.json`:
`worktreeTemplate` for the directory and `branchTemplate` for the branch. The
worktree-paths plugin reads the same two keys, so a worktree Claude Code creates
lands where one you ask fnclaude for does.

## Auto-tmux

Claude Code has no persistent setting for `--tmux`, so fnclaude supplies one. A new
worktree is a natural moment for a new tmux session:

```json
{ "auto": { "tmux": "worktree" } }
```

fnclaude then adds `--tmux` whenever `-w <name>` creates a new worktree. `"always"`
adds it to every launch; `"never"` is the default. Pass `--no-tmux` to skip it once
without touching the config — that wins under every setting.
