/**
 * Shell-style prompt-history recall, extracted from App.tsx (issue #296 finding
 * 3) so the recall logic is unit-testable without mounting Ink.
 *
 * `createPromptHistory` is a framework-free store: Up recalls the previous
 * (older) prompt, repeated Up walks older; Down walks back toward the newest,
 * and Down past the newest restores the in-progress draft stashed when
 * navigation began. `usePromptHistory` is the thin React wrapper that seeds the
 * store once from any resumed `user_prompt` events and keeps it stable across
 * renders.
 */

import { useRef } from "react";
import type { ClaudeEvent } from "./types/events.ts";

export interface PromptHistory {
  /**
   * Recall the previous (older) prompt. Pass the current draft so it can be
   * stashed when navigation first enters the history. Returns the new draft
   * text, or `null` for no change (empty history, or already at the oldest).
   */
  recallPrev: (currentDraft: string) => string | null;
  /**
   * Recall the next (newer) prompt; past the newest, restore the stashed
   * in-progress draft. Returns the new draft text, or `null` when already on
   * the live draft (no change).
   */
  recallNext: () => string | null;
  /**
   * Record a submitted prompt and reset navigation to the live end: Up after a
   * submit starts from the newest, and a fresh Down (with no stash) restores an
   * empty draft rather than a stale stashed one.
   */
  record: (text: string) => void;
}

/**
 * Framework-free prompt-history store. `idx` is the cursor: `idx === length`
 * means "on the live draft, not browsing". `stash` holds the in-progress draft
 * captured when navigation begins so Down past the newest restores it.
 */
export function createPromptHistory(initial: string[]): PromptHistory {
  const history = [...initial];
  let idx = history.length;
  let stash = "";

  return {
    recallPrev(currentDraft) {
      if (history.length === 0) return null;
      if (idx >= history.length) {
        // entering history from the live draft — stash it so Down can restore it
        stash = currentDraft;
        idx = history.length;
      }
      if (idx > 0) {
        idx -= 1;
        return history[idx] ?? "";
      }
      return null;
    },
    recallNext() {
      if (idx >= history.length) return null; // already at the live draft
      idx += 1;
      return idx >= history.length ? stash : (history[idx] ?? "");
    },
    record(text) {
      history.push(text);
      idx = history.length;
      stash = "";
    },
  };
}

/** Seed the history from resumed `user_prompt` events, oldest→newest. */
export function seedFromEvents(events: ClaudeEvent[]): string[] {
  return events
    .filter((e): e is Extract<ClaudeEvent, { type: "user_prompt" }> => e.type === "user_prompt")
    .map((e) => e.text);
}

/**
 * React wrapper: builds the store once (seeded from `initialEvents`) and returns
 * the same instance across renders. The store holds its own mutable cursor, so
 * App no longer needs the four history refs.
 */
export function usePromptHistory(initialEvents?: ClaudeEvent[]): PromptHistory {
  const ref = useRef<PromptHistory | null>(null);
  if (ref.current === null) {
    ref.current = createPromptHistory(seedFromEvents(initialEvents ?? []));
  }
  return ref.current;
}
