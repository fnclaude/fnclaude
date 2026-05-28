/**
 * §8.5 — Handoff trigger primitive.
 *
 * The parent's MCP dispatch goroutine fires `Triggered` when a `restart`
 * or non-`never`-mode `switch` arrives; a separate awaiter (started at
 * parent startup) blocks on it until then. Two pieces:
 *
 *   1. `stashArgv` — first-stash-wins shared field for the relaunch
 *      argv. Mirrors Go canonical's `sync.Mutex` + nil-check pattern
 *      (mcpserver.HandoffTrigger.Stash, see Go src/handoff.go for the
 *      reference). The "rare race" in design.mcp.md §8 (concurrent
 *      restart + switch) lands here: both stashes succeed at the JSON-
 *      RPC layer; only the first one's argv survives to drive the kill.
 *
 *   2. `fire` + `awaitTrigger` — one-shot signal. `fire` is idempotent;
 *      a second call is a no-op. `awaitTrigger` returns a promise that
 *      resolves the moment `fire` runs, or immediately if `fire` already
 *      ran before the await was created. Multiple awaiters are fine —
 *      all resolve on the same fire.
 *
 * Design: docs/design.mcp.md §6.1, §8 (concurrent-dispatch race).
 */

export interface HandoffTrigger {
  /**
   * Stash the relaunch argv. Returns true on the first call (argv now
   * owned by the trigger), false on every subsequent call (the caller's
   * argv is dropped silently — first-stash-wins semantics).
   */
  stashArgv: (argv: string[]) => boolean;
  /**
   * Read back the stashed argv. Null when no stash has happened yet.
   * The reference is shared — callers must not mutate.
   */
  getStashedArgv: () => string[] | null;
  /**
   * Fire the trigger. Idempotent — a second call is a no-op (the
   * underlying promise stays resolved; no second resolution happens).
   */
  fire: () => void;
  /**
   * Resolve when `fire` has been called (now or in the future). Multiple
   * awaiters all see the same fire. If `fire` already ran, the returned
   * promise resolves on the next microtask.
   */
  awaitTrigger: () => Promise<void>;
}

/**
 * Module-level singleton mirroring Go canonical's
 * `mcpserver.HandoffTrigger`. The parent's MCP dispatch tools and the
 * kill-and-exec awaiter both refer to this one instance; tests that
 * exercise the trigger contract should use `createHandoffTrigger`
 * directly to keep state hermetic.
 */
export const handoffTrigger: HandoffTrigger = createHandoffTriggerFactory();

export function createHandoffTrigger(): HandoffTrigger {
  return createHandoffTriggerFactory();
}

function createHandoffTriggerFactory(): HandoffTrigger {
  let stashed: string[] | null = null;
  let fired = false;
  let resolveFn: (() => void) | null = null;
  const triggered = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });

  return {
    stashArgv(argv: string[]): boolean {
      if (stashed !== null) return false;
      stashed = argv;
      return true;
    },
    getStashedArgv(): string[] | null {
      return stashed;
    },
    fire(): void {
      if (fired) return;
      fired = true;
      // `resolveFn` is always set by the time fire() can run — the
      // Promise constructor runs its executor synchronously.
      resolveFn!();
    },
    awaitTrigger(): Promise<void> {
      return triggered;
    },
  };
}
