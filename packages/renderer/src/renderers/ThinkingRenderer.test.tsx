import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ThinkingRenderer } from "./ThinkingRenderer.tsx";

const longThought =
  "This is the first sentence. And here is the second sentence which keeps going. " +
  "Third sentence. Fourth. Fifth. Sixth. Seventh. Eighth.";

describe("ThinkingRenderer", () => {
  test("show: full content with dim styling", () => {
    const { lastFrame } = render(<ThinkingRenderer thinking={longThought} visibility="show" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first sentence");
    expect(frame).toContain("Eighth");
    // Dim ANSI (CSI 2) should be present
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("hide: renders nothing visible", () => {
    const { lastFrame } = render(<ThinkingRenderer thinking={longThought} visibility="hide" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("summary: first sentence + (thinking continues)", () => {
    const { lastFrame } = render(<ThinkingRenderer thinking={longThought} visibility="summary" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This is the first sentence.");
    expect(frame).toContain("thinking continues");
    expect(frame).not.toContain("Eighth");
  });

  test("dim: full content (with dim escape)", () => {
    const { lastFrame } = render(<ThinkingRenderer thinking="short thought" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("short thought");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("summary with single short sentence keeps it whole, no continuation marker", () => {
    const { lastFrame } = render(<ThinkingRenderer thinking="Just one." visibility="summary" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Just one.");
    expect(frame).not.toContain("thinking continues");
  });
});
