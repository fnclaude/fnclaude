import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ReadContent } from "./ReadContent.tsx";

const bigFile = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");

describe("ReadContent", () => {
  test("show: full content", () => {
    const { lastFrame } = render(<ReadContent filePath="/x" content={bigFile} visibility="show" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line1");
    expect(frame).toContain("line50");
  });

  test("hide: empty", () => {
    const { lastFrame } = render(<ReadContent filePath="/x" content={bigFile} visibility="hide" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  test("summary: file path + line count, no content", () => {
    const { lastFrame } = render(
      <ReadContent filePath="/etc/hosts" content={bigFile} visibility="summary" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/etc/hosts");
    expect(frame).toMatch(/50 lines/);
    expect(frame).not.toContain("line1\nline2");
  });

  test("dim: full content with dim styling", () => {
    const { lastFrame } = render(<ReadContent filePath="/x" content="hello" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary differ", () => {
    const p = { filePath: "/x", content: bigFile };
    const a = render(<ReadContent {...p} visibility="show" />).lastFrame() ?? "";
    const b = render(<ReadContent {...p} visibility="hide" />).lastFrame() ?? "";
    const c = render(<ReadContent {...p} visibility="summary" />).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
