/**
 * Owner liveness for coordination-registry entries.
 *
 * An entry records its owner as `{ pid, starttime }`, where starttime is
 * field 22 of /proc/<pid>/stat captured at registration. Liveness = the pid
 * is alive AND its CURRENT starttime matches the recorded one. The
 * starttime match guards pid reuse: a recycled pid gets a fresh starttime,
 * so a stale entry whose pid number happens to be alive again still reads
 * as dead.
 *
 * Starttime is kept as a STRING and compared for equality only — no
 * numeric interpretation, so clock-tick units and integer width never
 * matter. When starttime is unavailable on either side (non-Linux platform,
 * unreadable /proc), liveness degrades to pid-aliveness alone.
 *
 * The /proc/<pid>/stat parse anchors on the LAST ')' — comm (field 2) is
 * the process name in parens and may itself contain spaces and parens, so
 * a naive split on whitespace mis-fields any entry whose comm does (e.g.
 * `(tmux: server)`).
 */

import { readFileSync } from 'node:fs';

export interface RegistryOwner {
  pid: number;
  /** Field 22 of /proc/<pid>/stat at registration, or null if unreadable. */
  starttime: string | null;
}

/**
 * Extract field 22 (starttime) from the content of /proc/<pid>/stat.
 * Returns null when the content doesn't look like a stat line or is too
 * short to carry field 22.
 */
export function parseStarttime(statContent: string): string | null {
  const closeParen = statContent.lastIndexOf(')');
  if (closeParen < 0) {
    return null;
  }
  // Fields after comm start at field 3 (state); starttime is field 22 →
  // index 19 of the post-comm split.
  const rest = statContent.slice(closeParen + 1).trim().split(/\s+/);
  const starttime = rest[19];
  if (starttime === undefined || !/^\d+$/.test(starttime)) {
    return null;
  }
  return starttime;
}

/** Read the current starttime for `pid`, or null when /proc is unavailable. */
export function readStarttime(pid: number): string | null {
  try {
    return parseStarttime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Signal-0 pid probe. EPERM means "alive but not ours" — still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Injectable probes for {@link isOwnerLive}; default to the real /proc + kill(0). */
export interface LivenessDeps {
  pidAlive: (pid: number) => boolean;
  readStarttime: (pid: number) => string | null;
}

const defaultDeps: LivenessDeps = { pidAlive, readStarttime };

export function isOwnerLive(owner: RegistryOwner, deps: LivenessDeps = defaultDeps): boolean {
  if (!deps.pidAlive(owner.pid)) {
    return false;
  }
  if (owner.starttime === null) {
    // Recorded without a starttime (non-Linux) — pid-aliveness is all we have.
    return true;
  }
  const current = deps.readStarttime(owner.pid);
  if (current === null) {
    // Current starttime unreadable — degrade to pid-aliveness.
    return true;
  }
  return current === owner.starttime;
}
