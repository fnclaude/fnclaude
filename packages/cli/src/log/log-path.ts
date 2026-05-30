/**
 * Cross-platform log directory + file-path computation for the launcher's
 * file-only logging subsystem.
 *
 * Pure functions — take an env map / platform / home, return a path. No fs
 * touches here; the caller (init.ts) mkdir's and writes. Mirrors the shape of
 * mcp/socket-path.ts: empty-string env vars are treated as unset (matches the
 * `x !== undefined && x !== ''` house pattern).
 *
 * Directory per platform (the OS-conventional STATE/log location):
 *   - win32:  %LOCALAPPDATA%\fnclaude\logs  (fallback ~\AppData\Local)
 *   - darwin: ~/Library/Logs/fnclaude
 *   - else:   $XDG_STATE_HOME/fnclaude/logs (fallback ~/.local/state)
 *
 * Filenames use epoch-ms + pid (`fnclaude-<ms>-<pid>.jsonl`) so concurrent
 * sessions never collide and the name stays Windows-filename-safe (no colons,
 * unlike an ISO timestamp).
 */

import { join } from 'node:path';

export interface ComputeLogDirArgs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

export function computeLogDir(args: ComputeLogDirArgs): string {
  const { env, platform, home } = args;
  if (platform === 'win32') {
    // Build with backslashes explicitly — node:path's `join` uses the *host*
    // separator (a forward slash when these functions run on a non-Windows
    // CI box), which would corrupt the AppData fallback path.
    const localAppData = isSet(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : `${home}\\AppData\\Local`;
    return `${localAppData}\\fnclaude\\logs`;
  }
  if (platform === 'darwin') {
    return `${home}/Library/Logs/fnclaude`;
  }
  const stateHome = isSet(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(stateHome, 'fnclaude', 'logs');
}

export interface LogFileNameArgs {
  pid: number;
  timestampMs: number;
}

export function logFileName(args: LogFileNameArgs): string {
  return `fnclaude-${args.timestampMs}-${args.pid}.jsonl`;
}

export interface ComputeLogFilePathArgs {
  dir: string;
  pid: number;
  timestampMs: number;
}

export function computeLogFilePath(args: ComputeLogFilePathArgs): string {
  return join(args.dir, logFileName({ pid: args.pid, timestampMs: args.timestampMs }));
}
