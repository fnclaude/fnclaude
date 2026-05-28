/**
 * Fabricate a missing cwd tree so Bun.spawn doesn't report ENOENT against
 * the claude binary path. Per design.md §26 (Go canonical src/pty_run.go:154-237).
 *
 * Motivation: when resuming a session whose stored cwd no longer exists,
 * the kernel returns ENOENT during spawn — but the error message blames
 * the binary, not the cwd. Pre-creating the cwd tree gets us a clean
 * spawn; the cwd is held by inode reference after the child chdirs, so
 * we can remove the fabricated dirs immediately afterward and the child
 * still has a working pwd.
 *
 * Algorithm:
 *   1. Dir exists & is a directory → return ok with empty created list
 *   2. Dir exists & is NOT a directory → error
 *   3. Walk up the tree recording missing levels (shallowest first)
 *   4. mkdir each missing level in order
 *   5. Return a cleanup() that rmdirs each in deepest-first order
 *
 * Cleanup robustness:
 *   - Tolerates a created dir that became non-empty (rmdir refuses;
 *     we swallow the error — the spec treats this as "shouldn't happen"
 *     but we don't want cleanup to crash the launcher path)
 *   - Idempotent: safe to call cleanup() twice
 */

import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type EnsureCwdResult =
  | { ok: true; created: string[]; cleanup: () => void }
  | { ok: false; error: string };

export function ensureCwd(path: string): EnsureCwdResult {
  // Walk up collecting missing levels (deepest first while collecting,
  // we reverse at the end).
  const missing: string[] = [];
  let cur = path;
  while (true) {
    let st;
    try {
      st = statSync(cur);
    } catch {
      missing.push(cur);
      const parent = dirname(cur);
      if (parent === cur) {
        // Reached filesystem root and still missing — implausible but defensive.
        return { ok: false, error: `cannot ensure cwd: walked to root looking for ${path}` };
      }
      cur = parent;
      continue;
    }
    // Found an existing level.
    if (!st.isDirectory()) {
      return { ok: false, error: `cannot ensure cwd: ${cur} exists but is not a directory` };
    }
    break;
  }

  // Reverse so shallowest-first; that's the mkdir order we need.
  missing.reverse();
  const created: string[] = [];
  for (const p of missing) {
    try {
      mkdirSync(p);
      created.push(p);
    } catch (err) {
      // Unwind what we created on failure.
      cleanupCreated(created);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `cannot ensure cwd: mkdir ${p} failed (${msg})` };
    }
  }

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupCreated(created);
  };

  return { ok: true, created, cleanup };
}

function cleanupCreated(created: readonly string[]): void {
  // Deepest first.
  for (let i = created.length - 1; i >= 0; i--) {
    try {
      rmdirSync(created[i]!);
    } catch {
      // Dir became non-empty, was already removed, or some other condition.
      // Don't crash the launcher; the spec treats this as "shouldn't happen"
      // but our policy is best-effort cleanup.
    }
  }
}
