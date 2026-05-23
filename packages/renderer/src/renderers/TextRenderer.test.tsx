import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TextRenderer } from "./TextRenderer.tsx";

const md = "# Heading\n\nSome *italic* text.";

describe("TextRenderer", () => {
  test("glow=null: renders raw markdown unchanged", () => {
    const { lastFrame } = render(<TextRenderer text={md} glow={null} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("# Heading");
    expect(frame).toContain("Some *italic* text.");
  });

  test("glow injected: output differs from raw markdown path", () => {
    const fakeGlow = (input: string) => `<<RENDERED:${input}>>`;
    const plain = render(<TextRenderer text={md} glow={null} />).lastFrame() ?? "";
    const glowed = render(<TextRenderer text={md} glow={fakeGlow} />).lastFrame() ?? "";
    expect(plain).not.toBe(glowed);
    expect(glowed).toContain("<<RENDERED:");
    expect(glowed).toContain("# Heading"); // the input gets embedded
  });

  test("glow output containing ANSI escapes is passed through", () => {
    const ansiGlow = (_input: string) => "\x1B[1mBOLD\x1B[0m text";
    const { lastFrame } = render(<TextRenderer text="anything" glow={ansiGlow} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("BOLD");
    // ANSI escape opening sequence should survive
    expect(frame).toMatch(/\x1B\[/);
  });

  test("empty text produces empty output", () => {
    const { lastFrame } = render(<TextRenderer text="" glow={null} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
