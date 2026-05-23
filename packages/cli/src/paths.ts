// Path helpers. Ported from expandTildePath in src/resolver.go.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading "~" or "~/" to the user's home directory.
 *
 * - "~" → homedir()
 * - "~/foo" → join(homedir(), "foo")
 * - Everything else (including mid-token "~", "~user/...", absolute paths,
 *   relative paths, empty string) is returned unchanged. This matches the
 *   Go reference and POSIX shell behaviour: only bare `~` and `~/` expand.
 *
 * The user's home dir comes from `os.homedir()` rather than being threaded
 * through every call site — the Go version passes `home` explicitly because
 * Go style discourages global env reads inside helpers; in TS the harness
 * is fine.
 */
export function expandTildePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
