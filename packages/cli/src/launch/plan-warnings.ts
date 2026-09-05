/**
 * The plan-phase warning sink (design.di-architecture §4, §6).
 *
 * A minimal add/drain buffer the plan root registers and the Planner drains onto
 * `plan.warnings`. Sugar-free, so it constructs in a unit test with zero DI.
 */

import type { IWarningBuffer } from './contracts';

/** A fresh warning sink: queue with `add`, empty and read with `drain`. */
export function createPlanWarnings(): IWarningBuffer {
  const queue: string[] = [];
  return {
    add: (msg) => {
      queue.push(msg);
    },
    drain: () => queue.splice(0),
  };
}
