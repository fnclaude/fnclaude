/**
 * Resolver orchestrator — takes the first positional argument (or null)
 * and decides what fnclaude should do with it. Pure dispatch + filesystem
 * existence checks; gh-CLI-bound side effects (owner lookup, clone
 * execution) are surfaced as result variants so the caller (CLI main)
 * handles them at the boundary.
 *
 * Mirrors Go canonical `src/resolver.go:resolveLaunchCwd` minus the gh
 * branches:
 *   - Short-circuit for /, ~, ~/, ., .., ./x, ../x → launch unconditionally
 *     (explicit paths, no fs check)
 *   - Everything else → dual lookup
 *       path:  is <shellCwd>/<input> a directory?
 *       repo:  parse, compute clone destination, does it exist?
 *   - Both found  → ambiguous (caller errors with disambiguation msg)
 *   - One found   → launch that one
 *   - Neither     → needs-clone (resolved owner) or needs-owner-lookup
 *                   (bare name) — caller invokes gh CLI
 *
 * See specs.md §18.1 for the user-facing description.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { expandTilde, noopDir } from '../path/resolve';
import { buildCloneUrl, computeCloneDestination } from './clone';
import { findLocalClones } from './local-clones';
import { effectiveHost, hasResolvedOwner, parseRepoRef } from './ref';

export interface ResolveInputArgs {
  input: string | null;
  shellCwd: string;
  home: string;
  xdgConfigHome: string | undefined;
  settings: {
    cloneTemplate: string;
    hostAliases: Record<string, string>;
  };
}

export type ResolveResult =
  | {
      kind: 'launch';
      launchCwd: string;
      workspace: string;
      usedNoopFallback: boolean;
    }
  | {
      kind: 'needs-clone';
      url: string;
      destination: string;
      workspace: string;
    }
  | {
      kind: 'needs-owner-lookup';
      name: string;
      workspace: string;
    }
  | {
      kind: 'ambiguous';
      path: string;
      cloneDestination?: string;
      repoRef?: string;
    }
  | {
      kind: 'ambiguous-local';
      name: string;
      paths: string[];
    }
  | { kind: 'error'; error: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPathShortCircuit(input: string): boolean {
  if (input === '~') return true;
  if (input.startsWith('/')) return true;
  if (input.startsWith('~/')) return true;
  // Explicit relative paths are unambiguously paths, never repo refs. `.`
  // and `..` can't be repo names, and `./<name>` is the very syntax the
  // ambiguous-reference error tells the user to type for "the local path".
  // Short-circuiting here keeps a bare `.` (or `./foo`) out of the bare-name
  // dual-lookup branch, where `join(shellCwd, ".")` always exists and so
  // every `fnc .` resolved to `ambiguous`.
  if (input === '.' || input === '..') return true;
  if (input.startsWith('./') || input.startsWith('../')) return true;
  return false;
}

export function resolveInput(args: ResolveInputArgs): ResolveResult {
  const { input, shellCwd, home, xdgConfigHome, settings } = args;

  // 1. Null / empty → noop fallback
  if (input === null || input === '') {
    return {
      kind: 'launch',
      launchCwd: noopDir({ xdgConfigHome, home }),
      usedNoopFallback: true,
      workspace: '',
    };
  }

  // 2. Path short-circuit: /, ~, ~/, ., .., ./x, ../x skip the repo lookup
  //    entirely (per specs.md §18.1). Don't check whether the directory
  //    exists — user said "go here", we go there.
  if (isPathShortCircuit(input)) {
    const expanded = expandTilde(input, home);
    const launchCwd = isAbsolute(expanded) ? expanded : join(shellCwd, expanded);
    return { kind: 'launch', launchCwd, usedNoopFallback: false, workspace: '' };
  }

  // 3. Dual lookup: check both path-on-disk and repo-ref interpretation.
  const pathCandidate = join(shellCwd, input);
  const pathExists = isDirectory(pathCandidate);

  const parseResult = parseRepoRef(input);

  // If repo-ref parse failed: path is the only chance.
  if (!parseResult.ok) {
    if (pathExists) {
      return {
        kind: 'launch',
        launchCwd: pathCandidate,
        usedNoopFallback: false,
        workspace: '',
      };
    }
    return { kind: 'error', error: parseResult.error };
  }

  const ref = parseResult.ref;

  // Bare name (owner not in input). Disk presence disambiguates BEFORE any
  // remote owner lookup: a single local clone wins over remote ambiguity.
  if (!hasResolvedOwner(ref)) {
    if (pathExists) {
      return { kind: 'ambiguous', path: pathCandidate, repoRef: input };
    }
    if (settings.cloneTemplate !== '') {
      const local = findLocalClones({
        name: ref.name,
        template: settings.cloneTemplate,
        host: effectiveHost(ref),
        hostAliases: settings.hostAliases,
        home,
      });
      if (local.ok) {
        if (local.paths.length === 1) {
          return {
            kind: 'launch',
            launchCwd: local.paths[0]!,
            usedNoopFallback: false,
            workspace: ref.workspace,
          };
        }
        if (local.paths.length > 1) {
          return { kind: 'ambiguous-local', name: ref.name, paths: local.paths };
        }
      }
      // local.ok === false (template error) or zero matches: fall through to
      // the existing remote owner-lookup behavior, unchanged.
    }
    return { kind: 'needs-owner-lookup', name: ref.name, workspace: ref.workspace };
  }

  // Owner is resolved; compute clone destination.
  if (settings.cloneTemplate === '') {
    return {
      kind: 'error',
      error:
        'cloneTemplate is not configured in repoSettings; cannot resolve repo references. Set repoSettings.cloneTemplate in ~/.claude/settings.json (e.g. "~/src/{repo}@{owner}")',
    };
  }

  const destResult = computeCloneDestination({
    ref,
    template: settings.cloneTemplate,
    hostAliases: settings.hostAliases,
    home,
  });
  if (!destResult.ok) {
    return { kind: 'error', error: destResult.error };
  }
  const destination = destResult.path;
  const destExists = isDirectory(destination);

  if (pathExists && destExists) {
    return { kind: 'ambiguous', path: pathCandidate, cloneDestination: destination };
  }
  if (pathExists) {
    return {
      kind: 'launch',
      launchCwd: pathCandidate,
      usedNoopFallback: false,
      workspace: ref.workspace,
    };
  }
  if (destExists) {
    return {
      kind: 'launch',
      launchCwd: destination,
      usedNoopFallback: false,
      workspace: ref.workspace,
    };
  }

  return {
    kind: 'needs-clone',
    url: buildCloneUrl(ref),
    destination,
    workspace: ref.workspace,
  };
}
