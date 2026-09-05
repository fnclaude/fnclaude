---
title: Repo resolution
description: Every reference form fnc accepts for a destination, and the order it tries them in.
---

`fnc` takes a repository reference the way you would say it and turns it into a
directory. You never work out the path, and neither does the model. The reference
goes through verbatim.

fnclaude does not resolve repository references itself. It hands them to
[fngit](https://www.npmjs.com/package/@rhombus.rocks/fngit), which owns the whole
job — parsing the reference, expanding your clone template, searching your source
directories, asking GitHub who owns a bare name, and cloning when there is nothing
on disk yet. fnclaude runs `fngit clone <reference>` and launches in the path it
prints.

## Accepted forms

| Form | Example | How it resolves |
| --- | --- | --- |
| Absolute path | `/home/tom/src/proj` | Used as is. fnclaude, not fngit. |
| Home-relative | `~/src/proj` | Expanded, then used as is. fnclaude, not fngit. |
| Explicitly relative | `./proj` | Relative to the current directory. Also the escape hatch for a directory named like a repository. |
| Bare name | `arch-setup` | A directory of that name in your current directory wins; otherwise fngit matches it against your existing clones, then your GitHub user and orgs. |
| `name@owner` | `arch-setup@fnclaude` | Owner is known. No search. |
| `owner/name` | `fnclaude/arch-setup` | Same. |
| `gh:owner/name` | `gh:fnclaude/arch-setup` | Same. |
| HTTPS URL | `https://github.com/fnclaude/arch-setup` | Host, owner, and name come from the URL. |
| SSH URL | `git@github.com:fnclaude/arch-setup` | Same. |

Any of them may carry a `+workspace` suffix, as in `arch-setup+fix-lid-sync`. That
is fnclaude's, not fngit's: fnclaude strips it, resolves the repository, then adds a
worktree beside it. See [Worktrees](/sessions/worktrees/).

## Resolution order

1. **No argument.** fnclaude launches in its starting directory, described below.
2. **An explicit path.** Anything starting with `/`, `~`, `.`, or `..` is a path and
   nothing else. fnclaude launches there without checking that it exists. You said
   go here, so it goes here.
3. **A bare word naming a directory in your current directory** launches in that
   directory. `fnc packages` inside a monorepo opens `./packages`; it does not go
   looking for a repository called "packages".
4. **Anything else** goes to fngit. It resolves or it fails, and fnclaude relays
   its reason verbatim.

To force the other reading of an ambiguous word: `./name` for the directory,
`name@owner` for the repository.

## Where clones and worktrees land

From the shared configuration at `~/.config/rhombus.rocks/config.json`:

```json
{
  "repos": {
    "cloneTemplate": "~/src/{repo}@{owner}",
    "worktreeTemplate": "~/src/{repo}@{owner}+{input}",
    "branchTemplate": "{input}",
    "additionalSrcDirs": ["~/.local/src", "~/code"],
    "hostAliases": { "git.example.com": "ex" }
  }
}
```

fngit reads it for clone destinations and search paths; the worktree-paths plugin
reads it for worktree creation. fnclaude reads none of it — one file, one layout,
shared by the tools that act on it.

## fngit is optional

Without fngit on your `PATH`, fnclaude accepts only real paths — absolute,
`~`-anchored, or `./`-relative. A repository reference then errors with a message
naming `fnc install`, the wizard that sets fngit up.

```sh
npm install -g @rhombus.rocks/fngit
```

## No argument at all

A bare `fnc` launches in `~/.config/rhombus.rocks/fnclaude/noop`, a neutral
directory, rather than wherever your shell happened to be. Set `noopDir` in the
config to put it elsewhere. On the first such launch fnclaude copies a handoff
template into it. Everything else in that directory is yours and never touched.
