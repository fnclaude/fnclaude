---
title: Installation
description: Install the fnc binary, and what it needs on the machine to run.
---

fnclaude is on npm. A global install gives you the `fnc` binary:

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

## Requirements

- **[Bun](https://bun.sh/).** `fnc` runs under Bun. You can install the package with
  npm, but the binary re-executes itself under `bun` on launch, and fails with a
  pointer to the Bun installer if `bun` is not on your `PATH`. Node alone is not
  enough.
- **The `claude` CLI on your `PATH`.** `fnc` resolves where the session should run,
  translates your arguments, and hands off to claude. Without claude installed it
  stops with a message pointing you at Claude Code.

## Platform support

Linux and macOS. The code has a Windows fallback path, but it has never been
exercised. Expect breakage there.

## Configuration files

Both are optional.

| Path | What it holds |
| --- | --- |
| `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json` | fnclaude's own: auto-tmux, auto-handoff, the command that opens a new terminal window for a sibling session, default claude flags, and environment injected into every claude child. |
| `$XDG_CONFIG_HOME/rhombus.rocks/config.json` | Shared with fngit and the worktree-paths plugin: `cloneTemplate`, `worktreeTemplate`, `branchTemplate`, `additionalSrcDirs`, `hostAliases` under `repos`. fnclaude does not read this file — fngit does. |

`fnc install` writes both. Either may also be `.jsonc`, `.toml`, or `.yaml`; fnclaude writes JSON so editors pick up the `$schema` line.

The keys are on [CLI flags](/reference/cli-flags/).
