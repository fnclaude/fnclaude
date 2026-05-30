/**
 * Execute a `gh repo clone` to materialize a needs-clone destination.
 *
 * Mkdirs the parent first, then delegates to the injected `ghClone`
 * runner. Surfacing both as injected callbacks keeps this module
 * unit-testable without any real gh subprocess or filesystem touching.
 */

import { dirname } from 'node:path';

export type GhCloneResult = { ok: true } | { ok: false; error: string; stderr: string };

export type GhCloneCall = (url: string, destination: string) => Promise<GhCloneResult>;

export type Mkdirp = (path: string) => Promise<void>;

export interface CloneRepoArgs {
  url: string;
  destination: string;
  ghClone: GhCloneCall;
  mkdirp: Mkdirp;
}

export type CloneRepoResult =
  | { ok: true }
  | { ok: false; error: string; stderr: string };

export async function cloneRepo(args: CloneRepoArgs): Promise<CloneRepoResult> {
  const parent = dirname(args.destination);
  try {
    await args.mkdirp(parent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to create parent directory ${parent}: ${msg}`, stderr: '' };
  }
  const r = await args.ghClone(args.url, args.destination);
  if (!r.ok) return { ok: false, error: `gh repo clone failed: ${r.error}`, stderr: r.stderr };
  return { ok: true };
}
