/**
 * Parse claude's "To resume, run: cd <dir> && claude --resume <uuid>" hint
 * out of captured PTY output (typically the tail of fnclaude's 64 KB ring
 * buffer after claude exits).
 *
 * Per design.md §4 (Go canonical src/pty_run.go:17–99):
 *   - Regex: `/To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})/g`
 *   - When multiple matches appear in the tail, LAST match wins. claude's
 *     own most-recent print is the authoritative hint; earlier matches are
 *     stale history.
 *   - Destination cwd must pass `isSafeDest` — absolute path, no shell
 *     metacharacters, no `..` segment. We reject hostile hints rather than
 *     silently falling back to an earlier valid one: an attacker who can
 *     inject bytes into claude's TTY shouldn't get to redirect the relaunch
 *     just because they followed a benign hint with a hostile one.
 *   - UUID is defensively re-validated against the canonical 8-4-4-4-12
 *     shape. The regex character class allows any combination of hex+dash
 *     in a 36-char run, so e.g. a 36-char hex-only string matches the
 *     regex but isn't a real UUID — the shape check filters those out.
 */

export interface CrossCwdHint {
  cwd: string;
  uuid: string;
}

const HINT_RE = /To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})/g;

const UUID_SHAPE_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Shell metacharacters and quote characters that have no business in a
// path we're about to hand to `cd` (even though we don't actually invoke
// a shell — defense in depth in case a future call site does).
const UNSAFE_CHARS = new Set([
  ';', '|', '&', '$', '`', '<', '>', '(', ')',
  '{', '}', '[', ']', '#', '!', '\\', "'", '"',
]);

export function isSafeDest(dest: string): boolean {
  if (dest === '') return false;
  // POSIX absolute path. Windows handling is a follow-up.
  if (!dest.startsWith('/')) return false;
  for (const ch of dest) {
    if (UNSAFE_CHARS.has(ch)) return false;
  }
  // No `..` path segment.
  for (const seg of dest.split('/')) {
    if (seg === '..') return false;
  }
  return true;
}

export function parseCrossCwdHint(text: string): CrossCwdHint | null {
  // Reset the global regex's lastIndex defensively — matchAll handles this
  // correctly for us, but we treat HINT_RE as a module-level constant and
  // never want stateful surprises.
  let last: { cwd: string; uuid: string } | null = null;
  for (const m of text.matchAll(HINT_RE)) {
    const cwd = m[1];
    const uuid = m[2];
    if (cwd === undefined || uuid === undefined) continue;
    last = { cwd, uuid };
  }
  if (last === null) return null;
  if (!isSafeDest(last.cwd)) return null;
  if (!UUID_SHAPE_RE.test(last.uuid)) return null;
  return last;
}
