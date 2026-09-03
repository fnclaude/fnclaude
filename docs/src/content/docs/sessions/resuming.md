---
title: Resuming & continuing
description: Pick a session back up with one word, from any directory, including sessions that live somewhere else.
---

Three of `fnc`'s magic words cover picking work back up. They sit in the same
positional slot as the model and effort words, and they are order-independent among
themselves and the path:

| Word | Short form | Becomes |
| --- | --- | --- |
| `resume` | `res` | `--resume` — the session picker |
| `continue` | `con` | `--continue` — the most recent session |
| `fork` | `fk` | `--resume --fork-session` — branch off a session |

```sh
fnc resume         # pick from this project's sessions
fnc continue       # straight back into the last one
fnc fork           # pick one, then branch rather than extend it
```

## Resuming a project you are not in

Add a path and the picker scopes to that project instead of the current directory:

```sh
fnc resume ~/src/proj
fnc resume arch-setup
```

The second form takes any of the reference shapes from
[Repo resolution](/reference/repo-resolution/), so you can resume in a repository by
name without knowing where it lives on disk.

## Cross-cwd resume

Inside claude's resume picker, <kbd>Ctrl-A</kbd> widens the list to sessions from
*every* directory rather than just the current one. Pick one belonging to another
project and something has to happen about the mismatch: claude prints a line telling
you to `cd` there and re-run with the session id.

fnclaude reads that line and does it for you. It re-execs itself in the session's own
directory with the session id attached, and every flag from your original invocation
preserved. From where you are sitting, the session simply opens.

```sh
fnc resume
# Ctrl-A, choose a session from another project — fnc relaunches there
```

This is the one place `fnc resume` does something plain `claude --resume` cannot.
