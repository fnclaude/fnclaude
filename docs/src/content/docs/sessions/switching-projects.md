---
title: Switching projects
description: Replace the current session with one rooted in another repository, carrying the conversation across.
---

Ask to switch projects and the model calls `fnc_switch_project`. The current session
is killed and fnclaude re-execs at the destination, carrying a
[continuity summary](/continuity-summaries/) so the new session opens knowing what it
is there for.

This is the destructive one. To keep the current session running and open a second
alongside it, use [Spawning siblings](/sessions/spawning-siblings/) instead. To
restart where you are, see `fnc_restart` in the [Tool reference](/reference/tools/).

## The cancellation window

The call ends the session, so it is one-shot and it warns you first. Before calling,
the model prints a short line such as *"Transferring in 3 seconds. Ctrl-C to cancel"*
and runs a sleep. If the sleep completes uninterrupted, the switch fires. Interrupt it
and nothing happens.

## What you pass

You pass a destination the way you would say it out loud. Resolution happens inside
fnclaude, not in the model — the reference goes through verbatim, and fnclaude's
resolver finds it, cloning if necessary:

```sh
# all of these are valid destinations
arch-setup
arch-setup@fnrhombus
fnrhombus/arch-setup
https://github.com/fnrhombus/arch-setup
~/src/dots
arch-setup+fix-lid-sync
```

The full grammar is on [Repo resolution](/reference/repo-resolution/).

If the request is ambiguous to the *model* — "switch me to the other one", with no
name — it asks you which, rather than guessing.

## What carries over

fnclaude preserves the flags you started the original session with, minus a denylist
of ones that belong to the old destination (`--add-dir`, `--mcp-config`, `--from-pr`,
`--name`, and friends). The live permission mode is captured from the session's own
log rather than assumed.

Individual flags can be overridden for the destination when you ask for it: model,
effort, permission mode, allowed tools, agent, and the `--brief` / `--chrome` /
`--ide` / `--verbose` switches.

## When auto-handoff is off

With auto-handoff disabled in config, the tool returns a `paste_flow` result instead
of transferring: fnclaude renders the equivalent command and you paste it yourself.
`fnc_copy_to_clipboard` exists to make that one keystroke.
