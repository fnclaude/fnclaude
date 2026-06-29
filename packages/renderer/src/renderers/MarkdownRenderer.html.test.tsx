import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { KBD_ALPHA, KBD_MODIFIER } from "./kbd-glyphs";
import { setHyperlinkSupportOverride } from "./osc8";

/** Strip ANSI SGR escape sequences for plain-text content assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Raw/inline HTML handling. `marked` emits inline HTML as a split open/text/
 * close token stream, so the renderer groups it back into styled spans. Tags
 * with a terminal analog are INTERPRETED; everything else is surfaced as
 * colored literal markup rather than silently dropped.
 */
describe("MarkdownRenderer — inline HTML subset", () => {
  test("<br>: interpreted as a newline, no literal tag", () => {
    const { lastFrame } = render(<MarkdownRenderer text="line<br>break" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line");
    expect(frame).toContain("break");
    expect(frame).not.toContain("<br>");
  });

  test("<hr>: interpreted as a horizontal rule, no literal tag", () => {
    const { lastFrame } = render(<MarkdownRenderer text="<hr>" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("─");
    expect(frame).not.toContain("<hr>");
  });

  test("<kbd>Ctrl+C</kbd>: one NerdFont glyph per recognized key", () => {
    const { lastFrame } = render(<MarkdownRenderer text="<kbd>Ctrl+C</kbd>" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(KBD_MODIFIER.control);
    expect(frame).toContain(KBD_ALPHA.c);
    expect(frame).not.toContain("<kbd>");
    expect(frame).not.toContain("Ctrl");
  });

  test("<kbd>: separate kbd elements each map to a glyph", () => {
    const { lastFrame } = render(<MarkdownRenderer text="Press <kbd>Ctrl</kbd>+<kbd>C</kbd>" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(KBD_MODIFIER.control);
    expect(frame).toContain(KBD_ALPHA.c);
    expect(frame).not.toContain("<kbd>");
  });

  test("<kbd>: unknown key renders its literal text in the kbd style, no crash", () => {
    const { lastFrame } = render(<MarkdownRenderer text="<kbd>Frobnicate</kbd>" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Frobnicate");
    expect(frame).not.toContain("<kbd>");
  });

  test("<mark>: interpreted as a highlight (inverse-video SGR)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="a <mark>hi</mark> b" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).not.toContain("<mark>");
    expect(frame).toMatch(/\x1B\[7m/); // inverse video
  });

  test("<sub>: ASCII underscore prefix (H<sub>2</sub>O → H_2O)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="H<sub>2</sub>O" />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("H_2O");
    expect(frame).not.toContain("<sub>");
  });

  test("<sup>: ASCII caret prefix (x<sup>2</sup> → x^2)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="x<sup>2</sup>" />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("x^2");
    expect(frame).not.toContain("<sup>");
  });

  test("<strong>: styled raw tag maps to the bold inline style", () => {
    const { lastFrame } = render(<MarkdownRenderer text="a <strong>bold</strong> b" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bold");
    expect(frame).not.toContain("<strong>");
    expect(frame).toMatch(/\x1B\[1m/); // bold
  });

  test("raw <a href>: emits OSC 8 hyperlink when support is ON", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = render(
      <MarkdownRenderer text={'see <a href="https://x.com">site</a> end'} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\x1b]8;;https://x.com\x07");
    expect(frame).toContain("site");
    expect(frame).not.toContain("<a href");
  });

  test("unknown tag <Foo>: colored literal raw markup, never dropped", () => {
    const { lastFrame } = render(<MarkdownRenderer text="raw <Foo>thing</Foo> tag" />);
    const frame = lastFrame() ?? "";
    const plain = stripAnsi(frame);
    expect(plain).toContain("<Foo>");
    expect(plain).toContain("</Foo>");
    expect(plain).toContain("thing");
    expect(plain).toContain("tag");
    expect(frame).toMatch(/\x1B\[35m/); // magenta — distinct raw-markup color
  });

  test("block-level raw HTML (<div>): colored literal, not dropped", () => {
    const { lastFrame } = render(<MarkdownRenderer text="<div>block</div>" />);
    const plain = stripAnsi(lastFrame() ?? "");
    expect(plain).toContain("<div>");
    expect(plain).toContain("block");
  });

  describe("OSC 8 off", () => {
    afterEach(() => setHyperlinkSupportOverride(undefined));
    test("raw <a href>: no OSC 8 bytes when support is OFF, still blue+underline", () => {
      setHyperlinkSupportOverride(false);
      const { lastFrame } = render(<MarkdownRenderer text={'<a href="https://x.com">site</a>'} />);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("site");
      expect(frame).not.toContain("\x1b]8");
      expect(frame).toMatch(/\x1B\[34m/); // blue
    });
  });
});
