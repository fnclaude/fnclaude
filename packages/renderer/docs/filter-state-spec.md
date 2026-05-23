# Filter state — visibility presets, per-element overrides, repaint semantics

## Concept

Every event passes through a filter function:

```ts
filter(event, state): "show" | "hide" | "summary" | "dim"
```

State has two parts:

- **Preset** — `quiet | normal | verbose | debug`. Sets default visibility per element.
- **Per-element overrides** — explicit `show | hide | summary | dim` for specific elements, taking precedence over the preset.

Toggling an element flips its override: no override → set the opposite of the preset default; existing override → clear it (revert to preset).

## Element list (Alt+1–8 order)

1. `thinking` — thinking content blocks
2. `Bash.input` — `tool_use` of `Bash`, the command field
3. `Bash.output` — `tool_result` for `Bash`
4. `Edit.diff` — `tool_use` of `Edit`, the diff body
5. `Read.content` — `tool_result` for `Read` (large file content)
6. `Write.content` — `tool_use` of `Write`, the content field
7. `Task.nested` — `tool_use` of `Task`, the subagent prompt
8. `errors` — blocks with `is_error: true` and result events with `is_error: true`

**Always-shown content** (not filterable): assistant text, tool-call headers, result events' `result` text.

## Preset defaults

| Element | quiet | normal | verbose | debug |
|---|---|---|---|---|
| thinking | hide | dim | dim | show |
| Bash.input | summary | show | show | show |
| Bash.output | hide | hide | show | show |
| Edit.diff | summary | show | show | show |
| Read.content | hide | hide | summary | show |
| Write.content | summary | summary | show | show |
| Task.nested | summary | summary | show | show |
| errors | show | show | show | show |

## Visibility levels

- `show` — render in full
- `hide` — render nothing (one-line `▸ <ToolName>: <summary>` header still visible for `tool_use`)
- `summary` — first 5 lines + `(… N more lines)` indicator
- `dim` — full content but ANSI-faint (especially for thinking blocks)

## Repaint mechanism

Filter applies at **render time**, not receive time. The renderer maintains an in-memory event log (all received events). On filter state change:

1. Compute the new filter from the updated state.
2. Re-render the entire transcript view from the log through the new filter.
3. Ink's reconciler handles the screen diff.

Toggling shows or hides past content — repaint without re-execution. The event log must persist across toggles for the lifetime of the session.

## Initial state

`{ preset: "normal", overrides: {} }`. Overridable later via CLI flag (`--verbosity verbose`, `--show Bash.output`) and a config file. CLI/config support is post-v0.

## TypeScript shape

See `src/types/events.ts`:

```ts
type FilterState = {
  preset: Preset;
  overrides: Partial<Record<ElementId, Visibility>>;
};
```

`resolve(element, state): Visibility` checks `overrides` first, falls back to the preset default.

## Summary semantics

Slice C's per-element components decide what `summary` means per element:

- `Bash.output` — first 5 lines + `(… N lines hidden)`
- `Edit.diff` — file path + line count of change
- `Write.content` — file path + line count of new content
- `Read.content` — file path + line count of file
- `Task.nested` — first line of subagent prompt + line count
- `thinking` — first sentence + `(thinking continues)`

Each element-renderer accepts `visibility: Visibility` and renders accordingly.
