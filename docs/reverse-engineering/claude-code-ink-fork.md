# Claude Code's renderer is a fork of Ink

What Claude Code's terminal UI is actually built on, how much of it is
Anthropic's own code rather than the upstream library, and what that means for
anyone trying to reach visual parity with a stock-Ink app.

> Per the folder convention: no minified symbol names, no byte offsets. Findings
> are anchored on durable string literals and on publicly-published source
> structure. See [`claude-code-binary-internals.md`](claude-code-binary-internals.md)
> for the grep technique.

Companion to [`claude-code-render-modes.md`](claude-code-render-modes.md), which
covers the three screen-management modes this renderer draws in. Read that one
for *which* mode is active and why; read this one for *what does the drawing*.

---

## The headline

Claude Code's TUI is **React + Ink** — the same foundation `packages/renderer`
uses. But it is not stock Ink with components on top. Anthropic **forked the
rendering layer** and rewrote the terminal-facing half of it.

This is the single most useful fact in this document, because it reframes the
gap between fnclaude's renderer and Claude Code's. The gap is not "they picked a
better framework." Both are Ink. The gap is roughly 660 KB of hand-written
terminal code that stock Ink does not contain and was never designed to contain.

---

## Evidence from the shipped binary

Probing the Bun-compiled binary for Ink's reconciler node types — durable string
literals in Ink's host config, present in any Ink build:

| Literal | Occurrences |
|---|---|
| `ink-box` | 12 |
| `ink-text` | 17 |
| `ink-virtual-text` | 10 |
| `ink-root` | 6 |
| `measureElement` | 3 |

Confirms Ink. Two further probes establish that the shipped bundle is **not a
viable extraction target**:

- **`node_modules/ink/` → 0 occurrences.** Ink is inlined into the bundle, not
  present as a discrete module with recoverable boundaries.
- **No Claude Code source paths survive.** A sweep for `.tsx` paths returns ~135
  hits, essentially all of them Bun's own scaffolding baked into the standalone
  runtime — the shadcn `bun init` templates (`src/components/ui/button.tsx` and
  siblings), `bun-framework-react/{ssr,client,server}.tsx`, Next.js internals,
  and `REPLACE_ME_WITH_YOUR_APP_*.client.tsx` placeholders. Exactly one genuine
  Claude Code filename appears anywhere in the binary: `AgentTool.tsx`.
- **Component identities are gone.** Of ~169 `displayName` assignments, every one
  with a human-readable value belongs to *web* UI (a combobox family, checkbox,
  button, Clarity Design System layer helpers) or to the JetBrains IDE-integration
  name list. Every terminal-side assignment targets a short minified symbol.

So: one Bun-compiled standalone, fully minified, module boundaries dissolved, no
sourcemaps for first-party code. Recovering the renderer from the binary would
mean reconstructing a transitive closure of minified functions and would not
survive the next release's symbol reshuffle.

---

## Structure, from the published source snapshot

On **2026-03-31** sourcemaps were shipped in the `@anthropic-ai/claude-code` npm
package, exposing first-party TypeScript. Several public repositories preserve
and rebuild that snapshot. They are useful for *architectural orientation* — the
shape below is not recoverable from the shipped binary at any reasonable cost.

**Top-level `src/` layout** — ~40 directories, including `tools/`, `services/`,
`components/`, `hooks/`, `screens/`, `state/`, `coordinator/`, `query/`,
`remote/`, `skills/`, `keybindings/`, `vim/`, `voice/`, and — the one that
matters here — **`ink/`**.

`src/screens/` is three files: `REPL.tsx`, `Doctor.tsx`, `ResumeConversation.tsx`.
`src/components/` holds ~151 entries.

### `src/ink/` — the fork

~664 KB of TypeScript across ~40 files plus five subdirectories.

| File | Size | Stock Ink? |
|---|---|---|
| `ink.tsx` | 252 KB | name yes, size no |
| `render-node-to-output.ts` | 63 KB | yes |
| `screen.ts` | 49 KB | **no** |
| `selection.ts` | 35 KB | **no** |
| `Ansi.tsx` | 33 KB | **no** |
| `log-update.ts` | 27 KB | yes |
| `output.ts` | 26 KB | yes |
| `parse-keypress.ts` | 23 KB | **no** |
| `styles.ts` | 21 KB | yes |
| `dom.ts` | 15 KB | yes |
| `reconciler.ts` | 15 KB | yes |
| `render-to-screen.ts` | 8.5 KB | **no** |

Additional first-party files with no upstream counterpart: `hit-test.ts`
(mouse target resolution), `frame.ts`, `optimizer.ts`, `searchHighlight.ts`,
`line-width-cache.ts`, `node-cache.ts`, `bidi.ts`, `supports-hyperlinks.ts`,
`clearTerminal.ts`, `colorize.ts`, `devtools.ts`, `stringWidth.ts`,
`squash-text-nodes.ts`, `render-border.ts`, `get-max-width.ts`.

**Subdirectories:**

- **`termio/`** — `ansi.ts`, `csi.ts`, `dec.ts`, `esc.ts`, `osc.ts`, `sgr.ts`,
  `parser.ts`, `tokenize.ts`, `types.ts`. A hand-written terminal
  escape-sequence stack, split by sequence class. Nothing like it exists in
  upstream Ink.
- **`layout/`** — `engine.ts`, `geometry.ts`, `node.ts`, `yoga.ts`. Their own
  layout layer wrapping Yoga rather than calling it directly.
- **`components/`**, **`hooks/`**, **`events/`** — renderer-internal, distinct
  from the app-level `src/components/` and `src/hooks/`.

### What the fork buys

Reading the file inventory as a feature list, the fork exists to provide:
mouse hit-testing, text selection, in-buffer search highlighting, an
alternate-screen manager, frame-level paint control (this is where
synchronized-output wrapping lives), a render optimizer with width/node caches,
bidirectional text, and custom key parsing.

**Stock Ink provides none of those.** They are exactly the capabilities a
terminal app needs to feel like an application rather than a scrolling log.

---

## Implications for fnclaude

1. **Framework choice was never the problem.** `packages/renderer` and Claude
   Code sit on the same library. Feature-parity work is not a migration, it is
   a fork-and-rewrite of the terminal layer.
2. **Flicker is the cheapest win and is already specced.** Frame-level
   synchronized output (DEC private mode 2026) is one concern out of that list
   and is isolatable — see the flicker section of
   [`claude-code-render-modes.md`](claude-code-render-modes.md).
3. **Everything else on the list is expensive** and interdependent: selection
   needs hit-testing needs layout geometry needs a screen manager.
4. **The published snapshot is a blueprint, not a source.** Its value is knowing
   *which* concerns to build and in what order. Anthropic's implementation is
   proprietary and does not belong in a published package; upstream Ink is MIT
   and is the correct thing to fork if that path is taken.

---

## Version drift

The published snapshot is **2026-03-31**. Binary probes above are against
**v2.1.240** (2026-08). The renderer is among the most actively developed
surfaces in the product — the fullscreen alt-screen mode shipped as a research
preview in v2.1.89, i.e. after the snapshot. Treat the snapshot as architecture
and verify specifics against the live binary before relying on them.

---

## Reusable string seeds

| Seed | Leads to |
|---|---|
| `ink-box` / `ink-text` / `ink-virtual-text` / `ink-root` | Ink reconciler host config; confirms Ink in any build |
| `measureElement` | Ink measurement API |
| `node_modules/ink/` | absence confirms Ink is inlined, not modular |
| `displayName` | component identity survival (web components only) |
| `AgentTool.tsx` | the only first-party source filename in the bundle |
