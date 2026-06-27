import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MarkdownRenderer } from "./MarkdownRenderer";

/** Strip ANSI SGR escape sequences for plain-text content assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

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
    // Syntax highlighting interleaves ANSI codes; strip them for the content check.
    expect(stripAnsi(frame)).toContain("const a = 1;");
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
    // Syntax highlighting interleaves ANSI codes; strip them for the content check.
    expect(stripAnsi(frame)).toContain("const a = 1;");
    expect(frame).not.toContain("```");
  });

  test("empty text produces empty output", () => {
    const { lastFrame } = render(<MarkdownRenderer text="" />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  // -------------------------------------------------------------------------
  // CodeBlock wiring
  // -------------------------------------------------------------------------

  test("code: fenced python block — syntax-highlighted via CodeBlock (blue SGR for keywords)", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"```python\ndef add(a, b): return a+b\n```"} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("add");
    expect(frame).not.toContain("```");
    // cli-highlight colors `def` / `return` keywords with blue (\x1B[34m).
    // The current inline <Text color="green"> only emits \x1B[32m (green).
    expect(frame).toMatch(/\x1B\[34m/);
  });

  // -------------------------------------------------------------------------
  // TableBlock wiring
  // -------------------------------------------------------------------------

  test("table: renders header + body cells and box-drawing borders via TableBlock", () => {
    const { lastFrame } = render(
      <MarkdownRenderer text={"| Name | Score |\n|---|---|\n| Alice | 42 |"} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Name");
    expect(frame).toContain("Score");
    expect(frame).toContain("Alice");
    expect(frame).toContain("42");
    expect(frame).not.toContain("|"); // raw pipe must not appear (uses │ box-drawing)
    expect(frame).toMatch(/[┌┬┐├┼┤└┴┘]/); // box-drawing top/sep/bot borders
  });

  // -------------------------------------------------------------------------
  // AlertBlock wiring
  // -------------------------------------------------------------------------

  test("blockquote: GitHub [!NOTE] alert renders the 'Note' label and body via AlertBlock", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"> [!NOTE]\n> pay attention"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Note");
    expect(frame).toContain("pay attention");
    expect(frame).not.toContain("[!NOTE]");
  });

  test("blockquote: plain (non-alert) blockquote still renders its body text", () => {
    const { lastFrame } = render(<MarkdownRenderer text="> just a quote" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("just a quote");
  });

  // -------------------------------------------------------------------------
  // Heading differentiation
  // -------------------------------------------------------------------------

  test("heading: H1 has underline SGR (\\x1B[4m)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="# Heading One" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Heading One");
    expect(frame).not.toContain("#");
    expect(frame).toMatch(/\x1B\[4m/); // underline
  });

  test("heading: H3 does NOT have underline SGR and is visually distinct from H1", () => {
    const h1Frame = render(<MarkdownRenderer text="# H1" />).lastFrame() ?? "";
    const h3Frame = render(<MarkdownRenderer text="### H3" />).lastFrame() ?? "";
    // H3 must not carry the same underline attribute as H1
    expect(h3Frame).not.toMatch(/\x1B\[4m/);
    // The two frames must not be identical (they are styled differently)
    expect(h1Frame).not.toBe(h3Frame);
  });

  test("heading: no '#' characters appear in any heading level", () => {
    for (const md of ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6"]) {
      const frame = render(<MarkdownRenderer text={md} />).lastFrame() ?? "";
      expect(frame).not.toContain("#");
    }
  });

  // -------------------------------------------------------------------------
  // Task-list checkboxes
  // -------------------------------------------------------------------------

  test("task list: checked item renders ☑, unchecked renders ☐, no literal [x]/[ ]", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"- [x] done\n- [ ] todo"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("☑");
    expect(frame).toContain("☐");
    expect(frame).toContain("done");
    expect(frame).toContain("todo");
    expect(frame).not.toContain("[x]");
    expect(frame).not.toContain("[ ]");
  });

  // -------------------------------------------------------------------------
  // HTML entity decoding
  // -------------------------------------------------------------------------

  test("entities: &copy; &mdash; &rarr; &hearts; decode to © — → ♥", () => {
    // Use a JS string variable so JSX-attribute entity-decoding (which the bun
    // compiler applies at compile-time) doesn't short-circuit the test. We need
    // the raw entity strings to reach MarkdownRenderer's inline renderer.
    const entityText = ["&copy;", "&mdash;", "&rarr;", "&hearts;"].join(" ");
    const { lastFrame } = render(<MarkdownRenderer text={entityText} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("©");
    expect(frame).toContain("—");
    expect(frame).toContain("→");
    expect(frame).toContain("♥");
    expect(frame).not.toContain("&copy;");
    expect(frame).not.toContain("&mdash;");
    expect(frame).not.toContain("&rarr;");
    expect(frame).not.toContain("&hearts;");
  });

  // -------------------------------------------------------------------------
  // Link clickability (OSC 8 hyperlinks)
  // -------------------------------------------------------------------------

  test("link: http href — emits OSC 8 hyperlink escape and blue+underline styling", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[click](https://example.com)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("click");
    expect(frame).toContain("\x1b]8;;https://example.com\x07"); // OSC 8 open
    expect(frame).toContain("\x1b]8;;\x07"); // OSC 8 close
    expect(frame).toMatch(/\x1B\[4m/); // underline SGR
  });

  test("link: anchor href (#section) — renders text plain, no underline, no OSC 8", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[section](#section)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("section");
    expect(frame).not.toMatch(/\x1B\[4m/); // no underline
    expect(frame).not.toContain("\x1b]8;;"); // no OSC 8
  });
});
