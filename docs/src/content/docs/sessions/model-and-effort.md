---
title: Model & effort
description: Set model and effort at launch, or change either while the session runs.
---

Pick the model and effort when the session starts, or change them while it runs. The
two paths are separate mechanisms and accept slightly different words.

## At launch

The first two positional slots take a model alias and an effort level. `fnc` turns
them into flags before claude sees the arguments:

```sh
fnc opus max ~/src/proj     # --model opus --effort max
fnc sonnet ~/src/proj       # --model sonnet
fnc high ~/src/proj         # effort alone implies opus
fnc ~/src/proj              # no model flag; claude picks its default
```

| Slot | Words |
| --- | --- |
| Model alias | `opus`, `sonnet`, `haiku`, `fable` |
| Effort level | `low`, `medium`, `high`, `xhigh`, `max`, `auto` |

The words are read left to right at the head of argv, before any flag. A directory
named `opus` is reachable as `./opus`.

## Mid-session

Two tools change the running session in place. No restart, nothing lost:

- **`fnc_set_model`** takes `opus`, `sonnet`, or `haiku`.
- **`fnc_set_effort`** takes `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.

Both are fire-and-forget. The change applies and nothing comes back through the tool.

## Across a restart

`fnc_restart` relaunches the session in place with the conversation intact, and takes
`model` and `effort` among its optional overrides. Leave them out and the startup
values carry over.

Effort is the one worth passing every time. claude updates `$CLAUDE_EFFORT` when you
run `/effort`, so a shell can read the live level, but fnclaude cannot see it any
other way. The tool descriptions tell the model to read that variable before calling.
