import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { setHyperlinkSupportOverride } from "./osc8";

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

  test("table: styled-cell rows stay column-aligned with header (width from rendered tokens)", () => {
    const md = [
      "| Left | Center | Right |",
      "| :--- | :----: | ----: |",
      "| a | b | c |",
      "| `x` | **y** | ~~z~~ |",
    ].join("\n");
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const frame = stripAnsi(lastFrame() ?? "");

    // Both data rows present.
    for (const cell of ["a", "b", "c", "x", "y", "z"]) {
      expect(frame).toContain(cell);
    }
    // Box-drawing, not raw pipes.
    expect(frame).not.toContain("|");

    // Every table line must share one identical visible width. The bug measures
    // styled cells from raw cell.text (e.g. "`x`" len 3) but renders the stripped
    // token text ("x" len 1), so the styled row + bottom border come out shorter.
    const boxChars = /[┌┬┐├┼┤└┴┘│─]/;
    const tableLines = frame
      .split("\n")
      .filter((line) => boxChars.test(line))
      .map((line) => line.length);
    expect(tableLines.length).toBeGreaterThan(0);
    const widths = new Set(tableLines);
    expect(widths.size).toBe(1);
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
  // Link rendering (no OSC 8 — Ghostty's built-in URL matcher handles clicks)
  // -------------------------------------------------------------------------

  test("link: http href — blue+underline styled, NO OSC 8 escapes", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[click](https://example.com)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("click");
    expect(frame).toMatch(/\x1B\[4m/); // underline SGR present
    expect(frame).toMatch(/\x1B\[34m/); // blue SGR present
    expect(frame).not.toContain("\x1b]8;;"); // NO OSC 8 sequences
  });

  test("link: https href — blue+underline styled, NO OSC 8 escapes", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[go](http://example.org)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("go");
    expect(frame).toMatch(/\x1B\[4m/); // underline SGR present
    expect(frame).not.toContain("\x1b]8;;"); // NO OSC 8 sequences
  });

  test("link: mailto href — blue+underline styled, NO OSC 8 escapes", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[email](mailto:user@example.com)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("email");
    expect(frame).toMatch(/\x1B\[4m/); // underline SGR present
    expect(frame).not.toContain("\x1b]8;;"); // NO OSC 8 sequences
  });

  test("link: anchor href (#section) — renders text plain, no underline, no OSC 8", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[section](#section)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("section");
    expect(frame).not.toMatch(/\x1B\[4m/); // no underline
    expect(frame).not.toContain("\x1b]8;;"); // no OSC 8
  });

  test("link: relative path href — renders text plain, no underline, no OSC 8", () => {
    const { lastFrame } = render(<MarkdownRenderer text="[doc](./readme.md)" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("doc");
    expect(frame).not.toMatch(/\x1B\[4m/); // no underline
    expect(frame).not.toMatch(/\x1B\[34m/); // no blue
    expect(frame).not.toContain("\x1b]8;;"); // no OSC 8
  });

  test("link in table cell — no OSC 8 bytes leak into measured cell content", () => {
    const md = "| Link |\n|---|\n| [visit](https://example.com) |";
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("visit");
    expect(frame).not.toContain("8;;"); // OSC 8 URL bytes must not appear
  });

  // -------------------------------------------------------------------------
  // OSC 8 clickable hyperlinks (terminal supports them)
  // -------------------------------------------------------------------------

  describe("OSC 8 hyperlinks", () => {
    // Detection reads the (non-TTY) test stream and reports unsupported by
    // default; force it explicitly per test and restore after each.
    afterEach(() => setHyperlinkSupportOverride(undefined));

    test("hyperlinks ON: titled link emits BEL-form OSC 8 with the url and text", () => {
      setHyperlinkSupportOverride(true);
      const { lastFrame } = render(
        <MarkdownRenderer text="[the docs](https://example.com/page)" />,
      );
      const frame = lastFrame() ?? "";
      // Opener: ESC ] 8 ; ; <url> BEL — exact BEL terminator, not ESC-backslash.
      expect(frame).toContain("\x1b]8;;https://example.com/page\x07");
      // Closer: ESC ] 8 ; ; BEL.
      expect(frame).toContain("\x1b]8;;\x07");
      // The display text (not the url) is what's visible.
      expect(frame).toContain("the docs");
      // Still styled blue+underline.
      expect(frame).toMatch(/\x1B\[4m/);
      expect(frame).toMatch(/\x1B\[34m/);
      // No ESC-backslash (ST) terminator form — Ink only parses BEL.
      expect(frame).not.toContain("\x1b]8;;https://example.com/page\x1b\\");
    });

    test("hyperlinks ON: mailto link is wrapped in OSC 8", () => {
      setHyperlinkSupportOverride(true);
      const { lastFrame } = render(<MarkdownRenderer text="[mail me](mailto:a@b.com)" />);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("\x1b]8;;mailto:a@b.com\x07");
      expect(frame).toContain("mail me");
    });

    test("hyperlinks OFF: no OSC 8 bytes, falls back to blue+underline", () => {
      setHyperlinkSupportOverride(false);
      const { lastFrame } = render(<MarkdownRenderer text="[the docs](https://example.com)" />);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("the docs");
      expect(frame).not.toContain("\x1b]8"); // no OSC 8 at all
      expect(frame).toMatch(/\x1B\[4m/); // still underlined
      expect(frame).toMatch(/\x1B\[34m/); // still blue
    });

    test("hyperlinks ON: anchor/relative hrefs stay plain (no OSC 8)", () => {
      setHyperlinkSupportOverride(true);
      const anchor = render(<MarkdownRenderer text="[s](#section)" />).lastFrame() ?? "";
      const rel = render(<MarkdownRenderer text="[d](./readme.md)" />).lastFrame() ?? "";
      for (const frame of [anchor, rel]) {
        expect(frame).not.toContain("\x1b]8");
      }
    });

    // The three link render paths (markdown `link`, raw `<a href>`, GitHub
    // autolink) all flow through one `<Link>` component, so the underline
    // policy lives in exactly one place. The non-hyperlink branch is where the
    // autolink path had drifted — it dropped the underline the other two keep.
    // With OSC 8 OFF, every clickable path must still emit the underline SGR.
    test("hyperlinks OFF: markdown link, raw <a>, and autolink all underline", () => {
      setHyperlinkSupportOverride(false);
      const mdLink = render(<MarkdownRenderer text="[click](https://example.com)" />).lastFrame() ?? "";
      const rawAnchor =
        render(<MarkdownRenderer text={'<a href="https://x.com">site</a>'} />).lastFrame() ?? "";
      const autolink = render(<MarkdownRenderer text="thanks @octocat" />).lastFrame() ?? "";
      for (const frame of [mdLink, rawAnchor, autolink]) {
        expect(frame).toMatch(/\x1B\[4m/); // underline SGR present on every path
        expect(frame).toMatch(/\x1B\[34m/); // blue SGR present on every path
        expect(frame).not.toContain("\x1b]8"); // no OSC 8 when support is off
      }
    });

    test("hyperlinks ON: link inside a table cell keeps columns aligned", () => {
      setHyperlinkSupportOverride(true);
      const md = [
        "| Site | Note |",
        "|---|---|",
        "| [visit](https://example.com) | ok |",
        "| plain | yep |",
      ].join("\n");
      const { lastFrame } = render(<MarkdownRenderer text={md} />);
      const frame = lastFrame() ?? "";
      // OSC 8 is actually present (clickable) in the cell...
      expect(frame).toContain("\x1b]8;;https://example.com\x07");
      expect(frame).toContain("visit");
      // ...yet every bordered table line shares one identical visible width,
      // proving the zero-width OSC bytes didn't perturb measurement. Strip
      // BOTH the SGR (CSI) codes and the OSC 8 sequences — neither occupies a
      // terminal cell — before comparing line lengths.
      const stripOsc8 = (s: string): string => s.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
      const boxChars = /[┌┬┐├┼┤└┴┘│─]/;
      const widths = new Set(
        stripOsc8(stripAnsi(frame))
          .split("\n")
          .filter((line) => boxChars.test(line))
          .map((line) => line.length),
      );
      expect(widths.size).toBe(1);
    });
  });
});
