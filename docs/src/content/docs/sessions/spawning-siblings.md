---
title: Spawning siblings
description: Open a second fnclaude session in a new terminal window without abandoning the current one.
---

`fnc_spawn_session` opens a sibling session for a different project in a new terminal
window and **leaves the current session running**. Use it when, mid-task, you find an
unrelated task in another repository and do not want to drop what you are doing here.

Two tracks in parallel, neither waiting on the other. If the current session *should*
be replaced, use [Switching projects](/sessions/switching-projects/) instead.

## No cancellation window

Unlike a switch, spawning needs no countdown. The current session survives regardless,
so there is nothing to cancel. The model calls once and carries on.

## A spawn is a fresh start

Spawning does **not** inherit the current session's startup flags. The sibling begins
with whatever you ask for explicitly, and nothing else. The overridable arguments are
the same set as a switch: model, effort, permission mode, allowed tools, agent, and
the `--brief` / `--chrome` / `--ide` / `--verbose` switches — all applied to the
sibling, never to the session you are in.

It still carries a [continuity summary](/continuity-summaries/), scoped to the
sibling's task: what you want done over there, with enough context to start cold.

## Opening the window

fnclaude needs a way to open a terminal. Set it in
`$XDG_CONFIG_HOME/fnclaude/config.toml`:

```toml
[auto]
spawn_command = "..."
```

With no launcher available, the tool returns a `paste_flow` result — fnclaude renders
the command and you paste it into a new terminal yourself.
