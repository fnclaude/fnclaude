/**
 * Resolve the on-disk source for `handoff.template.md`, which fnclaude
 * seeds into the noop dir on first noop-fallback launches (design.md §19).
 *
 * Precedence (mirrors prompts/dir.ts):
 *   1. $FNC_NOOP_TEMPLATE_PATH (env override; empty string treated as unset)
 *   2. <exe-dir>/templates/handoff.template.md         (dev / sibling layout)
 *   3. <exe-dir>/../templates/handoff.template.md      (npm / monorepo layout
 *                                                       where the bin lives
 *                                                       in its own subdir)
 *   4. <exe-dir>/../share/fnclaude/templates/handoff.template.md
 *                                                      (FHS / AUR layout —
 *                                                       this is also where
 *                                                       the repo ships the
 *                                                       canonical copy)
 *
 * Symlink resolution of exeDir is the caller's responsibility — pass the
 * already-resolved path here.
 *
 * Returns the first candidate that exists and is a regular file. If none
 * match, returns null. Seeding gracefully degrades on null (the noop dir
 * is still created and the session still launches per design.md §19) so
 * we don't bother surfacing a warning here.
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ResolveTemplateSourceArgs {
  envOverride: string | undefined;
  exeDir: string;
}

export interface ResolveTemplateSourceResult {
  path: string | null;
  tried: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveTemplateSourcePath(args: ResolveTemplateSourceArgs): ResolveTemplateSourceResult {
  const candidates: string[] = [];

  if (args.envOverride !== undefined && args.envOverride !== '') {
    candidates.push(args.envOverride);
  }
  candidates.push(join(args.exeDir, 'templates', 'handoff.template.md'));
  candidates.push(resolve(args.exeDir, '..', 'templates', 'handoff.template.md'));
  candidates.push(resolve(args.exeDir, '..', 'share', 'fnclaude', 'templates', 'handoff.template.md'));

  for (const c of candidates) {
    if (isFile(c)) return { path: c, tried: candidates };
  }

  return { path: null, tried: candidates };
}
