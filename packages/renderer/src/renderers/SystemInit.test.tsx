import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SystemEvent } from "../types/events.ts";
import { SystemInit } from "./SystemInit.tsx";

const baseEvent: SystemEvent = {
  type: "system",
  subtype: "init",
  session_id: "sess-abc123",
  uuid: "u-1",
  cwd: "/home/user/proj",
  model: "claude-sonnet-4",
};

describe("SystemInit", () => {
  test("renders session_id, cwd, model on one line", () => {
    const { lastFrame } = render(<SystemInit event={baseEvent} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("sess-abc123");
    expect(frame).toContain("/home/user/proj");
    expect(frame).toContain("claude-sonnet-4");
    // single line (no embedded newlines other than trailing)
    const lines = frame.trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("tolerates missing optional fields", () => {
    const { lastFrame } = render(
      <SystemInit event={{ type: "system", subtype: "init", session_id: "s1", uuid: "u1" }} />,
    );
    expect(lastFrame() ?? "").toContain("s1");
  });
});
