import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ErrorRenderer } from "./ErrorRenderer.tsx";

describe("ErrorRenderer", () => {
  test("renders error text with red styling (ANSI escape present)", () => {
    const { lastFrame } = render(<ErrorRenderer message="boom: file not found" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("boom: file not found");
    // CSI escape opens with ESC[ (\x1B[). Confirm color/bold escapes present.
    expect(frame).toMatch(/\x1B\[/);
  });

  test("renders multi-line errors", () => {
    const { lastFrame } = render(<ErrorRenderer message={"line one\nline two"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
  });

  test("includes optional label prefix", () => {
    const { lastFrame } = render(<ErrorRenderer message="bad" label="Bash" />);
    expect(lastFrame() ?? "").toContain("Bash");
  });
});
