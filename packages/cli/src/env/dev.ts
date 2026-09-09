/**
 * What counts as a DEVELOPMENT environment.
 *
 * fnc gains and loses capability on this answer, so it is one function with
 * one definition rather than an ad-hoc check per call site. Today it decides
 * whether fnc arms the channel allowlist bypass
 * (`--dangerously-load-development-channels`), which must never be armed on a
 * user's installed copy.
 *
 * The definition, in precedence order:
 *
 *   1. `FNC_DEV` set explicitly — `1` is dev, `0` is not. An override exists
 *      because the heuristic below cannot see intent: a maintainer testing an
 *      installed build wants dev, and a demo recorded from a checkout does
 *      not.
 *   2. Running out of `node_modules/` — never dev. This is the installed
 *      shape, and it is checked BEFORE the git test because a dependency's
 *      own checkout would otherwise read as one.
 *   3. A `.git` entry in the bin's directory or any ancestor — dev. Running
 *      from a source checkout is the only way to have a `.git` above the bin,
 *      since neither npm nor mise ships one.
 *   4. Anything else — not dev. The default is the safe one.
 *
 * `.git` is tested with `existsSync` rather than `statSync().isDirectory()`
 * on purpose: in a git worktree it is a FILE containing a `gitdir:` pointer,
 * and a worktree of this repo is as much a dev checkout as the main one.
 */

import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface DevEnvironmentArgs {
  /**
   * Absolute path to the running fnc bin, already realpath'd. The caller
   * resolves symlinks (npm's `.bin/` shims are symlinks into the package),
   * because the question is where the CODE lives, not how it was reached.
   */
  binPath: string;
  /** Environment to read `FNC_DEV` from. */
  env: Record<string, string | undefined>;
}

/** Is fnc running from a source checkout rather than an installed copy? */
export function isDevEnvironment(args: DevEnvironmentArgs): boolean {
  const override = args.env.FNC_DEV;
  if (override === '1') return true;
  if (override === '0') return false;

  if (args.binPath === '') return false;
  if (args.binPath.includes(`${sep}node_modules${sep}`)) return false;

  return hasGitAbove(args.binPath);
}

/** Walk from the bin's directory to the filesystem root looking for `.git`. */
function hasGitAbove(binPath: string): boolean {
  let dir = dirname(binPath);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
