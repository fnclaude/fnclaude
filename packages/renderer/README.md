# fnclaude-renderer

Configurable TUI front-end for Claude Code. Bidirectional stream-json driver, repaint-on-toggle visibility filters (Alt+1-8), pretty markdown via [glow](https://github.com/charmbracelet/glow).

## Status

Pre-v1. Active development. v0 ships the renderer in standalone wrapper mode — `fnclaude-renderer ...` spawns claude internally, renders the stream.

## Goals

- Replace the Claude Code CLI's fixed output with **verbosity presets** (quiet / normal / verbose / debug) and **per-element show/hide toggles**.
- **Repaint past content on toggle** — flip a filter and previously-hidden content appears in place; previously-shown content collapses to a header. The transcript is a live view of the event log under the current filter.
- Pipe assistant markdown through `glow` when available; raw fallback otherwise.
- One persistent `claude` subprocess per session, driven via `--input-format stream-json --output-format stream-json`. No `--resume`-per-turn latency.

## Install

### Arch Linux (AUR)

```sh
yay -S fnclaude-renderer-bin
```

### Other platforms

Download the pre-built binary for your platform from the [latest release](https://github.com/fnrhombus/fnclaude-renderer/releases/latest):

- Linux x86_64 / arm64
- macOS x86_64 (Intel) / arm64 (Apple Silicon)
- Windows x86_64 / arm64

Extract and place `fnclaude-renderer` on your `$PATH`.

### Optional: glow

[glow](https://github.com/charmbracelet/glow) renders assistant markdown with syntax highlighting. If it's on your `$PATH` it gets used automatically; otherwise raw markdown is shown.

## Keybinds

| Keybind | Element toggled |
|---|---|
| `Alt+1` | `thinking` blocks |
| `Alt+2` | `Bash.input` (commands) |
| `Alt+3` | `Bash.output` |
| `Alt+4` | `Edit.diff` |
| `Alt+5` | `Read.content` |
| `Alt+6` | `Write.content` |
| `Alt+7` | `Task.nested` (subagent prompts) |
| `Alt+8` | `errors` |
| `Alt+0` / `Alt+9` | cycle preset forward / backward |
| `Ctrl+L` | force repaint |
| `Ctrl+D` | clean exit |

See [docs/keybind-spec.md](docs/keybind-spec.md) for terminal-specific caveats (especially macOS Terminal.app's Option/Meta handling).

## Architecture

- [docs/stream-json-findings.md](docs/stream-json-findings.md) — empirical notes on `claude`'s stream-json mode (what works, what's a footgun).
- [docs/event-spec.md](docs/event-spec.md) — the typed event contract between the process driver and the UI.
- [docs/filter-state-spec.md](docs/filter-state-spec.md) — verbosity presets, per-element override mechanics, repaint semantics.
- [docs/keybind-spec.md](docs/keybind-spec.md) — Alt+1-8 mapping, terminal caveats.

## License

MIT.
