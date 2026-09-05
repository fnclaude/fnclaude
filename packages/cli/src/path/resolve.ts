/**
 * Path-targeting primitives: tilde expansion and the launch-cwd fallback.
 *
 * Mirrors Go canonical's expandTildePath (src/resolver.go:267-278) and the
 * cwd-resolution block in main.go around lines 940-963: tilde first, then make
 * absolute by joining against the shell cwd.
 *
 * Repo-reference resolution is not here and is not fnc's any more — it goes to
 * the fngit CLI (`repo/fngit.ts`). These functions assume their input is a
 * filesystem path.
 */

import { isAbsolute, join } from 'node:path';

const SEPARATOR = '/';

export interface ResolveEnv {
  home: string;
  /** fnc's starting directory, already absolute. */
  noopDir: string;
  shellCwd: string;
}

export interface ResolveResult {
  launchCwd: string;
  usedNoopFallback: boolean;
}

export function expandTilde(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith(`~${SEPARATOR}`)) return join(home, input.slice(2));
  return input;
}

export function resolveCwd(firstPath: string | null, env: ResolveEnv): ResolveResult {
  if (firstPath === null || firstPath === '') {
    return { launchCwd: env.noopDir, usedNoopFallback: true };
  }

  const expanded = expandTilde(firstPath, env.home);
  const launchCwd = isAbsolute(expanded) ? expanded : join(env.shellCwd, expanded);

  return { launchCwd, usedNoopFallback: false };
}
