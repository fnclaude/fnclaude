import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { WriteContent } from "./WriteContent.tsx";

const body = Array.from({ length: 8 }, (_, i) => `body${i + 1}`).join("\n");

describe("WriteContent", () => {
  test("show: file path + full content", () => {
    const { lastFrame } = render(
      <WriteContent filePath="/tmp/out.txt" content={body} visibility="show" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/out.txt");
    expect(frame).toContain("body1");
    expect(frame).toContain("body8");
  });

  test("hide: header only, no content body", () => {
    const { lastFrame } = render(
      <WriteContent filePath="/tmp/out.txt" content={body} visibility="hide" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/out.txt");
    expect(frame).not.toContain("body1");
  });

  test("summary: file path + line count, no body", () => {
    const { lastFrame } = render(
      <WriteContent filePath="/tmp/out.txt" content={body} visibility="summary" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/out.txt");
    expect(frame).toMatch(/8 lines/);
    expect(frame).not.toContain("body1");
  });

  test("dim: full body with dim styling", () => {
    const { lastFrame } = render(<WriteContent filePath="/x" content="hi" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary differ", () => {
    const p = { filePath: "/x", content: body };
    const a = render(<WriteContent {...p} visibility="show" />).lastFrame() ?? "";
    const b = render(<WriteContent {...p} visibility="hide" />).lastFrame() ?? "";
    const c = render(<WriteContent {...p} visibility="summary" />).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
