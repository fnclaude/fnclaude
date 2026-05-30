/**
 * Log-directory retention: keep the most-recent N session log files, unlink
 * the rest. Called once per launch (from init.ts) so the always-on per-launch
 * JSONL files don't accumulate unbounded.
 *
 * Best-effort throughout, mirroring ensure-cwd's swallow-on-cleanup posture: a
 * top-level readdir/stat failure or a per-file unlink failure routes to onError
 * (default: swallow) and never throws. Only `fnclaude-*.jsonl` files are
 * considered — anything else in the dir is left untouched. fs operations are
 * injectable seams (readdirSync / statSync / unlinkSync defaults).
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LOG_FILE_RE = /^fnclaude-.*\.jsonl$/;

export interface PruneLogDirArgs {
  dir: string;
  keep: number;
  readdir?: (dir: string) => string[];
  stat?: (path: string) => { mtimeMs: number };
  unlink?: (path: string) => void;
  onError?: (err: unknown) => void;
}

export interface PruneResult {
  removed: string[];
}

export function pruneLogDir(args: PruneLogDirArgs): PruneResult {
  const readdir = args.readdir ?? readdirSync;
  const stat = args.stat ?? ((p: string) => statSync(p));
  const unlink = args.unlink ?? unlinkSync;
  const onError = args.onError ?? (() => {});

  const removed: string[] = [];
  try {
    const candidates = readdir(args.dir)
      .filter((name) => LOG_FILE_RE.test(name))
      .map((name) => {
        const path = join(args.dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = stat(path).mtimeMs;
        } catch (err) {
          onError(err);
        }
        return { path, mtimeMs };
      });

    // Newest first; drop everything past the keep window.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const victim of candidates.slice(Math.max(0, args.keep))) {
      try {
        unlink(victim.path);
        removed.push(victim.path);
      } catch (err) {
        onError(err);
      }
    }
  } catch (err) {
    onError(err);
  }

  return { removed };
}
