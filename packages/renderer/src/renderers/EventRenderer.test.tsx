/**
 * Tests for the per-event render dispatch extracted from App.tsx (issue #296
 * findings 3, 4, 5). Two things under test:
 *
 *  - renderEventNode maps each committed ClaudeEvent to the right renderer.
 *  - The dispatch is an EXHAUSTIVE switch (finding 4): an off-union payload
 *    still surfaces as RawJson rather than throwing or being silently dropped,
 *    and the meta visibility gate (finding 5) hides init/system/rate-limit
 *    events as one rule.
 *
 * The compile-time guarantee (a new ClaudeEvent variant becomes a type error in
 * the switch) is enforced by `tsc`; this suite covers the runtime contract.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type {
  AssistantEvent,
  ClaudeEvent,
  ElementId,
  RateLimitEvent,
  SystemEvent,
  Visibility,
} from "../types/events.ts";
import { renderEventNode } from "./EventRenderer.tsx";

const showAll = (_id: ElementId): Visibility => "show";
const hideMeta = (id: ElementId): Visibility => (id === "meta" ? "hide" : "show");

function frameOf(node: React.ReactNode): string {
  const { lastFrame } = render(<>{node}</>);
  return lastFrame() ?? "";
}

const ctx = (visibilityFor: (id: ElementId) => Visibility) => ({
  visibilityFor,
  toolCallById: new Map(),
  lastAssistantText: null as string | null,
});

describe("renderEventNode dispatch", () => {
  test("assistant text renders through markdown", () => {
    const event: AssistantEvent = {
      type: "assistant",
      session_id: "s",
      uuid: "u",
      message: {
        model: "m",
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
      },
    };
    expect(frameOf(renderEventNode(event, ctx(showAll)))).toContain("hello world");
  });

  test("user_prompt renders the prompt marker", () => {
    const event: ClaudeEvent = { type: "user_prompt", text: "my question" };
    expect(frameOf(renderEventNode(event, ctx(showAll)))).toContain("my question");
  });

  test("parse_error surfaces the raw line", () => {
    const event: ClaudeEvent = { type: "parse_error", raw: "{bad json" };
    expect(frameOf(renderEventNode(event, ctx(showAll)))).toContain("{bad json");
  });

  test("an off-union payload surfaces as RawJson, not a throw (exhaustive default)", () => {
    // Simulate a wire event whose `type` is not in the modeled union. The
    // exhaustive switch's default must still render it (finding 4: never drop).
    const rogue = { type: "totally_new_event", payload: 42 } as unknown as ClaudeEvent;
    const frame = frameOf(renderEventNode(rogue, ctx(showAll)));
    expect(frame).toContain("totally_new_event");
  });
});

describe("meta visibility gate (finding 5)", () => {
  const systemInit: SystemEvent = {
    type: "system",
    subtype: "init",
    session_id: "s",
    uuid: "u",
  };
  const rateLimit: RateLimitEvent = {
    type: "rate_limit_event",
    rate_limit_info: { remaining: 7 },
  };

  test("system init renders nothing when meta is hidden", () => {
    expect(frameOf(renderEventNode(systemInit, ctx(hideMeta)))).toBe("");
  });

  test("system init renders when meta is shown", () => {
    expect(frameOf(renderEventNode(systemInit, ctx(showAll)))).not.toBe("");
  });

  test("rate_limit renders nothing when meta is hidden", () => {
    expect(frameOf(renderEventNode(rateLimit, ctx(hideMeta)))).toBe("");
  });

  test("rate_limit renders when meta is shown", () => {
    expect(frameOf(renderEventNode(rateLimit, ctx(showAll)))).toContain("remaining");
  });
});
