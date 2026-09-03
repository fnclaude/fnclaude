---
title: Installation
description: Install the fnc binary, plus the runtime and platform requirements fnclaude expects.
---

fnclaude publishes to npm. Install it globally and you get the `fnc` binary:

```sh
npm i -g fnclaude
```

Then confirm it resolved:

```sh
fnc --version
```

:::note
`-v` and `--version` print *fnclaude's* version. `fnc` claims the flag before claude
sees it, so reach claude's own version with `claude --version` directly.
:::

## Requirements

- **[Bun](https://bun.sh/) 1.0 or later.** fnclaude ships TypeScript that Bun executes
  directly, and the session machinery depends on Bun-specific process handling. You can
  install the package with npm, but `fnc` runs under Bun.
- **The `claude` CLI on your `PATH`.** fnclaude is a launcher: it resolves where the
  session should run, translates your arguments, and then execs claude. Without
  claude installed, `fnc` fails with a message pointing you at Claude Code.

## Platform support

Linux and macOS are supported. There is a Windows fallback path in the codebase
(`spawn` plus `process.exit` in place of `execve`), but it has never been exercised —
treat Windows as untested and expect breakage.

## Configuration files

fnclaude reads two files, both optional:

| Path | What it holds |
| --- | --- |
| `$XDG_CONFIG_HOME/fnclaude/config.toml` | Auto-naming model, auto-tmux behaviour, the spawn command for new terminal windows, environment injected into every claude child. |
| `~/.claude/settings.json` | `cloneTemplate`, `worktreeTemplate`, and `branchTemplate` under `repoSettings` — shared with the claude-code-worktree-paths plugin. |

The keys are listed in full on [CLI flags](/reference/cli-flags/).
