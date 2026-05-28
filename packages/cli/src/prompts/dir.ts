/**
 * Resolve the prompts directory to load fragments from (specs.md §12.1).
 *
 * Precedence:
 *   1. $FNC_PROMPTS_DIR (env override; empty string treated as unset)
 *   2. <exe-dir>/prompts/        (dev workflow)
 *   3. <exe-dir>/../share/fnclaude/prompts/  (FHS / AUR layout)
 *
 * Symlink resolution of exeDir is the caller's responsibility — pass the
 * already-resolved path here (Go canonical uses filepath.EvalSymlinks
 * before invoking this).
 *
 * Returns the first candidate that exists and is a directory. If none
 * match, returns null + a warning naming all candidates tried, so the
 * caller can degrade gracefully (PromptSet empty, session still launches
 * per specs.md §12.1).
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ResolvePromptsDirArgs {
  envOverride: string | undefined;
  exeDir: string;
}

export interface ResolvePromptsDirResult {
  dir: string | null;
  warning: string | undefined;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolvePromptsDir(args: ResolvePromptsDirArgs): ResolvePromptsDirResult {
  const candidates: string[] = [];

  if (args.envOverride !== undefined && args.envOverride !== '') {
    candidates.push(args.envOverride);
  }
  candidates.push(join(args.exeDir, 'prompts'));
  candidates.push(resolve(args.exeDir, '..', 'share', 'fnclaude', 'prompts'));

  for (const c of candidates) {
    if (isDir(c)) return { dir: c, warning: undefined };
  }

  return {
    dir: null,
    warning: `fnclaude: prompts directory not found; tried: ${candidates.join(', ')}. Set FNC_PROMPTS_DIR to override.`,
  };
}
