import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ResultEvent } from "../types/events.ts";
import { ResultRenderer } from "./ResultRenderer.tsx";

const baseEvent: ResultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "s1",
  uuid: "u1",
  result: "All good.",
  num_turns: 1,
  duration_ms: 10,
  duration_api_ms: 5,
  total_cost_usd: 0,
};

describe("ResultRenderer", () => {
  test("renders the result text", () => {
    const { lastFrame } = render(<ResultRenderer event={baseEvent} />);
    expect(lastFrame() ?? "").toContain("All good.");
  });

  test("detects 'Unknown command:' prefix and styles as a soft warning", () => {
    const ev: ResultEvent = { ...baseEvent, result: "Unknown command: /foo" };
    const { lastFrame } = render(<ResultRenderer event={ev} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Unknown command: /foo");
    // Yellow ANSI (CSI 33) for soft warning
    expect(frame).toMatch(/\x1B\[33m/);
  });

  test("non-Unknown result does NOT use yellow warning color", () => {
    const { lastFrame } = render(<ResultRenderer event={baseEvent} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/\x1B\[33m/);
  });

  test("is_error: delegates to error styling (red)", () => {
    const ev: ResultEvent = {
      ...baseEvent,
      is_error: true,
      subtype: "error",
      result: "kaboom",
    };
    const { lastFrame } = render(<ResultRenderer event={ev} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("kaboom");
    expect(frame).toMatch(/\x1B\[31m/);
  });
});
