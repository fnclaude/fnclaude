/**
 * The post-Apply scan of `~/.claude/CLAUDE.md`.
 *
 * A user's own preferences file often carries instructions about where
 * worktrees go or where clones live — written before fnc had templates for
 * either. Those lines don't stop working, but they can quietly contradict the
 * templates just set, and the user is the only one who can say which they
 * meant.
 *
 * So this is deliberately a HEURISTIC that reports, never edits.
 * `~/.claude/CLAUDE.md` is a file fnc does not own (owner, 2026-09-04:
 * templates are NOT written into it), and a grep for three words is nowhere
 * near precise enough to justify touching it. The output is a list of line
 * numbers for the user to look at.
 */

import { CLAUDE_MD_SCAN_HEADER, CLAUDE_MD_SCAN_PATTERNS } from './questions';

export interface ScanHit {
  /** 1-based line number, as an editor would show it. */
  line: number;
  text: string;
}

/** Find lines mentioning worktrees, clones, or a source path. */
export function scanClaudeMd(content: string): ScanHit[] {
  const hits: ScanHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lower = line.toLowerCase();
    if (CLAUDE_MD_SCAN_PATTERNS.some((p) => lower.includes(p))) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

/**
 * Render the scan for printing, or null when there is nothing to say. Silence
 * on no hits is the point: a closing note that always prints a section about a
 * file with nothing wrong in it trains the user to skip the whole note.
 */
export function formatScan(hits: readonly ScanHit[]): string | null {
  if (hits.length === 0) return null;
  const body = hits.map((h) => `  ${h.line}: ${h.text}`).join('\n');
  return `${CLAUDE_MD_SCAN_HEADER}\n${body}`;
}

export interface RunScanArgs {
  path: string;
  /** Read seam. Returns null when the file is absent or unreadable. */
  read?: (path: string) => string | null;
}

/** Read and format in one step. Returns null when there is nothing to report. */
export function runClaudeMdScan(args: RunScanArgs): string | null {
  const read =
    args.read ??
    ((path: string): string | null => {
      try {
        // Synchronous on purpose: this runs once, at the very end of the
        // wizard, immediately before the closing note is printed.
        return require('node:fs').readFileSync(path, 'utf8') as string;
      } catch {
        return null;
      }
    });
  const content = read(args.path);
  if (content === null) return null;
  return formatScan(scanClaudeMd(content));
}
