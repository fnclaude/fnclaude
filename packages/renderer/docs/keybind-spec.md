# Keybinds — Alt+1–8 element toggles, preset cycling, escape

## Element toggles

| Keybind | Element |
|---|---|
| `Alt+1` | `thinking` |
| `Alt+2` | `Bash.input` |
| `Alt+3` | `Bash.output` |
| `Alt+4` | `Edit.diff` |
| `Alt+5` | `Read.content` |
| `Alt+6` | `Write.content` |
| `Alt+7` | `Task.nested` |
| `Alt+8` | `errors` |

Each toggles the corresponding element's override (see [filter-state-spec.md](filter-state-spec.md)). Emits an in-pane status toast on toggle.

## Preset cycling

| Keybind | Action |
|---|---|
| `Alt+0` | Cycle preset forward: `quiet → normal → verbose → debug → quiet` |
| `Alt+9` | Cycle preset backward |

Cycling **clears all overrides** — the new preset starts clean.

## Other

| Keybind | Action |
|---|---|
| `Ctrl+C` | SIGINT to claude; second within 1s → exit renderer cleanly |
| `Ctrl+D` (on empty input line) | Close stdin to claude, wait for exit, then exit renderer |
| `Ctrl+L` | Force full repaint (debugging convenience) |

Typed text + Enter → forwarded to claude as a user turn. Slashes are forwarded transparently — claude handles its own slash commands.

## Implementation pattern

Ink's `useInput` surfaces `meta: true, ctrl: false` for `Alt+digit` (terminal-dependent encoding):

```ts
useInput((input, key) => {
  if (key.meta && /^[0-9]$/.test(input)) {
    const digit = Number(input);
    if (digit >= 1 && digit <= 8) toggleElement(digit);
    else if (digit === 0) cyclePreset(+1);
    else if (digit === 9) cyclePreset(-1);
    return;
  }
});
```

## Terminal caveats

- **macOS Terminal.app** — needs "Use Option as Meta key" enabled in Settings → Profiles → Keyboard. Without it, `Alt+digit` inserts a Unicode character instead of emitting an escape sequence.
- **tmux** — `bind-key -n M-1` window-switching collides with `Alt+1`. Either disable the tmux binding inside the renderer's session or remap.
- **kitty / iTerm2 / Ghostty** — work out of the box.

The renderer detects terminal type at startup and surfaces a status line if it appears to be one of the known-broken configurations.

## Fallback (post-v0)

`:` (colon) enters command-line mode for explicit `:toggle Bash.output`, `:preset verbose`, etc. — for terminals where Alt+digit can't be made to work.

## Status surface

Bottom status line displays:

- Current preset (`normal`)
- Override count (`2 overrides` if any)
- Momentary toast on toggle (~2s, then fades)
