# Claude Code auto-compaction thresholds (reverse-engineered)

Written against **v2.1.200** of `@anthropic-ai/claude-code` — the Bun-compiled
`bin/claude.exe` single-file executable, ~251 MB, **not-stripped** ELF,
embedded-JS greppable. Siblings in this folder (`claude-code-binary-internals.md`,
`claude-code-compact-prompts.md`) were written against v2.1.181; this is a
newer build. Minified symbol names are build-specific and routinely differ
between versions — **anchor on string literals and numeric constants, not
names.** For the actual grep/`dd` technique, see
`claude-code-binary-internals.md`; this doc doesn't duplicate it.

## TL;DR mechanism

Auto-compaction is driven by a level ladder (minified fn `r5l`/`EBe` in
v2.1.200) that returns one of `ok | warn | compact | blocked`. Auto-compaction
fires when the level reaches `compact` or `blocked`. The thresholds are an
**absolute token reserve subtracted from an effective window**, not a flat
percentage of context:

```
effectiveWindow = configuredWindow − min(max_output_tokens, 20000)

warn     fires at   effectiveWindow − 33000     (= compact − 20000)
compact  fires at   effectiveWindow − 13000     ← the auto-compact event
blocked  fires at   rawWindow − 23000           (hard stop; uses RAW window, not configured)
```

Note `blocked` is the odd one out: it subtracts from the *raw* window
(model capability ceiling), while `warn`/`compact` subtract from the
*effective* (output-reserved) window.

## Configured-window resolution

Precedence, highest first:

1. **`CLAUDE_CODE_AUTO_COMPACT_WINDOW`** (env, tokens, clamped 100,000–1,000,000)
   — sets configured window directly.
2. **`settings.json` → `autoCompactWindow`** (int, 1e5–1e6) — same knob, via settings.
3. **Surface/entrypoint table** — `CLAUDE_CODE_ENTRYPOINT=local-agent` or
   `remote_cowork` overrides configured window to **500,000**. The default
   `cli` entrypoint does **not** trigger this override. (See
   `claude-code-binary-internals.md` for how `CLAUDE_CODE_ENTRYPOINT` is set
   and its full value enum.)
4. **Per-model default table** (minified `o5l` in v2.1.200): 1M-class models
   default configured window to **967,000** (raw capability 1,000,000).
5. **`CLAUDE_CODE_DISABLE_1M_CONTEXT`** drops 1M-class models to a 200,000
   window.

## Worked example — default `cli` surface, 1M-class model

This is the common case: interactive TUI or a plain headless run with no
overrides.

- `configuredWindow` = 967,000 (`o5l` table)
- output reserve = `min(64000, 20000)` = 20,000 → `effectiveWindow` = 947,000
- **`compact` (auto-compact) fires at 934,000 ≈ 93.4% of a nominal 1M window**
- `warn` fires at 914,000 (91.4%)
- `blocked` (hard stop) fires at 977,000 (97.7%)

The widely-repeated "92%" figure for auto-compact has no authoritative
source I could find — folklore. The real number on a default 1M `cli`
session is **~93.4%**, not 92%.

### Live verification (this machine, this session)

```
$ printenv CLAUDE_CODE_ENTRYPOINT
cli
```

No `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`, or other override
set. So the 500k-surface override does **not** apply, and the 934,000-token
backstop above is the operative one for this session.

One ambiguity worth stating plainly: the 1M-class default (967,000) was
resolved via the model-registry `sonnet-5` entry, but this session's model is
`claude-opus-4-8[1m]`. I didn't independently measure the constant for the
Opus entry — treat "967,000 for 1M-class models" as the fact in evidence,
not "specifically measured for Opus."

## The 500k-surface gotcha

Under `local-agent`/`remote_cowork` entrypoints, configured window = 500,000,
so `compact` fires at **~467,000** (500,000 − 33,000) — less than half the
nominal-1M figure. Anything that reasons about "the backstop" needs to check
`CLAUDE_CODE_ENTRYPOINT` first: the same model auto-compacts at wildly
different absolute token counts depending on surface.

| Surface | Configured window | `compact` fires at |
|---|---|---|
| `cli` (default), 1M-class model | 967,000 | 934,000 |
| `local-agent` / `remote_cowork` | 500,000 | 467,000 |
| 1M-class w/ `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 200,000 | 167,000 |

## Overrides / kill-switches

| Knob | Effect |
|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (env, tokens, clamp 100k–1M) | Highest-precedence configured-window setter. |
| `autoCompactWindow` (settings.json, int 1e5–1e6) | Same, via settings. |
| `autoCompactEnabled` (settings.json bool, default `true`) | Shown as "Auto-compact" in `/config`. |
| `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` (env) | Disables the `compact` trigger only; `warn`/`blocked` levels still evaluate. |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (env, 1–100) | Test knob; can only *lower* the threshold, never raise it — "values above default have no effect." Only bites for *proactive* compaction (cloud sessions, or when `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, or Sonnet 4.6/Opus 4.6 non-extended). On most local sessions on newer models it's a no-op, since compaction is tied to the context limit itself. |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | Overrides the `blocked` threshold directly. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Feeds the `min(max_output_tokens, 20000)` reserve calc. |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Drops 1M-class models to a 200,000 window. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Only takes effect with `DISABLE_COMPACT` set, or on non-`claude-*` models. |

## Cross-check against Anthropic's public docs & changelog

- `code.claude.com/docs/en/model-config`: Sonnet 5 "auto-compacts before the
  window fills, at about 967,000 tokens"; Sonnet 4.6 / Opus 4.6 without
  extended context "compact at the 200K boundary." Reconciling with the
  binary: the docs' 967,000 is the *configured-window table value*, not the
  trigger point. The actual `compact` **event** fires at
  `configuredWindow − 33,000` = 934,000. The public doc names the window,
  not the threshold.
- `CHANGELOG.md`:
  - v1.0.51 raised the auto-compact **warning banner** threshold from 60% to
    80% — a UI heads-up, distinct from the `compact` trigger itself.
  - v2.1.7 fixed the `blocked` limit to use the effective (output-reserved)
    window instead of the raw window. (Current v2.1.200 behavior — `blocked`
    keyed to *raw* window — postdates and differs from that fix; re-verify
    if this matters for your use case.)
  - v2.1.14 fixed a regression that blocked at ~65% instead of the
    "intended ~98%."

## Minified symbol seeds (build-specific — v2.1.200; will drift)

Level ladder: `r5l` / `EBe`. Supporting: `$ar`, `Yie`, `A3`, `OVf`. Per-model
window table: `o5l`. These are seeds to grep for in a given build, not stable
identifiers — expect different minified names in other versions.

Numeric constants are sturdier grep anchors than names:

- `20000` — output-reserve cap
- `13000` — `compact` offset
- `33000` — `warn` offset
- `23000` — `blocked` offset
- `967000` — 1M-class configured-window default
- `500000` — `local-agent`/`remote_cowork` surface override
- `200000` — `CLAUDE_CODE_DISABLE_1M_CONTEXT` window

For the runbook on turning a string/numeric seed into verified source (grep →
byte offset → `dd` window → confirm), see `claude-code-binary-internals.md`.

## Why this matters for fnclaude

fnclaude's own `[[context.notice_tiers]]` (`at`) and `[context.notice_repeat]`
(`every`) are absolute-token thresholds measured against the same usage
counter Claude Code uses internally. On a default 1M `cli` session the
auto-compact backstop is ~934,000, so a manual notice ladder should anchor
its top ("urgent") tier a few percent under that — and the tier has to be
recomputed by hand if the surface (500k override) or the model's window
changes. This is exactly the coupling
[issue #332](https://github.com/fnclaude/fnclaude/issues/332) (accept
percentage thresholds instead of absolute counts) proposes to fix.
