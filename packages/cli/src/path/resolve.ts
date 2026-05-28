/**
 * Path-targeting primitives: tilde expansion, noop fallback, and the
 * full launch-cwd resolver.
 *
 * Mirrors Go canonical's expandTildePath (src/resolver.go:267-278) and
 * the cwd-resolution block in main.go around lines 940-963: tilde first,
 * then make absolute by joining against the shell cwd.
 *
 * Repo-reference resolution (bare-name multi-org search, owner/name,
 * SSH/HTTPS URLs, name@owner cloneTemplate forms) is a separate concern
 * handled in §3.4 — resolveCwd here ASSUMES its input is a filesystem
 * path. Callers route repo references through the resolver first.
 */

import { isAbsolute, join } from 'node:path';

const SEPARATOR = '/';

export interface ResolveEnv {
  home: string;
  xdgConfigHome: string | undefined;
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

export function noopDir(env: { xdgConfigHome: string | undefined; home: string }): string {
  const base = env.xdgConfigHome && env.xdgConfigHome.length > 0
    ? env.xdgConfigHome
    : join(env.home, '.config');
  return join(base, 'fnclaude', 'noop');
}

export function resolveCwd(firstPath: string | null, env: ResolveEnv): ResolveResult {
  if (firstPath === null || firstPath === '') {
    return {
      launchCwd: noopDir(env),
      usedNoopFallback: true,
    };
  }

  const expanded = expandTilde(firstPath, env.home);
  const launchCwd = isAbsolute(expanded) ? expanded : join(env.shellCwd, expanded);

  return {
    launchCwd,
    usedNoopFallback: false,
  };
}
