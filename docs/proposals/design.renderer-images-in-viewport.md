# fnclaude — inline images inside the app-owned scroll viewport

> **Status: forward-looking.** Design, not shipped code. This document
> **supersedes the `<Static>`-based M0** in
> [`design.renderer-images.md`](design.renderer-images.md). Read this one
> for the rendering foundation; that one still holds for the parts that are
> orthogonal to scroll (the SSRF/path-traversal security model, the paste
> pipeline, the math/mermaid adapters).

## Why this doc exists

The earlier images design made one load-bearing assumption that is now
false: it specced **milestone M0 as moving the finalized transcript into
Ink's `<Static>`** so images would be emitted once into the terminal's
*native scrollback* and the terminal would own scrolling them.

PR #284 shipped an **app-owned scroll viewport** instead. The renderer no
longer relies on terminal scrollback for the transcript — it clips the
committed transcript itself (`overflowY="hidden"` plus a negative
`marginTop`) and **re-renders the React tree on every scroll**. The scroll
machinery (`src/scroll/`) — anchored sticky-follow, per-row height
measurement, reanchor-on-growth, the keybinds, the Alt+u token-burn
toggle, and the deferred scroll-to-anchor+flash feature — is **non-negotiable
and will not be walked back**.

`<Static>` and the app-owned viewport are **mutually exclusive**:

- `<Static>` hands lines to the terminal's scrollback and never touches
  them again. The app cannot clip, reanchor, filter, or re-lay-out content
  it has given away.
- The viewport does exactly those things — it owns the window, the offset,
  and the relayout.

So **`<Static>` is off the table.** Inline images must survive Ink's
clipping, relayout, and per-scroll redraw. This doc picks an image
technique that does, and rewrites the milestone plan around it.

Cross-references:

- [`design.renderer-images.md`](design.renderer-images.md) — the original
  images playbook; still authoritative for security, paste, math/mermaid.
- [`design.renderer.md`](design.renderer.md) — renderer↔CLI integration.
- [`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md)
  — broad feasibility survey.
- `src/scroll/` — `useAnchoredScroll`, `ScrollViewport`, `MeasuredRow`,
  `anchor.ts`. The integration surface for this design.
- `src/capabilities.ts` (#295, merged) — env-only terminal capability
  detection; the gate this design extends.

---

## 1. The constraint, stated precisely

The viewport works like this (`src/scroll/ScrollViewport.tsx`):

```tsx
<Box height={height} overflowY="hidden" flexDirection="column">
  <Box ref={contentRef} flexShrink={0} marginTop={-scrollOffset}>
    {children}
  </Box>
</Box>
```

The inner box holds the **full unclipped** transcript; `flexShrink={0}`
keeps Yoga from compressing it so `useBoxMetrics` reports true content
height. The outer box is a fixed-height window; everything above the
window (negative `marginTop`) and below it (`overflowY="hidden"`) is
clipped. Scroll = change `scrollOffset` = Ink re-lays-out and repaints the
whole inner box at a new offset.

For an image to live in this transcript it must:

1. **Be a real participant in the cell grid** — occupy a known number of
   rows and columns that Yoga lays out and `MeasuredRow` can measure, so
   the anchor math in `src/scroll/anchor.ts` stays correct.
2. **Move with its cells when the offset changes** — no fixed pixel
   anchor that the negative-margin shift leaves behind.
3. **Clip gracefully at the window edge** — show a partial image when the
   row sits half-in/half-out of the viewport, not a smear or an orphan.
4. **Not re-transmit its pixels every frame** — a scroll is a full
   repaint; re-sending base64 on each keystroke is fatal.

Only one technique satisfies all four. The rest fail (2) or (3).

---

## 2. Technique evaluation — scored on scroll-compatibility

| Technique | Anchoring | Survives clip + relayout + re-render? | Verdict |
|---|---|---|---|
| **Kitty Unicode placeholders (virtual placement)** | **Cell** — image is pinned to placeholder *text cells* | **Yes** — cells reflow/clip/scroll like any text; image follows them | **Primary** |
| Kitty *direct* placement (`a=T` at cursor) | Cursor pixel position at emit time | No — image stays where the cursor was; the negative-margin shift slides the cells out from under it → orphan/overlap | Rejected for transcript |
| iTerm2 OSC 1337 inline image | Cursor / insertion point | No — same cursor-anchor failure; designed for append-to-scrollback flow, not in-place relayout | Fallback only (→ half-block) |
| Sixel | Cursor, raster dumped into the grid | No — pixels are baked at the cursor; a re-render at a new offset double-paints or orphans (the classic "frame at (1,1) scrolls down and isn't overwritten" bug) | Fallback only (→ half-block) |
| Overlay process (ueberzug / ueberzugpp) | Separate OS window positioned *over* the terminal | Partially, but app must re-feed pixel coordinates on every scroll frame; X11/Wayland-only, no SSH, obscures popups, drifts | Rejected — wrong model for an in-band TUI |
| Cell-based (chafa / half-block / sextant / braille) | **Cell** — it *is* colored text | **Yes** — trivially, because it is text | **Fallback** (universal, low-res) |

The split is clean: **cell-anchored techniques survive, cursor-anchored
techniques don't.** The viewport's negative-margin relayout is precisely
the operation that orphans a cursor-anchored bitmap, because the cursor
position the bitmap was painted at no longer corresponds to the cell that
"owns" it after the shift.

### 2.1 Why Kitty Unicode placeholders win

The Kitty graphics protocol has two placement modes:

- **Direct placement** (`a=T`): the terminal draws the image at the
  current cursor pixel position. Fixed to pixels, not cells.
- **Virtual placement + Unicode placeholders** (`a=p,U=1` + `U+10EEEE`
  cells): the image is *referenced* by special placeholder characters in
  the text. **The terminal paints the image into whatever cells currently
  hold the placeholder characters.** Move the characters — by reflow,
  scroll, clip, relayout — and the image moves with them, because to the
  application the placeholders are just ordinary Unicode text.

This is exactly the property the viewport needs. The image becomes a block
of text cells; Ink lays them out, clips them, and repaints them at the new
offset like any other text, and the terminal keeps the picture glued to
them.

**How it works on the wire:**

1. **Transmit once, quietly, no placement:**
   `ESC _ G a=t,f=100,t=d,i=<id>,q=2 ; <base64-png-chunks> ESC \`
   (`q=2` suppresses the terminal's ok/error reply; `a=t` = transmit
   only). The pixels now live in the terminal keyed by image id `<id>`.
2. **Declare a virtual placement** — an invisible prototype sized in cells:
   `ESC _ G a=p,U=1,i=<id>,c=<cols>,r=<rows> ESC \`
3. **Emit the placeholder cells** as normal text inside the render tree.
   Each cell is `U+10EEEE`, its **foreground color encodes the image id**,
   and **combining diacritics encode the row and column** of the image
   that cell should show:
   ```
   # a 2-col × 2-row image with id 42, in 256-color mode:
   \e[38;5;42m \u{10EEEE}\u{0305}\u{0305}  \u{10EEEE}\u{0305}\u{030D} \e[39m
   \e[38;5;42m \u{10EEEE}\u{030D}\u{0305}  \u{10EEEE}\u{030D}\u{030D} \e[39m
   ```
   `U+0305` = index 0, `U+030D` = index 1, etc. **Diacritic inheritance**
   lets you drop them: a placeholder cell with no diacritics and the same
   fg/underline color as its left neighbor inherits `row = left.row`,
   `col = left.col + 1`. So a full rectangle only needs the row diacritic
   on the first cell of each line.

Because step 1 happens *once* and steps 2–3 are just text, **a scroll
re-render rewrites only cheap placeholder cells — it never re-transmits
the base64.** This is the same "encode once, re-place cheaply" pattern
`ratatui-image` uses to make Kitty work inside *its* immediate-mode redraw
loop, which is structurally identical to Ink's.

### 2.2 Clipping at the viewport edge — the free win

When a row of placeholder cells sits half inside the window, the viewport
clips it like any text row. The terminal then paints **only the
sub-rectangle of the image mapped to the still-visible placeholder cells**
— because every placeholder cell carries its own (row, col) coordinate
into the image. Partial-image clipping at the top/bottom edge is therefore
*automatic*, not something the renderer computes. (This is the single most
important behavior to verify empirically — see §6.)

---

## 3. Terminal support and the capability gate

Unicode-placeholder support is **narrower** than Kitty-graphics support
generally. This matters because `src/capabilities.ts` currently collapses
kitty/ghostty/wezterm into one `images: "kitty"` value, which is **too
coarse for this design**.

| Terminal | Kitty graphics | Unicode placeholders | In-viewport plan |
|---|---|---|---|
| kitty | Yes | **Yes** | Placeholders |
| Ghostty | Yes | **Yes** (added 2024; the only non-kitty terminal with it) | Placeholders |
| WezTerm | Yes (direct placement) | **No** | Half-block fallback |
| Konsole | Yes (direct) | No | Half-block fallback |
| iTerm2 | OSC 1337 | n/a | Half-block fallback |
| everything else | — | — | Half-block / `[image]` text |

> **Load-bearing, verify before building:** as of this writing only kitty
> and Ghostty implement Unicode placeholders. WezTerm tracks Kitty
> graphics but **direct placement only** — direct placement is
> cursor-anchored and orphans in our viewport, so WezTerm must use the
> half-block fallback *even though `capabilities.images` says `"kitty"`*.
> Re-check WezTerm/Konsole placeholder status at implementation time; the
> matrix shifts.

**Capability change required (small, additive):** add a distinct signal
for "placeholders are safe," e.g. extend `ImageProtocol` with a
`"kitty-placeholder"` value (or add a `kittyPlaceholders: boolean`), and
gate it on kitty (`KITTY_WINDOW_ID`) or Ghostty only — *not* the broader
kitty-graphics set. `detectImages` already has the terminal branches; this
is a one-branch refinement, env-only, unit-testable, consistent with the
module's existing conservative-degrade philosophy. Ghostty is the maintainer's
target terminal, so the primary path is exercised by default.

---

## 4. Integration with the scroll machinery

The decisive architectural simplification: **both the primary
(placeholder) and fallback (half-block) renderers produce the same thing
— a `rows × cols` block of text cells of known dimensions.** Only the cell
*content* differs (PUA placeholder chars vs. colored half-block chars).
Everything downstream — measurement, anchoring, clipping — is identical
and already exists.

### 4.1 The image primitive

A single component renders an image as an explicit-dimension Box:

```tsx
// dimensions in cells, computed from the image's pixel size / cell size
<Box width={cols} height={rows} flexShrink={0}>
  <Text>{cellGrid}</Text>   // placeholder rows OR half-block rows
</Box>
```

Give the Box **explicit `width`/`height` in cells** rather than relying on
Ink/`string-width` to measure `U+10EEEE` + combining diacritics — PUA and
combining-char width is exactly the kind of thing terminals and width
tables disagree on, and an explicit Box sidesteps it. (See the flicker/
measurement risks in §6.)

### 4.2 Where each piece plugs in

| Concern | Component | What changes |
|---|---|---|
| **Row-height measurement** | `MeasuredRow` (`src/scroll/MeasuredRow.tsx`) | **Nothing.** The image Box is `rows` cells tall; `useBoxMetrics` reports `rows`; the height flows up via `reportRowHeight` exactly like a text row. The image primitive must commit to its row count *before* paint so the measured height is stable. |
| **Scroll/anchor math** | `useAnchoredScroll` + `anchor.ts` | **Nothing.** It already consumes per-row heights generically and "carries NO knowledge of transcripts" — an image row is just a taller row. |
| **Clip + offset** | `ScrollViewport` | **Nothing.** Placeholder/half-block cells clip with the negative-margin shift like any text. The terminal clips the image to the visible placeholder cells. |
| **Capability gate** | `capabilities.ts` (#295) | Add the placeholder-distinct signal (§3); choose renderer = placeholders \| half-block \| `[image: alt]`. |
| **Pixel transmission** | new side-effect, *out of band* | Transmit `a=t,q=2` **once per image id** in a `useEffect` that writes directly to stdout — **not** through Ink's render string. Ink owns the placeholder *cells*; the renderer owns the one-time pixel upload. Keyed by a stable id (content hash) so it fires once regardless of re-render count. |

### 4.3 Emit ordering relative to the clip

- **Placeholder cells** go *through* Ink, inside the clipped inner box of
  `ScrollViewport`. They participate in layout and clipping normally.
- **Pixel data** (`a=t`) and the **virtual-placement declaration**
  (`a=p,U=1`) go *around* Ink — written once to stdout from a side-effect,
  before the first frame that references the id. They carry no cursor
  position and paint nothing on their own, so they're immune to Ink's
  repaint-clears-the-screen behavior. Ink redrawing the placeholder cells
  is what makes the image (re)appear.

This separation is the whole trick: **the expensive, stateful part
(pixels) is emitted once and lives in the terminal; the cheap, positional
part (cells) goes through Ink's normal render/clip/scroll path.**

### 4.4 Computing rows × cols

`rows = ceil(imgPxHeight / cellPxHeight)`, `cols = ceil(imgPxWidth /
cellPxWidth)`, after downscaling the image to a sane on-screen size. Cell
pixel size comes from the terminal where available (kitty/Ghostty report
it; iTerm2 has `OSC 1337 ReportCellSize`); when unknown, fall back to a
fixed ratio (`ratatui-image` uses 4:8 px for half-blocks). The chosen
`rows` value is what `MeasuredRow` will report, so it must be decided
*before* the row is laid out, not discovered after.

---

## 5. Milestone plan (replaces M0/M1/M2)

The old M0 (`<Static>` refactor) is **deleted**. The scroll viewport from
#284 *is* the foundation; there is no transcript-architecture prerequisite
left to build.

| Milestone | Deliverable | Integration points |
|---|---|---|
| **V0 — capability split** | Extend `capabilities.ts` to distinguish placeholder-capable terminals (kitty, Ghostty) from the broader kitty-graphics set; downgrade WezTerm/Konsole/iTerm2 to half-block for *in-viewport* images. Unit tests on the env matrix. | `src/capabilities.ts` (#295) |
| **V1 — the cell-grid image primitive + fallback** | The `rows × cols` image Box (§4.1); the half-block fallback path; the placeholder-cell encoder (id → fg color, row/col → diacritics, inheritance); the **transmit-once** out-of-band side-effect; render a fixture PNG **inside the scroll viewport** and prove it scrolls, clips at both edges, and survives a relayout. | `ScrollViewport`, `MeasuredRow`, `useAnchoredScroll`, `capabilities.ts` |
| **V2 — model-output images** | `MarkdownRenderer` `image` inline token + `<img>` html case → resolution pipeline (fetch / `fs.readFile`) → SVG→PNG → downscale → rows×cols → image primitive. **Reuse the SSRF + path-traversal guards, the async pre-resolve cache, and `@resvg/resvg-js`/`sharp` exactly as specced in [`design.renderer-images.md`](design.renderer-images.md) §4** — those are scroll-independent and carry over unchanged. | `MarkdownRenderer.tsx`, V1 primitive |
| **V3 — image lifecycle** | Delete pixel data (`a=d,d=i,i=<id>`) when an event is evicted (e.g. post-compaction) to stay inside the terminal's per-screen image budget; handle resize (recompute rows×cols, re-place — pixels stay resident, only cells change). | image-id registry, `useAnchoredScroll` (resize) |

Paste/thumbnail support (#293, M3 in the old doc) is unchanged in
*concept* — it just renders its thumbnail through the **V1 primitive**
instead of an `ink-picture` `<Static>` child. The note in the old doc that
the thumbnail "moves to the transcript as a finalized event under
`<Static>`" no longer applies; it moves to a committed transcript row
inside the viewport like everything else.

V2 and V3 are independent once V1 lands; V0 gates V1.

> **`ink-picture` no longer fits.** The old doc recommended `ink-picture`,
> whose model is "reserve Flexbox space + re-emit the Kitty escape via
> cursor positioning each frame, fall back to half-blocks when scrolled out
> of view." That is **direct (cursor) placement re-emitted per frame** —
> exactly the cursor-anchored approach §2 rejects, and it re-transmits on
> every scroll. The placeholder approach replaces it. If a library is still
> wanted, it must be one that emits **Unicode placeholders** (the
> `ratatui-image` model), not cursor-positioned direct placement; otherwise
> hand-roll the small encoder (it is a few dozen lines).

---

## 6. Known problems and mitigations

The maintainer asked specifically "what problems to expect." Enumerated:

| Problem | Why it happens | Mitigation |
|---|---|---|
| **Image orphaned / duplicated on scroll** | Cursor-anchored protocols (direct kitty, iTerm2, sixel) paint at a fixed position; the negative-margin relayout slides the cells away | Use **cell-anchored** Unicode placeholders; the image is bound to cells, not pixels. This is the entire reason for the design. |
| **Partial-image clip at the window edge** | A row straddling the viewport boundary is half-clipped | With placeholders this is *automatic* — each visible placeholder cell carries its own (row,col) into the image, so the terminal shows exactly the visible sub-rectangle. **Must verify empirically per terminal** (§6 note). |
| **Re-emit cost every scroll frame** | A scroll is a full repaint; re-sending base64 each frame is fatal | **Transmit pixels once** (`a=t,q=2`, keyed by id, out of band); per-frame work is only cheap placeholder text. |
| **Image-id leak / budget exhaustion** | Terminals cap stored image data (Ghostty ~320 MB/screen); never-deleted ids accumulate | Stable id per image (content hash); `a=d,d=i,i=<id>` on event eviction (V3). Virtual placements only delete with `d` ∈ {i,I,r,R,n,N}. |
| **Row-height measurement wrong** | Anchor math needs the image's row count; if `MeasuredRow` measures it wrong, scroll position drifts | Render the primitive as an **explicit `width`/`height` Box** (cells decided before layout). Don't rely on `string-width` for `U+10EEEE` + combining chars. |
| **`string-width` miscounts placeholder cells** | PUA + combining-diacritic width is inconsistent across width tables; Ink/Yoga lay out by measured string width | Explicit-dimension Box (above). Validate that Ink emits the raw placeholder bytes + SGR fg color **without** stripping/rewriting them — Ink's color handling and any text transforms are a risk surface; test with a known id and assert the bytes on the PTY. |
| **Flicker on redraw** | If pixels were re-transmitted per frame, or if the terminal re-decodes on each placement | Transmit-once removes re-decode; placement is just text. Residual flicker is a per-terminal concern to measure. |
| **Capability misdetection → orphans** | Treating all kitty-graphics terminals as placeholder-capable sends placeholders to WezTerm/Konsole, which render them as garbage or fall to direct placement | The §3 capability split; conservative-degrade to half-block on anything not confirmed kitty/Ghostty. |
| **Interaction with Ink's reconciler/relayout** | Ink diffs and repaints; the image data lives outside its model | Keep pixels strictly out of band (side-effect to stdout); let Ink own only the placeholder cells. The reconciler then treats an image row as ordinary text and cannot lose the pixels. |
| **Fully scrolled out of view** | Image row clipped entirely away | No visible placeholder cells → terminal paints nothing for it; pixels stay resident (cheap) until V3 eviction. No orphan, because orphans require a stale *visible* placement, and there is none. |
| **tmux / multiplexer passthrough** | Placeholders were *designed* for multiplexers (that's their headline use case), but require the multiplexer to pass APC + forward the PUA cells | Out of scope for v1 (no multiplexer in the target setup); note that placeholders are the *only* approach with a path to tmux support later. |
| **Cell pixel size unknown** | rows×cols computation needs cell dimensions | Query the terminal (kitty/Ghostty report; iTerm2 `ReportCellSize`); fall back to a fixed ratio when unknown. |

> **Empirical-verification gate.** Two behaviors are load-bearing and
> under-documented across terminals: (a) partial-image clipping when only
> some placeholder rows are visible, and (b) Ink emitting the
> placeholder + SGR sequence byte-for-byte. **V1 must prove both in
> Ghostty (and kitty) before V2 builds on them.** If a terminal paints the
> whole image regardless of how many placeholder cells are visible, the
> edge-clip story changes and the viewport may need to special-case
> top/bottom-edge image rows. The research could not confirm partial-clip
> behavior from documentation alone — treat it as the first thing to test,
> not an assumption.

---

## 7. References

| Source | Notes |
|---|---|
| [Kitty graphics protocol — Unicode placeholders](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders) | Virtual placement (`a=p,U=1`), `U+10EEEE`, fg-color id encoding, row/col diacritics, diacritic inheritance, deletion modes |
| [Kitty graphics protocol — deleting images](https://sw.kovidgoyal.net/kitty/graphics-protocol/#deleting-images) | `a=d` modes; virtual placements delete only with `d` ∈ {i,I,r,R,n,N} |
| [terminfo.dev — Kitty graphics protocol support](https://terminfo.dev/extensions/kitty-graphics-protocol) | Per-terminal support matrix |
| [Ghostty adds Unicode placeholder support](https://x.com/mitchellh/status/1818696111999299976) | Ghostty is the only non-kitty terminal with placeholders; enables tmux |
| [WezTerm Kitty image protocol tracking (#986)](https://github.com/wezterm/wezterm/issues/986) | WezTerm Kitty support status (direct placement) |
| [ratatui-image](https://github.com/ratatui/ratatui-image) | The closest analog: image widget in an **immediate-mode** TUI; kitty placeholders + halfblock fallback; "encode once, re-place cheaply"; stateless `Image` vs blocking `StatefulImage` |
| [ratatui-image docs](https://docs.rs/ratatui-image/latest/ratatui_image/) | Kitty "stateful but can re-render at a position"; skips cells covered by the image; halfblocks universal fallback |
| [chafa](https://hpjansson.org/chafa/) | Cell-based fallback: half-block / sextant / braille; always scroll-safe because it is text |
| [presenterm — images](https://mfontanini.github.io/presenterm/features/images.html) | Real scrollless slideshow; protocol auto-detect + explicit `--image-protocol`; not a scroll reference but a protocol-selection one |
| [ueberzugpp](https://github.com/jstkdng/ueberzugpp) | Overlay model; "hacky" external window, drifts, no SSH, obscures popups — why it is rejected here |
| [yazi image-preview docs](https://yazi-rs.github.io/docs/image-preview/) | How a scrollable TUI selects protocols and copes with overlay drift |
| [claude-code issue #54546](https://github.com/anthropics/claude-code/issues/54546) | Upstream request for inline images "surviving repaints/scrolling/resize" — same problem statement |
| [`design.renderer-images.md`](design.renderer-images.md) | Original playbook; security model, paste, math/mermaid, Kitty wire format carry over |
