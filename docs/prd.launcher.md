# fnclaude — launcher features

Everything users experience when invoking fnclaude to start a claude session.

---

## Model and effort shortcuts

The first two words you type can be a model name and an effort level. fnclaude intercepts them before `claude` ever sees your command.

```sh
fnclaude opus max ~/src/proj     # full-power session in ~/src/proj
fnclaude sonnet ~/src/proj       # sonnet-class session
fnclaude haiku low ~/src/proj    # faster, lighter session
fnclaude max ~/src/proj          # max effort, opus implied
fnclaude ~/src/proj              # no model or effort; claude picks its defaults
```

Supported model names: `opus`, `sonnet`, `haiku`.
Supported effort levels: `low`, `medium`, `high`, `xhigh`, `max`, `auto`.

When you type a model name at position 1 and an effort level at position 2, both are passed to claude. When you type only an effort level at position 1 with no model before it, `opus` is implied — `fnc max ~/src/proj` is equivalent to `fnc opus max ~/src/proj`.

If you have a directory literally named `opus` or `haiku`, prefix it with `./` to prevent fnclaude from treating it as a model name: `fnclaude ./opus`.

---

## Session-type shortcuts

You can type `resume`, `continue`, or `fork` anywhere before any flags to jump straight to those session modes, in any order relative to the model and effort words.

```sh
fnclaude resume ~/src/proj            # open the session picker in proj
fnclaude opus max resume ~/src/proj   # same, but with model and effort set
fnclaude fork ~/src/proj              # pick a session and fork it
fnclaude continue ~/src/proj          # resume the most recent session in proj
```

Short aliases: `res` for resume, `con` for continue, `fk` for fork. Only one session-type word per invocation; using two is an error.

---

## Directory targeting

The first path you give after any model/effort/session words is where claude launches. You can use absolute paths, `~`-prefixed paths, or relative paths:

```sh
fnclaude ~/src/proj            # home-relative
fnclaude /absolute/path        # absolute
fnclaude ./relative/path       # relative to where you're standing
```

You can also type a bare repo name, a `name@owner` reference, an `owner/name` form, a `gh:owner/name` shorthand, or a full URL — fnclaude finds the clone in your configured location or clones it fresh:

```sh
fnclaude arch-setup                              # bare name: searches your orgs
fnclaude fnclaude@fnrhombus                      # name@owner form
fnclaude fnrhombus/fnclaude                      # owner/name form
fnclaude gh:fnrhombus/fnclaude                   # gh: shorthand
fnclaude https://github.com/fnrhombus/fnclaude   # HTTPS URL
fnclaude git@github.com:fnrhombus/fnclaude.git   # SSH URL
```

For a bare repo name like `arch-setup`, fnclaude searches your authenticated GitHub account — your personal login first, then each of your organizations — until it finds a match. If you give a form that already names an owner (any form other than bare name), only that owner is checked.

The `name@owner` form (`fnclaude@fnrhombus` above) comes from the clone naming template in your shared worktree-paths config (see [Repo naming template](#repo-naming-template) below). The other reference forms — bare name, `owner/name`, SSH URLs, HTTPS URLs — are non-configurable requirements.

When fnclaude finds the repo on GitHub but you don't have it cloned, it clones it to your configured clone location and then launches there. If you give a name that could be both a local directory and a GitHub repo, fnclaude tells you and asks you to be explicit.

A second positional argument (after the directory) is treated as a worktree name — the same as passing `-w`. See [Worktree intercept](#worktree-intercept) below.

---

## Multiple directories — ON ICE

> **Status: deferred.** The `-A`/`--also` multi-dir feature is on ice. The flag exists in the current implementation but this feature set is not being carried forward in the rewrite without further scope definition.

Need claude to see a second project's configuration alongside the main one? Pass it with `-A` or `--also`:

```sh
fnclaude ~/src/proj -A ~/src/shared-tools
fnclaude ~/src/proj -A ~/src/tools -A ~/src/config
```

For each additional directory, fnclaude automatically wires in that directory's MCP configuration and settings files when they exist. You don't specify which files — fnclaude looks for them in the standard locations and includes them if present.

---

## Inline prompts and auto-naming

Add `--` after your other arguments to pass a prompt directly. Claude starts immediately with that prompt as its first instruction:

```sh
fnclaude sonnet ~/src/proj -- "add integration tests for the payments module"
fnclaude . -- "what does this codebase do?"
```

When you pass an inline prompt and haven't already set a session name, fnclaude generates a short label for the session automatically — something like `refactor-auth-module` or `add-payment-tests`. This label shows up in claude's session history so you can find the conversation later.

The label is generated by asking a lightweight AI model to read your prompt and produce a 1–3 word hyphenated summary. If the call fails or times out, fnclaude falls back to picking the first few meaningful words from your prompt itself.

Auto-naming is skipped when you explicitly set `--name`, when you're resuming an existing session (`resume`, `continue`, `fork`), or when you're using a print-mode invocation (`--print`).

Any session name you supply or that fnclaude generates is cleaned up before reaching claude. Characters that would be problematic in file paths or branch names are replaced with a single hyphen — runs of problematic characters collapse to one hyphen, so `foo!!bar` becomes `foo-bar` rather than `foo--bar`. You'll see a note in your terminal after the session ends if fnclaude changed your name.

`--name` is always set, whether you're creating a new worktree or resuming an existing one.

---

## Worktree intercept

When you pass `-w <name>` (or a worktree name as the second positional), fnclaude checks whether that name matches an existing worktree of the current project:

```sh
fnclaude ~/src/proj -w feature-branch   # if feature-branch worktree exists, launch there
fnclaude ~/src/proj -w new-thing        # if no match, creates a new worktree named new-thing
```

When a match is found, fnclaude changes to that worktree's directory without creating anything new. `--name` is set to the worktree name in both cases — whether fnclaude is entering an existing worktree or creating a new one.

When there is no match, the name is passed through to claude as a new worktree request and also becomes the session name.

Shell completions for `-w` suggest your existing worktrees by name, so you can tab-complete into the right one.

---

## Short flags

`claude`'s long options are the right form, but slow to type. fnclaude maps each common one to a capital-letter short flag:

| Short | Equivalent |
|---|---|
| `-B` | `--brief` |
| `-C` | `--chrome` |
| `-D` | `--dangerously-skip-permissions` |
| `-F` | `--fork-session` |
| `-G <agent>` | `--agent <agent>` |
| `-I` | `--ide` |
| `-M <mode>` | `--permission-mode <mode>` |
| `-P` | `--from-pr` |
| `-R` | `--remote-control` |
| `-T` | `--tmux` |
| `-V` | `--verbose` |
| `-W <tools>` | `--allowedTools <tools>` |

You can collapse multiple no-value flags into a single token: `-BVC` is the same as `-B -V -C`. The last flag in a collapsed group may also take a value: `-BVCM plan` parses as `-B -V -C -M plan`, where `-M` consumes `plan` as its argument. Flags that require a value (`-G`, `-M`, `-W`) cannot appear in the middle of a collapsed group — they must be the final character, or fnclaude reports an error.

Any `claude` flag not in this table passes through verbatim — fnclaude doesn't interfere with flags it doesn't know about.

fnclaude's own flags:

| Flag | What it does |
|---|---|
| `-A <dir>` / `--also <dir>` | Add an extra directory (repeatable) — ON ICE, see above |
| `--no-tmux` | Suppress auto-tmux for this one launch |
| `-h` / `--help` | Show fnclaude's flag reference |
| `-v` / `--version` | Print fnclaude's version |

Note: `-v` is claimed by fnclaude and prints fnclaude's version, not claude's. Use `claude --version` directly if you need claude's version.

---

## Auto-tmux

If you use `auto.tmux = "worktree"` in your config, fnclaude automatically adds `--tmux` whenever you're creating a new worktree (i.e., when you pass `-w <name>` and no existing worktree matched). You don't have to remember to type it yourself every time you open a new worktree session.

This is off by default. Suppress it for a single launch with `--no-tmux` without touching your config.

---

## Config file

Persistent preferences live at `~/.config/fnclaude/config.toml`:

```toml
[name]
model = "claude-haiku-4-5"   # which model generates session names
timeout = "3s"               # how long to wait for the naming call

[auto]
tmux = "never"      # "never" | "worktree"
handoff = "ask"     # "never" | "ask" | N (seconds countdown)
spawn_command = ""  # template for opening new terminal windows

[exec.env]
MY_VAR = "value"    # injected into every claude session you launch
```

All settings can also be set via environment variables — see `fnclaude --help` for the full list. Environment variables override config file settings; command-line flags override both.

---

## Cross-cwd resume

When you open claude's session picker and select a session from a different project directory, claude normally prints a message telling you to `cd` there and run a command. fnclaude intercepts that message and does it for you — the new session opens in the right directory without you doing anything. From your perspective, the picker just works across all your projects.

This feature is fully supported on Linux and Windows. On macOS it also works, though macOS is a secondary target: fnclaude's daily-driver platform is Linux, with Windows as its first-class peer. All flags and settings from your original invocation are preserved in the relaunch.

---

## Repo naming template

The `name@owner` reference form — and where cloned repos land on disk — comes from the `cloneTemplate` field in the shared `repoSettings` config block. This is the same config block the `claude-code-worktree-paths` plugin reads for its `worktreeTemplate` and `branchTemplate`. You set it once in `~/.claude/settings.json` and both fnclaude and the plugin use it.

Example `~/.claude/settings.json`:

```json
{
  "repoSettings": {
    "cloneTemplate": "~/src/{repo}@{owner}",
    "worktreeTemplate": "~/src/{repo}@{owner}+{input}",
    "branchTemplate": "{input}"
  }
}
```

With `cloneTemplate: "~/src/{repo}@{owner}"`, typing `fnc fnclaude@fnrhombus` resolves to `~/src/fnclaude@fnrhombus` on disk. The `name@owner` form is not a fixed requirement — it is whatever your template produces. Change the template and the directory shape changes with it.

Project-level settings (`.claude/settings.json` in the repo) and local overrides (`.claude/settings.local.json`) can override per field. The managed system-level path (`/etc/claude-code/managed-settings.json` on Linux) takes highest precedence.

---

## No-op fallback

Running `fnclaude` with no directory launches a lightweight general-purpose session in a dedicated directory (`~/.config/fnclaude/noop`). This acts as a catch-all: ask questions, look things up, or ask claude to send you to the right project. See [In-session features: noop session routing](prd.in-session.md#noop-session-routing) for what happens when you ask it to do project work.

---

## Shell completion

Completions for zsh, bash, and fish are in the `completions/` directory of the release. All three include smart `-w`/`--worktree` completion that reads your existing worktrees from git.

- **zsh**: copy or symlink `completions/_fnclaude` to a directory in `$fpath`, then run `compinit`.
- **bash**: `source completions/fnclaude.bash` from your `.bashrc`.
- **fish**: copy `completions/fnclaude.fish` to `~/.config/fish/completions/`.

---

## Install

**npm (recommended):**
```sh
npm install -g @fnclaude/cli
```

Or with mise (keeps it project-local or per-user without global npm pollution):
```sh
mise use -g npm:@fnclaude/cli
```

**GitHub Releases:** grab the binary for your platform from the [releases page](https://github.com/fnrhombus/fnclaude/releases).

Linux is the daily-driver target. Windows and macOS binaries ship in every release and are fully supported — Windows is the first-class non-Linux platform.
