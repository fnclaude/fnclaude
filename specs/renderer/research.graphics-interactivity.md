# Renderer graphics + interactivity — feasibility memo

Captured 2026-06-26. Feeds the work begun in PR #261 (GFM rendering gaps) and PR #263 (OSC 8 regression).

## Why this exists

After closing the GFM rendering gaps, two research sweeps examined what it would take to go further: inline images (math, diagrams, actual `<img>` content, pasted screenshots), mouse events, hyperlinks, custom selection, and scrolling. This doc records what is feasible, what is blocked, and in what order to build it.

Cross-references (do not duplicate):

- [`specs/proposals/design.renderer.md`](../proposals/design.renderer.md) — in-process renderer↔CLI integration design; the architecture these features land into.
- [`specs/decisions.md`](../decisions.md) — dated decisions driven by the findings here.

---

## Terminal inline-image pipeline

### Protocol support matrix

| Protocol | How it works | Ghostty support |
|---|---|---|
| **Kitty graphics** | APC-wrapped base64 payload; chunked at 4 096-byte boundaries with `m=1` on all but the last chunk, `m=0` on the final. Minimal transmit-and-display escape: `ESC_G f=100,a=T;<base64>ESC\` (`f=100`=PNG, `a=T`=transmit+display); dimensions read from PNG metadata. | **Yes — the only protocol Ghostty supports.** |
| **iTerm2 OSC 1337** | `ESC]1337;File=…:<base64>BEL` | No. Open feature request; no commitment from the maintainer. |
| **Sixel** | DCS-escaped, palette-indexed pixel rows | No. Maintainer explicitly rejected it — cited libsixel quality issues and Kitty as the feature-rich alternative. |

Ghostty stores up to ~320 MB of image data per screen. Any image work must target Kitty exclusively.

### The Ink re-emit problem

Ink clears and redraws the whole frame on every render. Any graphics escape written outside the render tree is erased on the next keypress. Consequence: a live (streaming) image must be re-emitted every frame, which causes inherent flicker and grows CPU with transcript length.

The clean solution for finalized content is Ink's `<Static>` component — content emitted once falls into real terminal scrollback and the terminal composites it. This is the pre-requisite for safe inline images (see [Static finding](#the-static-finding) below).

### Libraries

| Library | Role | Notes |
|---|---|---|
| **ink-picture** | Ink component: reserves Flexbox space, re-emits via cursor positioning each frame, falls back to Unicode half-blocks when scrolled out of view. v2, MIT, maintained. | The right integration point for images inside the dynamic live tail. |
| **terminal-image** | Sindre Sorhus; terminal image rendering to stdout | Useful for one-shot CLI output; not Ink-aware. |
| **chafa** | C binary (or WASM build); best fallback cascade: Kitty → iTerm2 → sixel → Unicode → ASCII | Use as last-resort fallback renderer for environments that lack Kitty. |
| **supports-terminal-graphics** | Startup-time protocol detection | Run once; gate the whole pipeline on the result. |

### Inline `<img src>` rendering

1. **Fetch/read.** Remote URL → `fetch` + check `Content-Type`; local path → `readFile`.
2. **Downscale.** Use `sharp` for raster images; `@resvg/resvg-js` (Rust/napi, Bun-compatible) for SVG → PNG.
3. **Base64 → Kitty.** Chunk at 4 096 bytes; emit via the APC escape.

**Risks:**

- **SSRF / path-traversal.** The URL or path comes from model output. Needs an allowlist or sandbox — never pass raw model-provided URLs directly to `fetch` without validation, and never open arbitrary local paths.
- **Memory.** Downscale eagerly before display; never hold the full-resolution buffer in memory during render.
- **Async-during-render.** `fetch` and `readFile` cannot run inside Ink's synchronous render pass. Pre-resolve all images before entering (or re-entering) the render loop; cache by URL/path.

### Pasted images

Terminals do **not** forward clipboard image bytes to the app. Ghostty paste delivers nothing for images; the clipboard read must be done by the app via a platform-specific backend.

**Backends by platform (priority order):**

| Platform | Command |
|---|---|
| Wayland | `wl-paste --type image/png` |
| X11 | `xclip -selection clipboard -t image/png -o` or `xsel` |
| macOS | `pbpaste` + `pngpaste` |
| WSL | `clip.exe` / PowerShell `Get-Clipboard` |

Claude Code uses exactly this mechanism. The difference for fnclaude: under the renderer, claude runs headless (stream-json), so its own interactive ctrl+v path never fires. **Image paste is therefore the renderer's responsibility.** The flow is: intercept the paste keystroke → run the clipboard backend → base64 the PNG → inject an Anthropic `image` content block into the turn sent over stdin.

`packages/cli/src/mcp/handlers/clipboard-backends.ts` already implements backend selection on the write side — the read side extends that same selection logic. Size cap: 10 MB base64 (Anthropic API limit + stdin throughput).

---

## Math (LaTeX) rendering

**Target library:** `mathjax` v3 (npm, pure Node/Bun, no browser or DOM dependency) → SVG output → `@resvg/resvg-js` → PNG → Kitty pipeline. Latency: ~10–50 ms per expression.

**Avoid:**

- `mathjax-node` — 2018, MathJax v2, requires jsdom. Effectively abandoned.
- Browser-based rendering (Puppeteer) — 2–3 s cold start; overkill for math.

**Alternative:** `RaTeX` (Rust, KaTeX-compatible) — young project, claimed to be fast, but diagram-type coverage and maintenance status are unverified as of this writing. Worth revisiting once it matures.

Unicode-math approximation (e.g. outputting `∫ f(x) dx`) is too lossy for anything beyond the simplest expressions. Use it only as a last-resort fallback with explicit labeling.

---

## Mermaid diagram rendering

Two viable paths, with very different cost profiles:

| Path | Tool | Cold start | Correctness | Recommendation |
|---|---|---|---|---|
| Headless Chromium | `@mermaid-js/mermaid-cli` (`mmdc`) | 2–3 s | Full Mermaid support | Correct; too heavy to bundle |
| Rust + resvg | `mmdr` | ~2–6 ms | Claims 500–1000× faster; coverage unverified | Promising; verify diagram types before committing |

**Recommended approach: opt-in lazy rendering.** Detect a local `mmdc` or `mmdr` binary at startup; skip gracefully if absent (render a fenced code block as-is with a note). Cache diagram hash → PNG so a re-render of an unchanged diagram is free. Never bundle Chromium.

---

## Shared rendering foundation

All of the above — math, `<img>`, mermaid — share the same core pipeline:

```
content  →  PNG  →  base64  →  Kitty escape  →  terminal
```

Build this once as a `renderToKitty(png: Buffer, opts: { cols: number; rows: number }): string` primitive. The content-specific adapters (MathJax, sharp, mmdc/mmdr, fetch) sit above it.

**Arbitrary / uncontrolled HTML:** [Satori](https://github.com/vercel/satori) (Vercel, JSX/HTML+CSS → SVG → resvg → PNG, no browser needed) handles *controlled* HTML templates — flexbox only, no Grid, no `calc`, no `z-index`, no `<style>` blocks, no JS. For genuinely uncontrolled HTML from model output, a real headless browser rendering to an ~80×40 character grid gives poor fidelity-to-cost; hand off to the user's real browser via a link instead of emulating in-grid.

### Recommended build order

1. **Kitty emitter + ink-picture + protocol detection** — the infrastructure everything else plugs into.
2. **Math + `<img>` + pasted-image clipboard read** — the highest-value content types.
3. **Mermaid (opt-in)** — detect binary, cache, skip gracefully if absent.

---

## Interactivity: mouse, links, selection

### Mouse events

Ink 5 (the version pinned in this repo: `ink: "^5.0.0"`) has zero native mouse support. The `Key` interface is keyboard-only.

**How to add mouse:** emit mode-enable escapes to stdout, intercept stdin before Ink's parser:

| Escape | Mode | Notes |
|---|---|---|
| `\x1b[?1000h` | Click only (X10) | Minimal |
| `\x1b[?1002h` | Click + drag | |
| `\x1b[?1003h` | Click + drag + motion | Maximum |
| `\x1b[?1006h` | SGR encoding (cell coords) | Recommended over legacy |
| `\x1b[?1016h` | SGR-Pixels (pixel-exact coords) | Ghostty supports this |

Ghostty supports X10 / normal / button / any-event modes plus SGR cell (`1006h`) and SGR-Pixel (`1016h`, listed as `PIXEL_POSITION_MOUSE` in Ghostty's xterm-behavior audit).

`ink-mouse` existed as a library but was archived in May 2026 — reference only; do not depend on it.

**Two hard conflicts with always-on mouse tracking:**

1. Enabling mouse tracking disables native terminal text-selection (the terminal captures mouse events instead of selecting).
2. The scroll wheel is forwarded to the app rather than scrolling terminal scrollback.

Mouse tracking must be an opt-in, transient "nav mode," never global.

### OSC 8 hyperlinks

Format: `\x1b]8;;URL\x1b\\text\x1b]8;;\x1b\\` (BEL `\x07` is also a valid terminator). Ghostty supports OSC 8 (since PR #1928, 2024).

**A confirmed `string-width` bug gates their use.** `string-width` (Ink's internal column-width measurer) strips CSI escape sequences but not OSC sequences. OSC 8 bytes inflate the measured column width, causing broken wrapping and misaligned table borders in any cell that contains a link. This bit fnclaude directly: the `TableBlock` component added in PR #261 used a `visibleWidth` regex that consumed only the `ESC]` prefix and left `8;;<url>\x07` counted as visible characters, misaligning columns with links. PR #263 removed OSC 8 to fix the regression. See the corresponding decision in [`specs/decisions.md`](../decisions.md).

### ctrl+click on links — who owns it

ctrl+click on a raw `http://…` URL in Ghostty's terminal grid is handled by **Ghostty's own `link-url` regex matcher**, not by the app. The app has no involvement in this event. Subtlety: ANSI styling applied around the URL text can break Ghostty's plain-text regex match. Consequence: keep link text styled blue+underline (matching the URL shape exactly or wrapping it cleanly) so Ghostty's matcher finds the URL shape in the cell grid.

### `<details>`/`<summary>` collapsible sections

Keyboard-first implementation is self-contained and feasible:

- A `FocusManager` context owns `focusedIndex`.
- Arrow keys move focus; Enter/Space toggles the collapsed state.
- `▸`/`▾` glyphs + focus indicator provide affordance.

Mouse-click toggle depends on the mouse infrastructure above. Status: **punted** — not currently in the build plan, but framed as a future primitive.

### Footnote / anchor → scroll-to + flash

Flash-on-visible-target is straightforward (`flashingKeys` set + `backgroundColor` + a timeout). True scroll-to-target is not — Ink has no y-position API and no scroll control; implementing it requires a windowed fixed-height viewport with estimated per-event row heights. Status: **deferred and coupled** — flash without scroll is useless, so they ship together or not at all.

---

## Scrolling and the transcript architecture

### Native terminal scroll vs. app-owned scroll

| Aspect | Native (content flows inline) | App-owned (wheel events + viewport) |
|---|---|---|
| Smoothness | GPU-composited, trackpad inertia, zero app round-trips | Stutters — re-emit/redraw over a serial escape channel |
| Inline image scroll | Generally works (icat-style natural flow) | **Blocked by Ghostty issue #4323 (OPEN):** Kitty images don't follow CSI-driven scroll, forcing a full per-frame redraw |
| Text selection | Native, immediate | Conflicts with mouse tracking (see above) |
| App awareness of scroll offset | None — terminal owns the offset, never reports it | Full — but requires taking over the wheel |

**Ghostty issue #4323** specifically affects programmatic/CSI scroll commands — natural newline-flow scroll of inline images works. This means the incremental "CSI-scroll + draw only new rows" trick doesn't work in Ghostty today, so app-owned scroll with images is forced into full per-frame redraws.

### Native scroll XOR mouse tracking

These are mutually exclusive: enabling mouse tracking takes over the scroll wheel, and the terminal never reports its scrollback offset to the app. "Custom selection across the whole transcript" therefore forces app-owned scroll and incurs the smoothness cost above.

### The `<Static>` finding

**Current state:** `packages/renderer/src/App.tsx` renders the entire transcript as one dynamic column — `{events.map(...)}` inside a single `<Box flexDirection="column">`. There is no `<Static>` (the file imports only `Box`, `Text`, `useInput`). This re-renders all history on every frame. CPU grows with transcript length; Ink's cursor-up repaint corrupts / flickers once content exceeds viewport height (the exact failure mode `<Static>` was designed to prevent). For inline images this is fatal: every image in history would be re-emitted on every keystroke.

**Recommended foundation (pre-requisite for any inline-image work):** move finalized transcript events into Ink's `<Static>` (emitted once → real terminal scrollback → native scroll; native text-selection on the text parts; inline images emitted once and scrolled by the terminal), keeping only the live streaming message and the input box in the dynamic tree.

### Layered transparent-overlay selection (future path)

If custom selection is ever built, the Kitty protocol supports z-index layering with alpha-blending of overlapping placements, and Ghostty has full support including gamma-correct blending. The approach:

1. Transmit the base content image once at low z.
2. Render the selection highlight as a small, mostly-transparent RGBA overlay at higher z — only the selection's bounding box, not the full window.
3. Transmit only the overlay per selection change; the GPU composites it for free. The heavy base image is never re-sent during a drag.
4. Throttle repaints to cell-span changes; use place-new-before-delete-old to avoid flash; drive the overlay via a direct escape write outside Ink.

This solves the selection *feedback-rendering* cost but not scrolling (moving the base image still requires retransmission) nor the pixel→text mapping needed to actually copy selected text.

---

## Mixed font sizes

Not feasible — terminals are a fixed cell grid. Differentiate heading levels and emphasis via weight, color, and underline, not size. (H1–H6 differentiation via these axes was shipped in PR #261.)

---

## Sources and durable references

| Source | Notes |
|---|---|
| [Kitty graphics protocol spec](https://sw.kovidgoyal.net/kitty/graphics-protocol/) | Chunk size, `m=` flag, `f=100`, `a=T` semantics |
| [Ghostty issue tracker — sixel rejection](https://github.com/ghostty-org/ghostty) | Maintainer comment citing libsixel quality + Kitty as alternative |
| [Ghostty PR #1928](https://github.com/ghostty-org/ghostty/pull/1928) | OSC 8 support landed |
| [Ghostty issue #4323](https://github.com/ghostty-org/ghostty/issues/4323) | Kitty images don't follow CSI-driven scroll (OPEN as of 2026-06-26) |
| [ink-picture v2](https://www.npmjs.com/package/ink-picture) | Ink Kitty image component; space reservation + per-frame re-emit |
| [supports-terminal-graphics](https://www.npmjs.com/package/supports-terminal-graphics) | Protocol detection at startup |
| [chafa](https://hpjansson.org/chafa/) | C/WASM fallback cascade |
| [MathJax v3 npm](https://www.npmjs.com/package/mathjax) | Pure Node, no DOM, SVG output |
| [@resvg/resvg-js](https://www.npmjs.com/package/@resvg/resvg-js) | Rust/napi SVG → PNG; Bun-compatible |
| [Satori](https://github.com/vercel/satori) | JSX/HTML+CSS → SVG → PNG, no browser; flexbox-only |
| [xterm.net mouse modes](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Mouse-Tracking) | `1000h` / `1002h` / `1003h` / `1006h` / `1016h` escape reference |
| [string-width](https://www.npmjs.com/package/string-width) | Ink's internal column measurer; strips CSI, not OSC |
