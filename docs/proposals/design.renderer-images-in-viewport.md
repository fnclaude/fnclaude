# fnclaude — inline images in the app-owned scroll viewport

> **Status: forward-looking.** Design, not shipped code. This document
> **supersedes the `<Static>`-based M0** in
> [`design.renderer-images.md`](design.renderer-images.md). Read this one
> for the rendering foundation; that one still holds for the parts that are
> orthogonal to scroll (the SSRF/path-traversal security model, the paste
> pipeline, the math/mermaid adapters, the Kitty wire format + `emitKittyImage`).

## Why this doc exists

The earlier images design assumed **M0 = move the finalized transcript into
Ink's `<Static>`** so images would land once in the terminal's *native
scrollback* and the terminal would scroll them. PR #284 shipped an
**app-owned scroll viewport** instead: the renderer clips the transcript
itself (`overflowY="hidden"` + negative `marginTop`) and **re-renders the
React tree on every scroll**. The scroll machinery (`src/scroll/`) —
anchored sticky-follow, per-row height measurement, reanchor-on-growth, the
keybinds, the Alt+u token-burn toggle, the deferred scroll-to-anchor+flash —
is **non-negotiable and will not be walked back**. `<Static>` hands lines to
scrollback and can't clip/reanchor/relayout them, so **`<Static>` is off the
table**.

**The goal is true inline rendering: image bitmaps painted directly in the
scrolling transcript, surviving Ink's clip + relayout + per-scroll redraw.**
This doc's headline recommendation makes that happen, states plainly which
technique can deliver it and which can't, and defines a graceful-degradation
path (placeholder + modal popup, §6) for the cases where a full-fidelity
inline bitmap genuinely isn't achievable.

Cross-references:

- [`design.renderer-images.md`](design.renderer-images.md) — original
  playbook; still authoritative for security, paste, math/mermaid, wire
  format.
- [`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md)
  — feasibility survey (mouse-SGR infra, keyboard focus model,
  scroll-vs-mouse conflict, z-index layering) reused below.
- [`design.renderer.md`](design.renderer.md) — renderer↔CLI integration.
- `src/scroll/` — `useAnchoredScroll`, `ScrollViewport`, `MeasuredRow`,
  `anchor.ts`.
- `src/capabilities.ts` (#295, merged) — env-only capability detection.
- `src/mount.tsx` — mounts Ink with `alternateScreen: true`.

---

## 1. The constraint, stated precisely

`src/scroll/ScrollViewport.tsx`:

```tsx
<Box height={height} overflowY="hidden" flexDirection="column">
  <Box ref={contentRef} flexShrink={0} marginTop={-scrollOffset}>
    {children}
  </Box>
</Box>
```

The inner box holds the full unclipped transcript; `flexShrink={0}` keeps
Yoga from compressing it so `useBoxMetrics` reports true height. The outer
box is a fixed window; content above (negative `marginTop`) and below
(`overflowY="hidden"`) is clipped. **A scroll is not a terminal CSI-scroll —
it is a full Ink re-render at a new offset.** That distinction is the crux
of everything below.

An inline image must: (1) participate in the cell grid with a known
rows×cols footprint so `MeasuredRow` measures it and `anchor.ts` stays
correct; (2) move with its cells when the offset changes; (3) clip
gracefully at the window edge; (4) not re-transmit pixels every frame.

---

## 2. Technique feasibility — can a bitmap survive the re-render?

| Technique | Anchoring | Survives the viewport's clip + relayout + re-render? | Verdict |
|---|---|---|---|
| **Kitty Unicode placeholders (virtual placement)** | **Cell** — image is bound to placeholder *text cells* | **Yes.** The cells are ordinary text; Ink lays them out, clips them, and repaints them at the new offset, and the terminal keeps the image glued to whatever cells hold the placeholders. | **Primary (graphics)** |
| **Cell-based: chafa / half-block / sextant / braille** | **Cell** — it *is* colored text | **Yes, trivially.** Lower resolution, but scroll-safe by construction and works on any color terminal. | **Primary fallback (universal, still inline)** |
| Kitty *direct* placement (`a=T` at cursor) | Cursor pixel position | **No.** Ghostty issue #4323: classic placements don't follow scrolled text. In our re-render loop the image stays where the cursor was; the relayout slides cells out from under it → orphan/overlap. | Rejected for the transcript (used only in the §6 modal) |
| iTerm2 OSC 1337 / Sixel | Cursor / raster at cursor | **No.** Same cursor-anchor failure. Textual (an app-owned-scroll TUI like ours) reports Sixel "injected in a hacky manner… scrolling leads to a lot of flickering… for mostly static images it should work fine" — i.e. it does **not** survive an actively scrolling, re-rendered viewport. | Rejected for the transcript (used only in the §6 modal) |
| Overlay process (ueberzug/ueberzugpp) | External window over the terminal | Only by re-feeding pixel coordinates every scroll frame; X11/Wayland-only, no SSH, drifts, obscures popups. | Rejected — wrong model for an in-band TUI |

**The finding is unambiguous: only cell-anchored techniques survive the
re-render.** Cursor-anchored bitmaps (direct Kitty, iTerm2, Sixel) orphan
because the cursor position they were painted at no longer maps to the cell
that "owns" them after the negative-margin shift — this is exactly what
Ghostty #4323 documents for direct placements and what Textual observes for
Sixel. No trick from yazi/timg/presenterm salvages them **for a
continuously re-rendered viewport**: those tools either don't scroll the
image region (presenterm slides are static; timg prints once), rely on
natural newline-flow into scrollback (which the app-owned viewport
deliberately doesn't use), or repaint via an overlay process (ueberzug).
The techniques that *do* work in a scrolling TUI are the cell-anchored ones —
which is why `ratatui-image` (kitty placeholders + half-block) and Textual's
TGP widget scroll cleanly where their Sixel paths flicker.

So the inline design is a **two-tier cell-anchored cascade**, both tiers
rendered *inline in the viewport*:

1. **Kitty Unicode placeholders** on kitty/Ghostty — real bitmap fidelity.
2. **Half-block/sextant cells (chafa)** everywhere else with color — lower
   resolution, but a genuine inline image that scrolls perfectly.

The modal popup (§6) is the graceful-degradation path for the residual
cases, and an optional "view full-resolution" affordance — not the primary.

---

## 3. Primary: Kitty Unicode placeholders (virtual placement)

The Kitty protocol has two placement modes. **Direct placement** (`a=T`)
paints at the cursor pixel position — cursor-anchored, rejected above.
**Virtual placement + Unicode placeholders** references the image from
special placeholder characters in the *text*; the terminal paints the image
into whatever cells currently hold those characters. Move the characters —
by reflow, scroll, clip, relayout — and the image moves with them, because
to the application the placeholders are ordinary Unicode text. That is
precisely the property the re-rendered viewport needs.

**On the wire:**

1. **Transmit once, quietly, no placement:**
   `ESC _ G a=t,f=100,i=<id>,q=2 ; <base64-png-chunks> ESC \`
   (`q=2` suppresses the ok/error reply; `a=t` = transmit only). Pixels now
   live in the terminal keyed by image id `<id>`.
2. **Declare a virtual placement** (invisible prototype, sized in cells):
   `ESC _ G a=p,U=1,i=<id>,c=<cols>,r=<rows> ESC \`
3. **Emit the placeholder cells** as normal text in the render tree. Each
   cell is `U+10EEEE`; its **foreground color encodes the image id**, and
   **combining diacritics encode the (row, col)** of the image that cell
   shows. `U+0305` = index 0, `U+030D` = index 1, … **Diacritic
   inheritance:** a placeholder cell with no diacritics and the same
   fg/underline color as its left neighbor inherits `row = left.row`,
   `col = left.col + 1`, so a rectangle only needs the row diacritic on the
   first cell of each line.

Because step 1 happens **once** and steps 2–3 are just text, **a scroll
re-render rewrites only cheap placeholder cells and never re-transmits the
base64.** This is the "encode once, re-place cheaply" pattern `ratatui-image`
uses to make Kitty work inside *its* immediate-mode redraw loop, which is
structurally identical to Ink's.

**Edge clipping (the free win, with an honest caveat).** When a placeholder
row sits half inside the window, the viewport clips it like any text row;
each *visible* placeholder cell carries its own (row, col) into the image,
so the terminal should paint only the visible sub-rectangle. This makes
partial-image clipping at the top/bottom edge *automatic* — **if** the
terminal implements per-cell placeholder clipping. That behavior is
**under-documented and MUST be verified empirically** in kitty and Ghostty
before building on it (§7). If a terminal instead paints the whole image
regardless of how many placeholder cells are visible, the viewport must
special-case the top/bottom edge rows.

**Terminal support (narrow — gates the capability change):**

| Terminal | Kitty graphics | Unicode placeholders | Inline plan |
|---|---|---|---|
| kitty | Yes | **Yes** | Placeholders |
| Ghostty | Yes | **Yes** (only non-kitty terminal with it; enables tmux) | Placeholders |
| WezTerm | Yes (direct only) | **No** | Half-block cells (§4) |
| Konsole | Yes (direct) | No | Half-block cells |
| iTerm2 | OSC 1337 | n/a | Half-block cells |
| no graphics, has color | — | — | Half-block cells |
| no color / dumb | — | — | Text placeholder + modal (§6) |

> **Capability change required (small, additive).** `src/capabilities.ts`
> currently collapses kitty/ghostty/wezterm into `images: "kitty"`, which is
> too coarse: WezTerm/Konsole do Kitty graphics but **direct placement
> only**, which orphans in the viewport. Add a placeholder-distinct signal
> (e.g. extend `ImageProtocol` with `"kitty-placeholder"` or add
> `kittyPlaceholders: boolean`) gated on kitty (`KITTY_WINDOW_ID`) or
> Ghostty only. Env-only, unit-testable, consistent with the module's
> conservative-degrade philosophy. Ghostty is the maintainer's target
> terminal, so the primary path is exercised by default.

---

## 4. The inline fallback: cell-based (chafa / half-block) — still in the viewport

For color terminals without Unicode-placeholder support (WezTerm, Konsole,
iTerm2, VTE, tmux-without-passthrough, …), render the image as **half-block
/ sextant / braille cells** via [chafa](https://hpjansson.org/chafa/) (C or
WASM). This is **still an inline image in the scrolling transcript** — it is
just colored text, so it is scroll-safe by construction, measured as normal
rows, and clipped like any text. Lower resolution than a real bitmap, but it
delivers the maintainer's goal (an image inline in the viewport) on the
broad set of terminals that can't do placeholders.

**The decisive simplification:** both tiers produce the **same thing — a
`rows × cols` block of text cells of known dimensions.** Only the cell
*content* differs (PUA placeholder chars vs. colored block chars).
Measurement, anchoring, and clipping are identical and already exist. The
capability gate just chooses which cell content to emit.

---

## 5. Integration with the scroll machinery

### 5.1 The image primitive

One component renders an image as an explicit-dimension Box:

```tsx
// dimensions in cells, from the image's pixel size / cell size
<Box width={cols} height={rows} flexShrink={0}>
  <Text>{cellGrid}</Text>   // placeholder rows OR half-block rows
</Box>
```

Give the Box **explicit `width`/`height` in cells** rather than relying on
`string-width` to measure `U+10EEEE` + combining diacritics — PUA and
combining-char width is exactly where width tables disagree (§7). An
explicit Box sidesteps it and makes the measured row count deterministic.

### 5.2 Where each piece plugs in

| Concern | Component | What changes |
|---|---|---|
| **Row-height measurement** | `MeasuredRow` (`src/scroll/MeasuredRow.tsx`) | **Nothing.** The image Box is `rows` cells tall; `useBoxMetrics` reports `rows`; the height flows up via `reportRowHeight` like any row. The primitive must commit to `rows` *before* paint so the measured height is stable. |
| **Scroll/anchor math** | `useAnchoredScroll` + `anchor.ts` | **Nothing.** It consumes per-row heights generically and "carries NO knowledge of transcripts" — an image row is just a taller row. |
| **Clip + offset** | `ScrollViewport` | **Nothing.** Placeholder/half-block cells clip with the negative-margin shift like any text; the terminal clips the image to the visible placeholder cells (pending the §7 verification). |
| **Capability gate** | `capabilities.ts` (#295) | Add the placeholder-distinct signal (§3); choose renderer = placeholders \| half-block \| (text placeholder + modal). |
| **Pixel transmission** | new side-effect, *out of band* | Transmit `a=t,q=2` **once per image id** in a `useEffect` that writes directly to stdout — **not** through Ink's render string. Ink owns the placeholder *cells*; the renderer owns the one-time pixel upload. Keyed by a stable id (content hash). |

### 5.3 Emit ordering relative to the clip

- **Placeholder / half-block cells** go *through* Ink, inside the clipped
  inner box of `ScrollViewport`, and participate in layout + clipping
  normally.
- **Pixel data** (`a=t`) and the **virtual-placement declaration**
  (`a=p,U=1`) go *around* Ink — written once to stdout from a side-effect
  before the first frame that references the id. They carry no cursor
  position and paint nothing on their own, so they're immune to Ink's
  repaint-clears-the-screen behavior. Ink redrawing the placeholder cells is
  what makes the image (re)appear.

This separation is the whole trick: the expensive, stateful part (pixels) is
emitted once and lives in the terminal; the cheap, positional part (cells)
goes through Ink's normal render/clip/scroll path.

### 5.4 Sizing

`rows = ceil(imgPxH / cellPxH)`, `cols = ceil(imgPxW / cellPxW)`, after
downscaling to a sane on-screen size. Cell pixel size comes from the
terminal where reported (kitty/Ghostty; iTerm2 `ReportCellSize`); when
unknown, use a fixed ratio (`ratatui-image` uses 4:8 px for half-blocks).
The chosen `rows` is what `MeasuredRow` reports, so decide it **before**
the row is laid out.

### 5.5 Milestone plan (replaces M0/M1/M2)

The old M0 (`<Static>` refactor) is **deleted** — the #284 viewport is the
foundation.

| Milestone | Deliverable | Integration points |
|---|---|---|
| **V0 — capability split** | Distinguish placeholder-capable terminals (kitty, Ghostty) from the broader kitty-graphics set; downgrade WezTerm/Konsole/iTerm2 to half-block for in-viewport images. Unit tests on the env matrix. | `src/capabilities.ts` (#295) |
| **V1 — cell-grid primitive + both tiers** | The `rows × cols` image Box (§5.1); the placeholder-cell encoder (id→fg color, row/col→diacritics, inheritance) + transmit-once side-effect; the half-block tier via chafa; render a fixture PNG **inside the scroll viewport** and **prove it scrolls, clips at both edges, and survives relayout** in kitty + Ghostty (the §7 gate). | `ScrollViewport`, `MeasuredRow`, `useAnchoredScroll`, `capabilities.ts` |
| **V2 — model-output images** | `MarkdownRenderer` `image` inline token + `<img>` html case → resolution pipeline (fetch / `fs.readFile`) → SVG→PNG → downscale → rows×cols → primitive. **Reuse the SSRF + path-traversal guards, async pre-resolve cache, `@resvg/resvg-js`/`sharp`** from [`design.renderer-images.md`](design.renderer-images.md) §4 unchanged. | `MarkdownRenderer.tsx`, V1 |
| **V3 — lifecycle + zoom** | Delete pixel data (`a=d,d=i,i=<id>`) on event eviction/compaction to respect the per-screen image budget; handle resize (recompute rows×cols, re-place; pixels stay resident). Wire the optional §6 modal as a "view full-resolution" action. | image-id registry, `useAnchoredScroll` (resize), §6 modal |

V2/V3 are independent once V1 lands; V0 gates V1.

> **`ink-picture` doesn't fit the inline path.** Its model is "reserve
> Flexbox space + re-emit the Kitty escape via **cursor positioning each
> frame**, fall back to half-blocks when scrolled out of view" — that is
> direct (cursor) placement re-emitted per frame, exactly what §2 rejects,
> and it re-transmits on every scroll. Use Unicode placeholders (the
> `ratatui-image` model) or hand-roll the small encoder; don't take
> `ink-picture`'s cursor-positioned path.

---

## 6. Fallback / graceful degradation: placeholder in transcript → modal popup

**This is the fallback, not the primary.** Use it when a full-fidelity
inline bitmap genuinely can't be delivered — a terminal with no graphics
*and* where half-block cells are unacceptable, a no-color/dumb terminal, or
(pending the §7 verification) a placeholder-capable terminal where per-cell
edge-clipping turns out not to work. It also doubles as an optional **"view
full-resolution"** action from an inline half-block image.

**The model:** render a scroll-safe **text placeholder** (`🖼 image — <alt or
filename> (↵)`) in the transcript — pure cells, so it scrolls/clips/reflows
trivially, no graphics escapes in the scroll region at all. **Selecting or
clicking it opens a modal** that renders the image **statically**. Because
the modal doesn't scroll/clip/relayout, the hard problem disappears and the
broad cursor-anchored protocols (direct Kitty, iTerm2, Sixel) are safe
again.

- **Activation.** Keyboard first (a `FocusManager` with `focusedIndex` +
  Enter/Space per the research-doc sketch — works everywhere, no graphics
  needed); mouse second (transient SGR `1006h` per #285, hit-testing the
  clicked cell back to a placeholder through `scrollOffset` + the
  `useAnchoredScroll` height map).
- **The modal in Ink.** Ink has **no documented z-index/overlay
  compositing** (Box layout is Flexbox-relative; overlapping cells overwrite
  in tree order), so the modal is a **render-tree swap**, not an absolute
  overlay: while open, render the modal Box *instead of* the viewport tree.
  The renderer already runs on the **alternate screen**
  (`src/mount.tsx`, `alternateScreen: true`), so the swap is a single clean
  repaint. Scroll offset persists in `useAnchoredScroll`, so closing the
  modal returns the transcript exactly where it was. A `useInput` handler
  captures keys while open (Esc closes); nothing is mounted behind it to
  misroute input to. The prior interactivity feasibility doc
  ([`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md),
  ~#268) supplies the reusable substrate (mouse SGR infra, the keyboard
  focus model, z-index layering) but does **not** itself record a modal-UI
  capability — the modal is proposed here.
- **Image in the modal.** Emit a single **direct Kitty placement** (`a=T`,
  emit-once, `a=d` on close) into a reserved `rows × cols` region at a
  deterministic screen position, falling to iTerm2/Sixel per capability,
  then half-block cells, then a text metadata card on `none`. Reuse
  `emitKittyImage` unchanged — only the placement *context* is static, so
  the cursor-anchored protocols that fail in the transcript are reliable
  here. Size the image to fit the reserved region (downscale before base64).

---

## 7. Known problems and mitigations

| Problem | Why it happens | Mitigation |
|---|---|---|
| **Bitmap orphaned/duplicated on scroll** | Cursor-anchored protocols (direct Kitty per Ghostty #4323, iTerm2, Sixel) paint at a fixed position; the relayout slides cells away | Use **cell-anchored** Unicode placeholders (or half-block cells). The bitmap is bound to cells, not pixels. This is the entire reason for the design. |
| **Partial-image clip at the window edge** | A row straddling the boundary is half-clipped | With placeholders this *should* be automatic (each visible cell carries its (row,col)). **Under-documented — VERIFY empirically per terminal (kitty, Ghostty) in V1 before building on it.** If a terminal paints the whole image regardless, special-case edge rows or fall to the §6 modal. |
| **Re-emit cost every scroll frame** | A scroll is a full re-render; re-sending base64 each frame is fatal | **Transmit pixels once** (`a=t,q=2`, keyed by id, out of band); per-frame work is only cheap cell text. |
| **Image-id leak / budget exhaustion** | Terminals cap stored image data (Ghostty ~320 MB/screen) | Stable id per image (content hash); `a=d,d=i,i=<id>` on event eviction (V3). Virtual placements delete only with `d` ∈ {i,I,r,R,n,N}. |
| **Row-height measurement wrong** | Anchor math needs the image's row count; a wrong measure drifts the scroll position | Render the primitive as an **explicit `width`/`height` Box**; decide `rows` before layout. Don't rely on `string-width` for `U+10EEEE` + combining chars. |
| **`string-width` miscounts placeholder cells** | PUA + combining-diacritic width is inconsistent across tables; Ink/Yoga lay out by measured width | Explicit-dimension Box (above). **Verify Ink emits the raw placeholder bytes + SGR fg color unmodified** — assert the bytes on a PTY with a known id. |
| **Flicker on redraw** | Re-transmitting pixels per frame, or terminal re-decode per placement; Textual observed this for Sixel on scroll | Transmit-once removes re-decode; placement is just text. Residual flicker is a per-terminal measurement. |
| **Capability misdetection → orphans** | Sending placeholders to WezTerm/Konsole (direct-only) renders garbage | The §3 capability split; conservative-degrade to half-block on anything not confirmed kitty/Ghostty. |
| **Interaction with Ink's reconciler/relayout** | Ink diffs and repaints; pixel data lives outside its model | Keep pixels strictly out of band (side-effect to stdout); Ink owns only the placeholder cells, so the reconciler treats an image row as ordinary text and can't lose the pixels. |
| **Fully scrolled out of view** | Image row clipped entirely away | No visible placeholder cells → terminal paints nothing; pixels stay resident (cheap) until V3 eviction. No orphan, because orphans require a stale *visible* placement. |
| **Cell pixel size unknown** | rows×cols needs cell dimensions | Query the terminal (kitty/Ghostty; iTerm2 `ReportCellSize`); fixed ratio fallback. |
| **(Fallback path) modal open/close redraw, hit-testing, sizing** | See §6 | Render-tree swap on the alternate screen; keyboard activation avoids hit-testing; downscale to the reserved region; delete on close. |

---

## 8. References

| Source | Notes |
|---|---|
| [Kitty graphics protocol — Unicode placeholders](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders) | Virtual placement (`a=p,U=1`), `U+10EEEE`, fg-color id, row/col diacritics, inheritance, deletion modes — the primary inline path |
| [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) | Chunking, `a=t`/`a=T`/`a=d`, transmit-once; direct placement (used only in the §6 modal) |
| [terminfo.dev — Kitty graphics support](https://terminfo.dev/extensions/kitty-graphics-protocol) | Per-terminal matrix (direct vs. placeholder) |
| [Ghostty #4323 — Kitty images aren't scrolled with the text](https://github.com/ghostty-org/ghostty/issues/4323) | Classic/direct placements don't follow CSI-scrolled text — why direct placement is rejected inline |
| [Ghostty adds Unicode placeholders](https://x.com/mitchellh/status/1818696111999299976) | Only non-kitty terminal with placeholders; bounds the primary path to kitty/Ghostty |
| [ratatui-image](https://github.com/ratatui/ratatui-image) · [docs](https://docs.rs/ratatui-image/latest/ratatui_image/) | Image widget in an **immediate-mode** TUI; kitty placeholders + half-block; "encode once, re-place cheaply"; skips cells covered by the image |
| [textual-image](https://pypi.org/project/textual-image/) | TGP/Sixel/Halfcell/Unicode widgets in an app-owned-scroll TUI; **Sixel "hacky… scrolling leads to a lot of flickering… static images work fine"** — evidence cursor/raster placement doesn't survive a scrolling re-render |
| [chafa](https://hpjansson.org/chafa/) | Cell-based inline fallback: half-block/sextant/braille; scroll-safe because it is text |
| [presenterm — images](https://mfontanini.github.io/presenterm/features/images.html) | Static (non-scrolling) rendering — analog for the §6 modal, not the inline path |
| [`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md) | Mouse SGR infra (`1000h`/`1002h`/`1003h`/`1006h`/`1016h`); mouse-XOR-native-selection/scroll-wheel; keyboard `FocusManager`; z-index layering — substrate for the §6 fallback |
| [Ink (vadimdemedes/ink)](https://github.com/vadimdemedes/ink) · [absolute-positioning #182](https://github.com/vadimdemedes/ink/issues/182) | No documented z-index/overlay compositing; `useCursor` hook; basis for the §6 render-tree-swap modal. Pinned `^7.1.0` (Ink 7 + React 19, #282) |
| [iTerm2 inline images (OSC 1337)](https://iterm2.com/documentation-images.html) | Modal-path protocol on iTerm2; `ReportCellSize` for sizing |
| [`design.renderer-images.md`](design.renderer-images.md) | Kitty wire format + `emitKittyImage`, model-output resolution + **SSRF/path-traversal security**, paste, math/mermaid — all carry over |
| [claude-code issue #54546](https://github.com/anthropics/claude-code/issues/54546) | Upstream request for inline images surviving repaints/scroll/resize — same problem statement |
