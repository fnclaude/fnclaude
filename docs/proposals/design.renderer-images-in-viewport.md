# fnclaude — inline images with the scroll viewport: placeholder + modal popup

> **Status: forward-looking.** Design, not shipped code. This document
> **supersedes the `<Static>`-based M0** in
> [`design.renderer-images.md`](design.renderer-images.md). Read this one
> for the rendering foundation; that one still holds for the parts that are
> orthogonal to scroll (the SSRF/path-traversal security model, the paste
> pipeline, the math/mermaid adapters, the Kitty wire format).

## Why this doc exists

The earlier images design made one load-bearing assumption that is now
false: **M0 = move the finalized transcript into Ink's `<Static>`** so
images would be emitted once into the terminal's *native scrollback* and
the terminal would own scrolling them.

PR #284 shipped an **app-owned scroll viewport** instead. The renderer no
longer relies on terminal scrollback for the transcript — it clips the
committed transcript itself (`overflowY="hidden"` plus a negative
`marginTop`) and **re-renders the React tree on every scroll**. The scroll
machinery (`src/scroll/`) — anchored sticky-follow, per-row height
measurement, reanchor-on-growth, the keybinds, the Alt+u token-burn
toggle, and the deferred scroll-to-anchor+flash feature — is
**non-negotiable and will not be walked back**.

`<Static>` and the app-owned viewport are **mutually exclusive**: `<Static>`
hands lines to terminal scrollback and never touches them again; the
viewport must clip, reanchor, filter, and relayout content it owns. So
**`<Static>` is off the table.**

That leaves the genuinely hard problem: a graphics bitmap painted into the
transcript must survive Ink's clip + relayout + per-scroll redraw. Every
cursor-anchored protocol (direct Kitty, iTerm2 OSC 1337, Sixel) **orphans**
under the viewport's negative-margin relayout, and even the one
cell-anchored protocol (Kitty Unicode placeholders) carries real
edge-clipping and capability risk (§5).

**The chosen resolution sidesteps the hard problem entirely: don't render
image bitmaps in the scrolling transcript at all.** Render a scroll-safe
**text placeholder** where the image goes; let the user **select/click** it
to open a **modal popup** that renders the image **statically**. Because
the modal isn't clipped, relaid-out, or scrolled, the "images-during-scroll"
problem disappears and the modal can use whichever graphics protocol is
simplest and most reliable. This **fully preserves #284 scroll** and is the
**primary** design. True inline-in-viewport rendering is kept as a demoted,
optional future path (§5).

Cross-references:

- [`design.renderer-images.md`](design.renderer-images.md) — original
  playbook; still authoritative for security, paste, math/mermaid, wire
  format.
- [`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md)
  — feasibility survey. Source for the mouse-SGR infrastructure, the
  keyboard focus model, and the scroll-vs-mouse conflict reused below.
- [`design.renderer.md`](design.renderer.md) — renderer↔CLI integration.
- `src/scroll/` — `useAnchoredScroll`, `ScrollViewport`, `MeasuredRow`,
  `anchor.ts`.
- `src/capabilities.ts` (#295, merged) — env-only capability detection.
- `src/mount.tsx` — mounts Ink with `alternateScreen: true` (the modal
  builds on this).

> **Prior-art check.** The interactivity research doc does **not** record a
> modal/popup-as-UI capability. What it *does* record and this design
> reuses: the **mouse-SGR infrastructure** (#285 — modes `1000h`/`1002h`/
> `1003h` + SGR cell `1006h`, and the hard rule that mouse tracking must be
> transient because it disables native selection and captures the scroll
> wheel); a **keyboard `FocusManager` model** (`focusedIndex`, arrow keys,
> Enter/Space, `▸`/`▾` affordance) sketched for collapsibles and explicitly
> framed as "a future primitive"; and a **z-index layered-overlay**
> technique for *selection feedback* graphics. The modal popup is a *new*
> proposal here built on that substrate — it is not claimed by the prior
> doc.

---

## 1. The constraint, stated precisely

The viewport (`src/scroll/ScrollViewport.tsx`):

```tsx
<Box height={height} overflowY="hidden" flexDirection="column">
  <Box ref={contentRef} flexShrink={0} marginTop={-scrollOffset}>
    {children}
  </Box>
</Box>
```

The inner box holds the full unclipped transcript; `flexShrink={0}` keeps
Yoga from compressing it so `useBoxMetrics` reports true height. The outer
box is a fixed window; everything above (negative `marginTop`) and below
(`overflowY="hidden"`) is clipped. Scroll = change `scrollOffset` = Ink
re-lays-out and repaints the whole inner box.

Anything painted into this transcript must (1) be a real cell-grid
participant of known rows/cols so `MeasuredRow` measures it and the
`anchor.ts` math stays correct; (2) move with its cells on offset change;
(3) clip gracefully at the window edge; (4) not re-transmit pixels every
frame. A **text placeholder** satisfies all four trivially — it *is* text.
A **bitmap** satisfies them only with the cell-anchored Unicode-placeholder
protocol, and even then with edge-clip and capability caveats (§5). So the
transcript gets the placeholder; the bitmap goes to the modal.

---

## 2. Primary design: placeholder in transcript → modal popup renders statically

```
┌─ scrolling transcript (app-owned viewport, #284) ─────────────┐
│  assistant: here is the diagram you asked for                  │
│  ┌───────────────────────────────┐                            │
│  │ 🖼  image — diagram.png  (↵)   │   ← scroll-safe text cell  │
│  └───────────────────────────────┘                            │
│  assistant: …and the explanation continues …                  │
└───────────────────────────────────────────────────────────────┘
        │  Enter / click
        ▼
╔═ MODAL (render-tree swap; not scrolled, not clipped) ═════════╗
║                                                               ║
║            <the image, rendered statically>                   ║
║                                                               ║
║   diagram.png · 1280×720 · esc to close                       ║
╚═══════════════════════════════════════════════════════════════╝
```

Four pieces: the placeholder cell, its activation (keyboard + mouse), the
modal mechanics, and the in-modal image render.

### 2.1 The transcript placeholder (pure cells, scroll-safe)

Where an image would appear, render a small bordered/iconic Box of plain
text — e.g. `🖼 image — <alt or filename> (↵)`. It is ordinary Ink text:
Yoga lays it out, `MeasuredRow` measures its (small, fixed) row count,
`ScrollViewport` clips it, and a scroll repaints it like any other row.
**No graphics escape sequence is ever written into the scroll region**, so
the entire class of orphan/duplicate/edge-clip bugs cannot occur in the
transcript.

The placeholder carries the data needed to open the modal: the resolved
image source (URL/path) or a handle into the image cache, plus the alt
text. It also carries a stable **focus id** for selection (see 2.2).

### 2.2 Activation — keyboard first, mouse second

**Keyboard (primary, works everywhere).** Reuse the `FocusManager` model
the research doc sketches for collapsibles: a context owns a `focusedIndex`
over the focusable items currently in the transcript (placeholders, and
later links/collapsibles); a key (e.g. Tab / a dedicated nav key) moves
focus, the focused placeholder shows an affordance (reverse-video or a `▸`
marker), and **Enter/Space opens the modal** for the focused image. This
needs no mouse and no graphics capability, so it is the baseline path and
ships first.

**Mouse (secondary, capability-gated).** Tie into the #285 SGR mouse
infrastructure from the research doc: enable SGR cell mode (`1006h`) only
as a transient affordance, parse click reports off stdin before Ink's
parser, and **hit-test the clicked cell against placeholder bounds**. The
research doc's two hard constraints apply and must be respected: mouse
tracking disables native text-selection and captures the scroll wheel, so
it cannot be globally on. Options, in order of safety:

- *Click-to-open only* (`1000h`/`1006h`), enabled briefly, is the least
  intrusive. Even this trades away native selection while active.
- A persistent "nav mode" toggle that the user enters deliberately.

Hit-testing requires mapping a clicked `(row, col)` back to a placeholder.
This is the one genuinely fiddly part (§4): the click report gives a cell
in the *visible window*, which must be translated through `scrollOffset`
and the per-row height map (`useAnchoredScroll`) to the placeholder that
owns that cell. Keyboard activation has none of this complexity, which is
why it leads.

### 2.3 The modal in Ink — a render-tree swap on the alternate screen

Ink has **no documented z-index / absolute-overlay compositing**: Box
layout is Flexbox-relative, and Ink paints to a 2-D output buffer where
overlapping cells are simply overwritten in tree order — there is no true
layered overlay. So the reliable modal is **not** an absolutely-positioned
overlay box; it is a **conditional render-tree swap**:

```tsx
return modal
  ? <ImageModal image={modal} onClose={() => setModal(null)} />
  : <>
      <ScrollViewport …>{transcript}</ScrollViewport>
      <InputBar … />
      <StatusLine … />
    </>;
```

- **Why this is clean here:** the renderer already runs on the **alternate
  screen** (`src/mount.tsx`, `alternateScreen: true`). Ink clears and
  repaints the whole frame on every render, so swapping the visible tree to
  a centered, full-window modal Box is a single clean repaint with nothing
  bleeding through from the transcript. On close, swapping back repaints the
  transcript at its preserved `scrollOffset` — **the scroll state lives in
  `useAnchoredScroll` and is untouched while the modal is open**, so the
  transcript returns exactly where it was.
- **Open / dismiss.** A piece of app state (`modal: ImageRef | null`).
  Opening sets it from the focused/clicked placeholder; **Esc** (and a
  click outside, if mouse is on) clears it. While open, a `useInput`
  handler **captures input** so transcript scroll keys don't fire behind
  the modal.
- **Focus handling.** Trivial compared to an overlay: because the modal
  *replaces* the tree, there is nothing behind it to misroute input to. The
  modal owns all keys until dismissed.
- **Sizing.** Center a Box of, say, `min(termCols-4, …) × min(termRows-4,
  …)`; reserve an inner region of `rows × cols` cells for the image plus a
  caption line (filename · dimensions · "esc to close").
- **(Optional) absolute-overlay variant.** If a future Ink version offers
  real overlap compositing, a centered overlay that dims the transcript
  behind it could replace the swap. **Do not rely on it** — treat overlap
  as unsupported until verified against the pinned Ink (currently `^7.1.0`,
  Ink 7 + React 19 per #282). The render-tree swap needs no such support.

### 2.4 Rendering the image inside the modal — relaxed constraints

This is the payoff. The transcript rejected cursor-anchored protocols
because scroll relayout orphans them. **The modal does not scroll, clip, or
relayout** (open/close/resize only), so those protocols are safe again and
the **broadest, simplest** graphics path is available:

| Protocol in modal | Anchoring | Use it? |
|---|---|---|
| **Kitty direct placement** (`a=T`) | Cursor pixel position | **Recommended primary** — broad support (kitty, Ghostty, WezTerm, Konsole), simplest wire format; safe because nothing moves it |
| iTerm2 OSC 1337 | Cursor | Yes, on iTerm2 — same reasoning |
| Sixel | Cursor raster | Yes, where supported — safe with no scroll |
| Kitty Unicode placeholder | Cell | Works too (avoids cursor math), but adds encoding complexity that the modal doesn't need; reserve for terminals where it's the only option |
| **chafa / half-block / sextant / braille** | Cell (it *is* text) | **Fallback** for non-graphics terminals — render as Ink cells in the modal region |

**Recommended:** in the modal, emit a **single direct Kitty placement**
(falling to iTerm2/Sixel per capability, then to a chafa/half-block cell
render) into the reserved region. Concretely:

1. On open, lay out the modal so the image region is a reserved `rows ×
   cols` Box at a **deterministic** screen position (we control the modal
   geometry and know `process.stdout` rows/cols).
2. After Ink paints the modal frame, a side-effect moves the cursor to the
   region's top-left (cursor-position CSI; Ink's `useCursor` hook may
   assist) and writes the graphics escape **once**.
3. On resize, recompute geometry and re-emit. On close, emit a delete
   (`a=d` for Kitty) to reclaim the terminal's per-screen image budget and
   swap the tree back.

Because the modal is static, this is the *original* images design's
direct-placement idea — now reliable, because the thing that broke it
(scroll) is gone. The Kitty wire format, chunking, and `emitKittyImage`
emitter from [`design.renderer-images.md`](design.renderer-images.md) §2/§6
carry over **unchanged**; only the *placement context* changed from
"scrolling transcript" (unsafe) to "static modal" (safe).

**Sizing the image to the modal.** Downscale eagerly to fit the reserved
region: `cols = min(modalInnerCols, imgPxW/cellPxW)`, `rows` likewise,
preserving aspect ratio. Cell pixel size comes from the terminal where
reported (kitty/Ghostty; iTerm2 `ReportCellSize`); fall back to a fixed
ratio when unknown. Downscale before base64 to respect the per-screen image
budget.

### 2.5 Capability gating (still via `src/capabilities.ts`, #295)

`capabilities.images` (`"kitty" | "iterm2" | "half-block" | "none"`)
chooses the **in-modal** renderer: graphics protocol when available, else
chafa/half-block cells in the modal, else a text card (`[image: <alt>]`
with dimensions). The placeholder cell and the modal *chrome* are pure text
and need no capability gate — only the bitmap inside does. This keeps the
feature degrading gracefully: a `none` terminal still shows the placeholder
and can still open the modal to read the metadata card.

---

## 3. Integration with existing code

| Concern | Component | What changes |
|---|---|---|
| **Placeholder is just a row** | `MeasuredRow`, `ScrollViewport`, `useAnchoredScroll`, `anchor.ts` | **Nothing.** A placeholder is a short text row; height flows up via `reportRowHeight` like any row. The scroll math already "carries NO knowledge of transcripts." |
| **Modal swap + scroll preservation** | top-level App render + `useAnchoredScroll` | Add `modal` state; conditionally render the modal vs. the viewport tree. Scroll offset persists in the hook across the swap. |
| **Keyboard activation** | new `FocusManager` (per research-doc sketch) | `focusedIndex` over focusable rows; Enter/Space opens the modal. New, but pre-designed. |
| **Mouse activation (later)** | #285 SGR mouse infra | Transient `1006h`; parse clicks; hit-test cell→placeholder through `scrollOffset` + height map. Capability- and mode-gated. |
| **In-modal bitmap** | `emitKittyImage` (from old doc §6) + capability switch | Reuse the emitter; emit once into the reserved region after the modal paints; delete on close. |
| **Capability gate** | `src/capabilities.ts` (#295) | Selects in-modal graphics vs. cell fallback vs. text card. No new detection needed. |
| **Model-output resolution + security** | `MarkdownRenderer.tsx` + resolver | The `image` inline token / `<img>` html case resolves the source and emits a **placeholder** (not a bitmap) into the transcript; resolution pipeline, SSRF + path-traversal guards, `@resvg/resvg-js`, `sharp`, async cache carry over **unchanged** from old-doc §4. |

---

## 4. Milestone plan (replaces M0/M1/M2)

The old M0 (`<Static>` refactor) is **deleted** — the #284 viewport is the
foundation.

| Milestone | Deliverable | Integration points |
|---|---|---|
| **V0 — placeholder + keyboard activation** | The scroll-safe placeholder row; the `FocusManager` (`focusedIndex`, nav key, Enter/Space); a no-op "modal" stub that proves open/close + scroll preservation with placeholder text only. No graphics yet. | `ScrollViewport`, `MeasuredRow`, `useAnchoredScroll`, new `FocusManager` |
| **V1 — modal renders a real image statically** | The modal render-tree swap; reserve the image region; `emitKittyImage` direct placement into it (emit-once, delete-on-close); chafa/half-block fallback in the modal; text-card fallback on `none`; render a fixture PNG and prove open→image→esc→transcript-restored. | modal swap, `capabilities.ts`, `emitKittyImage` (old doc §6), `src/mount.tsx` altscreen |
| **V2 — model-output images** | `MarkdownRenderer` `image` token + `<img>` html case → resolve source → emit a **placeholder** bound to the cache handle; resolution pipeline + SSRF/path-traversal guards + SVG→PNG + downscale, **reused unchanged** from old-doc §4. | `MarkdownRenderer.tsx`, V0 placeholder, V1 modal |
| **V3 — mouse activation + lifecycle** | #285 SGR mouse (transient), click hit-testing cell→placeholder through scroll offset; image-budget management (delete on modal close + on transcript eviction/compaction); resize handling. | #285 mouse infra, `useAnchoredScroll`, image-id registry |

Paste/thumbnail (#293, old-doc M3) is unchanged in concept: a pasted image
shows a **placeholder** in the prompt/transcript and opens the same modal
for preview; it reuses V1's modal + emitter.

> **`ink-picture` no longer fits.** The old doc and the research doc both
> recommended `ink-picture`, whose model is "reserve Flexbox space + re-emit
> the Kitty escape via **cursor positioning each frame**, fall back to
> half-blocks when scrolled out of view." That is direct (cursor) placement
> re-emitted per frame — exactly what scroll orphans, and it re-transmits on
> every scroll. In this design the transcript holds **no bitmap at all**
> (just a placeholder), and the modal emits a direct placement **once**
> (no per-frame re-emit, because the modal doesn't scroll). `ink-picture` is
> neither needed nor suitable; the small `emitKittyImage` emitter covers it.

---

## 5. Optional future path: true inline-in-viewport rendering (de-prioritized)

For graphics-capable terminals, a future enhancement could render images
*inline in the scrolling transcript* (no modal) using **Kitty Unicode
placeholders (virtual placement)** — the only cell-anchored graphics
protocol, so the image is pinned to placeholder *text cells* and
scrolls/clips/relayouts with them.

Sketch (full detail retained from the prior revision of this doc):

- **Transmit once, quietly:** `ESC _ G a=t,f=100,i=<id>,q=2 ; <b64> ESC \`.
- **Declare a virtual placement:** `ESC _ G a=p,U=1,i=<id>,c=<cols>,r=<rows> ESC \`.
- **Emit placeholder cells** (`U+10EEEE`, foreground color = image id,
  combining diacritics = row/col, with diacritic inheritance) through Ink's
  normal render inside the clipped viewport. Pixels transmit once; per-scroll
  work is only cheap text. This is the `ratatui-image` model, proven in a
  structurally identical immediate-mode redraw loop.

**Why it is the harder, optional path, not the primary:**

- **Narrow support.** Only **kitty** and **Ghostty** implement Unicode
  placeholders. WezTerm/Konsole track Kitty graphics with **direct
  placement only** (cursor-anchored → orphans in the viewport), so they
  cannot use this path even though `capabilities.images` reports `"kitty"` —
  it would need a placeholder-distinct capability signal.
- **Edge-clip is unverified.** Whether a terminal paints only the
  sub-rectangle mapped to the *visible* placeholder cells (true partial
  clip at the window edge) is not confirmable from documentation; it must
  be tested per terminal. If a terminal paints the whole image regardless,
  the viewport must special-case edge rows.
- **Layout fragility.** `string-width` disagreement on `U+10EEEE` +
  combining chars; needing explicit-dimension Boxes; verifying Ink emits the
  placeholder + SGR bytes unmodified.

The modal path has none of these risks and works on a far broader set of
terminals (any cursor-anchored protocol, plus a universal cell fallback).
Inline-in-viewport stays a **possible enhancement for kitty/Ghostty only**,
behind the modal, once the edge-clip behavior is empirically nailed down.

---

## 6. Known problems and mitigations

| Problem | Why it happens | Mitigation |
|---|---|---|
| **Bitmap orphaned/duplicated on scroll** | Cursor-anchored protocols paint at a fixed position; the negative-margin relayout slides cells away | **Primary design renders no bitmap in the transcript** — only a text placeholder. The bitmap lives in the static modal. The bug class cannot occur in the scroll region. |
| **Placeholder hit-testing in a scrolling viewport** | A mouse click reports a cell in the *visible window*; the placeholder's identity depends on `scrollOffset` + per-row heights | Translate the clicked `(row,col)` through `scrollOffset` and the `useAnchoredScroll` height map to the owning placeholder. **Keyboard activation avoids this entirely and ships first**; mouse is the later, gated path. |
| **Clicked cell → which image** | Multiple placeholders, variable heights, filtered rows | Each placeholder carries a stable focus id + cache handle; the focus/hit-test resolves to that id, not to pixel geometry. |
| **Modal open/close redraw** | Swapping the render tree repaints the whole alternate screen | Alternate screen + Ink's full-frame repaint make this a clean single repaint; scroll offset persists in `useAnchoredScroll`, so the transcript returns in place. Emit the bitmap **after** the modal frame paints; **delete** it on close. |
| **Image sizing in the modal** | Image may exceed the modal region | Downscale to fit `rows×cols` of the reserved region, aspect-preserving, before base64; use terminal-reported cell size or a fixed ratio. |
| **Input bleed behind the modal** | Transcript scroll keys firing while modal open | The modal's `useInput` captures input; the render-tree swap means nothing is mounted behind it to receive keys. |
| **Image-budget leak** | Terminals cap stored image data (Ghostty ~320 MB/screen) | Delete (`a=d`) on modal close and on transcript eviction/compaction; stable id per image (content hash). |
| **Mouse tracking side effects** | Enabling mouse disables native selection and captures the scroll wheel (research doc) | Mouse is transient/opt-in only; keyboard is the always-available path. Never enable global mouse tracking. |
| **No Ink overlay/z-index** | Ink has no layered compositing; overlapping cells overwrite in tree order | Use the **render-tree swap**, not an absolute overlay. Don't depend on overlap support in any Ink version without verifying it. |
| **`none`-capability terminals** | No graphics, no color planes | Placeholder + modal still work; the modal shows a text metadata card (`[image: <alt>] · <dims>`). Feature degrades, never breaks. |
| **(Optional path only) edge-clip / placeholder width / WezTerm support** | See §5 | Reasons the inline-in-viewport path stays optional and kitty/Ghostty-only. |

---

## 7. References

| Source | Notes |
|---|---|
| [`design.renderer-images.md`](design.renderer-images.md) | Kitty wire format + `emitKittyImage` (§2/§6), model-output resolution + **SSRF/path-traversal security** (§4), paste (§5), math/mermaid — all carry over unchanged |
| [`../research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md) | Mouse SGR infra (`1000h`/`1002h`/`1003h`/`1006h`/`1016h`; ink-mouse archived); mouse-XOR-native-selection/scroll-wheel; keyboard `FocusManager` model; z-index layered-overlay (selection feedback) |
| [Ink (vadimdemedes/ink)](https://github.com/vadimdemedes/ink) | Flexbox layout, no documented z-index/absolute overlay compositing; `useCursor` hook; basis for the render-tree-swap modal. Pinned `^7.1.0` (Ink 7 + React 19, #282) |
| [Ink absolute-positioning issue #182](https://github.com/vadimdemedes/ink/issues/182) | History of overlay/absolute-position requests — why overlay is not relied on |
| [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) | Direct placement (`a=T`) for the modal; chunking; `a=d` delete; (optional path) Unicode placeholders / virtual placement |
| [Kitty Unicode placeholders](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders) | `U+10EEEE`, fg-color id, row/col diacritics, inheritance — the optional inline-in-viewport path (§5) |
| [terminfo.dev — Kitty graphics support](https://terminfo.dev/extensions/kitty-graphics-protocol) | Per-terminal support matrix (direct vs. placeholder) |
| [Ghostty adds Unicode placeholders](https://x.com/mitchellh/status/1818696111999299976) | Only non-kitty terminal with placeholders — bounds the optional path to kitty/Ghostty |
| [ratatui-image](https://github.com/ratatui/ratatui-image) | Image widget in an immediate-mode TUI; "encode once, re-place cheaply"; kitty + halfblock fallback — model for the optional inline path |
| [chafa](https://hpjansson.org/chafa/) | Cell-based fallback (half-block/sextant/braille) rendered inside the modal for non-graphics terminals |
| [presenterm — images](https://mfontanini.github.io/presenterm/features/images.html) | Static (non-scrolling) image rendering with protocol auto-detect — analogous to the modal context |
| [iTerm2 inline images (OSC 1337)](https://iterm2.com/documentation-images.html) | Modal-path protocol on iTerm2; `ReportCellSize` for sizing |
| [claude-code issue #54546](https://github.com/anthropics/claude-code/issues/54546) | Upstream request for inline images surviving repaints/scroll/resize — same problem statement |
