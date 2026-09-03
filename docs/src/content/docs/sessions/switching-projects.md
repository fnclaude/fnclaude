---
title: Switching projects
description: Replace this session with one in another repository, and carry the conversation across.
---

Ask to switch projects and the model calls `fnc_switch_project`. This session ends
and fnclaude relaunches at the destination with a written summary of the
conversation, so the new session starts already briefed.

This is the one that ends a session. To keep this one and open a second beside it,
see [Spawning siblings](/sessions/spawning-siblings/). To restart where you are, see
`fnc_restart` in the [Tool reference](/reference/tools/).

## The countdown

The call ends the session, so the model warns you first. It prints a line like
*"Transferring in 3 seconds. Ctrl-C to cancel"* and sleeps. If the sleep finishes,
the switch fires. Interrupt it and nothing happens.

## The summary that travels

Before calling, the model writes a summary of the conversation so far: what you
asked for in your own words, the decisions made and why, the files read or edited,
what is finished, what is still in flight, and any open questions. In-flight work is
the part that matters most. It is what lets the new session pick up the thread
instead of starting over.

With it goes a `name`, a three-to-six-word kebab-case topic such as `fix-auth-bug`,
which labels the session at the destination.

## What you pass

Say the destination the way you would say it out loud. The model passes it through
verbatim and fnclaude's resolver finds it, cloning if it has to:

```sh
# all valid destinations
arch-setup
arch-setup@fnrhombus
fnrhombus/arch-setup
https://github.com/fnrhombus/arch-setup
~/src/dots
arch-setup+fix-lid-sync
```

The full grammar is on [Repo resolution](/reference/repo-resolution/).

If the request is ambiguous to the model, say "switch me to the other one" with no
name, it asks which rather than guessing.

## What carries over

The flags you started this session with carry over, minus a denylist of ones that
belong to the old destination: `--add-dir`, `--mcp-config`, `--from-pr`, `--name`,
and similar. The live permission mode is read from the session's own log rather
than assumed.

Ask for a change and the model overrides that one flag for the destination: model,
effort, permission mode, allowed tools, agent, or the `--brief`, `--chrome`, `--ide`,
and `--verbose` switches.

## When auto-handoff is off

With auto-handoff disabled in config, the tool returns `paste_flow` instead of
transferring. fnclaude renders the equivalent command and puts it on your clipboard,
and you run it yourself.
