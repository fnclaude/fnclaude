/**
 * Locate `claude` on PATH so we can fail fast with a clean error when it
 * isn't installed — rather than blowing up at Bun.spawn time with a less
 * helpful ENOENT.
 *
 * We walk PATH directly (rather than calling `Bun.which`) so callers can
 * pass an explicit PATH for testing. This matches the standard PATH
 * resolution: left-to-right, first executable file with the right name
 * wins, non-existent directories are skipped silently.
 *
 * Windows handling (PATHEXT, .exe etc.) is a follow-up; the rewrite's
 * primary Unix path lands here first.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FindClaudeArgs {
  pathEnv: string;
}

export type FindClaudeResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export function findClaude(args: FindClaudeArgs): FindClaudeResult {
  if (args.pathEnv === '') {
    return errorResult();
  }
  const dirs = args.pathEnv.split(':');
  for (const dir of dirs) {
    if (dir === '') continue;
    const candidate = join(dir, 'claude');
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { ok: true, path: candidate };
    } catch {
      // Missing, not executable, or unreadable — keep walking.
    }
  }
  return errorResult();
}

function errorResult(): FindClaudeResult {
  return {
    ok: false,
    error:
      'fnclaude: `claude` not found on PATH. Install Claude Code (https://docs.claude.com/en/docs/agents/claude-code) and ensure the `claude` binary is on your PATH.',
  };
}
