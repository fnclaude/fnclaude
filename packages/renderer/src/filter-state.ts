/**
 * Filter state reducer + utilities.
 *
 * See docs/filter-state-spec.md for the table of preset defaults and the
 * toggle semantics. Pure functions; no React. Callers in App.tsx hold the
 * state in a useState/useReducer.
 */

import type { ElementId, FilterState, Preset, Visibility } from "./types/events.ts";

/**
 * Preset defaults table. Mirror of the table in docs/filter-state-spec.md.
 * Source of truth for `resolve()` when no per-element override is set.
 */
const PRESET_DEFAULTS: Record<Preset, Record<ElementId, Visibility>> = {
  quiet: {
    thinking: "hide",
    "Bash.input": "summary",
    "Bash.output": "hide",
    "Edit.diff": "summary",
    "Read.content": "hide",
    "Write.content": "summary",
    "Task.nested": "summary",
    errors: "show",
  },
  normal: {
    thinking: "dim",
    "Bash.input": "show",
    "Bash.output": "hide",
    "Edit.diff": "show",
    "Read.content": "hide",
    "Write.content": "summary",
    "Task.nested": "summary",
    errors: "show",
  },
  verbose: {
    thinking: "dim",
    "Bash.input": "show",
    "Bash.output": "show",
    "Edit.diff": "show",
    "Read.content": "summary",
    "Write.content": "show",
    "Task.nested": "show",
    errors: "show",
  },
  debug: {
    thinking: "show",
    "Bash.input": "show",
    "Bash.output": "show",
    "Edit.diff": "show",
    "Read.content": "show",
    "Write.content": "show",
    "Task.nested": "show",
    errors: "show",
  },
};

const PRESET_CYCLE: Preset[] = ["quiet", "normal", "verbose", "debug"];

export function defaultState(): FilterState {
  return { preset: "normal", overrides: {} };
}

export function resolve(element: ElementId, state: FilterState): Visibility {
  const override = state.overrides[element];
  if (override !== undefined) return override;
  return PRESET_DEFAULTS[state.preset][element];
}

/**
 * Visibility "polarity": dim/show/summary are all "shown to the user in some
 * form" — toggling away from any of them sets `hide`. Toggling from `hide`
 * sets `show`. This is the "opposite of preset" rule from the spec.
 */
function oppositeOf(v: Visibility): Visibility {
  return v === "hide" ? "show" : "hide";
}

export function toggleElement(state: FilterState, element: ElementId): FilterState {
  const nextOverrides = { ...state.overrides };
  if (state.overrides[element] !== undefined) {
    // Existing override → clear it (revert to preset default).
    delete nextOverrides[element];
  } else {
    // No override → set opposite-of-preset.
    const presetDefault = PRESET_DEFAULTS[state.preset][element];
    nextOverrides[element] = oppositeOf(presetDefault);
  }
  return { preset: state.preset, overrides: nextOverrides };
}

export function cyclePreset(state: FilterState, direction: 1 | -1): FilterState {
  const i = PRESET_CYCLE.indexOf(state.preset);
  const len = PRESET_CYCLE.length;
  const nextIdx = (i + direction + len) % len;
  const nextPreset = PRESET_CYCLE[nextIdx];
  // Type-narrow: nextIdx is in [0, len-1], so PRESET_CYCLE[nextIdx] is defined.
  // noUncheckedIndexedAccess requires the guard.
  if (nextPreset === undefined) {
    throw new Error(`cyclePreset: invalid index ${nextIdx}`);
  }
  return { preset: nextPreset, overrides: {} };
}

/**
 * Count of currently-active overrides, for the status line.
 */
export function overrideCount(state: FilterState): number {
  return Object.keys(state.overrides).length;
}
