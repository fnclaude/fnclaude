import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TextRenderer } from "./TextRenderer";

describe("TextRenderer", () => {
  test("delegates to the native markdown renderer: bold, no literal markup", () => {
    const { lastFrame } = render(<TextRenderer text="**hi**" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).not.toContain("**");
    expect(frame).toMatch(/\x1B\[1m/);
  });

  test("heading renders without the leading #", () => {
    const { lastFrame } = render(<TextRenderer text="# Heading" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Heading");
    expect(frame).not.toContain("#");
  });

  test("empty text produces empty output", () => {
    const { lastFrame } = render(<TextRenderer text="" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
