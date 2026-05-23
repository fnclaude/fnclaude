import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ReadInput } from "./ReadInput.tsx";

describe("ReadInput", () => {
  test("renders path being read", () => {
    const { lastFrame } = render(<ReadInput filePath="/etc/hosts" />);
    expect(lastFrame() ?? "").toContain("/etc/hosts");
  });

  test("includes line range when offset/limit present", () => {
    const { lastFrame } = render(<ReadInput filePath="/etc/hosts" offset={10} limit={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/etc/hosts");
    expect(frame).toMatch(/10/);
    expect(frame).toMatch(/20/);
  });
});
