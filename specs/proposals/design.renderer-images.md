# fnclaude — renderer inline images: implementation guide

> **Status: forward-looking.** This document describes a design that is NOT yet implemented. It is a forward-looking implementer's playbook, not a description of shipped code.

> **⚠️ Superseded foundation — read [`design.renderer-images-in-viewport.md`](design.renderer-images-in-viewport.md) first.** This doc's **§3 `<Static>` foundation** and its **M0** are obsolete: PR #284 shipped an app-owned scroll viewport (`src/scroll/`) that re-renders the transcript on scroll, which is **mutually exclusive** with moving the transcript into Ink's `<Static>` / native scrollback. The current design renders images **inline in that scrolling viewport**: **Kitty Unicode placeholders** (cell-anchored, so the bitmap scrolls/clips/reflows with the text cells) on kitty/Ghostty, with **chafa/half-block cells** as the inline fallback on other color terminals; a placeholder + **modal popup** is the graceful-degradation path. The `ink-picture` per-frame cursor re-emit is dropped. The in-viewport doc supersedes §3 and the M0/M1/M2 milestone plan. **The rest of this doc remains authoritative** for the parts orthogonal to scroll: the Kitty wire format + `emitKittyImage` (§2/§6), model-output resolution + **SSRF/path-traversal security** (§4), pasted images (§5), and the math/mermaid adapters.

## Why this exists

[`specs/research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md) is the broad feasibility survey — images, math, mermaid, mouse, links, scroll. This doc goes deep on **images only** and is scoped to production implementation: exact integration points, concrete data flows, security requirements, and a milestone ordering. Math and mermaid reuse the same PNG→Kitty core described here; see the research doc for their content-specific adapters.

Cross-references:

- [`specs/proposals/design.renderer.md`](design.renderer.md) — renderer↔CLI in-process integration architecture; where this feature lands.
- [`specs/decisions.md`](../decisions.md) — dated log of technical decisions that flow from this design.
- [`specs/research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md) — feasibility findings, protocol comparison table, library survey, mouse/links/scroll analysis.

---

## 1. Scope and target terminal

Inline images in the fnclaude transcript on Ghostty. Ghostty supports **Kitty graphics protocol only** — sixel was explicitly rejected by the maintainer (cited libsixel quality issues), and iTerm2 OSC 1337 has an open feature request with no commitment. Everything here routes through one Kitty emitter. If another terminal is targeted later, the emitter is the only layer that changes.

Two image sources:

- **Model-output images** — `![]()` in markdown, `<img src>` in raw HTML from assistant text.
- **User-pasted images** — triggered by the paste key; read from the OS clipboard, injected into the next turn as an Anthropic image content block.

---

## 2. The Kitty graphics protocol

### Escape shape

```
ESC _ G <control-data> ; <base64-payload> ESC \
```

That outer wrapper is APC (Application Program Command). `ESC _` opens it; `ESC \` (ST, String Terminator) closes it. Everything between is the Kitty payload: comma-separated key=value control fields, a semicolon delimiter, then the base64 chunk.

**Transmit-and-display in one shot:**

| Key | Value | Meaning |
|---|---|---|
| `a` | `T` | Action: transmit + display immediately |
| `f` | `100` | Format: PNG (dimensions read from PNG metadata) |
| `f` | `32` | Format: RGBA 32-bit raw pixels |
| `f` | `24` | Format: RGB 24-bit raw pixels |
| `c` | N | Fit to N terminal columns |
| `r` | N | Fit to N terminal rows |
| `z` | N | Z-index for layering (negative allowed) |
| `i` | N | Image ID for later delete/replace via `a=d` |
| `m` | `1` | More chunks follow |
| `m` | `0` | Final chunk (or only chunk) |

PNG is the only format worth using in practice — the terminal reads width/height from the PNG header automatically, so no explicit dimension fields are needed for correctly-sized images. Use `f=100` + `a=T` as the baseline.

### Chunking — the part implementers get wrong

The base64 payload must be split into chunks of **at most 4096 bytes each**. The control data block (`a=T,f=100,c=80,r=24,i=42`) appears **only on the first chunk**. Every chunk except the last carries `m=1`; the last (or only) chunk carries `m=0`. Subsequent chunks are bare — no control fields, only `m=` and the payload:

```
# First chunk  (with all control fields)
ESC _ G a=T,f=100,c=80,r=24,i=42,m=1 ; <base64-chunk-1> ESC \

# Middle chunks  (control fields omitted)
ESC _ G m=1 ; <base64-chunk-2> ESC \

# Final chunk
ESC _ G m=0 ; <base64-chunk-N> ESC \
```

A single-chunk image (payload ≤ 4096 bytes) uses `m=0` and carries all control fields on that single escape.

### Image lifecycle management

Ghostty stores approximately 320 MB of image data per screen. Assign an `i=<id>` to every image at transmit time. Delete stale images when content is evicted from the transcript (e.g. after a compaction) to reclaim that budget: `ESC _ G a=d,i=<id> ESC \`.

---

## 3. The Ink integration problem and the `<Static>` foundation

**This is the critical prerequisite. Nothing else in this doc ships without it.**

### What Ink does today

Ink clears and redraws the entire component tree on every render. Any graphics escape written to stdout is erased on the next keypress. The current renderer puts the full transcript in a single dynamic column:

```tsx
// App.tsx — the entire transcript is dynamic
<Box flexDirection="column">
  {events.map((event, idx) => {
    // ... per-event renderers
  })}
</Box>
```

There is no `<Static>` in `App.tsx`. The file imports only `Box`, `Text`, and `useInput` from ink. Every inline image in the history would be re-emitted on every keystroke — fatal for performance and display fidelity (each re-emit flickers).

### The fix: `<Static>` for finalized transcript events

Ink's `<Static>` component emits content **once** into real terminal scrollback. The terminal composites it; Ink never touches it again. Inline images in finalized transcript events are emitted once and scrolled natively by the terminal. Only the still-streaming live message (rendered by `LiveRegion`) needs per-frame re-emit handling.

**Required refactor (M0):**

```tsx
import { Static, Box, Text, useInput } from "ink";

// Finalized events → Static (emit-once, native scrollback)
<Static items={events}>
  {(event, idx) => <EventRow key={...} event={event} ... />}
</Static>

// Live streaming tail + input bar → still dynamic
<LiveRegion live={live} visibilityFor={visibilityFor} />
<InputBar draft={draft} />
<Text>{statusLine}</Text>
```

The `<Static>` component's items array must be append-only — Ink diffs the array length to know what to emit next. Mutating earlier items or reordering the array breaks the emit-once guarantee. The event log in `App` is already append-only (`[...prev, event]`), so this constraint is naturally satisfied.

### How ink-picture interacts with `<Static>`

**[ink-picture](https://www.npmjs.com/package/ink-picture)** (v2, MIT, maintained) is the recommended integration point. It:
- Reserves Flexbox space in the layout tree so surrounding text doesn't collapse into the image cells.
- Re-emits the Kitty escape via cursor positioning each frame (for images in the dynamic tail).
- Falls back to Unicode half-blocks when scrolled out of view.

Usage pattern:

| Image location | `<Static>` or dynamic | ink-picture re-emit behavior |
|---|---|---|
| Finalized transcript event | `<Static>` — emit-once | No re-emit needed; terminal owns it in scrollback |
| In-flight streaming message (`LiveRegion`) | Dynamic | ink-picture re-emits via cursor each frame |

Without `<Static>`, ink-picture's per-frame re-emit applies to every image in history — O(N) Kitty escapes per keystroke where N is the number of images in the transcript.

### Capability detection + fallback

Run **[supports-terminal-graphics](https://www.npmjs.com/package/supports-terminal-graphics)** once at startup before displaying any image. If Kitty is unsupported:
- Try **[chafa](https://hpjansson.org/chafa/)** (C binary or WASM build) as a fallback cascade (Kitty → iTerm2 → sixel → Unicode half-blocks → ASCII).
- If chafa is also unavailable, render a plain text placeholder: `[image: <alt text>]`.

Never block startup on capability detection — run it in a side-effect and gate image rendering on the result.

### Ghostty issue #4323

**[Ghostty issue #4323](https://github.com/ghostty-org/ghostty/issues/4323) (open as of 2026-06-26):** Kitty images do not follow CSI-driven scroll. Natural newline-flow scroll (the icat-style flow where images move up as new content pushes them) generally works, but programmatic scroll commands (`ESC[S`, `ESC[T`) do not reposition images. The `<Static>` foundation works via natural flow — images enter scrollback as Ink emits them, pushed up by subsequent content. Verify this empirically in Ghostty before relying on it; the issue status may change.

---

## 4. Model-output images

### Integration points in the current code

**`MarkdownRenderer.tsx` — `BlockToken` (line 61–142):**

The `html` case today renders raw HTML as plain text:

```tsx
case "html":
  return <Text>{(token as Tokens.HTML).text}</Text>;
```

An `<img src="...">` tag from assistant output arrives here as an `html` block token. This case must be extended to parse out `src` and `alt` attributes and route them to image resolution.

**`MarkdownRenderer.tsx` — `inline()` (line 210–273):**

The `image` token type (from `![]()` markdown syntax) is an **inline** token. `marked` emits it with `href` (the URL) and `text` (the alt text). Currently it falls through to the `default` case in `inline()`:

```tsx
default:
  return <Text key={`in-${i}`}>{"text" in t ? (t as { text: string }).text : ""}</Text>;
```

A new `case "image":` must be added to `inline()`, mirroring the `link` case structure. The `link` case (lines 238–256) is the exact model: it casts the token, reads `href`, applies conditional styling. The `image` case reads `href` + `text` (alt), and routes to the async image resolver.

**No graphics dependencies in `packages/renderer/package.json` today:**

The current `dependencies` block contains: `cli-highlight`, `entities`, `ink`, `marked`, `react`, `react-devtools-core`, `remend`. No `ink-picture`, `sharp`, `@resvg/resvg-js`, `supports-terminal-graphics`, or `chafa`. All new graphics packages must be added as dependencies before shipping image support.

### Resolution pipeline

```
href / src
  │
  ├── remote (https?://)  →  fetch()  →  verify Content-Type: image/*
  │                                   →  arrayBuffer() → Buffer
  │
  └── local path          →  fs.readFile()
                                         │
                          ┌─────────────┘
                          ▼
                    SVG? → @resvg/resvg-js → PNG Buffer
                          │
                          ▼
                    downscale to target cell dimensions  (sharp)
                          │
                          ▼
                    emitKittyImage(buffer, { cols, rows, id })
```

**Downscale eagerly** — before base64 encoding, not after. A 4 K photo base64-encoded and transmitted verbatim saturates Ghostty's 320 MB per-screen budget in a handful of images. Target cell dimensions at time of render; re-downscale on terminal resize if the size has changed significantly.

### Async-during-render

`fetch` and `readFile` are async; Ink's render pass is synchronous. The render loop must never block on network I/O. Required pattern:

1. Maintain a `Map<string, Buffer | "loading" | "error">` image cache keyed by URL or resolved path.
2. On first encounter, kick off resolution in a `useEffect` (or equivalent side-effect outside the render function), store `"loading"`, and re-render with a placeholder (`[loading image…]`).
3. When resolution completes, store the `Buffer` in the cache and trigger a state update that causes a re-render. The re-render finds the buffer in cache and emits the Kitty escape.
4. On error, store `"error"` and render `[image: <alt text>]`.

Never start a fetch inside the render function. Never await inside a component body.

### Security — mandatory, not optional

The URL or path comes from **model output**. An adversarial or jailbroken model can construct any URL or path. Validate before touching the network or filesystem:

**SSRF guard (remote URLs):**
- Reject `localhost`, `127.0.0.1`, `::1`, and the entire `127.0.0.0/8` range.
- Reject link-local addresses: `169.254.0.0/16` (cloud metadata — AWS IMDSv1 is `169.254.169.254`), `fe80::/10`.
- Reject private RFC 1918 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
- Reject private IPv6: `fc00::/7`.
- Follow redirects cautiously — validate the final resolved address, not just the original URL.
- Consider an explicit allowlist for production (only `https://` public URLs matching a domain pattern) rather than a blocklist.
- Enforce a fetch timeout (e.g. 10 s) and a max response size (e.g. 10 MB pre-downscale).

**Path traversal guard (local paths):**
- Resolve via `realpath()` before opening.
- Restrict to an allowed root (e.g. the user's home directory). Reject anything that resolves outside it.
- Reject device files, symlinks that escape the root, and paths matching `/proc/`, `/sys/`, `/dev/`.

Spell these out as assertions in the resolver, not as documentation aspirations. Each guard must reject its target case with a testable error code, not a generic "image failed to load."

---

## 5. Pasted images

### Why paste is the renderer's responsibility

Terminals do not forward clipboard image bytes. Ghostty's paste event delivers text only; the application must explicitly request image data from the OS clipboard using a platform clipboard tool. Under the renderer, `claude` runs headless in `--print` stream-json mode — its own interactive ctrl+v image-read path never fires. The renderer must intercept the paste key and read the image itself.

### Clipboard read path

`packages/cli/src/mcp/handlers/clipboard-backends.ts` already implements backend selection and write-side invocation. The same `detectBackend` / priority logic extends to the read side. The write-side backends pipe text to stdin; the read side reads image bytes from stdout.

**Read-side backend commands (priority order):**

| Platform | Read command |
|---|---|
| Wayland | `wl-paste --type image/png` |
| X11 | `xclip -selection clipboard -t image/png -o` |
| X11 (fallback) | `xsel --clipboard --output` |
| macOS | `pngpaste -` (separate binary; `pbpaste` outputs text only) |
| WSL | `powershell.exe -Command "... Get-Clipboard -Format Image ..."` |

The read side needs a new function — `readImageFromClipboard(args: { which: WhichFn; spawn: SpawnFn }): Promise<Buffer | null>` — that mirrors `runBackend`'s shape but captures stdout instead of writing stdin. Keep the same injected-`which` / injected-`spawn` pattern for testability.

### Unconfirmed risk — verify early

> **Must-verify-early:** Whether `claude` in headless `--input-format stream-json` mode actually accepts image content blocks is **unconfirmed**. The stream-json input schema is reverse-engineered and undocumented. Build a minimal probe (send a single-turn input with an `image` content block, observe whether claude processes it without error) before building the paste UX. This gates the entire pasted-image feature. If claude silently strips image blocks or errors on them, the injection path doesn't exist.

### Injection format

The turn sent over claude's stdin (`sendUserTurn`) today carries a text content block. With pasted images, extend it to a multi-block content array:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "what's in this screenshot?"
      },
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "<base64-encoded-png>"
        }
      }
    ]
  }
}
```

Multiple images per turn are allowed; maintain a total-size budget. The Anthropic API's per-image limit is effectively bounded by the request size limit; as a practical cap, **reject or recompress any single image whose base64 representation exceeds 10 MB**. If the total across all images in a turn exceeds 20 MB, warn the user and drop the largest until it fits.

### Size management

Before injecting:
1. Decode the raw PNG bytes from the clipboard read.
2. If the decoded buffer exceeds the 10 MB base64 cap (~7.5 MB raw PNG), pass it through `sharp` to downscale. Target: reduce to the pixel dimensions that map to the current terminal viewport (e.g. `terminalCols × charWidth` by `terminalRows × charHeight` pixels). Downscale is lossless in the sense that the model sees a smaller image that still represents the same content.
3. Re-encode to PNG, base64-encode, check size again. Repeat with more aggressive scaling if still over.

### Local display in the user prompt bar

After reading the clipboard image, display it in the `›` prompt bar so the user sees what they're attaching. `UserPromptRender` currently takes only `text: string` (line 186 of `App.tsx`). Extend its props to accept an optional `attachedImages: Buffer[]` and render each via `emitKittyImage` alongside the text:

```tsx
function UserPromptRender({
  text,
  attachedImages,
}: {
  text: string;
  attachedImages?: Buffer[];
}): React.ReactElement {
  return (
    <Box marginTop={1} marginBottom={1} flexDirection="row">
      <Text bold color="cyan">{"› "}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <MarkdownRenderer text={text} />
        {attachedImages?.map((buf, i) => (
          <InkPicture key={i} buffer={buf} cols={20} rows={10} />
        ))}
      </Box>
    </Box>
  );
}
```

The image shown here is a thumbnail preview (small `cols`/`rows`). It disappears from the dynamic tree once the turn is submitted and moves to the transcript as a finalized event under `<Static>`.

---

## 6. Shared core and build order

### The single emitter

Factor `emitKittyImage(buffer: Buffer, opts: KittyOpts): string` as the one place that knows the Kitty wire format. It returns the full escape string (all chunks concatenated); callers write it to stdout or pass it to ink-picture. This function is reused by:

- Model-output `<img>` and `![]()` rendering.
- Pasted image local display in the user prompt bar.
- Math (MathJax → SVG → resvg → PNG → here) — see the research doc.
- Mermaid (mmdc/mmdr → PNG → here) — see the research doc.

```ts
interface KittyOpts {
  cols: number;    // terminal columns to occupy
  rows: number;    // terminal rows to occupy
  id?: number;     // image id for later deletion; omit for fire-and-forget
  zIndex?: number; // z-layer; defaults to 0
}

function emitKittyImage(buffer: Buffer, opts: KittyOpts): string {
  const b64 = buffer.toString("base64");
  const chunkSize = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    chunks.push(b64.slice(i, i + chunkSize));
  }

  const controlFields = [
    "a=T",
    "f=100",
    `c=${opts.cols}`,
    `r=${opts.rows}`,
    ...(opts.id !== undefined ? [`i=${opts.id}`] : []),
    ...(opts.zIndex !== undefined ? [`z=${opts.zIndex}`] : []),
  ].join(",");

  return chunks
    .map((chunk, idx) => {
      const isLast = idx === chunks.length - 1;
      const ctrl = idx === 0 ? `${controlFields},m=${isLast ? 0 : 1}` : `m=${isLast ? 0 : 1}`;
      return `\x1b_G${ctrl};${chunk}\x1b\\`;
    })
    .join("");
}
```

### Milestone order

| Milestone | Deliverable | Prerequisite |
|---|---|---|
| **M0** | `<Static>` transcript refactor in `App.tsx` | None — do this first, standalone |
| **M1** | `emitKittyImage` + ink-picture wiring + `supports-terminal-graphics` detection + render a test PNG inline | M0 |
| **M2** | Model-output images: `<img>` HTML case + `image` inline token in `MarkdownRenderer.tsx`; resolution pipeline (fetch + fs.readFile); SVG→PNG via `@resvg/resvg-js`; downscale via `sharp`; async pre-resolve cache; SSRF + path-traversal guards | M1 |
| **M3** | Pasted images: clipboard read path extending `clipboard-backends.ts`; content-block injection; size management; local thumbnail in `UserPromptRender`; verify stream-json image-block acceptance (probe first) | M1, probe result |

M0 is a standalone refactor with no image code and can be reviewed independently. M2 and M3 are independent of each other once M1 is done; they can be built in parallel if the probe for M3 comes back positive before M2 is complete.

---

## 7. Testing

### Unit tests

All of the following assert on escape bytes and data shapes — not on pixel output.

**Kitty emitter:**
- Payload ≤ 4096 bytes → single chunk, `m=0` on the only escape, control fields present.
- Payload = 4097 bytes → two chunks; first escape has `m=1` + control fields; second has `m=0` + no control fields beyond `m=`.
- Payload = exactly 8192 bytes → two full 4096-byte chunks.
- Payload = 8193 bytes → three chunks; only first and third matter for boundary assertions.
- `i=` present in first chunk when `id` option provided; absent when omitted.

**Security guards:**
- SSRF: `http://localhost/` rejected; `http://127.0.0.1/` rejected; `http://169.254.169.254/` rejected; `http://10.0.0.1/` rejected; `https://example.com/image.png` accepted.
- Path traversal: `/etc/passwd` rejected (outside allowed root); `~/images/../../../etc/shadow` resolves and is rejected; `~/images/photo.png` accepted.
- Each rejection must return a typed error value, not throw.

**Clipboard backend selection (read side):**
- Given a `which` that returns a path only for `wl-paste` → `wl-paste` selected.
- Given a `which` that returns null for all → returns null.
- Given only `xclip` on PATH → `xclip` selected with correct stdout-capture args.

**Content-block injection:**
- Given a text turn + one image buffer → output JSON has `content` as array with `text` block first, `image` block second.
- Given two images → array has one text block + two image blocks.
- Image block has `type: "image"`, `source.type: "base64"`, `source.media_type: "image/png"`, `source.data` matching the base64 of the buffer.

**Fallback:**
- When `supports-terminal-graphics` returns false, `emitKittyImage` is never called and the alt text placeholder is rendered.

### Integration tests

Real pixel verification is manual / local — CI cannot render a Ghostty frame. Note this explicitly in the test suite (e.g. a `// INTEGRATION: run manually in Ghostty` comment block with the test scenario). Integration assertions for CI:

- Write an `emitKittyImage` escape to a PTY and verify the byte sequence structure (APC open/close, chunk boundaries) without rendering.
- Full round-trip test (if Ghostty is available in the CI runner via a virtual framebuffer): launch the renderer, inject an assistant event with an `<img>` URL pointing to a test fixture PNG, assert that the Kitty escape bytes appear in the terminal's PTY output. This test is optional-in-CI, required-in-local-sign-off.

---

## 8. References

| Source | Notes |
|---|---|
| [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/) | Chunk size, `m=` flag, `f=100`, `a=T`, `a=d`, placement keys |
| [Ghostty issue #4323](https://github.com/ghostty-org/ghostty/issues/4323) | Kitty images don't follow CSI-driven scroll (open) |
| [ink-picture](https://www.npmjs.com/package/ink-picture) | Ink component: Flexbox space reservation + per-frame re-emit + Unicode fallback |
| [supports-terminal-graphics](https://www.npmjs.com/package/supports-terminal-graphics) | Startup-time protocol detection |
| [chafa](https://hpjansson.org/chafa/) | C/WASM fallback: Kitty → iTerm2 → sixel → Unicode → ASCII cascade |
| [@resvg/resvg-js](https://www.npmjs.com/package/@resvg/resvg-js) | Rust/napi SVG → PNG; Bun-compatible |
| [sharp](https://www.npmjs.com/package/sharp) | Raster image downscale before Kitty transmission |
| [Anthropic vision docs](https://docs.anthropic.com/en/docs/build-with-claude/vision) | Image content block format; base64 encoding; supported media types |
| [Anthropic image content block](https://docs.anthropic.com/en/api/messages) | `source.type: "base64"`, `media_type`, size limits |
| [`research/renderer-graphics-interactivity.md`](../research/renderer-graphics-interactivity.md) | Broad feasibility survey; math/mermaid adapters; mouse/links/scroll findings |
| [`design.renderer.md`](design.renderer.md) | Renderer↔CLI integration architecture |
| [`decisions.md`](../decisions.md) | Dated technical decisions |
