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
/** ANSI: clear the screen + home the cursor. Mirrors Go's clearScreen(). */
const CLEAR_SCREEN_SEQ = '\x1b[2J\x1b[H';

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
  /**
   * Test seam: emit the clear-screen escape. Defaults to writing
   * CLEAR_SCREEN_SEQ to process.stdout.
   */
  clearScreen?: (seq: string) => void;
  /**
   * Test seam: spawn the relaunch child. Defaults to Bun.spawn. Receives
   * the child env (with FNC_ARGS_JSON rewritten to the relaunch argv) as a
   * second argument so callers/tests can assert on it.
   */
  spawn?: (
    argv: string[],
    env: Record<string, string | undefined>,
  ) => Pick<Bun.Subprocess, 'exited'>;
  /** Test seam: process exit. Defaults to process.exit. */
  exit?: (code: number) => never;
}

export async function reexecSelf(args: ReexecSelfArgs): Promise<never> {
  const bunExec = args.bunExec ?? process.execPath;
  const fncBin = args.fncBin ?? process.argv[1] ?? '';
  const clearScreen =
    args.clearScreen ??
    ((seq: string): void => {
      process.stdout.write(seq);
    });
  const spawn =
    args.spawn ??
    ((argv: string[], env: Record<string, string | undefined>): Pick<Bun.Subprocess, 'exited'> =>
      Bun.spawn(argv, {
        cwd: process.cwd(),
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      }));
  const exit = args.exit ?? ((code: number): never => process.exit(code));

  // Rewrite FNC_ARGS_JSON to THIS relaunch's argv. The parent inherited the
  // var from the node→bun preflight shim (bin/fnc.js), where it holds the
  // *original* invocation (e.g. `["resume"]`). main.ts's readArgv() reads
  // FNC_ARGS_JSON before process.argv, so passing the parent's stale value
  // would shadow the reconstructed argv below — the relaunched process would
  // re-run the original command (back to the picker) and loop forever (#55).
  // Stamping it with the real relaunch argv keeps readArgv and the spawn argv
  // in agreement and preserves the `--`-safety the shim provides.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    FNC_ARGS_JSON: JSON.stringify(args.argv),
  };

  // Clear the screen before handing off — hides the flicker of claude's
  // "This conversation is from a different directory." block that already
  // scrolled to the terminal before the cross-cwd hint was detected.
  // Mirrors Go canonical's clearScreen() call immediately before exec in
  // silentRelaunch / silentRelaunchHandoff (pty_run_unix.go).
  clearScreen(CLEAR_SCREEN_SEQ);

  const child = spawn([bunExec, fncBin, ...args.argv], childEnv);
  const code = await child.exited;
  return exit(code);
}
