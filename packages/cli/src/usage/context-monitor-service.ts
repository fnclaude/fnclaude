/**
 * The run root's {@link IContextMonitor}: a wrapper constructed empty (the poll needs
 * claude's pid to pin the session JSONL, so it cannot start at resolve time) whose
 * {@link ContextMonitorService.start} begins polling post-spawn and whose disposal
 * stops the timer (design.di-architecture §4).
 */

import type { FnConfig } from '../config/load';
import type { IContextMonitor, IControlSeamHolder, ILogger, LaunchPlan } from '../launch/contracts';
import { deriveAutoCompactThreshold } from './autocompact-threshold';
import {
  resolveContextNoticeLadder,
  startContextMonitor,
  type RunningContextMonitor,
} from './context-monitor';
import { makeOwnSessionFileResolver } from './proc-session-id';

export class ContextMonitorService implements IContextMonitor {
  readonly #config: FnConfig;
  readonly #plan: LaunchPlan;
  readonly #controlSeam: IControlSeamHolder;
  readonly #log: ILogger;
  #running: RunningContextMonitor | null = null;

  constructor(config: FnConfig, plan: LaunchPlan, controlSeam: IControlSeamHolder, log: ILogger) {
    this.#config = config;
    this.#plan = plan;
    this.#controlSeam = controlSeam;
    this.#log = log;
  }

  start(proc: Pick<Bun.Subprocess, 'pid'>): void {
    const ladder = resolveContextNoticeLadder({
      configLadder: this.#config.contextNoticeLadder,
      configThreshold: this.#config.contextNoticeThreshold,
    });
    this.#running = startContextMonitor({
      launchCWD: this.#plan.launchCWD,
      ladder,
      sendControl: this.#controlSeam.sendControl,
      deriveThreshold: (model: string) => deriveAutoCompactThreshold({ model, env: this.#plan.env }),
      ownSessionFile: makeOwnSessionFileResolver({
        upfrontId: this.#plan.sessionID,
        claudePid: proc.pid,
      }),
    });
    this.#log.info('context.monitor.start', { claudePid: proc.pid });
  }

  [Symbol.dispose](): void {
    this.#running?.stop();
    this.#running = null;
  }
}
