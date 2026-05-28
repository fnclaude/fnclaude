/**
 * §8.5 — Production wiring for the kill-and-exec side-promise.
 *
 * `startHandoffAwaiter` is the parent-side glue that hooks the trigger
 * (fired by MCP dispatch) up to the kill sequence + process re-exec.
 * Spec: docs/design.mcp.md §6.
 *
 * The returned promise is "fire-and-forget" by design — if no handoff
 * ever fires, the awaiter sits idle for the lifetime of the session,
 * then the orphaned promise gets garbage-collected with the rest of
 * main.ts's state when the parent exits naturally. If a handoff DOES
 * fire, the kill sequence runs, claude exits, and then the re-exec
 * either swaps the process image (true execve, not available under
 * Bun) or in the Bun.spawn-based shim, spawns a child, waits, then
 * `process.exit`s with the child's code.
 *
 * Tests pass injected `execve`/`signalSend`/`sleep` so they can
 * exercise the wiring without actually killing or re-executing.
 */

import { killAndExec, type KillAndExecArgs, type SignalName } from './kill-and-exec.ts';
import type { HandoffTrigger } from './trigger.ts';

export interface StartHandoffAwaiterArgs {
  trigger: HandoffTrigger;
  proc: Pick<Bun.Subprocess, 'exited' | 'kill'>;
  /** Optional override for the kill-and-exec primitive (test seam). */
  killAndExec?: (a: KillAndExecArgs) => Promise<void>;
  /** Optional override for the signal sender (test seam). */
  signalSend?: (signal: SignalName) => void;
  /** Optional override for sleep (test seam). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional override for the re-exec primitive (test seam). */
  execve?: (argv: string[]) => void | Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * Start the awaiter. Returns the side-promise (caller is expected to
 * fire-and-forget; no need to await unless you want the kill+exec to
 * complete first). If the trigger never fires, the promise sits
 * pending until process exit.
 */
export function startHandoffAwaiter(args: StartHandoffAwaiterArgs): Promise<void> {
  const platform = args.platform ?? process.platform;
  const sleep =
    args.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const signalSend =
    args.signalSend ??
    ((signal: SignalName): void => {
      // proc.kill returns false if the process has already exited; that's
      // expected after the 200 ms grace window when SIGTERM landed. Don't
      // throw — the parent's only job left is to await `exited` and
      // re-exec.
      try {
        args.proc.kill(signal);
      } catch {
        // ESRCH/EPERM: already-reaped or out-of-our-pgrp. Ignore.
      }
    });
  const execve = args.execve ?? defaultExecve;
  const killFn = args.killAndExec ?? killAndExec;

  return (async (): Promise<void> => {
    await args.trigger.awaitTrigger();
    const stashedArgv = args.trigger.getStashedArgv();
    if (stashedArgv === null) {
      // Trigger fired but nothing stashed — shouldn't happen under the
      // §6.1 contract (the dispatcher always stashes before firing), but
      // bail rather than re-exec into a nil argv if it ever does.
      return;
    }
    await killFn({
      proc: args.proc,
      stashedArgv,
      signalSend,
      sleep,
      execve,
      platform,
    });
  })();
}

/**
 * Default re-exec primitive. Wraps the reusable `reexecSelf` helper —
 * shared with §9.3's cross-cwd silent relaunch path.
 */
async function defaultExecve(argv: string[]): Promise<void> {
  await reexecSelf({ argv });
}

/**
 * Process image replacement via Bun.spawn — shared between §8.5's
 * handoff exec and §9.3's cross-cwd silent relaunch.
 *
 * Bun has no `execve` binding — true process image replacement isn't
 * possible. The closest stable analog is
 * `Bun.spawn(process.execPath, [bin, ...argv])`, then await the
 * child's exit and `process.exit` with the child's code.
 *
 * The fnc bin lives at `process.argv[1]` (already resolved by the
 * shim) by default; callers can override via `args.fncBin`. The same
 * runtime that's currently executing (`process.execPath` by default)
 * hosts the child so any preflight/argv-rehydration step runs
 * identically on the relaunch.
 *
 * Never returns on success — `process.exit(code)` ends the parent
 * before this promise resolves. The signature is `Promise<never>` to
 * keep TypeScript honest about the control-flow.
 *
 * Deviation from Go canonical (true execve) is documented in
 * docs/decisions.md.
 */
export interface ReexecSelfArgs {
  /** Argv to hand the new fnclaude process (excluding bin path / runtime). */
  argv: string[];
  /** Override the Bun executable. Defaults to `process.execPath`. */
  bunExec?: string;
  /**
   * Override the fnc bin path passed to bun as argv[0]. Defaults to
   * `process.argv[1] ?? ''` — the same script that the parent is
   * running.
   */
  fncBin?: string;
}

export async function reexecSelf(args: ReexecSelfArgs): Promise<never> {
  const bunExec = args.bunExec ?? process.execPath;
  const fncBin = args.fncBin ?? process.argv[1] ?? '';
  const child = Bun.spawn([bunExec, fncBin, ...args.argv], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  process.exit(code);
}
