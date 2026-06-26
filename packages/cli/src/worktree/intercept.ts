/**
 * Worktree intercept — handles `-w <name>` (and 2nd-positional, which
 * the parser routes through the same worktreeArg slot).
 *
 * Mirrors Go canonical `src/main.go:631-743` with one rewrite deviation
 * per PRD item #8: ALSO set `--name <name>` on match. Go canonical
 * didn't; the rewrite always sets `--name` so the session name reflects
 * the worktree name regardless of match.
 *
 * Behavior matrix (specs.md §10):
 *
 *   worktreeSet=false       → no-op (passthrough unchanged)
 *   bare -w (arg='')        → push `--worktree` alone (no name)
 *   -w <name>, match found  → swap launchCwd to match.path;
 *                             push `--name <name>` (unless --name/-n
 *                             already in passthrough);
 *                             do NOT push `--worktree`
 *   -w <name>, no match     → push `--worktree <name>`; push
 *                             `--name <name>` (unless already set)
 *   -w <name>, not a repo   → same as no-match (listWorktrees returns
 *                             null; git errors degrade silently)
 *
 * Match priority ladder against sanitizeForPath(<name>):
 *   1. branch === query
 *   2. branch with "worktree-" prefix stripped === query
 *   3. basename(worktree.path) === query
 *
 * The name is sanitized via §5.1 sanitizeForPath. Invalid → original
 * kept (with a deferred warning); changed-but-valid → sanitized used
 * (with a deferred warning naming both).
 */

import { basename } from 'node:path';

import { sanitizeForPath } from '../name/sanitize';

export interface Worktree {
  path: string;
  branch: string;
}

export interface InterceptArgs {
  worktreeSet: boolean;
  worktreeArg: string;
  launchCwd: string;
  passthrough: readonly string[];
  /**
   * Return the list of worktrees in launchCwd, or null if it's not a
   * git repo (or git failed). Caller wires `git worktree list
   * --porcelain` parsing.
   */
  listWorktrees: (cwd: string) => Worktree[] | null;
}

export interface InterceptResult {
  launchCwd: string;
  passthrough: string[];
  worktreeMatched: boolean;
  warnings: string[];
}

const WORKTREE_BRANCH_PREFIX = 'worktree-';

function hasNameInPassthrough(passthrough: readonly string[]): boolean {
  for (let i = 0; i < passthrough.length; i++) {
    const tok = passthrough[i]!;
    if (tok === '--name' || tok === '-n') return true;
    if (tok.startsWith('--name=') || tok.startsWith('-n=')) return true;
  }
  return false;
}

function findMatch(name: string, wts: Worktree[]): Worktree | null {
  // Priority 1: exact branch match
  for (const wt of wts) {
    if (wt.branch === name) return wt;
  }
  // Priority 2: branch with worktree- prefix stripped
  for (const wt of wts) {
    if (
      wt.branch.startsWith(WORKTREE_BRANCH_PREFIX) &&
      wt.branch.slice(WORKTREE_BRANCH_PREFIX.length) === name
    ) {
      return wt;
    }
  }
  // Priority 3: basename of worktree path
  for (const wt of wts) {
    if (basename(wt.path) === name) return wt;
  }
  return null;
}

export function applyWorktreeIntercept(args: InterceptArgs): InterceptResult {
  const passthrough = [...args.passthrough];
  const warnings: string[] = [];

  if (!args.worktreeSet) {
    return { launchCwd: args.launchCwd, passthrough, worktreeMatched: false, warnings };
  }

  // Bare -w (no value)
  if (args.worktreeArg === '') {
    passthrough.push('--worktree');
    return { launchCwd: args.launchCwd, passthrough, worktreeMatched: false, warnings };
  }

  // Sanitize the name, collecting any warning.
  const san = sanitizeForPath(args.worktreeArg);
  let name: string;
  if (san.kind === 'unchanged') {
    name = san.value;
  } else if (san.kind === 'changed') {
    name = san.value;
    warnings.push(
      `fnclaude: -w ${JSON.stringify(san.original)} sanitized to ${JSON.stringify(san.value)} (illegal path/branch chars)`,
    );
  } else {
    // Invalid — pass original through with warning, no match attempted.
    name = san.original;
    warnings.push(
      `fnclaude: -w ${JSON.stringify(san.original)} is not a safe path/branch name; passed through unchanged`,
    );
  }

  const wts = args.listWorktrees(args.launchCwd);
  const match = wts === null ? null : findMatch(name, wts);

  if (match !== null) {
    // Match: swap cwd, set --name unless already set, don't forward --worktree.
    const result: InterceptResult = {
      launchCwd: match.path,
      passthrough,
      worktreeMatched: true,
      warnings,
    };
    if (!hasNameInPassthrough(passthrough)) {
      passthrough.push('--name', name);
    }
    return result;
  }

  // No match: pass --worktree <name> through, set --name unless already set.
  passthrough.push('--worktree', name);
  if (!hasNameInPassthrough(args.passthrough)) {
    passthrough.push('--name', name);
  }

  return { launchCwd: args.launchCwd, passthrough, worktreeMatched: false, warnings };
}
