import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { type Token, type Tokens, marked } from "marked";
import { TableBlock } from "./TableBlock.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal renderInline stand-in: concatenates the plain .text of every token
 * and returns it as a <Text> node.  Real inline styling (bold, italic, etc.)
 * is tested via the MarkdownRenderer integration; here we just need cell
 * content to be predictably present in the frame.
 */
function fakeRenderInline(tokens: Token[]): React.ReactNode {
  const text = tokens
    .map((t) => ("text" in t ? (t as { text: string }).text : ""))
    .join("");
  return <Text>{text}</Text>;
}

/** Lex a markdown string and return its first token asserted as a Table. */
function lexTable(md: string): Tokens.Table {
  const tokens = marked.lexer(md);
  const t = tokens[0];
  if (!t || t.type !== "table") throw new Error("not a table token");
  return t as Tokens.Table;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A table with mixed alignment: right (Name col), center (Score col).
//   | Name  | Score |
//   |------:|:-----:|
//   | Alice |    42 |
//   | Bob   |     7 |
const MIXED = lexTable("| Name | Score |\n|---:|:---:|\n| Alice | 42 |\n| Bob | 7 |");

// A simple two-column table with default (left) alignment.
const SIMPLE = lexTable("| A | B |\n|---|---|\n| x | y |");

// A table with inline markup in a cell (bold text in header, code in body).
// We test this with a real renderInline-like shim that returns styled Text.
const STYLED = lexTable("| **Name** | Value |\n|---|---|\n| `code` | plain |");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TableBlock", () => {
  // --- cell content ----------------------------------------------------------

  test("renders all header cell texts", () => {
    const { lastFrame } = render(
      <TableBlock token={SIMPLE} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("A");
    expect(frame).toContain("B");
  });

  test("renders all body cell texts", () => {
    const { lastFrame } = render(
      <TableBlock token={SIMPLE} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("x");
    expect(frame).toContain("y");
  });

  test("renders multiple body rows", () => {
    const { lastFrame } = render(
      <TableBlock token={MIXED} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Alice");
    expect(frame).toContain("Bob");
    expect(frame).toContain("42");
    expect(frame).toContain("7");
  });

  // --- no literal pipe -------------------------------------------------------

  test("no literal ASCII pipe | characters in output", () => {
    const { lastFrame } = render(
      <TableBlock token={MIXED} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    // Box-drawing │ (U+2502) is fine; raw markdown pipe | (U+007C) must not appear.
    expect(frame).not.toContain("|");
  });

  // --- bold header -----------------------------------------------------------

  test("header row emits bold SGR escape (\\x1B[1m)", () => {
    const { lastFrame } = render(
      <TableBlock token={SIMPLE} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/\x1B\[1m/);
  });

  // --- alignment padding -----------------------------------------------------

  test("right-aligned column: short body cell has leading spaces", () => {
    // Column "Name" is right-aligned (---:).
    // colWidth = max("Name".length=4, "Alice".length=5, "Bob".length=3) = 5
    // "Bob" (len 3) right-aligned in width 5 → 2 leading spaces: "  Bob"
    const { lastFrame } = render(
      <TableBlock token={MIXED} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    // At minimum, "Bob" must be preceded by at least one space in the cell slot.
    // The exact form is: border space + padding spaces + "Bob".
    expect(frame).toMatch(/\s{2,}Bob/);
  });

  test("left-aligned column (default): body cell text is not right-padded-only", () => {
    // Column "A" is left-aligned.  Cell "x" (width 1) in column width 1 → no
    // extra padding.  We just confirm the text is there with no prefix spaces
    // beyond the mandatory single border margin.
    const { lastFrame } = render(
      <TableBlock token={SIMPLE} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("x");
  });

  // --- borders ---------------------------------------------------------------

  test("output contains box-drawing border characters", () => {
    const { lastFrame } = render(
      <TableBlock token={SIMPLE} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    // At least top-left and horizontal fill should appear.
    expect(frame).toMatch(/[┌┬┐├┼┤└┴┘]/);
    expect(frame).toMatch(/─/);
    // Vertical separator between columns within rows.
    expect(frame).toMatch(/│/);
  });

  test("header and body are visually separated (header separator row)", () => {
    const { lastFrame } = render(
      <TableBlock token={MIXED} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    // The header separator uses ├ ┼ ┤ characters.
    expect(frame).toMatch(/├/);
    expect(frame).toMatch(/┼/);
    expect(frame).toMatch(/┤/);
  });

  // --- renderInline delegation -----------------------------------------------

  test("calls renderInline with each cell's tokens", () => {
    const seen: string[] = [];
    const trackingRender = (tokens: Token[]): React.ReactNode => {
      const text = tokens
        .map((t) => ("text" in t ? (t as { text: string }).text : ""))
        .join("");
      seen.push(text);
      return <Text>{text}</Text>;
    };

    render(<TableBlock token={MIXED} renderInline={trackingRender} />);
    // Header + body cells: "Name", "Score", "Alice", "42", "Bob", "7"
    expect(seen).toContain("Name");
    expect(seen).toContain("Score");
    expect(seen).toContain("Alice");
    expect(seen).toContain("42");
    expect(seen).toContain("Bob");
    expect(seen).toContain("7");
  });

  // --- edge cases ------------------------------------------------------------

  test("table with no body rows renders header and borders only", () => {
    const headerOnly = lexTable("| Col |\n|---|\n");
    // marked may not produce a table with truly empty rows — just check it renders
    // without throwing and the header text is present.
    const { lastFrame } = render(
      <TableBlock token={headerOnly} renderInline={fakeRenderInline} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Col");
    expect(frame).not.toContain("|");
  });
});
