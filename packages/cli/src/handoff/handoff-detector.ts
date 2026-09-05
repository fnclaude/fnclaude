/**
 * The run root's {@link IHandoffDetector}: it races the handoff trigger against
 * claude's exit and, when a handoff fires, runs the same SIGTERM→SIGKILL kill
 * sequence the pre-DI awaiter used ({@link killAndExec}) — but with a no-op execve,
 * because the re-exec tail now runs in `run.ts` after container disposal, a hard
 * happens-before rather than the old teardown-vs-execve race (design.di-architecture
 * §2 doctrine 5).
 */

import type { ClaudeProcess, IHandoffDetector, IHandoffTrigger } from '../launch/contracts';
import { killAndExec, type SignalName } from './kill-and-exec';

/** Seams for {@link createHandoffDetector}, injectable so the kill sequence is testable. */
export interface HandoffDetectorDeps {
  /** The shared handoff trigger an MCP restart/switch fires. */
  trigger: IHandoffTrigger;
  /** `process.platform`; win32 collapses the kill sequence to a single signal. */
  platform?: NodeJS.Platform;
  /** Async sleep for the SIGTERM grace window. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Build the detector bound to the trigger; the kill runs against the proc race passes it. */
export function createHandoffDetector(deps: HandoffDetectorDeps): IHandoffDetector {
  const platform = deps.platform ?? process.platform;
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    async race(proc: ClaudeProcess): Promise<readonly string[] | undefined> {
      const firedFirst = await Promise.race([
        deps.trigger.awaitTrigger().then(() => true),
        proc.exited.then(() => false),
      ]);
      if (!firedFirst) return undefined;

      const stashed = deps.trigger.getStashedArgv();
      if (stashed === null) return undefined;

      // Kill claude and await its reaping; the execve is deliberately a no-op — run.ts
      // replaces the image after disposal, not here.
      await killAndExec({
        proc,
        stashedArgv: [...stashed],
        signalSend: (signal: SignalName): void => {
          try {
            proc.kill(signal);
          } catch {
            // already reaped / out of our pgrp — the parent's job is done regardless
          }
        },
        sleep,
        execve: () => {},
        platform,
      });
      return stashed;
    },
  };
}
