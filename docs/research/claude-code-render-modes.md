# Claude Code terminal render modes and scrolling

A reference for the three terminal render modes Claude Code supports, how the active mode is selected, the escape-sequence mechanics behind each, and what the mode selection means for fnclaude (which drives `claude` as a subprocess). Written against **v2.1.149** of the Bun-compiled ELF (grep technique documented in [`claude-code-binary-internals.md`](claude-code-binary-internals.md)); official-docs and GitHub-issue findings reflect behavior through ~v2.1.186.

> Minified symbol names and byte offsets are intentionally omitted — they are build-specific noise that changes between versions. All findings are anchored on durable string literals (config keys, env-var names, mode strings, and escape sequences). See [`claude-code-binary-internals.md`](claude-code-binary-internals.md) for the `grep -aboF` + `dd`-window technique.

Cross-reference: the subagent list, transcript view, agent panel, and steering-queue mechanics described in [`claude-code-agent-ui-internals.md`](claude-code-agent-ui-internals.md) render *inside* whichever mode is active here — this doc and that one are companions. Read that doc for what Claude Code draws; read this one for the screen-management layer it draws on.

---

## Why this exists

fnclaude wraps `claude` as a subprocess. Knowing which render mode `claude` is actually running in — and why — determines:

- Whether fnc's own renderer needs to handle alt-screen enter/exit sequences in claude's output.
- Whether `autoScrollEnabled` is live or inert.
- Who owns terminal scrollback: `claude`, the terminal emulator, or fnc.

The short answer: in fnc's normal subprocess mode, none of the scroll machinery applies. The sections below explain why, and what would change if fnc ever drives `claude` differently.

---

## The three render modes

### 1. Fullscreen (alternate-screen) renderer

Draws on the terminal's **alternate screen buffer** (like vim or htop). Characteristics:

- A fixed input box is pinned to the bottom; the content area fills the rows above it.
- Scrollback is **virtualized inside the app** — no native terminal scrollback accumulates. Scrolling is entirely app-managed via the `autoScrollEnabled` setting and the scroll-to-bottom keybind.
- **Mouse capture** is enabled: click-to-position, click-to-expand collapsed tool calls, wheel scroll, and text selection all go through the app.
- Every redraw frame is wrapped in **synchronized-output** markers (DEC private mode 2026) to eliminate flicker — this is what the `NO_FLICKER` flag and the `"fullscreen"` settings key refer to.

Shipped as a research preview in v2.1.89, rolling out gradually behind an internal feature flag. The `CLAUDE_CODE_NO_FLICKER` env var and `tui: "fullscreen"` setting are the stable external controls.

### 2. Classic main-screen renderer with a DECSTBM scroll region

Carves a **fixed-height scroll region** using the DECSTBM control sequence, keeps a fixed content viewport within it, and pushes scrolled-off history into the terminal's **native scrollback**. The input area sits outside the scroll region.

As the scroll position advances, the renderer emits newlines that push content into native scrollback and updates the fixed viewport by frame-diffing. The result is a hybrid: the app owns the visible viewport; the terminal owns history.

Gated by `CLAUDE_CODE_DECSTBM=1` or an internal rollout flag; **off by default**.

### 3. Plain streaming

The practical default, and always active when stdout is not a TTY. Streams rendered frames to stdout with no scroll region and no alt-screen. The **terminal owns 100% of scrollback**; the app holds no scroll state at all.

`autoScrollEnabled` is inert in this mode — there is no app-managed scroll viewport to govern.

---

## Mode selection — priority order

Evaluate top-to-bottom; the first matching rule wins. Confidence: high — bundle grep on v2.1.149, anchored on `CLAUDE_CODE_SESSION_KIND`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_DECSTBM`, `tui`, and the mode-string literals.

**Fullscreen predicate:**

| Priority | Condition | Result |
|---|---|---|
| 1 | Local-agent session | Never fullscreen |
| 2 | `CLAUDE_CODE_SESSION_KIND=bg`, or `claude attach`, or agent-view session | **Always fullscreen** — config cannot override |
| 3 | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` or `CLAUDE_CODE_NO_FLICKER=0` | Force off |
| 4 | `CLAUDE_CODE_NO_FLICKER=1` | Force on |
| 5 | tmux control-mode (iTerm2 `-CC`), or Windows over SSH | Never fullscreen |
| 6 | `tui: "fullscreen"` in settings.json | On |
| 7 | `tui: "default"` in settings.json | Off |
| 8 | Internal rollout feature flag | Default off (opt-in preview) |

**DECSTBM predicate** (evaluated only when fullscreen is off):

DECSTBM activates when stdout is a TTY, the session is not inside tmux, fullscreen is not active, and either `CLAUDE_CODE_DECSTBM=1` or its rollout flag is on (default off).

**Plain streaming** is the fallback whenever both predicates are false — which includes any invocation where `stdout.isTTY` is false.

---

## Settings and environment reference

| Signal | Effect |
|---|---|
| `tui: "fullscreen"` (settings.json) | Force fullscreen on. The schema description: "uses the flicker-free alt-screen renderer with virtualized scrollback, equivalent to `CLAUDE_CODE_NO_FLICKER=1`." |
| `tui: "default"` (settings.json) | Force fullscreen off (use classic or plain). |
| `CLAUDE_CODE_NO_FLICKER=1` | Force fullscreen on |
| `CLAUDE_CODE_NO_FLICKER=0` | Force fullscreen off |
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` | Force classic renderer (fullscreen off) |
| `CLAUDE_CODE_SESSION_KIND=bg` | Force fullscreen on (background/attached sessions) |
| `CLAUDE_CODE_DISABLE_MOUSE=1` | Keep fullscreen active but disable mouse capture |
| `CLAUDE_CODE_SCROLL_SPEED` | Scroll multiplier 1–20; fullscreen mode only |
| `CLAUDE_CODE_DECSTBM=1` | Enable the DECSTBM scroll-region classic renderer |
| `autoScrollEnabled` (settings.json, default `true`) | Sticky-follow behavior; see autoscroll section below |

---

## Alternate-screen escape sequences

**Confidence: high — bundle grep on v2.1.149, anchored on the literal escape sequences below. All sequences are durable DEC/ANSI standards; offsets are not cited.**

### Enter sequence

```
ESC[?1049h    — enter alternate screen buffer (DEC private mode 1049; also saves cursor)
ESC[2J        — clear the screen
ESC[H         — cursor home (row 1, col 1)
ESC[?1004l    — disable focus-change events
ESC[0m        — reset text attributes
ESC[?25h      — show cursor
```

### Exit sequence

```
ESC[?1049l    — leave alternate screen buffer (restores prior screen and cursor position)
```

Note: the implementation uses mode **1049** specifically, not the older `?47` or `?1047` variants. Mode 1049 saves and restores the cursor along with the screen buffer.

### Flicker-free paint (synchronized output)

Every redraw frame is wrapped in DEC synchronized-output markers:

```
ESC[?2026h    — begin synchronized update (hold rendering)
  ... frame content ...
ESC[?2026l    — end synchronized update (flush to screen atomically)
```

This is private mode 2026. It is what the `NO_FLICKER` flag and the `"fullscreen"` settings value refer to — not a proprietary mechanism, just standard synchronized-output use.

### Mouse tracking

Enabled in fullscreen mode. Multiple tracking modes are layered:

```
ESC[?1000h    — enable button event tracking
ESC[?1002h    — enable button-motion tracking
ESC[?1003h    — enable any-motion tracking (all mouse movements)
ESC[?1006h    — SGR extended coordinate encoding (needed for terminals wider than 223 cols)
ESC[?2004h    — bracketed paste mode
ESC[?1004h    — focus event reporting
```

`CLAUDE_CODE_DISABLE_MOUSE=1` suppresses these while leaving the alt-screen active.

---

## DECSTBM (classic) scroll-region mechanism

**Confidence: high — bundle grep on v2.1.149**

The classic renderer carves the content area with the DECSTBM control:

```
CSI <top> ; <bottom> r    — set scroll region to rows <top>–<bottom>
```

where `<top>` and `<bottom>` are one-based row numbers. The input area occupies rows outside the scroll region. As the renderer advances the scroll position, it emits newlines that push content out of the region and into the terminal's native scrollback. The visible viewport is maintained by frame-diffing: only changed cells are re-emitted each frame.

The net effect is that a user can scroll back through history using the terminal's own scroll mechanism (scrollbar, Shift+PgUp, etc.), while the fixed viewport and input box remain stable.

---

## Resize handling

**Confidence: high — bundle grep on v2.1.149**

Resize is driven by Node's `stdout.on("resize")` event (Node translates the OS SIGWINCH signal into this stream event — there is no direct SIGWINCH handler in Claude Code).

On each resize event:

1. Re-read `stdout.columns` and `stdout.rows` from the stream.
2. Trigger a Yoga relayout of the component tree.
3. Reset the alt-screen frame buffer (fullscreen mode) or recalculate the DECSTBM region bounds (classic mode).
4. Mark an erase-before-next-paint so stale content is cleared before the new frame lands.

A row-count adjustment is applied to compensate for terminal-multiplexer chrome — for example, a tmux status bar reduces the usable rows.

---

## autoscroll

**Confidence: high — bundle grep on v2.1.149 + official docs**

`autoScrollEnabled` (settings.json, default `true`, UI label "Auto-scroll") governs whether the fullscreen renderer's content area stays *sticky-pinned to the bottom* as new output streams in.

**This setting is scoped to the fullscreen renderer only.** It has no effect in DECSTBM or plain-streaming modes — those modes have no app-managed scroll state to govern.

### When `autoScrollEnabled` is true (default)

The scroll container follows new output as it arrives. The view stays pinned to the bottom throughout a streaming response.

### When `autoScrollEnabled` is false

New output does not pull the viewport down. The view stays wherever the user left it. Permission prompts are an exception: they still scroll into view regardless of this setting. The user re-pins manually by pressing the scroll-to-bottom keybind or by clicking the "new messages" divider pill.

### Disengagement and re-engagement

Scrolling up while output is streaming disengages the sticky-follow and surfaces an unseen-message divider with an unread count. Re-engagement happens when:

- The user scrolls back to the bottom, or
- A new human turn begins **and** `autoScrollEnabled` is on, or
- The user types in the input box **and** `autoScrollEnabled` is on.

When `autoScrollEnabled` is off, a new human turn or typing does **not** re-pin to the bottom.

Official docs phrasing: "In fullscreen rendering, follow new output to the bottom of the conversation. Permission prompts still scroll into view when this is off."

---

## Who owns scrolling — summary

| Mode | Scrollback owner | autoscroll relevant? |
|---|---|---|
| Fullscreen | App-internal only; no native terminal scrollback accumulates | Yes |
| DECSTBM classic | Hybrid: app owns the fixed viewport; terminal's native scrollback holds history | No (the terminal owns the scroll gesture) |
| Plain streaming | Terminal's native scrollback owns everything | No (no internal scroll state exists) |

---

## What this means for fnclaude

### Normal subprocess mode — plain streaming

fnc runs `claude` as a subprocess with `-p` / `--output-format stream-json`, which means stdout is not a TTY. Both the fullscreen and DECSTBM predicates are false. **Claude runs in plain streaming mode**: no alt-screen, no scroll region, `autoScrollEnabled` inert.

In this configuration fnc's own renderer owns scrolling and history entirely. There are no claude-side scroll mechanics to mirror or interoperate with.

### The exception: background and attached sessions

The background/attached rule overrides everything else. **If fnc ever drives `claude` via `claude attach` or with `CLAUDE_CODE_SESSION_KIND=bg` set, the fullscreen renderer activates regardless of other config.** In that case, fnc would need to handle:

- **Alt-screen enter/exit** (`ESC[?1049h` / `ESC[?1049l`) appearing in claude's output stream.
- **Synchronized-output markers** (`ESC[?2026h` / `ESC[?2026l`) wrapping every frame.
- **Mouse-tracking enable sequences** (`ESC[?1000h`, `?1002h`, `?1003h`, `?1006h`) unless `CLAUDE_CODE_DISABLE_MOUSE=1` is set.
- **`autoScrollEnabled` becoming live** — scroll state is now app-managed.

These sequences would either need stripping before passing the stream to fnc's renderer, or fnc would need to yield scrollback ownership to claude's alt-screen entirely.

### Replicating flicker-free fullscreen in fnc's own renderer

To match the fullscreen renderer's paint quality:

1. Enter the alternate screen: `ESC[?1049h` then `ESC[2J` + `ESC[H`.
2. Wrap each repaint in synchronized-output markers: `ESC[?2026h` … `ESC[?2026l`.
3. Drive relayout off `stdout.on("resize")`.
4. Exit with `ESC[?1049l` on shutdown or SIGTERM.

The escape sequences are standard; the implementation shape is the same as any Ink or terminal-kit app using alt-screen.

---

## Sources

| Source | Confidence | Notes |
|---|---|---|
| Direct bundle grep: v2.1.149 ELF | High | Anchored on env-var names, mode strings, and escape-sequence literals; minified symbol names and byte offsets intentionally omitted |
| `code.claude.com/docs/en/fullscreen` | High | Fullscreen renderer feature page |
| `code.claude.com/docs/en/settings` (settings.json reference) | High | `tui` enum, `autoScrollEnabled` |
| Official docs behavior observations through ~v2.1.186 | High | autoscroll engage/disengage, permission-prompt exception |
