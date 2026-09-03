---
title: Model & effort
description: Set model and effort at launch with bare words instead of flags.
---

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

## Across a restart

`fnc_restart` relaunches the session in place with the conversation intact, and takes
`model` and `effort` among its optional overrides. Leave them out and the startup
values carry over.

Effort is the one worth passing every time. claude updates `$CLAUDE_EFFORT` when you
run `/effort`, so a shell can read the live level, but fnclaude cannot see it any
other way. The tool descriptions tell the model to read that variable before calling.
