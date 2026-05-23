// Path helpers. Ported from expandTildePath in src/resolver.go.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

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

/**
 * Return the absolute, symlink-resolved path to this fnclaude script.
 *
 * Preference order:
 *  1. `process.argv[1]` — the CLI script path. Anchors to the script's
 *     neighbours (so `prompts/`, `mcp` subcommand spawn, spawn-launcher
 *     `{bin}` substitution all resolve relative to the script), not the
 *     Bun interpreter under `process.execPath`.
 *  2. `process.execPath` — fallback when `argv[1]` is empty.
 *
 * Symlinks are resolved when possible so callers receive the real
 * destination path; failure to resolve is non-fatal (returns the
 * unresolved path).
 *
 * This used to be duplicated in `spawn.ts:selfPath`, `argv.ts`'s
 * `buildFnclaudeMCPConfigJSON`, and `prompts.ts:findPromptsDir` — three
 * verbatim copies of the same six lines. Single source of truth here.
 */
export function resolveSelfPath(): string {
  const argv1 = process.argv.length > 1 ? process.argv[1] : undefined;
  let exe = argv1 !== undefined && argv1 !== '' ? argv1 : process.execPath;
  try {
    exe = realpathSync(exe);
  } catch {
    // symlink resolution failure is non-fatal — use the unresolved path
  }
  return exe;
}
