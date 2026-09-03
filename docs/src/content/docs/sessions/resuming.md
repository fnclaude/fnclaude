---
title: Resuming & continuing
description: Pick a session back up with one word, from any directory, even one that lives somewhere else.
---

Three magic words cover picking work back up. They share the positional slots with
the model and effort words, and their order among themselves and the path does not
matter:

| Word | Short | Becomes |
| --- | --- | --- |
| `resume` | `res` | `--resume`, the session picker |
| `continue` | `con` | `--continue`, the most recent session |
| `fork` | `fk` | `--resume --fork-session`, branch off a session |

```sh
fnc resume         # pick from this project's sessions
fnc continue       # straight back into the last one
fnc fork           # pick one, then branch instead of extending it
```

## A project you are not in

Add a path and the picker shows that project's sessions instead of the current
directory's:

```sh
fnc resume ~/src/proj
fnc resume arch-setup
```

The second form takes any reference from
[Repo resolution](/reference/repo-resolution/). Resume by name without knowing where
the clone lives.

## Cross-cwd resume

In claude's resume picker, <kbd>Ctrl-A</kbd> lists sessions from every directory, not
just the current one. Pick one from another project and claude cannot open it from
here. It prints a line telling you to `cd` there and run `claude --resume` with the
session id.

fnclaude reads that line and does it. It relaunches itself in the session's own
directory with the session id attached and every flag from your original invocation
kept. From where you sit, the session just opens.

```sh
fnc resume
# Ctrl-A, pick a session from another project. fnc relaunches there.
```

One case is refused on purpose: a session whose recorded directory no longer holds
its log, usually because it ran in a worktree that has since been removed. Relaunching
there would only bounce back to the picker, so fnclaude says what happened and stops.
