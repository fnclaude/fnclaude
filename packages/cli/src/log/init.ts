/**
 * Wiring entry point for the launcher's file-only logging subsystem — main.ts
 * calls this once, early, right after the launch cwd is resolved.
 *
 * Steps:
 *   1. Resolve the level by precedence: FNC_LOG env > configLevel > 'info'.
 *      A 'silent'/'off'/'none' result disables logging entirely → NOOP logger,
 *      null path, no fs touches.
 *   2. Compute the platform STATE-dir log path and mkdir -p it. A mkdir failure
 *      degrades to the NOOP logger (logging must never crash fnc).
 *   3. Prune old session logs down to the most-recent `keep` (default 50).
 *   4. Build a file sink + logger and return them.
 *
 * Never throws. Every fs seam is injectable (mkdir/append/readdir/stat/unlink)
 * so tests exercise the whole wiring without writing into the real STATE dir.
 */

import { mkdirSync } from 'node:fs';

import { createFileSink } from './file-sink';
import { computeLogDir, computeLogFilePath } from './log-path';
import {
  createLogger,
  type Logger,
  NOOP_LOGGER,
  parseLevel,
  type LogLevel,
} from './logger';
import { pruneLogDir } from './prune';

const DEFAULT_LEVEL: LogLevel = 'info';
const DEFAULT_KEEP = 50;

export interface InitLoggingArgs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  pid?: number;
  ppid?: number;
  now?: () => number;
  configLevel?: string;
  keep?: number;
  // fs seams (production defaults wired below)
  mkdir?: (dir: string) => void;
  append?: (path: string, line: string) => void;
  readdir?: (dir: string) => string[];
  stat?: (path: string) => { mtimeMs: number };
  unlink?: (path: string) => void;
}

export interface InitLoggingResult {
  logger: Logger;
  logPath: string | null;
}

export function initLogging(args: InitLoggingArgs): InitLoggingResult {
  const now = args.now ?? Date.now;
  const pid = args.pid ?? process.pid;
  const ppid = args.ppid ?? process.ppid;

  // 1. Level precedence: env > config > default.
  const resolved = parseLevel(args.env.FNC_LOG) ?? parseLevel(args.configLevel) ?? DEFAULT_LEVEL;
  if (resolved === 'silent') {
    return { logger: NOOP_LOGGER, logPath: null };
  }

  // 2. Compute dir + path, mkdir -p. Failure → no-op logger.
  const dir = computeLogDir({ env: args.env, platform: args.platform, home: args.home });
  const timestampMs = now();
  const logPath = computeLogFilePath({ dir, pid, timestampMs });
  const mkdir = args.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true }));
  try {
    mkdir(dir);
  } catch {
    return { logger: NOOP_LOGGER, logPath: null };
  }

  // 3. Prune old logs (best-effort).
  pruneLogDir({
    dir,
    keep: args.keep ?? DEFAULT_KEEP,
    readdir: args.readdir,
    stat: args.stat,
    unlink: args.unlink,
  });

  // 4. Build the sink + logger.
  const sink = createFileSink({ path: logPath, append: args.append });
  const logger = createLogger({ sink, level: resolved, now, pid, ppid });
  return { logger, logPath };
}
