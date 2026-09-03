/**
 * §8.5 — Kill sequence + process image replacement.
 *
 * When the parent's `awaitTrigger()` resolves (the MCP dispatcher fired
 * a handoff), the parent has to:
 *
 *   1. Send SIGTERM to the claude subprocess.
 *   2. Wait 200 ms.
 *   3. If claude hasn't exited, send SIGKILL.
 *   4. Await `proc.exited` so we know claude is reaped.
 *   5. Replace the parent's process image with `fnclaude <stashed argv>`.
 *
 * On Windows the kill sequence collapses to a single TerminateProcess-
 * equivalent (no graceful path), per design.mcp.md §6.1.
 *
 * **Why a side-effect injection seam:** the real `execve` and the real
 * `process.kill` are end-of-line operations — once they fire, the
 * process is gone or has different bytes in memory. Tests must run them
 * as injected callbacks so the test harness keeps running afterwards.
 *
 * **Why not real execve:** TS/Bun has no `execve` binding (Go's
 * `syscall.Exec` swaps the running process image in place). The closest
 * stable analog under Bun is `Bun.spawn(process.execPath, [bin, ...argv])`
 * — a child that inherits stdio and that the parent waits on. The
 * decision to use spawn-and-wait instead of true execve is documented
 * in specs/decisions.md ("Process image replacement via Bun.spawn").
 *
 * Design: specs/design.mcp.md §6.1, §6.2.
 */

export type SignalName = 'SIGTERM' | 'SIGKILL';

export interface KillAndExecArgs {
  /** Subprocess to terminate. Only `exited` is awaited; killing is via signalSend. */
  proc: Pick<Bun.Subprocess, 'exited'>;
  /** Argv to relaunch with after claude exits. */
  stashedArgv: string[];
  /**
   * Deliver a signal to the subprocess. Injected so tests can record
   * signals without actually killing anything. Production wires this
   * to `proc.kill(<signal>)`.
   */
  signalSend: (signal: SignalName) => void;
  /** Async sleep, injected so tests don't actually wait. */
  sleep: (ms: number) => Promise<void>;
  /**
   * Process-image-replacement. Injected so tests don't actually re-exec.
   * Production wires this to a `Bun.spawn` + `await child.exited` →
   * `process.exit(<code>)` sequence (see specs/decisions.md for why
   * Bun.spawn instead of native execve).
   */
  execve: (argv: string[]) => void | Promise<void>;
  /** `process.platform`. `win32` collapses the kill sequence to one signal. */
  platform: NodeJS.Platform;
}

const KILL_GRACE_MS = 200;

export async function killAndExec(args: KillAndExecArgs): Promise<void> {
  if (args.platform === 'win32') {
    // No graceful path on Windows — the closest analog to TerminateProcess
    // is a hard kill, surfaced through the same signalSend seam (callers
    // map it to `proc.kill()` on win32).
    args.signalSend('SIGKILL');
  } else {
    args.signalSend('SIGTERM');
    await args.sleep(KILL_GRACE_MS);
    // Race-aware: if proc has already exited by now, SIGKILL on a reaped
    // PID is a no-op error at the OS level; we hand it to signalSend
    // anyway and let production wiring (proc.kill) swallow the EPERM/
    // ESRCH. Tests that resolve `exited` on SIGTERM never see a SIGKILL
    // because we check before sending.
    const stillAlive = await isStillRunning(args.proc.exited);
    if (stillAlive) {
      args.signalSend('SIGKILL');
    }
  }

  // Wait for claude to be fully reaped before we re-exec. On Unix this
  // is the moment after the kernel delivers the signal and the parent
  // collects the exit status; without it the new process image could
  // race against the dying child's last writes to the controlling TTY.
  await args.proc.exited;

  await args.execve(args.stashedArgv);
}

/**
 * Resolve true iff `exited` has NOT resolved by the next macrotask.
 * Used to gate the SIGKILL escalation — we only want to send the
 * hard-kill if SIGTERM didn't already cause the process to exit during
 * the 200 ms grace window.
 *
 * The `setTimeout(0)` is important: a plain `Promise.resolve()` race
 * loses to an already-settled `exited` only if the .then() chain has
 * already drained. A short macrotask boundary gives the existing
 * promise pipeline (including .then chains hung off `exited` by the
 * test fake or by Bun.Subprocess itself) time to settle before we
 * decide whether to escalate.
 */
async function isStillRunning(exited: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('still-alive');
  const result = await Promise.race([
    exited.then(() => 'exited' as const),
    new Promise<typeof marker>((resolve) => {
      setTimeout(() => resolve(marker), 0);
    }),
  ]);
  return result === marker;
}
