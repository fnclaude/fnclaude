---
title: Model & effort
description: Set the model and reasoning effort at launch, or change either one mid-session.
---

Model and effort can be chosen when the session starts, or changed while it is
running. The launch-time and in-session paths are separate mechanisms with slightly
different vocabularies.

## At launch

The first two positional slots accept a model alias and an effort level. `fnc`
intercepts them before claude sees the arguments:

```sh
fnc opus max ~/src/proj     # --model opus --effort max
fnc sonnet ~/src/proj       # --model sonnet
fnc high ~/src/proj         # effort alone at position 1 implies opus
fnc ~/src/proj              # no model flag — claude picks the default
```

| Slot | Accepted words |
| --- | --- |
| Model alias | `opus`, `sonnet`, `haiku`, `fable` |
| Effort level | `low`, `medium`, `high`, `xhigh`, `max`, `auto` |

Scanning is left-to-right at the head of argv, before any flags. A directory that
happens to be named `opus` is reachable as `./opus`.

## Mid-session

Two tools change the live session in place, with no restart and no lost context:

- **`fnc_set_model`** — `opus`, `sonnet`, or `haiku`.
- **`fnc_set_effort`** — `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.

Both are fire-and-forget — the change applies to the running session and nothing comes
back through the tool.

## Across a restart

`fnc_restart` re-execs the session in place with conversation context preserved, and
takes `model` and `effort` overrides among its optional arguments. Omit them and the
startup values are preserved.

Effort is the one value worth passing explicitly on a restart: claude updates
`$CLAUDE_EFFORT` when you run `/effort`, so the live level is readable from a shell
but is not otherwise visible to fnclaude. The tool descriptions tell the model to read
that variable before calling.
