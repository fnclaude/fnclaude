/**
 * Sanitize a name for use as a path component (worktree name, etc.).
 *
 * Mirrors Go canonical `src/sanitize.go:1-50`.
 *
 * Pipeline (in order):
 *   1. Empty input → invalid.
 *   2. Input starting with `/` → invalid (path-escape risk).
 *   3. Replace runs of chars NOT in [A-Za-z0-9._/-] with a single `-`.
 *   4. Collapse `-{2,}` runs to single `-`.
 *   5. Collapse `/{2,}` runs to single `/`.
 *   6. TrimLeft `[-.]`  (strips leading dashes and dots).
 *   7. TrimRight `[-/]` (strips trailing dashes and slashes).
 *   8. Empty result → invalid.
 *   9. Result contains `..` → invalid (path-escape prevention).
 *
 * `/` is intentionally permitted so nested git refs (`feat/foo`,
 * `team/x/y`) pass through and produce nested worktree paths.
 */

const RE_PATH_SAFE_BAD = /[^A-Za-z0-9._/-]+/g;
const RE_DASH_RUN = /-{2,}/g;
const RE_SLASH_RUN = /\/{2,}/g;

export type SanitizeResult =
  | { kind: 'unchanged'; value: string }
  | { kind: 'changed'; value: string; original: string }
  | { kind: 'invalid'; original: string };

export function sanitizeForPath(input: string): SanitizeResult {
  if (input === '') return { kind: 'invalid', original: input };
  if (input.startsWith('/')) return { kind: 'invalid', original: input };

  let s = input.replace(RE_PATH_SAFE_BAD, '-');
  s = s.replace(RE_DASH_RUN, '-');
  s = s.replace(RE_SLASH_RUN, '/');
  s = trimLeftChars(s, '-.');
  s = trimRightChars(s, '-/');

  if (s === '') return { kind: 'invalid', original: input };
  if (s.includes('..')) return { kind: 'invalid', original: input };

  if (s === input) return { kind: 'unchanged', value: s };
  return { kind: 'changed', value: s, original: input };
}

function trimLeftChars(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return s.slice(i);
}

function trimRightChars(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1]!)) i--;
  return s.slice(0, i);
}
