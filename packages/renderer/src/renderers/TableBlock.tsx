import { Box, Text } from "ink";
import type { Token, Tokens } from "marked";
import React from "react";

export interface TableBlockProps {
  token: Tokens.Table;
  renderInline: (tokens: Token[]) => React.ReactNode;
}

/** ANSI escape sequence pattern — used to strip SGR codes before measuring visible width. */
// biome-ignore lint/complexity/useRegexLiterals: regex literal form also triggers noControlCharactersInRegex
// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b (ESC) is intentional in ANSI detection
const ANSI_RE = new RegExp("\\x1b(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g");

/** Visible character width of a string, ignoring ANSI escape sequences. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * The visible text a cell will actually render: the concatenation of its inline
 * tokens' text, with markdown syntax characters already consumed into the token
 * tree. Measuring `cell.text` instead would count raw syntax (e.g. "`x`" len 3)
 * against content that renders stripped ("x" len 1), misaligning styled rows.
 */
function inlineVisibleText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((t) => {
      const tt = t as { tokens?: Token[]; text?: string };
      if (Array.isArray(tt.tokens) && tt.tokens.length > 0) return inlineVisibleText(tt.tokens);
      if (t.type === "br") return "\n";
      return typeof tt.text === "string" ? tt.text : "";
    })
    .join("");
}

/** Visible width of a cell, measured from its rendered inline tokens. */
function cellVisibleWidth(cell: Tokens.TableCell | undefined): number {
  if (!cell) return 0;
  const tokenText = inlineVisibleText(cell.tokens);
  return visibleWidth(tokenText !== "" ? tokenText : (cell.text ?? ""));
}

/**
 * Compute leading/trailing padding strings for a cell whose plain-text length
 * is `textLen`, filling a column of `colWidth`, with the given alignment.
 *
 * Returns [leadingPad, trailingPad] — both are space strings.
 */
function cellPad(
  textLen: number,
  colWidth: number,
  align: Tokens.Table["align"][number],
): [string, string] {
  const gap = Math.max(0, colWidth - textLen);
  if (align === "right") return [" ".repeat(gap), ""];
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return [" ".repeat(left), " ".repeat(gap - left)];
  }
  // left (default for null)
  return ["", " ".repeat(gap)];
}

/**
 * Bordered, column-aligned table renderer matching GitHub / Claude-Code style.
 *
 * - Single-line box-drawing borders (┌ ┬ ┐ / ├ ┼ ┤ / └ ┴ ┘ / │ / ─)
 * - Header row visually separated from body rows
 * - Per-column alignment from token.align (left/center/right; null → left)
 * - Header text bold
 * - Each cell rendered via the injected renderInline so bold/italic/code/strike
 *   inside cells work transparently
 */
export function TableBlock({ token, renderInline }: TableBlockProps): JSX.Element {
  const { header, rows, align } = token;
  const numCols = header.length;

  // Column widths: max of header and body plain-text widths (ignoring ANSI).
  const colWidths: number[] = Array.from({ length: numCols }, (_, ci) => {
    const hw = cellVisibleWidth(header[ci]);
    const bw = rows.reduce((mx, row) => Math.max(mx, cellVisibleWidth(row[ci])), 0);
    return Math.max(hw, bw, 1);
  });

  // Build horizontal border rows as plain strings.
  // Each cell slot is colWidth + 2 (one space each side).
  const fillRow = (left: string, mid: string, right: string, fill: string): string =>
    left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right;

  const topBorder = fillRow("┌", "┬", "┐", "─");
  const headSep = fillRow("├", "┼", "┤", "─");
  const botBorder = fillRow("└", "┴", "┘", "─");

  /** Render a single data row (header or body). */
  function renderRow(cells: Tokens.TableCell[], bold: boolean): JSX.Element {
    return (
      <Box flexDirection="row">
        <Text>│</Text>
        {cells.map((cell, ci) => {
          const [lpad, rpad] = cellPad(
            cellVisibleWidth(cell),
            colWidths[ci] ?? 1,
            align[ci] ?? null,
          );
          // One space of margin inside the border, then alignment padding, then
          // the cell content, then trailing pad, then one space + the closing │.
          // Column index is stable (columns don't reorder); use text as key
          // to satisfy the noArrayIndexKey rule.
          const cellKey = `${ci}:${cell.text}`;
          return (
            <React.Fragment key={cellKey}>
              <Text>{` ${lpad}`}</Text>
              {bold ? (
                <Text bold>{renderInline(cell.tokens)}</Text>
              ) : (
                <Text>{renderInline(cell.tokens)}</Text>
              )}
              <Text>{`${rpad} │`}</Text>
            </React.Fragment>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{topBorder}</Text>
      {renderRow(header, true)}
      <Text>{headSep}</Text>
      {rows.map((row, ri) => {
        // Use concatenated cell text as key to avoid array-index-as-key.
        const rowKey = `${ri}:${row.map((c) => c.text).join("|")}`;
        return <React.Fragment key={rowKey}>{renderRow(row, false)}</React.Fragment>;
      })}
      <Text>{botBorder}</Text>
    </Box>
  );
}
