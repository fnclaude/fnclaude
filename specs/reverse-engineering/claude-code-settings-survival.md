# Which Claude Code settings survive renderer mode

Which `settings.json` keys still take effect when fnclaude drives `claude` in **renderer mode** (`FNC_RENDERER` → `claude --print --input-format stream-json --output-format stream-json --verbose`), and which are silently dropped because they only ever lived in the interactive TUI. Written against **v2.1.200** of the Bun-compiled ELF; grep technique in [`claude-code-binary-internals.md`](claude-code-binary-internals.md), render-mode mechanics in [`claude-code-render-modes.md`](claude-code-render-modes.md).

> Minified symbol names and byte offsets are intentionally omitted — they change between builds. Everything here is anchored on durable string literals (settings keys, system-prompt fragments, log lines) and one empirical `--print` experiment.

## The deciding axis: who *consumes* the setting

In renderer mode the `--print` child renders nothing — fnclaude owns the screen. So the split is not "session vs UI" in the abstract, it's **which layer reads the key**:

- **Consumed by claude-core's query / inference / tool machinery → survives.** These are read the same way regardless of who renders, so renderer mode inherits them for free.
- **Consumed only by the TUI's render + input event loop → lost.** The headless child has no render loop, so nothing on the claude side can apply them; if fnclaude wants the behavior it must implement it itself.

### Survives (core-consumed)

`model`, permission mode, `env`, `mcpServers` / MCP config, `hooks`, **all system-prompt modifiers** (there is a single system-prompt builder shared by interactive and headless — see below), `includeCoAuthoredBy` (applied in the git/commit tool path, not the TUI), auth / `forceLoginMethod`, and **`outputStyle`** (proven below).

### Lost (TUI-render-loop-consumed)

`theme`, `tui`, `autoScrollEnabled`, `editorMode`, `statusLine`, `voice`, `leftArrowOpensAgents`, notification/toast toggles, and cosmetic hint keys (`spinnerTipsEnabled` and similar). fnclaude must recreate any of these it wants as behavior. The cosmetic ones carry no behavioral payload, so "recreate" is moot — they're simply irrelevant in renderer mode.

## `outputStyle` survives — proven

Output styles are **not** a TUI feature. The headless `--print` path reads the `outputStyle` settings key from the normal precedence chain and injects the style's system-prompt content into the request.

### The single system-prompt builder

There is one system-prompt builder used by every query source, interactive and headless alike. Anchored on the string literals it emits:

- It resolves the active output style by calling a resolver that reads `outputStyle` off the merged settings object (default id `"default"`), then looks that name up in a map of all loaded styles. The map is keyed by each style's `name` frontmatter field and aggregated from built-in + user (`~/.claude/output-styles/`) + project (`.claude/output-styles/`) + plugin sources; a plugin style with `forceForPlugin` wins ahead of the setting. **This resolver runs unconditionally in the builder — there is no TTY / interactive / `-p` gate around it.**
- The resolved style is woven into the prompt two ways:
  1. Its own block, literal header `# Output Style: <name>` followed by the style's prompt body, registered under the section id `output_style`.
  2. The first sentence of the base system prompt swaps to the literal `...according to your "Output Style" below, which describes how you should respond to user queries.` when a style is active, versus `...with software engineering tasks.` when it isn't. (Two further variants of that opener exist for an alternate base-prompt mode; all four thread the same resolved-style value.)
- The builder exposes an option that omits some dynamic sections from certain assemblies; the `output_style` section is **not** among the ones it drops, so the style applies even in the reduced form.

### Empirical confirmation (the exact renderer-mode command)

A throwaway cwd with a custom style whose prompt mandates a unique marker, selected via project-local settings:

```
.claude/output-styles/zorptest.md   # frontmatter name: ZorpTest;
                                     # body: "begin every response with ZORP_MARKER_9town"
.claude/settings.local.json         # { "outputStyle": "ZorpTest" }
```

```sh
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with just the word: pineapple"}}' \
  | claude --print --input-format stream-json --output-format stream-json --verbose
```

- `outputStyle: "ZorpTest"` → assistant text `ZORP_MARKER_9town\n\npineapple`.
- Negative control `outputStyle: "default"` (same cwd, style file still on disk, just not selected) → `pineapple`, no marker.

The only variable changed was the `outputStyle` key, and the marker token exists nowhere but that style file — so its presence in the headless response is direct proof the style's prompt was injected into the `--print` request.

`--output-format stream-json` under `--print` **requires `--verbose`** (the child errors out otherwise: `When using --print, --output-format=stream-json requires --verbose`). This is why the renderer invocation carries `--verbose`.

### The headless child loads the full settings chain

Under `-d api --debug-file`, the `--print` child logs:

```
Watching for changes in setting files <user>/.claude/settings.json, <cwd>/.claude/settings.json, <cwd>/.claude/settings.local.json
```

i.e. headless loads the whole user → project → project-local precedence chain. The cwd-scoped storage of `outputStyle` (it's written to project `.claude/settings.local.json`, not user settings) is therefore a non-issue — `--print` reads the same chain the interactive TUI does.

## Scope caveat

`outputStyle` is the key verified end-to-end (empirical + code path), and structurally the whole shared system-prompt builder it rides in. The other bucket assignments are read off the same single-builder / TUI-render-loop split plus the settings-chain-load evidence; they're high-confidence but only `outputStyle` was exercised against a live `--print` request. Any specific other key is a cheap follow-up with the same marker-in-`--print` harness: put a distinctive, observable instruction behind the setting, run the renderer-mode command with it on and off, and diff the response.

## Redo-for-a-new-version checklist

1. `grep -aoc 'outputStyle' "$BIN"` and `grep -aoE 'outputStyle[A-Za-z]*' "$BIN" | sort -u` — confirm the key still exists.
2. `grep -aboF 'function' + 'Output Style below'` region — re-read the shared system-prompt builder; confirm the style resolver is still called unconditionally (no TTY/`-p` gate) and that the `output_style` section isn't newly excluded.
3. Re-run the marker experiment above against the exact renderer command; confirm the marker survives with the style selected and vanishes without it.
