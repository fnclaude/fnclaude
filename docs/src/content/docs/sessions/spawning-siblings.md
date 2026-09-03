---
title: Spawning siblings
description: Open a second session in a new terminal window without leaving the current one.
---

`fnc_spawn_session` opens a sibling session for a different project in a new
terminal window and **leaves this session running**. Use it when a task in another
repository turns up mid-flow and you do not want to drop what you are doing here.

Two sessions, side by side, neither waiting on the other. If this session should be
replaced instead, see [Switching projects](/sessions/switching-projects/).

## No countdown

A switch gives you a few seconds to cancel because it ends the session. A spawn
does not end anything, so there is nothing to cancel. The model calls once and
carries on.

## A fresh start

A spawn does **not** inherit this session's startup flags. The sibling starts with
what you ask for and nothing else. The overrides are the same set as a switch: model,
effort, permission mode, allowed tools, agent, and the `--brief`, `--chrome`, `--ide`,
and `--verbose` switches. They apply to the sibling, never to this session.

It does carry a written summary, scoped to the sibling's task: what you want done
over there, with enough context to start cold.

## Opening the window

fnclaude needs a command that opens a terminal. Set one in
`$XDG_CONFIG_HOME/fnclaude/config.toml`:

```toml
[auto]
spawn_command = "..."
```

The value is split on whitespace. Each token may contain `{bin}` (the fnc binary),
`{dest}` (the destination), `{name}` (the session name), and `{summary}` (the path to
the summary file). No shell is involved, so a destination with spaces stays one
argument.

Without one, being inside tmux is enough: fnclaude opens the sibling in a new tmux
window. With neither, the tool returns `paste_flow`. fnclaude renders the command,
puts it on your clipboard if it can, and you paste it into a new terminal yourself.
