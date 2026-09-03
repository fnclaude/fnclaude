---
title: Worktrees
description: The + suffix, the -w intercept, and how fnclaude places worktrees on disk.
---

fnclaude treats a git worktree as a first-class destination. Suffix any repository
reference with `+` and a workspace name:

```sh
fnc arch-setup+fix-lid-sync
```

That resolves the base repository — cloning it first if it is not on disk — and adds a
worktree beside it, branched and ready to commit. The same suffix works as the
`destination` argument to `fnc_switch_project` and `fnc_spawn_session`.

## The `-w` intercept

`-w <name>` (or a second positional argument after the cwd) does the same job with
one extra behaviour. fnclaude checks the name against the project repository's
existing worktrees:

- **It matches an existing worktree.** fnclaude swaps its own cwd to that worktree and
  launches there.
- **It matches nothing.** The name passes through to claude as a new-worktree request.

Either way `--name` is set, so the session is labelled for the workspace you are in.

```sh
fnc ~/src/proj feature      # second positional, same as -w feature
fnc -w fix-lid-sync ~/src/proj
```

## Where worktrees land

Paths come from `repoSettings` in `~/.claude/settings.json` —  `worktreeTemplate` for
the directory and `branchTemplate` for the branch — which fnclaude shares with the
claude-code-worktree-paths plugin. Settings are layered across the project, local, and
managed tiers in standard claude-settings precedence, so a repository can override the
default placement.

## Auto-tmux

Creating a worktree is a natural moment to want a fresh tmux session. With this in
`config.toml`:

```toml
[auto]
tmux = "worktree"
```

fnclaude injects `--tmux` whenever `-w <name>` creates a new worktree. Pass
`--no-tmux` to skip it for a single invocation without editing config. The default is
`tmux = "never"`.
