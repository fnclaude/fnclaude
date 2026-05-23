import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { BashOutput } from "./BashOutput.tsx";

const longOutput = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");

describe("BashOutput", () => {
  test("show: full output rendered", () => {
    const { lastFrame } = render(<BashOutput content={longOutput} visibility="show" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line1");
    expect(frame).toContain("line12");
  });

  test("hide: empty", () => {
    const { lastFrame } = render(<BashOutput content={longOutput} visibility="hide" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("summary: first 5 lines + (N lines hidden)", () => {
    const { lastFrame } = render(<BashOutput content={longOutput} visibility="summary" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line1");
    expect(frame).toContain("line5");
    expect(frame).not.toContain("line6");
    expect(frame).toMatch(/7 lines hidden/);
  });

  test("dim: dim styling, full content", () => {
    const { lastFrame } = render(<BashOutput content="hello" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary differ", () => {
    const a = render(<BashOutput content={longOutput} visibility="show" />).lastFrame() ?? "";
    const b = render(<BashOutput content={longOutput} visibility="hide" />).lastFrame() ?? "";
    const c = render(<BashOutput content={longOutput} visibility="summary" />).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
