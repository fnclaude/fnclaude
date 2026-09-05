# Renderer TODO — ffnc debugging effort

Active effort (2026-06-26): fix `packages/renderer` perf + close GFM rendering gaps.  
Live `fnc` = npm, frozen at 2.13.2; `ffnc` = working-tree source (changes land after `git pull` on main). Publishing PAUSED — feature PRs auto-merge to main, no npm publish fires.

---

## Status legend

✅ shipped · 🟡 in-progress · ⬜ queued · ❓ needs-decision

---

## Shipped

- [x] ✅ **Table styled-cell width misalignment** — `TableBlock` measured `cell.text` (with md syntax) but rendered stripped tokens; fixed via `inlineVisibleText` helper. PR #272, merged.
- [x] ✅ **Markdown-parse memoization / typing-lag** — `MarkdownRenderer.tsx` was re-running `remend()` + `marked.lexer()` (and `cli-highlight`) on every keystroke for every message (O(transcript)); fixed with `useMemo`. PR #273, merged.

> **Note:** `ffnc` needs a `git pull` on main to pick up both fixes.

---

## 1. Perf — flicker (priority: ship first)

The "total killer" remaining. Ink repaints full frame (cursor-up + clear + redraw) with no synchronized-output wrapping.

**Ink is NOT the problem** — Claude Code is also Ink; its flicker-free "fullscreen" renderer wraps each frame in **DEC private mode 2026** (`ESC[?2026h` … `ESC[?2026l`). That's the `CLAUDE_CODE_NO_FLICKER` / `tui:"fullscreen"` mechanism. Reference: `docs/reverse-engineering/claude-code-render-modes.md` §"Flicker-free paint (synchronized output)". Ghostty supports 2026.

- [ ] ❓ **Go-ahead from Tom** to proceed with the sync-output fix.
- [ ] ⬜ **Verify cleanest Ink-v5 hook point** — likely a wrapping `stdout` Writable passed to `render()` that intercepts each frame write and sandwiches it in `ESC[?2026h` / `ESC[?2026l`. Confirm before implementing.
- [ ] ⬜ **Implement + ship** — wrap Ink frame writes in DEC 2026 sync-output; test on Ghostty.

**`<Static>` is DEFERRED** — to the image/scroll roadmap (research doc wants it as the foundation for inline images + scroll). Its filter-repaint conflict (Alt+1-8 keybind: option a = filters new-content-only / option b = remount-on-toggle) is **parked, not decided**. Do not conflate with the flicker fix.

---

## 2. GFM rendering items (tackle after flicker)

### #1 — Clickable links via OSC 8

- [ ] ⬜ Use OSC 8 with **BEL terminator**: `\x1b]8;;URL\x07text\x1b]8;;\x07` — NOT ESC-backslash terminator.
- [ ] ⬜ Gate on `terminal-link@5` `supports-hyperlinks`; fall back to current blue+underline.
- [ ] ⬜ No `string-width` fork needed — `ansi-regex@6.2.2` (already installed) strips OSC; Ink's grid tokenizes BEL-form OSC as zero-width. The prior width-inflation bug (PR #261 / #263) was a `visibleWidth` regex that only consumed the `ESC]` prefix, leaving `8;;<url>\x07` as visible characters — BEL form + ansi-regex sidesteps it entirely.

> **Note:** this reverses the no-OSC-8 decision recorded in `docs/decisions.md` (2026-06-26). The revisit clause in that entry ("when string-width reliably strips OSC 8 bytes") is now satisfied by ansi-regex@6.2.2. The #261 revert was a capability/terminal issue, not unfixable width math.

- [ ] ⬜ Non-http hrefs (anchors `#…`, relative paths) stay PLAIN — no target in a terminal.
- [ ] ⬜ `@mention` (`@username`) → `https://github.com/<name>` link (OSC 8 once links are live).
- [ ] ⬜ `#123` issue refs → **PLAIN** (renderer has no repo context).

### #4 — `<sub>` / `<sup>` subscript / superscript

- [x] ✅ **DECIDED (Tom 2026-06-29): ASCII** — `<sub>x</sub>` → `_x`, `<sup>x</sup>` → `^x` (e.g. H<sub>2</sub>O → H_2O, x<sup>2</sup> → x^2). Not Unicode (`₂`/`²`) — Unicode sub/superscript covers only a limited char set.
- [ ] ⬜ Implement: prefix the grouped content with `_`/`^` in the shared inline-html grouping pass (open/text/close tokens) used by kbd #6 + HTML-subset coloring.

### #5a — Emoji shortcodes (`:rocket:` → 🚀)

- [ ] ❓ **Tom: ok to add `node-emoji` dep?**
- [ ] ⬜ Run `:shortcode:` tokens through `node-emoji` `emojify` if dep approved.

### #5b — `@mention` and `#123` refs

Covered in #1 above: `@mention` → GitHub link; `#123` → plain.

### #6 — `<kbd>` key glyphs

- [ ] ⬜ Replace `<kbd>KEY</kbd>` with nerdfont `nf-md` glyphs. Codepoint maps are already gathered at `scratchpad/nerdfont-glyphs.ts` (in the session scratchpad: `/tmp/claude-1000/-home-tom-src-fnclaude-fnclaude/de0c20a7-346c-464e-b349-87fc751d6c08/scratchpad/nerdfont-glyphs.ts`) — KBD_MODIFIER / SYMBOL / ALPHA / NUMERIC / ARROW / NAMED / FKEY tables are ready to import.

### #7 — Footnotes `[^1]`

- [ ] ⬜ Add a `marked` extension to tokenize footnote refs (`[^1]`) and footnote defs (`[^1]: …`).
- [ ] ⬜ Render refs as `nf-md` numeric_N_circle glyphs (cap at 10; fall back to `[N]` for N > 10). Codepoint map in `FOOTNOTE_CIRCLE` in the same `nerdfont-glyphs.ts` scratchpad file.

---

## Decisions log (brief)

| Decision | Outcome |
|---|---|
| OSC 8 approach | BEL terminator (`\x07`), gated on `terminal-link@5` `supports-hyperlinks`; no string-width fork, no roll-own Transform needed. Reverses 2026-06-26 no-OSC-8 entry. |
| Flicker fix approach | DEC 2026 synchronized-output, not `<Static>`. `<Static>` deferred to image/scroll roadmap. |
| `#123` issue refs | PLAIN — no repo context in renderer. |
| Alerts styled NOTE-only | CONTENT artifact (merged blockquote), GitHub-faithful, not a renderer bug. |
| Table row "leak as raw pipes" | CONTENT artifact (blank-line-split table / streaming transient frame), not a renderer bug. |

---

## Open questions / needs-Tom

1. **Flicker sync-output** — go-ahead to verify Ink-v5 hook + ship? (`ESC[?2026h`/`l` wrapping)
2. **`<sub>`/`<sup>`** — Unicode sub/superscript (`₂`/`²`) or ASCII (`_2`/`^2`)?
3. **`node-emoji` dep** — ok to add for `:shortcode:` → emoji?
4. **`<Static>` filter-repaint** (parked) — when revisited: option a (new-content-only on filter toggle) vs. option b (remount-on-toggle)?

---

## Conventions / notes

- **Publishing PAUSED** — `fix:`/`feat:` PRs auto-merge to main; no npm publish fires. Live `fnc` stays at 2.13.2. `ffnc` = source.
- **TDD hard rule** — every `fix:`/`feat:` needs a failing test first. No exceptions. Auto-merge fires the moment `verify` is green; the test suite is the only gate.
- **Stash-sanity in parallel worktrees** — use copy-to-`/tmp`, NOT `git stash`. Stash stack is shared across all worktrees; concurrent stash/pop swaps changes between them. See `~/.claude/projects/.../memory/MEMORY.md` → "Shared stash across worktrees".
- **PR-bound work** — code changes go via worktree + `pr-bound-coder` subagent. Branch names: `feat-renderer-*` / `fix-renderer-*` / `perf-renderer-*`.
- **Cross-ref:** stale untracked `PLAN.md` at repo root tracks a separate older multi-feature effort (tasks #57-#62, different scope). `docs/decisions.md` is the canonical decisions log — update it in the same commit as any new decision above.
