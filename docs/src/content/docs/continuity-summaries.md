---
title: Continuity summaries
description: The /compact-style handoff fnclaude carries between sessions, and what belongs in one.
---

A continuity summary is what makes a session transfer feel like a continuation rather
than a restart. Every fnclaude handoff carries one: the model writes it before the
call, and fnclaude passes it to the session it launches at the destination.

The target is the fidelity `/compact` preserves. The receiving session should feel as
if the whole conversation had happened there from the start.

## What goes in one

The prompt fnclaude ships asks the model to capture, in `/compact`'s shape and density:

- What you asked for, in your own words where possible.
- Decisions made during the conversation, with the reasoning behind them.
- Files read or edited, and what was learned from them.
- Work completed.
- Work that was **in flight** when the switch was requested. This is the critical one —
  it is what lets the receiving session pick up the thread instead of starting over.
- Open questions and pending decisions.
- Observations about you specifically that surfaced during the session.

It is explicitly not padded, and it does not restate structural truths the receiving
session can derive for itself.

## Where summaries are used

| Situation | Tool | This session |
| --- | --- | --- |
| Move to another project | `fnc_switch_project` | Killed and re-launched at the destination |
| Open a second project alongside | `fnc_spawn_session` | Keeps running |
| Restart in place | `fnc_restart` | Re-execed with context preserved |

Switching and spawning both take a `summary` argument. Restarting does not need one —
it preserves the conversation directly rather than reconstructing it.

Each also takes a `name`: a three-to-six-word kebab-case topic such as `fix-auth-bug`,
used as the session label at the destination.
