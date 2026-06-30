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

import type { ElementId } from "./types/events";

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
  // Fields added by Ink 7's input parser. Optional here so existing
  // partial Key literals (tests) stay valid; App passes ink's real Key
  // via `key as unknown as Key`.
  home?: boolean;
  end?: boolean;
  super?: boolean;
  hyper?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  eventType?: "press" | "repeat" | "release";
}

export type ScrollDelta = "lineUp" | "lineDown" | "pageUp" | "pageDown" | "top" | "bottom";

export type KeybindAction =
  | { kind: "toggleElement"; element: ElementId }
  | { kind: "cyclePreset"; direction: 1 | -1 }
  | { kind: "scroll"; delta: ScrollDelta }
  | { kind: "repaint" }
  | { kind: "closeStdin" }
  | { kind: "interrupt" }
  | { kind: "historyPrev" }
  | { kind: "historyNext" };

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

  // Alt + m → toggle the meta (system/rate-limit/session) noise group.
  // Digits 1-8 are taken and 9/0 cycle presets, so the noise group gets a
  // mnemonic letter bind instead of an out-of-range digit.
  if (key.meta && input === "m") {
    return { kind: "toggleElement", element: "meta" };
  }

  // Alt + u → toggle the per-turn token-usage one-liner (the "usage" POC).
  // Same letter-bind rationale as Alt+m: the digit table is full.
  if (key.meta && input === "u") {
    return { kind: "toggleElement", element: "token-burn" };
  }

  // Scroll the app-owned viewport. PageUp/PageDown page; Home/End jump to the
  // top/bottom. These are navigation keys, not text — they take precedence over
  // the draft input. Guarded behind no-modifier so Ctrl/Alt combos still pass.
  if (!key.ctrl && !key.meta) {
    if (key.pageUp) return { kind: "scroll", delta: "pageUp" };
    if (key.pageDown) return { kind: "scroll", delta: "pageDown" };
    if (key.home) return { kind: "scroll", delta: "top" };
    if (key.end) return { kind: "scroll", delta: "bottom" };
    // Up/Down walk the submitted-prompt history into the draft (shell-style
    // recall). Guarded with the navigation keys above so Ctrl+Up / Alt+Up still
    // fall through to null.
    if (key.upArrow) return { kind: "historyPrev" };
    if (key.downArrow) return { kind: "historyNext" };
  }

  // Ctrl combos
  if (key.ctrl && !key.meta) {
    if (input === "l") return { kind: "repaint" };
    if (input === "d") return { kind: "closeStdin" };
    if (input === "c") return { kind: "interrupt" };
  }

  return null;
}
