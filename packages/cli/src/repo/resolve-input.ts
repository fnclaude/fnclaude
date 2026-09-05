/**
 * Resolver orchestrator — takes the first positional argument (or null) and
 * decides what fnclaude should do with it.
 *
 * What is left here is only the glue that is fnc's, not fngit's:
 *
 *   1. **No argument** → the noop fallback (fnc's starting directory).
 *   2. **A path** (`/`, `~`, `~/x`, `.`, `..`, `./x`, `../x`) → launch there,
 *      unconditionally. Don't stat it — the user said "go here", so we go, and
 *      `ensureCwd` fabricates the tree if it's missing. Short-circuiting is
 *      also what keeps `fnc .` out of the repo path entirely.
 *   3. **Anything else** is a repo reference → `+workspace` comes off the end
 *      and the rest goes to `fngit clone`, which prints the directory.
 *
 * Everything the old resolver did between (2) and (3) — parsing `name@owner`,
 * expanding a clone template, searching source directories, disambiguating a
 * bare name against local clones, asking `gh` who owns it, cloning,
 * bootstrapping a repo that doesn't exist — is fngit's now. So are the
 * `ambiguous` / `ambiguous-local` outcomes: fngit either resolves a reference
 * or fails with its own reason, and fnc relays that.
 *
 * The one deliberate behavioural change is the path-versus-repo tie. The old
 * resolver checked `<shellCwd>/<input>` FIRST and reported `ambiguous` when a
 * local directory and a clone destination both existed. fnc no longer computes
 * clone destinations, so it cannot see that collision — and asking fngit first
 * would make `fnc somedir` ignore a directory sitting right there. So a
 * bare-word input that names an existing directory in the shell cwd wins, and
 * `<name>@<owner>`-style references (which can't be filenames in practice)
 * go straight to fngit. `./name` remains the way to force the path reading.
 *
 * See specs/rhombus-rocks-config.md § "fngit CLI contract".
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { expandTilde } from '../path/resolve';
import { type FngitRunner, locateRepo } from './fngit';
import { splitWorkspaceSuffix } from './workspace-suffix';

export interface ResolveInputArgs {
  input: string | null;
  shellCwd: string;
  home: string;
  /** fnc's starting directory, already expanded to an absolute path. */
  noopDir: string;
  /** Injected fngit runner. Null when fngit is not on PATH. */
  fngit: FngitRunner | null;
  /** Progress sink for the "resolving…" line. Defaults to no output. */
  onProgress?: (line: string) => void;
}

export type ResolveResult =
  | {
      kind: 'launch';
      launchCwd: string;
      /** The `+workspace` suffix, or `''`. Fed to the worktree intercept. */
      workspace: string;
      usedNoopFallback: boolean;
    }
  | { kind: 'error'; error: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Forms that are unambiguously filesystem paths and never repo references.
 * `.` and `..` can't be repo names, and `./<name>` is the syntax that forces
 * the path reading of a word that could be either.
 */
export function isPathShortCircuit(input: string): boolean {
  if (input === '~') return true;
  if (input.startsWith('/')) return true;
  if (input.startsWith('~/')) return true;
  if (input === '.' || input === '..') return true;
  if (input.startsWith('./') || input.startsWith('../')) return true;
  return false;
}

export async function resolveInput(args: ResolveInputArgs): Promise<ResolveResult> {
  const { input, shellCwd, home, noopDir } = args;

  // 1. No argument → the noop fallback.
  if (input === null || input === '') {
    return { kind: 'launch', launchCwd: noopDir, usedNoopFallback: true, workspace: '' };
  }

  // 2. Explicit path forms skip the repo lookup entirely.
  if (isPathShortCircuit(input)) {
    const { body, workspace } = splitWorkspaceSuffix(input);
    const expanded = expandTilde(body, home);
    const launchCwd = isAbsolute(expanded) ? expanded : join(shellCwd, expanded);
    return { kind: 'launch', launchCwd, usedNoopFallback: false, workspace };
  }

  const { body, workspace } = splitWorkspaceSuffix(input);
  if (body === '') {
    return { kind: 'error', error: `empty repo reference in ${JSON.stringify(input)}` };
  }

  // 3. A bare word that names a directory right here is that directory. This
  //    is checked before fngit so `fnc packages` in a monorepo doesn't go
  //    looking for a repo named "packages" on GitHub.
  const pathCandidate = join(shellCwd, body);
  if (!body.includes('@') && !body.includes(':') && isDirectory(pathCandidate)) {
    return { kind: 'launch', launchCwd: pathCandidate, usedNoopFallback: false, workspace };
  }

  // 4. Everything else is fngit's to resolve.
  const located = await locateRepo({
    ref: body,
    fngit: args.fngit,
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
  });
  if (!located.ok) return { kind: 'error', error: located.error };
  return { kind: 'launch', launchCwd: located.path, usedNoopFallback: false, workspace };
}
