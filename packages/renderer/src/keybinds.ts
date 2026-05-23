/**
 * Pure keybind dispatch. Maps `(input, key)` (the args Ink's `useInput`
 * passes) to a `KeybindAction`, or `null` when the input should fall
 * through to the App's text-input handling.
 *
 * Pure means: no React, no side effects, no Ink imports. The App owns the
 * effect — this module just decides which action a keystroke is.
 *
 * See docs/keybind-spec.md.
 */

import type { ElementId } from "./types/events.ts";

/**
 * Mirror of ink's `Key` shape, decoupled so the dispatch logic stays
 * Ink-free for direct unit testing. Anything passing a structurally-
 * matching object satisfies it.
 */
export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export type KeybindAction =
  | { kind: "toggleElement"; element: ElementId }
  | { kind: "cyclePreset"; direction: 1 | -1 }
  | { kind: "repaint" }
  | { kind: "closeStdin" }
  | { kind: "interrupt" };

/**
 * Element order matches `Alt+1` … `Alt+8` exactly (docs/keybind-spec.md).
 */
const ALT_DIGIT_ELEMENTS: Record<string, ElementId> = {
  "1": "thinking",
  "2": "Bash.input",
  "3": "Bash.output",
  "4": "Edit.diff",
  "5": "Read.content",
  "6": "Write.content",
  "7": "Task.nested",
  "8": "errors",
};

export function dispatchKey(input: string, key: Key): KeybindAction | null {
  // Alt + digit
  if (key.meta && /^[0-9]$/.test(input)) {
    if (input === "0") return { kind: "cyclePreset", direction: 1 };
    if (input === "9") return { kind: "cyclePreset", direction: -1 };
    const element = ALT_DIGIT_ELEMENTS[input];
    if (element !== undefined) return { kind: "toggleElement", element };
    return null;
  }

  // Ctrl combos
  if (key.ctrl && !key.meta) {
    if (input === "l") return { kind: "repaint" };
    if (input === "d") return { kind: "closeStdin" };
    if (input === "c") return { kind: "interrupt" };
  }

  return null;
}
