/**
 * Visibility-summary helpers shared by per-tool renderers.
 *
 * The generic "summary" rule from docs/filter-state-spec.md is:
 *   first 5 lines + "(… N more lines)"
 *
 * Per-element variants (Edit.diff, Read.content, Write.content) override
 * this with path + line count; those live in their own renderers.
 */

export const SUMMARY_LINE_LIMIT = 5;

export interface FirstNLinesResult {
  head: string;
  hiddenLines: number;
}

export function firstNLines(text: string, n: number = SUMMARY_LINE_LIMIT): FirstNLinesResult {
  const lines = text.split("\n");
  if (lines.length <= n) return { head: text, hiddenLines: 0 };
  return { head: lines.slice(0, n).join("\n"), hiddenLines: lines.length - n };
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}
