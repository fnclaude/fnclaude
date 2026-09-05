# OOBE interview — literal text

The in-session first-run interview (`fnc install`). Design and decisions: `TODO.md` § Restructure → In-session OOBE. This file is the **literal user-facing text**, reviewed by the owner on 2026-09-04. Implement it verbatim; do not paraphrase, reorder, or add questions.

Mechanics recap:

- fnc builds the questionnaire deterministically as data (a plan). The model only relays: it calls `fnc_oobe_next`, presents the returned batch with one `AskUserQuestion` call, posts each answer with `fnc_oobe_answer`, repeats until the plan returns null. `fnc_oobe_reask(id)` re-presents one question (used from the Apply screen's free-text slot).
- Batches are grouped by context, at most 4 questions per batch and at most 4 options per question (`AskUserQuestion` limits). "Other" (free text) is added automatically by the tool; `<type something>` below marks where free text is the intended path and what to say in its description.
- The first option is always the recommended one and carries "(Recommended)" or "(Highly Recommended)" in its label.
- A question is skipped when its key is already configured. A batch whose questions are all skipped is not shown. Progress is printed in the session before each batch (`Repos (2/6)`) and in the question's header chip (≤12 chars); the denominator counts the batches that will actually be shown.
- Every answer is written to the config file as soon as it is given. Everything else (mkdir of the noop dir, installing tools, PATH/shim edits, `noOobe = true`, the restart) waits for Apply.
- The wizard session runs in the shell cwd with `--no-session-persistence`, `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash`, `--permission-mode default`, and the `oobe.md` fragment injected instead of `noop-router.md`. It never fires for non-interactive launches (`-p`, stream-json, cloud).
- In oobe mode ref resolution is skipped entirely; after Apply fnc re-execs with the ORIGINAL argv (same trigger `fnc_restart` uses).

---

**Tools (1/6)**

- **Install fngit to resolve repo names?** With it, `fnc fnclaude` finds the repo in your source directories or clones it from GitHub, at the path your clone template says. Without it, fnc only accepts real paths to repos you've cloned yourself.
  - Yes (Highly Recommended)
  - No
- **Install the worktree-paths plugin for Claude Code?** When Claude Code creates a worktree, it buries it inside the repo at `.claude/worktrees/<name>/` and names the branch `worktree-<name>`. Install this to override both, using the templates in the next questions.
  - Yes (Highly Recommended)
  - No

**Repos (2/6)** — clone template and "other places" only if fngit was accepted; worktree template if either tool was accepted; branch template only if the hook was accepted; batch skipped if both were declined.

- **Where should fnc clone repos to?** fnc performs best when it can derive the owner, repo, and branch from the directory name alone, without opening any files. Placeholders: `{repo}`, `{owner}`, `{host}` e.g. `github.com`, `{host-plain}` e.g. `github`, `{host-short}` e.g. `gh`
  - `~/src/{repo}@{owner}` (Recommended)
  - <type something>
- **Where should worktrees go?** Placeholders: `{repo}`, `{owner}`, `{host}` e.g. `github.com`, `{host-plain}` e.g. `github`, `{host-short}` e.g. `gh`, `{input}` the requested worktree name, `{branch}` the branch name from the next question, `{clone-path}` absolute path of the main checkout e.g. `{clone-path}+{branch}`, `{repo-dir}` directory name of the main checkout, `{cwd}` directory name the request came from
  - `~/src/{repo}@{owner}+{input}` (Recommended)
  - <type something>
- **How should new branches be named?** Placeholders: `{input}` the requested worktree name, `{repo}`, `{owner}`, `{repo-dir}`, `{cwd}`, `{host}`, `{host-plain}`, `{host-short}`
  - `{input}` (Recommended) — same as the worktree name
  - <type something>
- **Other places to search for repositories.** These are searched before asking GitHub. Nothing is ever cloned into them.
  - `~/.local/src, ~/code, ~/dev, ~/projects, ~/Projects, ~/workspace, ~/repos, ~/git, ~/go/src/*/*, /usr/local/src, /usr/src, /opt` (Recommended) — fngit's standard list
  - None — only the clone directory is searched
  - <type something> — comma-separated; globs allowed

**Sessions (3/6)**

Printed as session text before the batch:

> fnc can start a session with no project at all. Run `fnc` with no path and Claude opens in a small directory that belongs to fnc, with a prompt that acts as a router: you describe what you want, and it either answers directly or transfers you to the right place. It's the place to start when you don't yet know which repo the work belongs in, or have a task that doesn't belong to any project or repository.

- **Where should fnc's starting directory live?**
  - `~/.config/rhombus.rocks/fnclaude/noop` (Recommended)
  - <type something>
- **How should fnc open a new terminal window?** Used when fnc spawns a session. Placeholders: `{bin}` fnc's own path, `{dest}` the project to open, `{name}` the session name, `{summary}` the handoff summary file
  - `<current terminal> … {bin} {dest} --name {name} @{summary}` (Recommended) — your current terminal
  - one line per other installed terminal emulator, e.g. `kitty {bin} {dest} --name {name} @{summary}` — also installed
  - `tmux new-window -d {bin} {dest} --name {name} @{summary}` — when running inside tmux
  - <type something>
- **When should fnc add `--tmux`?** Claude Code has no setting for this, so fnc supplies the default.
  - Never (Recommended)
  - Always
  - When creating a new worktree — `fnc -w <name>` with no existing match opens in tmux
- **How should session transfers be handled?**
  - Delay 3 seconds (Recommended) — Ctrl+C during the countdown cancels
  - Proceed immediately
  - Ask each time
  - <type something> — number of seconds to delay

**Claude and git (4/6)** — git shim question only if fngit was accepted.

- **Which claude flags should fnc pass on every launch?** Claude Code has no setting for these, so fnc supplies the default. Pick any. (multi-select)
  - `--chrome` — enable the Claude in Chrome browser integration
  - `--brief` — enable the SendUserMessage tool for short status pings
  - `--ide` — connect to a running IDE automatically on startup
  - `--verbose` — show full tool output in the transcript
  - <type something> — any other flags, space-separated
- **Put a `git` shim first on your PATH?** Every `git clone <name>` from any shell, script, or editor then gets the lookup. Everything else passes straight through to git.
  - Yes (Recommended)
  - No

**Apply (5/6)**

- **Ready to apply?** Above is every file that will be written and every command that will be run.
  - Apply (Recommended)
  - Abort — keep the answers saved so far, run nothing
  - <type something> — tell me what to change, e.g. "the clone template"

**Done (6/6)** — printed, no question:

> Two things you didn't get asked about, for when you want to dig in:
> - **Host aliases** for `{host-short}` default to `gh`, `gl`, `bb`, `cb`. Add or change them under `repos.hostAliases` in `~/.config/rhombus.rocks/config.json`.
> - **Prompt overrides**: any file you drop in `~/.config/rhombus.rocks/fnclaude/prompts/` replaces fnc's packaged system prompt of the same name. The `README.txt` there lists the names.
>
> Re-run this any time with `fnc install`.

Then, if a scan of `~/.claude/CLAUDE.md` finds lines mentioning worktrees, clones, or source paths (heuristic grep: `worktree`, `clone`, `~/src`), print them under: "Your `~/.claude/CLAUDE.md` mentions worktrees or clone paths on these lines; check they agree with the templates you just set:".

Not asked (config-only keys): `exec.env`, `context.*` notices, `repos.hostAliases`.
