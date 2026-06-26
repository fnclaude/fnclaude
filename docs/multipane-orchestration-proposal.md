# Multi-pane orchestration proposal

A design exploration for a TUI that hosts an Ink chrome, a real Neovim editor, and a Claude-conversation transcript renderer side-by-side, coordinated by a parent CLI orchestrator. Captured from an extended design conversation; not a commitment to build, just a record of the architecture and the tradeoffs that fall out of it.

## The target layout

Drawn by the user as five regions:

```
+-------------------------------------+
|  header                             |  (1) thin status strip
+--------+----------------+-----------+
|        |                |           |
| tabs   |   nvim         | transcript|  (3) (4) (5) — three vertical columns
| (Ink)  |                |           |
|        |                |           |
+--------+----------------+-----------+
|  footer                             |  (2) thin status strip
+-------------------------------------+
```

- **1, 2** — full-width header/footer strips
- **3** — vertical tabs corresponding to open branches/worktrees on a repo
- **4** — Neovim showing the worktree's codebase
- **5** — Claude conversation transcript for the selected worktree's agent (renderer "already handled in a separate project")

Behavior expected:

- Selecting a tab in **3** loads that worktree's transcript in **5** and that worktree's codebase in **4**.
- Each time the agent edits a file, **4** focuses on the changed file.

## Architectural shape

Tmux as **invisible plumbing** owns the screen layout. The parent CLI is the orchestrator. Ink and Neovim live in separate tmux panes; they don't talk to each other — they both talk back to the orchestrator over an out-of-band Unix socket.

```
[parent CLI: orchestrator]
   |
   |-- spawns tmux server (private socket via -L, custom config via -f)
   |     |-- top status bar       = region 1 (header)
   |     |-- pane: tabs (Ink)     = region 3
   |     |-- pane: nvim --listen  = region 4
   |     |-- pane: transcript     = region 5
   |     |-- bottom status bar    = region 2 (footer)
   |
   |-- opens unix socket $XDG_RUNTIME_DIR/yourapp/ctl.sock
         ^
         |
   Ink and transcript renderer connect back via the socket (path in env var)
```

Three tmux panes, not five. Tmux 2.9+ supports both top and bottom status bars (`set -g status 2`, `status-format[0]` for bottom, `status-format[1]` for top) — perfect fit for the chrome strips, no extra processes for them.

### Out-of-band channel

Why not extra file descriptors: tmux fork/execs each pane process with a fresh PTY and does not propagate arbitrary parent FDs. A Unix domain socket is the right answer — orchestrator creates it, passes the path via env var (e.g. `MYAPP_CTRL_SOCK`) to every pane process, panes connect on startup.

### Driving Neovim

Neovim runs in its own pane (rendered normally to that pane's TTY) AND exposes its full msgpack-RPC API on a `--listen` socket. The orchestrator can:

- `nvim_command(":e <path>")` to open a file — visible immediately in the pane
- Subscribe to autocommands (`BufEnter`, `ModeChanged`) and reflect state into Ink
- Query mode before stealing focus (don't yank focus while user is mid-insert)

This is the same mechanism used by neovim-remote, vim-slime, and various editor integrations. Stable, mature.

### Tmux as invisible plumbing

User never sees the word "tmux." Config:

```conf
unbind-key -a                    # nuke every default binding
set -g prefix None
set -g status 2                  # two status bars (top + bottom)
set -g pane-border-status off
set -g mouse on
set -g escape-time 0

# Global hotkeys — intercepted by tmux before any pane sees them.
bind -n M-1 run-shell "myapp-ctl focus-tab 1"
bind -n M-2 run-shell "myapp-ctl focus-tab 2"
bind -n M-e run-shell "myapp-ctl focus-editor"
bind -n M-r run-shell "myapp-ctl focus-tabs"
bind -n M-/ run-shell "myapp-ctl open-palette"
bind -n M-q run-shell "myapp-ctl quit"
```

Launched as:

```sh
tmux -L myapp-private -f myapp-tmux.conf new-session ...
```

`-L` isolates by socket name → does not show in user's `tmux ls`, does not collide with user's existing sessions, user's `~/.tmux.conf` ignored.

## Interaction flows

**User clicks a worktree tab in pane 3:**

1. Ink → orchestrator: `{op: "select_tab", worktree: "feat-foo"}`
2. Orchestrator:
   - `nvim_command(":cd /worktrees/feat-foo")` + `:e <last-file>` via RPC
   - Updates transcript renderer's data source to point at that agent's session
   - Optionally `tmux select-pane -t middle` if focus should move with the click
3. Ink updates tab highlight; nvim shows the worktree's code; transcript shows that agent's session.

**Claude (agent) edits a file:**

1. Transcript renderer (or whatever watches agent activity) emits `{event: "file_edited", path: "..."}` to orchestrator.
2. Orchestrator: `nvim_command(":e <path>")` via RPC; *optionally* `tmux select-pane -t middle`.
3. Nvim shows the new file. End-to-end latency: tens of ms locally.

**Global hotkeys regardless of focus:**

Tmux sees every keystroke before any pane does. `bind -n M-1 run-shell "myapp-ctl focus-tab 1"` works whether the user is mid-insert in nvim or focused on Ink. Hotkey budget is real: any key tmux grabs is a key Neovim can't use. Safe zone: Alt-modified keys, F-keys, Ctrl-Space. Avoid anything in Vim's natural command vocabulary.

## "Seamless" — what it takes

**Visually** indistinguishable from a single native TUI app if you:

- Nuke all tmux defaults (`unbind-key -a`, no prefix, no borders or 1-char styled-to-match borders)
- Drive both status bars' content from the orchestrator with your own format strings
- Pick consistent themes across Ink + nvim + transcript so colors don't fight at pane edges

**Interactively** seamless if you:

- Define your own hotkey scheme (M-letter / F-keys); user never types a tmux prefix
- Pre-spawn one nvim per worktree (one per tab) so tab switches are instant — no spawn latency or buffer-load stutter
- Push state from the orchestrator promptly (no polling)

**The honest catches:**

- **Auto-focus on Claude edits** interrupts a typing user. Mitigation: query nvim's mode via RPC before pulling focus; only auto-focus if user is in normal mode or has been idle >N seconds.
- **Mouse focus model.** When the user clicks a tab in Ink, mouse focus moves only if tmux mouse mode is on AND the orchestrator explicitly `select-pane`s after the click. Test carefully — tmux's mouse behavior at pane boundaries is subtle.
- **Multiple processes to coordinate.** Three panes = three processes (plus orchestrator + tmux + nvim's RPC channel). Startup ordering, crash detection, graceful restart — all things the orchestrator owns.

## Bundling and platform

Tmux is ISC-licensed → fine to bundle and redistribute inside a proprietary app. Build statically against musl on Linux (~1.5 MB), bundle similarly on macOS. Rename the binary if you want `ps` to not say "tmux." Distribution: optional-dep platform packages on npm, or alongside the main binary in a `bin/` dir located via `argv[0]`-relative lookup.

Lifecycle:

- Linux: `PR_SET_PDEATHSIG` on the tmux child → dies when orchestrator dies.
- macOS: orphan-cleanup on next launch (`tmux -L myapp-private kill-server` if socket exists).
- Graceful exit: orchestrator kills the tmux server before its own `process.exit()`.

**Windows is a problem.** Tmux has no native Windows port. WSL works (it's Linux underneath); native does not. If Windows is a target, this architecture either requires WSL or needs to be replaced with a homegrown PTY-based multiplexer (see "alternatives considered" below).

## Per-tab editor persistence

Two patterns, pick by resource budget:

- **One nvim, swap buffers.** Single nvim instance; orchestrator swaps active buffer per worktree. Lowest resource cost. Loses per-tab cursor/undo/jumplist unless you save/restore via shada.
- **One nvim per worktree, one tmux window per worktree.** Pre-spawn N nvims, each with its own `--listen` socket; tab switch = `tmux select-window -t :foo`. Each tab keeps everything (cursor, undo tree, LSP state, terminal buffers). ~30-50 MB per nvim → fine for 5-20 worktrees.

The orchestrator pattern makes either trivial — the change is just which RPC socket gets the next command.

## Open question

The transcript renderer is described as "already handled in a separate project." Its shape determines how it slots in:

- **Separate CLI/binary** → easiest. Run it in pane 5. Talk to it via stdin or a file it watches.
- **Ink component intended to be hosted in this same Ink app** → tiling problem. Tmux can't put one Ink pane on both sides of an nvim pane (each tmux pane = one process). Options:
  1. Two Ink processes (left pane for tabs, right pane for transcript), both connecting to the orchestrator.
  2. Switch to the msgpack-RPC embed path — single Ink owns the whole window, nvim's grid events render inside it.
- **Library that owns its own event loop** → likely needs an adapter.

This blocks finalizing the pane process layout; everything else is settled.

## Alternatives considered

Ranked by effort, smallest to largest:

1. **Full-screen shell-out to `$EDITOR`.** Hours. No persistent state. No simultaneous chrome + editor. Loses the layout entirely while editing.
2. **Bundle tmux + Ink chrome + nvim** (this proposal). 1-2 days of glue code. Linux + macOS only. Mature plumbing handles all the gnarly TTY work.
3. **Embed nvim via msgpack-RPC into Ink directly.** 3-6 weeks. Cross-platform, no external binary, only embeds nvim. Pure Ink window, nvim's grid events painted as Ink components. No prior art (researched: `@xterm/headless`, `neovim` npm client, NyaoVim, firenvim all exist; nobody has rendered nvim into Ink/blessed/neo-blessed).
4. **Build a full PTY-pane multiplexer in Ink + node-pty + `@xterm/headless`.** 4-8 weeks + indefinite edge-case grind. Cross-platform, embeds any TUI program (not just nvim). Effectively writing a minimal tmux in Node.

Option 2 is the path with the highest leverage for the lowest investment. Option 3 becomes interesting if Windows is a hard requirement or zero-external-binary purity matters. Option 4 only makes sense if hosting arbitrary TUI programs (not just nvim) becomes a goal.

## Estimated effort for the proposal architecture

- Tmux config + spawn/wrap/cleanup wrapper: 1 day
- Orchestrator skeleton (Unix socket, JSON protocol, lifecycle): 1 day
- Wire Ink ↔ orchestrator events: 1 day
- Wire nvim ↔ orchestrator via `--listen`: 0.5 day
- Wire the transcript renderer: depends entirely on its shape (see open question)
- Polish (themes, status-bar content, focus rules, auto-focus heuristics): 2-3 days

Total for a working, demoable v1: roughly **1 working week** on the architecture itself, assuming the transcript renderer slots in cleanly.

## Key references

- `@xterm/headless` — battle-tested ANSI parser + cell grid, no DOM. Foundation for any PTY-rendering path. https://www.npmjs.com/package/@xterm/headless
- `neovim` npm — official Node msgpack-RPC client, actively maintained. https://www.npmjs.com/package/neovim
- Neovim UI protocol — `:help ui` and https://neovim.io/doc/user/ui/
- Tmux dual status bars — `man tmux` § `status`, `status-format[0]`/`[1]` (tmux 2.9+)
- Tmux popup — `man tmux` § `display-popup` (tmux 3.2+) — useful for modal overlays, not for the persistent panes here
- Prior art for nvim-embedded-in-JS-host: NyaoVim (Electron), firenvim (browser), neovim-component (WebComponent). None render into a terminal-TUI framework.
