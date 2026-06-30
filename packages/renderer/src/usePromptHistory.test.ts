/**
 * Unit tests for the prompt-history store extracted from App.tsx (issue #296
 * finding 3). These exercise the framework-free core (`createPromptHistory` +
 * `seedFromEvents`) directly — no Ink, no React renderer — so the recall logic
 * is testable in isolation. The App.history.test.tsx integration tests remain
 * the end-to-end safety net.
 */
import { describe, expect, test } from "bun:test";
import type { ClaudeEvent } from "./types/events.ts";
import { createPromptHistory, seedFromEvents } from "./usePromptHistory.ts";

describe("createPromptHistory", () => {
  test("recallPrev with empty history returns null (no change)", () => {
    const h = createPromptHistory([]);
    expect(h.recallPrev("draft")).toBeNull();
  });

  test("recallPrev walks newest→oldest", () => {
    const h = createPromptHistory(["alpha", "beta"]);
    expect(h.recallPrev("")).toBe("beta");
    expect(h.recallPrev("")).toBe("alpha");
    // already at the oldest — no further change.
    expect(h.recallPrev("")).toBeNull();
  });

  test("recallNext past the newest restores the stashed in-progress draft", () => {
    const h = createPromptHistory(["alpha"]);
    expect(h.recallPrev("wip")).toBe("alpha"); // stashes "wip"
    expect(h.recallNext()).toBe("wip"); // back past newest → stash
  });

  test("recallNext on the live draft returns null", () => {
    const h = createPromptHistory(["alpha"]);
    expect(h.recallNext()).toBeNull();
  });

  test("recallNext walks oldest→newest after recallPrev", () => {
    const h = createPromptHistory(["alpha", "beta"]);
    h.recallPrev(""); // beta
    h.recallPrev(""); // alpha
    expect(h.recallNext()).toBe("beta");
  });

  test("record appends and resets navigation to the live end", () => {
    const h = createPromptHistory(["alpha"]);
    h.recallPrev("stashme"); // enter history, stash "stashme"
    h.record("gamma");
    // After record, Down is a no-op (on the live draft) and the stash is cleared.
    expect(h.recallNext()).toBeNull();
    // Up now starts from the just-recorded newest.
    expect(h.recallPrev("")).toBe("gamma");
  });

  test("recordeded prompts are recallable in order", () => {
    const h = createPromptHistory([]);
    h.record("one");
    h.record("two");
    expect(h.recallPrev("")).toBe("two");
    expect(h.recallPrev("")).toBe("one");
  });
});

describe("seedFromEvents", () => {
  test("extracts user_prompt text in order, ignoring other events", () => {
    const events: ClaudeEvent[] = [
      { type: "user_prompt", text: "first" },
      {
        type: "assistant",
        session_id: "s",
        uuid: "u",
        message: { model: "m", role: "assistant", content: [] },
      },
      { type: "user_prompt", text: "second" },
    ];
    expect(seedFromEvents(events)).toEqual(["first", "second"]);
  });

  test("empty for no user_prompt events", () => {
    expect(seedFromEvents([])).toEqual([]);
  });
});
