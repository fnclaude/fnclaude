/**
 * Cross-platform coordination-registry directory computation.
 *
 * One JSON file per live session lives at `<registry dir>/<session-id>.json`
 * (see SessionRegistry.ts). Pure functions — take an env map / platform /
 * home, return a path; no fs touches here. Mirrors the shape of
 * log/log-path.ts (empty-string env vars are treated as unset).
 *
 * Directory per platform (the OS-conventional STATE location — the registry
 * is mutable machine-local state, same category as logs):
 *   - win32:  %LOCALAPPDATA%\fnclaude\registry  (fallback ~\AppData\Local)
 *   - darwin: ~/Library/Application Support/fnclaude/registry
 *   - else:   $XDG_STATE_HOME/fnclaude/registry (fallback ~/.local/state)
 */

import { join } from 'node:path';

export interface ComputeRegistryDirArgs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

export function computeRegistryDir(args: ComputeRegistryDirArgs): string {
  const { env, platform, home } = args;
  if (platform === 'win32') {
    // Build with backslashes explicitly — node:path's `join` uses the *host*
    // separator, which would corrupt the AppData fallback path when these
    // functions run on a non-Windows CI box.
    const localAppData = isSet(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : `${home}\\AppData\\Local`;
    return `${localAppData}\\fnclaude\\registry`;
  }
  if (platform === 'darwin') {
    return `${home}/Library/Application Support/fnclaude/registry`;
  }
  const stateHome = isSet(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(stateHome, 'fnclaude', 'registry');
}

export function registryFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}
