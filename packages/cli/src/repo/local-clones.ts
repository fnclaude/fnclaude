/**
 * Discover on-disk clones of a bare repo name, so disk presence can
 * disambiguate before any remote owner lookup. Given `cloneTemplate` and a
 * bare name, this resolves every placeholder concretely EXCEPT {owner}
 * (wildcarded), then scans the directory the template would clone into and
 * returns the matching clone paths.
 *
 * Why route through the same applyTemplate/tilde-expansion the real clone
 * uses (rather than naively dirname-ing the template): the template may nest
 * by host or other placeholders, so the concrete parent dir and the literal
 * prefix/suffix around the owner segment have to be derived through the exact
 * substitution path a clone takes — otherwise the scan looks in the wrong dir
 * or matches the wrong entries.
 *
 * Worktree siblings are excluded. Worktrees live next to clones named
 * `<name>@<owner>+<workspace>` (e.g. `fnclaude@fnclaude+feat-x` beside the
 * clone `fnclaude@fnclaude`). A clone's owner segment never contains `+`; a
 * worktree's does. Matching owner segments that contain `+` (or a path
 * separator) are rejected, so a clone plus its worktree resolves to exactly
 * one clone, not a spurious "ambiguous" pair.
 *
 * fs access is an injectable seam (readdirSync default), mirroring
 * log/prune.ts so callers can unit-test without real directories.
 */

import { readdirSync } from 'node:fs';
import { dirname, sep } from 'node:path';

import { expandTilde } from '../path/resolve';
import { applyTemplate, cloneTemplateVars, deriveWorktreeMarker } from './template';

// Sentinel substituted for {owner} so we can locate the owner segment in the
// fully-expanded path. Chosen to never collide with a real owner name or any
// literal template text.
const OWNER_SENTINEL = '\uFFFF';

export interface FindLocalClonesArgs {
  name: string;
  template: string;
  /**
   * The user's `worktreeTemplate` (repoSettings), used to derive the separator
   * that distinguishes worktree siblings from real clones. Omitted/empty falls
   * back to the documented default marker (see {@link deriveWorktreeMarker}).
   */
  worktreeTemplate?: string;
  host: string;
  hostAliases: Record<string, string>;
  home: string;
  readdir?: (dir: string) => string[];
}

export type FindLocalClonesResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string };

export function findLocalClones(args: FindLocalClonesArgs): FindLocalClonesResult {
  const readdir = args.readdir ?? readdirSync;

  // Resolve every placeholder except {owner}, which becomes the sentinel.
  const vars = cloneTemplateVars(args.name, OWNER_SENTINEL, args.host, args.hostAliases);
  const applied = applyTemplate(args.template, vars);
  if (!applied.ok) {
    return applied;
  }
  const expanded = expandTilde(applied.value, args.home);

  const sentinelIdx = expanded.indexOf(OWNER_SENTINEL);
  if (sentinelIdx < 0) {
    // Template doesn't reference {owner}; we can't enumerate by owner, so
    // there's nothing disk-driven to disambiguate. Treat as no local clones.
    return { ok: true, paths: [] };
  }

  const prefix = expanded.slice(0, sentinelIdx);
  const suffix = expanded.slice(sentinelIdx + OWNER_SENTINEL.length);

  // The owner segment must live within a single directory level: a real
  // clone path can't have the owner span a path separator. Scan the parent
  // dir of the resolved path and reconstruct each candidate's full path,
  // matching it against prefix+<owner>+suffix.
  const scanDir = dirname(expanded.replace(OWNER_SENTINEL, ''));

  // Worktree-sibling marker, derived from the user's worktreeTemplate (not
  // hardcoded). A clone's owner segment never contains it; a worktree's does.
  const worktreeMarker = deriveWorktreeMarker(args.template, args.worktreeTemplate ?? '');

  const paths: string[] = [];
  let entries: string[];
  try {
    entries = readdir(scanDir);
  } catch {
    // Parent dir doesn't exist → no local clones.
    return { ok: true, paths: [] };
  }

  for (const entry of entries) {
    const owner = extractOwner(`${scanDir}${sep}${entry}`, prefix, suffix);
    if (owner === null) {
      continue;
    }
    // Reject worktree siblings (owner segment carries the derived worktree
    // marker before its workspace name) and any owner that would span a path
    // separator.
    if (
      (worktreeMarker !== '' && owner.includes(worktreeMarker)) ||
      owner.includes('/') ||
      owner.includes(sep) ||
      owner === ''
    ) {
      continue;
    }
    paths.push(`${scanDir}${sep}${entry}`);
  }

  return { ok: true, paths };
}

/**
 * Given a candidate full path and the literal prefix/suffix that bracket the
 * owner segment in the expanded template, return the owner segment, or null
 * if the candidate doesn't match the prefix/suffix shape.
 */
function extractOwner(candidate: string, prefix: string, suffix: string): string | null {
  if (!candidate.startsWith(prefix)) {
    return null;
  }
  if (suffix !== '' && !candidate.endsWith(suffix)) {
    return null;
  }
  const inner = candidate.slice(prefix.length, candidate.length - suffix.length);
  return inner;
}
