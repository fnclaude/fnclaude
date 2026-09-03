# Claude Code terminal/TUI tricks

A behavior-level reference for the terminal and TUI mechanisms Claude Code uses beyond basic ANSI rendering: theme detection, hyperlinks, image protocols, clipboard access, keyboard handling, and capability detection. Written against **v2.1.196** of the Bun-compiled ELF; findings are anchored on durable string literals (escape sequences, DEC mode numbers, OSC payloads, env-var names, regex patterns). Minified symbol names and byte offsets are intentionally omitted — they are build-specific noise.

> See [`claude-code-render-modes.md`](claude-code-render-modes.md) for the alt-screen / DECSTBM / streaming mode layer these tricks operate within. See [`claude-code-agent-ui-internals.md`](claude-code-agent-ui-internals.md) for the subagent and steering seam mechanics.

---

## DEC private mode map

The complete set of DEC private modes Claude Code manages is encoded in a single mode map. Every capability in this doc either sets or reads from this map:

```
CURSOR_VISIBLE:25
ALT_SCREEN:47
ALT_SCREEN_CLEAR:1049
MOUSE_NORMAL:1000
MOUSE_BUTTON:1002
MOUSE_ANY:1003
MOUSE_SGR:1006
FOCUS_EVENTS:1004
BRACKETED_PASTE:2004
THEME_NOTIFY:2031
SYNCHRONIZED_UPDATE:2026
```

A single enable/disable factory constructs the `\x1b[?{N}h` / `\x1b[?{N}l` sequences for all of these — the same factory used for alt-screen, synchronized update, focus, paste, and theme notify.

**Confidence:** confirmed (full map literal present in bundle).

---

## Live theme detection — DEC mode 2031 + `CSI ?997;{1|2}n`

Claude Code enables DEC private mode **2031** ("theme notify" / color-scheme-update) when it launches. When the terminal's palette switches between light and dark, a conformant terminal emits an unsolicited report; Claude parses this and re-selects its color theme live, without restarting.

Report format:
- `CSI ? 997 ; 1 n` — dark theme
- `CSI ? 997 ; 2 n` — light theme

**Anchors:**
- Mode constant: `THEME_NOTIFY:2031` (in the mode map above)
- Enable sequence constructed by the same factory as other modes (same `h`/`l` pattern)
- Response parser regex: `^\x1b\[\?997;([12])n$`

**Confidence:** confirmed — mode constant, enable-sequence factory, and the dedicated `?997;[12]n` parser all present.

This is the companion to the OSC 11 background-color query (see next section). OSC 11 handles initial theme bootstrap; mode 2031 handles subsequent live changes.

Terminals that do not support mode 2031 simply never emit the `997` report — the enable sequence is a no-op and produces no output.

---

## OSC 11 background-color query (initial theme bootstrap)

At startup, Claude Code parses an OSC 11 terminal response of the form `rgb:RRRR/GGGG/BBBB` (1–4 hex digits per channel — the XParseColor format) to read the terminal's actual background color. Luminance of the result determines whether the initial theme is light or dark.

**Anchors:**
- Parser regex: `rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})`
- References to `backgroundColor` and `color-scheme` / `prefers-color` alongside the parser

**Confidence:** parse side confirmed; the active query emit (`\x1b]11;?\x07` or `\x1b]11;?\x1b\\`) was not found as a literal and may be constructed dynamically, or CC may rely on environment variables for initial detection and only OSC 11 for validation. Treat the *response parser* as confirmed, the *active query* as inferred.

The query response arrives on stdin and must be consumed by the terminal-input parser before it reaches any interactive input handler. Implementations should time-box the wait — terminals that do not respond to OSC 11 must not stall startup.

---

## OSC 8 hyperlinks for markdown links

Markdown links are emitted as OSC 8 terminal hyperlinks (clickable in supporting terminals), gated on a `supportsHyperlinks` capability check.

Emit template:
```
\x1b]8;;{url}\x1b\\{visible_text}\x1b]8;;\x1b\\
```
(OSC 8 open — ST — visible text — OSC 8 close — ST)

**Dedup guard:** when the visible link text already equals the URL (the autolink case), the OSC 8 wrapping is skipped to avoid redundant emission. Guard condition: `text !== url && url !== "http://"+text && url !== "https://"+text`.

**Anchors:**
- Emit template: `]8;;${url}\x1B\\${url}\x1B]8;;\x1B\\`
- Capability flag threaded through the markdown renderer: `supportsHyperlinks`
- Dedup condition: `if(c!==e&&e!==\`http://${c}\`&&e!==\`https://${c}\``
- `FORCE_HYPERLINK` env override present for testing

**Confidence:** confirmed — emit template, capability flag in link renderer, and dedup logic all present.

OSC 8 byte sequences are zero-width and must not be counted by any display-width calculation. Terminals that do not support OSC 8 print the raw `]8;;` bytes, so the capability gate matters for portability.

---

## Inline-image rendering cascade

Images render through a graceful-degradation cascade, picking the best available protocol:

| Priority | Protocol | Notes |
|---|---|---|
| 1 | **Kitty graphics** | `_G` APC sequences; direct payload or file source |
| 2 | **iTerm2 inline image** | OSC 1337 `File=inline=1` + base64 |
| 3 | **Half-block unicode** | `▀` / `▄` — two pixels per terminal cell via fg/bg color |
| 4 | **ASCII art** | Character-based fallback |
| 5 | **None** | Placeholder only |

Protocol mode strings: `"kitty"` / `"iterm2"` / `"blocks"` / `"ascii"` / `"none"`.

**Kitty graphics emit:**
```
_Ga=T,t=d,f=100,q=2;{base64_payload}
_Ga=T,t=f,f=100,q=2;{file_path}
```
(`a=T` transmit+display, `t=d` direct / `t=f` file, `f=100` PNG format, `q=2` quiet — suppresses per-chunk OK/error replies from the terminal)

**iTerm2 emit:**
```
{OSC}1337;File=inline=1;width={w};height={h};preserveAspectRatio=0:{base64_data}{ST}
```

**Half-block fallback glyphs:** `▀` (U+2580) and `▄` (U+2584)

**Anchors:**
- Kitty emit literals: `_Ga=T,t=d,f=100,q=2;` and `_Ga=T,t=f,f=100,q=2;`
- iTerm2 emit: `${OSC}1337;File=inline=1` with `;width=`, `;height=`, `;preserveAspectRatio=0`, then `:` + base64
- Half-block glyphs: `▀` and `▄` as literals
- Protocol enum: `"kitty"`/`"iterm2"`/`"blocks"`/`"ascii"`/`"none"`

**Confidence:** kitty + iTerm2 emits and half-block glyphs confirmed; full capability-gate ordering inferred from enum + selector branch.

The `q=2` quiet flag is notable: without it, kitty terminals emit a status reply for each chunk (Kitty's 4096-byte payload limit means chunked transmission for larger images). Those replies land on stdin and would pollute any interactive input parser.

---

## OSC 52 clipboard write (SSH-safe)

Writes to the system clipboard via OSC 52:
```
{OSC}52;c;{base64_payload}{ST}
```

This mechanism works through SSH and tmux sessions where native clipboard tools (`wl-copy`, `xclip`) are unreachable. CC also activates an iTerm2-specific clipboard-access enabler (`enableITerm2ClipboardAccess`) since iTerm2 gates OSC 52 behind a user preference.

**Anchors:**
- Emit template: `${OSC}]52;c;${t}${ST}` where `t` is the base64-encoded payload
- `enableITerm2ClipboardAccess` identifier present

**Confidence:** emit template confirmed; iTerm2 enabler confirmed by name, exact escape sequence not traced.

Many terminals cap OSC 52 payload size; some disable it by default for security reasons. Implementations should base64-encode the payload, gate on a capability check, and treat a missing response as a silent failure.

---

## Private-mode sanitizer — tracking DEC modes in child output

A regex scanner tracks all DEC private mode set/reset sequences in subprocess output, against a fixed set of modes CC itself manages:

```
Scanner regex: /\x1b\[\?([\d;]+)([hl])/g
Tracked set: {1000, 1002, 1003, 1004, 1006, 2004, 2031}
```

This lets CC detect when a child process (a tool, a subprocess) has altered terminal state that CC depends on — e.g., a tool that disables mouse tracking or exits the alt screen without restoring it. The scanner enables normalization or re-assertion of CC's own modes after a child writes.

**Anchors:**
- Scanner regex literal: `bac=/\x1b\[\?([\d;]+)([hl])/g`
- Tracked set literal: `new Set([1000,1002,1003,1004,1006,2004,2031])`

**Confidence:** confirmed — regex and set literals both present.

---

## Unicode display width — `Intl.Segmenter` grapheme clustering

Display width is calculated with `Intl.Segmenter` for grapheme segmentation, combined with:
- East-Asian width tables
- ZWJ sequence (`‍`, U+200D) handling
- Variation selector 16 (`FE0F` — forces emoji presentation)
- Combining mark collapsing
- Explicit ambiguous-width handling

The result is a `getStringWidth` implementation that handles emoji ZWJ families, regional indicator flags, and CJK ambiguous characters correctly — rather than relying on `.length` or a naive byte count.

**Anchors:** `getStringWidth`, `Intl.Segmenter`, `wcwidth`, `stringWidth`; `FE0F` (VS16), `‍` (ZWJ), `combining`, `ambiguous`/`Ambiguous`, `fullwidth`/`halfwidth`

**Confidence:** all components confirmed present; exact width algorithm not fully traced.

`Intl.Segmenter` is built into Node.js / Bun (zero additional dependency). Ambiguous-width characters are terminal-dependent; CC's handling matches the de facto convention of treating them as narrow unless a CJK locale is active.

---

## Kitty keyboard protocol — progressive enhancement

CC supports the kitty keyboard protocol for unambiguous key reporting. This enables distinguishing Esc from Alt-combos, capturing modifiers on more keys, and reliable CSI-u sequences.

Relevant concepts: "progressive enhancement" flags, "disambiguate escape codes", `getNativeCSIuTerminalDisplayName`, native CSI-u terminal detection.

**Anchors:** `progressive`, `disambiguate`, `getNativeCSIuTerminalDisplayName`, `CSIu`, `kittyKeyboard`

**Confidence:** confirmed by name and flag literals; the exact enable/pop sequences (`\x1b[>{flags}u` / `\x1b[<u`) not captured as literals in this sweep.

The enable sequence must be pushed on entry and popped on exit — leaving the flag stack in an inconsistent state corrupts the user's shell key handling in subsequent processes.

---

## Completion notification channels

CC supports selectable notification channels for turn/task completion:

| Channel string | Behavior |
|---|---|
| `"terminal_bell"` | Emit BEL (`\x07`) |
| `"iterm2"` | iTerm2 attention / notification (exact OSC not isolated) |
| `"iterm2_with_bell"` | Both of the above |
| `"notifications_disabled"` | No notification |
| `"auto"` | Default; selects best available; falls back to `"no_method_available"` |

Configured via a `preferredNotifChannel` setting.

**Anchors:**
- Setting key: `preferredNotifChannel`, `notifChannel`
- Channel strings: `"terminal_bell"` / `"iterm2"` / `"iterm2_with_bell"` / `"notifications_disabled"` / `"auto"`
- Bell dispatch: `case"terminal_bell":return n.notifyBell()`

**Confidence:** channel set and bell dispatch confirmed; the iTerm2 channel's specific escape (OSC 9 vs OSC 1337 `RequestAttention`) was not isolated.

---

## Focus events and bracketed paste — the full alt-screen toolkit

The complete mode toolkit for alt-screen use (see also mode map at the top):

**Focus events (DEC mode 1004):**
- Enable: `\x1b[?1004h` — terminal emits `\x1b[I` (focus in) and `\x1b[O` (focus out)
- Lets CC dim cursor blink or pause animations when the window is unfocused

**Bracketed paste (DEC mode 2004):**
- Enable: `\x1b[?2004h` — terminal wraps paste content in `\x1b[200~` … `\x1b[201~` markers
- Prevents embedded newlines in a pasted block from being interpreted as submit events

**Synchronized output (DEC mode 2026):**
- Enable: `\x1b[?2026h` / disable: `\x1b[?2026l`
- Wraps each repaint frame; terminal holds screen update until the disable sequence, eliminating flicker

**Anchors:**
- Full mode map: `u_={...,FOCUS_EVENTS:1004,BRACKETED_PASTE:2004,...,SYNCHRONIZED_UPDATE:2026}`
- Focus markers: `?1004h` / `?1004l`
- Paste markers: `[200~` / `[201~`

**Confidence:** confirmed — mode constants, enable/disable patterns, and paste markers all present.

All three degrade silently when unsupported — the enable sequence is accepted and ignored, no response is emitted, no garbage appears on screen.

---

## Terminal capability detection

Feature gates for hyperlinks, graphics protocols, and clipboard access are driven by env-var sniffing, not active probes (DA2 / DECRQM were not found as active queries — see skip list below).

**Program identification — `TERM_PROGRAM` values checked:**
- `"Apple_Terminal"`, `"ghostty"`, `"iTerm.app"`, `"vscode"`, `"WezTerm"`

**Additional env vars checked:**
| Variable | Terminal |
|---|---|
| `KITTY_WINDOW_ID` | Kitty |
| `VTE_VERSION` | VTE-based (GNOME Terminal, Tilix, etc.) |
| `WT_SESSION` | Windows Terminal |
| `KONSOLE_VERSION` | Konsole |
| `GHOSTTY*` | Ghostty |
| `ITERM_SESSION_ID` | iTerm2 |
| `TERM_PROGRAM_VERSION` | Version of identified terminal |

**Color depth detection:**
- `COLORTERM=truecolor` or `COLORTERM=24bit` → 24-bit color
- `FORCE_COLOR` override → force color on regardless of detection
- `NO_COLOR` override → force color off

**Anchors:** program strings and env-var names as listed; `truecolor`, `24bit`, `FORCE_COLOR`, `NO_COLOR`, `COLORTERM`

**Confidence:** confirmed — all literals grouped with detection logic in the bundle.

This detection table is the lookup behind hyperlink, image-protocol, and clipboard capability gates. The env/program matrix can be reused directly; active terminal probing is not needed.

---

## Rate-limit data flow and the statusLine contract

### `rate_limit_event` stream shape (CC internal)

CC receives rate-limit utilization data from the Anthropic API via unified rate-limit utilization response headers. These are surfaced as `rate_limit_event` stream events carrying a `rate_limit_info` object.

`rate_limit_info` is keyed by rate-limit type:

| Key | Covers |
|---|---|
| `five_hour` | 5-hour rolling token budget |
| `seven_day` | 7-day rolling token budget |
| `seven_day_opus` | 7-day Opus-specific budget |
| `seven_day_sonnet` | 7-day Sonnet-specific budget |
| `seven_day_overage_included` | 7-day budget including overage |
| `overage` | Overage usage |

Each entry carries:
- A **reset timestamp** (Unix seconds)
- A **utilization fraction** in the range 0–1 (sourced from the API response headers)

### statusLine stdin JSON contract

The `statusLine` stdin JSON message (the shape consumed by the statusLine renderer) transforms the `rate_limit_info` values into a display-ready format.

**`rate_limits` field** — per-window usage, nested by type. Each may be absent if the corresponding data was not returned:

```jsonc
{
  "rate_limits": {
    "five_hour": {
      "used_percentage": 0,   // integer 0–100; fraction × 100
      "resets_at": 1234567890 // Unix seconds
    },
    "seven_day": {
      "used_percentage": 0,
      "resets_at": 1234567890
    }
    // other type keys follow the same shape; may be absent
  }
}
```

**`context_window` field** — current session context usage:

```jsonc
{
  "context_window": {
    "context_window_size": 200000,  // total context capacity in tokens
    "current_usage": 14321,         // tokens used so far
    "used_percentage": 7,           // 0–100 integer, or null if not computable
    "remaining_percentage": 93      // 0–100 integer complement
  }
}
```

### Transformation

| `rate_limit_info` field | → | `statusLine` field |
|---|---|---|
| utilization fraction (0–1) | × 100 → round | `used_percentage` (0–100) |
| reset timestamp | pass-through | `resets_at` |
| type key (`five_hour`, etc.) | → nested key under `rate_limits` | nested object |

---

## Skip list — confirmed absent

These mechanisms were checked and not found in v2.1.196:

| Mechanism | Notes |
|---|---|
| **Sixel graphics** (`DCS Pq` / `\x1bP…q`) | Not present. Image path is kitty → iTerm2 → half-block → ASCII, no sixel |
| **OSC 9 / OSC 777 / OSC 99 desktop notifications** | Not found as raw escape emits; completion notifications go through the `terminal_bell` / `iterm2` channel abstraction |
| **OSC 133 / OSC 633 shell-integration semantic marks** | Not found. Expected — CC is a TUI app, not a shell |
| **DECSCUSR cursor-shape** (`\x1b[{n} q`) | Cursor *visibility* (mode 25) is toggled; cursor *shape* is left alone |
| **DECSTBM scroll region** as a graphics primitive | Full-frame repaint (Ink/Yoga diff) in fullscreen mode; no hardware scroll region. DECSTBM is a separate render mode, not a trick — see [`claude-code-render-modes.md`](claude-code-render-modes.md) |
| **OSC 0 / OSC 2 window-title set** | Only a lone `]0;` literal (looks like a recognizer, not an emitter); no evidence CC sets the terminal title |
| **DA2 secondary device attributes** (`\x1b[>c`) / **DECRQM mode queries** (`\x1b[?{n}$p`) | Not found as active probes. Capability comes from env/program sniffing + the 2031/997 and OSC 11 reply parsers. A cursor-position report (`\x1b[6n`) parser path does exist |
| **Mouse motion tracking modes 1002 / 1003** | Present in the mode map as constants but not actively enabled — button-press-only (1000+1006) is what's enabled in practice |

---

## Sources

| Source | Confidence | Notes |
|---|---|---|
| Direct bundle grep: v2.1.196 Bun ELF | High | Anchored on env-var names, escape sequences, regex literals, and DEC mode numbers; minified symbols and byte offsets omitted |
| [`claude-code-render-modes.md`](claude-code-render-modes.md) | High | Alt-screen, DECSTBM, and synchronized-output mechanics (companion doc) |
| [`claude-code-agent-ui-internals.md`](claude-code-agent-ui-internals.md) | High | Subagent UI, steering seam, and teams mechanics (companion doc) |
