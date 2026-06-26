import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MarkdownRenderer } from "./MarkdownRenderer";

/**
 * The renderer walks marked's token tree, so every syntax character (`**`,
 * `#`, backticks, fence markers) is consumed into token metadata and must
 * NEVER reach a <Text>. Styling is asserted via the SGR escapes that
 * FORCE_COLOR=1 (test/preload.ts) makes chalk emit.
 */
describe("MarkdownRenderer", () => {
  test("bold: renders the word, emits the bold SGR, drops the asterisks", () => {
    const { lastFrame } = render(<MarkdownRenderer text="**hi**" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).not.toContain("**");
    expect(frame).toMatch(/\x1B\[1m/);
  });

  test("emphasis: renders the word, emits the italic SGR, drops the asterisks", () => {
    const { lastFrame } = render(<MarkdownRenderer text="*hi*" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).not.toContain("*");
    expect(frame).toMatch(/\x1B\[3m/);
  });

  test("heading: renders the text without the leading #, emits bold", () => {
    const { lastFrame } = render(<MarkdownRenderer text="# Title" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Title");
    expect(frame).not.toContain("#");
    expect(frame).toMatch(/\x1B\[1m/);
  });

  test("codespan: renders the content without backticks", () => {
    const { lastFrame } = render(<MarkdownRenderer text="use `xyzzy` here" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("xyzzy");
    expect(frame).not.toContain("`");
  });

  test("fenced code block: renders the body without the fence markers", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"```js\nconst a = 1;\n```"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("const a = 1;");
    expect(frame).not.toContain("```");
  });

  test("unordered list: renders item text without the leading dash marker", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"- one\n- two"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).not.toContain("- one");
  });

  test("link: renders the link text and emits the underline SGR", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[click](https://example.com)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("click");
    expect(frame).toMatch(/\x1B\[4m/);
  });

  test("streaming/partial: unclosed bold does not leak a literal asterisk", () => {
    const { lastFrame } = render(<MarkdownRenderer text="**hi" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    expect(frame).not.toContain("*");
  });

  test("streaming/partial: unclosed fence does not leak the backtick markers", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"```js\nconst a = 1;"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("const a = 1;");
    expect(frame).not.toContain("```");
  });

  test("empty text produces empty output", () => {
    const { lastFrame } = render(<MarkdownRenderer text="" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
