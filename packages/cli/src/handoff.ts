// Port of src/handoff.go (fnclaude/fnclaude Go reference).
//
// Resolves the directory and per-session filenames that fnc uses for its
// AF_UNIX socket (parent listener) and handoff-summary scratch files, and
// renders the FNCLAUDE_HANDOFF + FNC_SOCKET pair to inject into the claude
// child's environment.

import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the directory where handoff files (socket and summary content)
 * should live. Single point of truth, used by both handoffSocketPath and
 * handoffContentPath.
 *
 * Preference order:
 *
 *  1. $XDG_RUNTIME_DIR — the Linux/systemd ideal: tmpfs, mode 700, auto-
 *     cleared on user logout. Permissions are restrictive by default so
 *     other users on the box can't read handoff content (often includes
 *     conversation context, tool-call results, or other session-private
 *     data).
 *  2. os.tmpdir() — the OS-native fallback. On Unix this honors $TMPDIR
 *     then falls back to /tmp; on macOS launchd sets $TMPDIR to a per-user
 *     mode-700 dir under /var/folders/; on Windows it returns %TMP% /
 *     %TEMP% / %USERPROFILE%. Using tmpdir() (vs a hardcoded "/tmp"
 *     literal) is what makes this code portable.
 */
export function handoffBaseDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return xdg;
  return tmpdir();
}

/**
 * Return the AF_UNIX socket path the parent listens on for MCP-side
 * Requests. PID is included so concurrent fnclaude sessions don't collide.
 *
 * AF_UNIX paths on Linux/Darwin are limited to ~108 bytes (sun_path
 * length); handoffBaseDir + "fnclaude-mcp-<pid>.sock" stays well under
 * that cap for every realistic PID.
 */
export function handoffSocketPath(pid: number): string {
  return join(handoffBaseDir(), `fnclaude-mcp-${pid}.sock`);
}

/**
 * Return the env-var entries (KEY=VALUE strings) that fnc injects into
 * the claude child's environment when auto-handoff is active.
 *
 *  - FNCLAUDE_HANDOFF=<mode> tells the noop session which UX to use when
 *    proposing a project transfer.
 *  - FNC_SOCKET=<path> tells the `fnclaude mcp` subprocess (spawned by
 *    claude) where to dial the parent's AF_UNIX listener.
 *
 * `mode` is the resolved Auto.Handoff value ("never", "ask", or a
 * non-negative integer); all three are valid here because the listener
 * still needs to answer OpRestart and OpCopy regardless of the noop
 * proposal mode.
 */
export function handoffEnv(mode: string, socketPath: string): string[] {
  return [`FNCLAUDE_HANDOFF=${mode}`, `FNC_SOCKET=${socketPath}`];
}

/**
 * Return a unique path where the listener can write the handoff summary
 * content for an OpSwitch Request. Uses a random hex token to guarantee
 * uniqueness — no risk of collision via PID recycling even if the user
 * delays pasting a rendered relaunch command for hours.
 */
export function handoffContentPath(): string {
  const base = handoffBaseDir();
  // 8 bytes → 16 hex chars, 64 bits of entropy.
  const token = randomBytes(8).toString('hex');
  return join(base, `fnclaude-handoff-content-${token}.md`);
}

/**
 * Configures fnc's auto-handoff machinery for a single PTY run. Passed as
 * a parameter to the spawn entry point; `null` means handoff disabled,
 * no env injection, no socket listener (the legacy code path).
 */
export interface HandoffSpec {
  /**
   * Resolved Auto.Handoff value ("never", "ask", or a non-negative
   * integer-as-string). The parent's socket-listener dispatcher consults
   * Mode when answering OpSwitch (initial, non-Confirmed) requests.
   */
  mode: string;

  /**
   * Filesystem path of the AF_UNIX socket the parent listens on for
   * MCP-side Requests. fnc generates this per-session from its PID so
   * concurrent sessions don't collide. The MCP subprocess receives it
   * via $FNC_SOCKET and dials it for every tool invocation.
   */
  socketPath: string;

  /**
   * Snapshot of process.argv from the fnclaude invocation (typically
   * `process.argv.slice(2)`), threaded through to the socket listener so
   * handleRestart and handleSwitch can preserve user-supplied flags across
   * the relaunch. Empty array is allowed — handlers fall back to the
   * flag-less relaunch shape.
   */
  originalArgs: string[];
}
