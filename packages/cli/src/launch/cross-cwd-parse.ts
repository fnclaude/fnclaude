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

// claude's command builder (O4) emits the cwd one of two ways:
//   - bare, when every char is in [A-Za-z0-9_./:=@+,-]:  cd /home/tom/foo
//   - single-quoted otherwise, escaping any inner ' as '"'"':
//       cd '/home/tom/my project'
//       cd '/home/tom/o'"'"'brien'   (path: /home/tom/o'brien)
//
// HINT_RE has two cwd alternatives. The quoted alternative
// `'((?:[^']|'"'"')*)'` matches a single-quoted run where each unit is
// either a non-quote char OR the literal 6-char escape sequence `'"'"'`.
// The bare alternative `(\S+)` matches a whitespace-free token (the
// original Linux `&&` shape). unquoteCwd reverses O4's quoting.
//
// Windows uses `;` instead of `&&` as the command separator; the Go
// canonical only compiles the `&&` form, so we mirror that — Windows
// cross-cwd resume is a documented follow-up, not a regression here.
const HINT_RE =
  /To resume, run:[\s\S]*?cd (?:'((?:[^']|'"'"')*)'|(\S+)) && claude --resume ([0-9a-fA-F-]{36})/g;

/**
 * Reverse O4's single-quoting: a single-quoted run with inner quotes
 * encoded as the 6-char sequence `'"'"'`. Replacing each such sequence
 * with a literal `'` yields the original path.
 */
function unquoteCwd(quotedBody: string): string {
  return quotedBody.replaceAll(`'"'"'`, "'");
}

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
  return isSafeDestImpl(dest, false);
}

/**
 * `quoted` relaxes the shell-metachar denylist. When claude single-quotes
 * the cwd it does so *precisely because* the path contains a char outside
 * `[A-Za-z0-9_./:=@+,-]` (space, `'`, `$`, …) — those are legitimate
 * filename bytes claude itself quoted, not injection. The regex already
 * structurally bounds the quoted run (closing `'` before ` && claude`), and
 * the dest is handed to Bun.spawn as `cwd`, never to a shell — so the
 * denylist would wrongly reject real directories. Absolute-path and `..`
 * checks still apply in both modes.
 *
 * Bare (unquoted) hints keep the strict denylist: a metachar appearing in
 * an *unquoted* token is exactly the injected-hint shape we reject (claude
 * would have quoted a path that legitimately contained one).
 */
function isSafeDestImpl(dest: string, quoted: boolean): boolean {
  if (dest === '') return false;
  // POSIX absolute path. Windows handling is a follow-up.
  if (!dest.startsWith('/')) return false;
  if (!quoted) {
    for (const ch of dest) {
      if (UNSAFE_CHARS.has(ch)) return false;
    }
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
  let last: { cwd: string; uuid: string; quoted: boolean } | null = null;
  for (const m of text.matchAll(HINT_RE)) {
    // Group 1: quoted-cwd body (inner quotes still O4-encoded).
    // Group 2: bare cwd. Exactly one is defined per match.
    // Group 3: uuid.
    const quotedBody = m[1];
    const bareCwd = m[2];
    const uuid = m[3];
    if (uuid === undefined) continue;
    const quoted = quotedBody !== undefined;
    const cwd = quoted ? unquoteCwd(quotedBody) : bareCwd;
    if (cwd === undefined) continue;
    last = { cwd, uuid, quoted };
  }
  if (last === null) return null;
  if (!isSafeDestImpl(last.cwd, last.quoted)) return null;
  if (!UUID_SHAPE_RE.test(last.uuid)) return null;
  return { cwd: last.cwd, uuid: last.uuid };
}
