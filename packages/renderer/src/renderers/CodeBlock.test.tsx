import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { CodeBlock } from "./CodeBlock.tsx";

const pyCode = `def add(a, b):\n    return a + b`;

describe("CodeBlock", () => {
  test("renders code text inside a framed box", () => {
    const { lastFrame } = render(<CodeBlock code="hello world" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello world");
  });

  test("box uses round border characters", () => {
    const { lastFrame } = render(<CodeBlock code="x = 1" lang="python" />);
    const frame = lastFrame() ?? "";
    // Ink's round border uses ╭ or similar curved corners
    expect(frame).toMatch(/[╭╮╰╯]/);
  });

  test("with known lang: output contains ANSI escapes (syntax highlighting active)", () => {
    const { lastFrame } = render(<CodeBlock code={pyCode} lang="python" />);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/\x1B\[/);
    expect(frame).toContain("add");
  });

  test("without lang: code rendered as-is (no markup literals)", () => {
    const code = "just plain text";
    const { lastFrame } = render(<CodeBlock code={code} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(code);
    expect(frame).not.toContain("```");
    expect(frame).not.toContain("<code>");
  });

  test("does not render literal backticks or HTML tags", () => {
    const { lastFrame } = render(<CodeBlock code="fn foo() {}" lang="rust" />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("```");
    expect(frame).not.toContain("<pre>");
    expect(frame).not.toContain("</pre>");
  });
});
