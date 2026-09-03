/**
 * §8.5 — post-`proc.exited` teardown decision.
 *
 * After claude exits, the parent fnclaude has two mutually-exclusive
 * roles depending on whether an MCP handoff (restart / project transfer)
 * is in flight:
 *
 *   - **No handoff** (`own-exit`): the parent owns the shutdown. On the
 *     useTerminal branch it restores cooked mode (`setRawMode(false)`),
 *     pauses its stdin reader, then runs the rest of its exit tail
 *     (cross-cwd scan, warnings flush, `process.exit`).
 *
 *   - **Handoff stashed** (`defer-to-handoff`): the awaiter side-promise
 *     has already (or is about to) SIGTERM claude and `reexecSelf` the
 *     new fnc as a child that inherits this process's stdio. The parent
 *     must NOT tear down the tty or exit on its own — doing so races the
 *     re-exec and, if the self-exit wins, orphans the child out of the
 *     controlling tty's foreground process group, so the child's
 *     `setRawMode(true)` hits EIO (errno 5). Instead the parent hands the
 *     tty over: it stops reading its own stdin (so the child reads the
 *     tty alone — two readers on one stdin fd is its own bug) and leaves
 *     termios untouched (the child owns raw mode; flipping it off here
 *     then having the child flip it back on races the brief window where
 *     the child isn't yet foreground). main.ts then awaits the awaiter,
 *     which keeps the parent alive + foreground until the child exits and
 *     `process.exit`s with the child's code.
 *
 * Pure: takes the post-exit inputs, returns the decision. The side-
 * effects (termios, stdin pause, awaiting the awaiter) live in main.ts.
 *
 * Design: specs/design.mcp.md §6; specs/decisions.md
 * ("setRawMode EIO on spawn-based re-exec handoff").
 */

export interface PostExitTeardownInput {
  /**
   * Whether the handoff trigger has accepted a stash
   * (`handoffTrigger.getStashedArgv() !== null`). True means an MCP
   * restart / switch is mid-handoff and the awaiter owns the relaunch.
   */
  handoffStashed: boolean;
  /**
   * Whether the session ran on the Bun.Terminal (PTY + raw-mode
   * forwarding) branch. False is the stdio-inherit branch, where the
   * parent never entered raw mode and never attached a stdin reader.
   */
  useTerminal: boolean;
}

export type PostExitTeardownDecision =
  | {
      kind: 'own-exit';
      /** Flip termios back to cooked. Only on the useTerminal branch. */
      restoreRawMode: boolean;
      /** Pause the parent's stdin reader. Only on the useTerminal branch. */
      releaseStdin: boolean;
    }
  | {
      kind: 'defer-to-handoff';
      /** Always false — the child owns termios across the handoff. */
      restoreRawMode: false;
      /**
       * Release the parent's stdin reader so the re-exec'd child reads
       * the tty alone. Only meaningful on the useTerminal branch, where
       * the parent attached a `data` listener + raw mode.
       */
      releaseStdin: boolean;
    };

/**
 * Decide what the parent does after `proc.exited` resolves.
 *
 * `defer-to-handoff` when a handoff is stashed — the parent skips its own
 * teardown+exit tail and hands the tty to the re-exec'd child.
 * `own-exit` otherwise — the parent restores the terminal and runs its
 * normal shutdown.
 */
export function decidePostExitTeardown(
  input: PostExitTeardownInput,
): PostExitTeardownDecision {
  if (input.handoffStashed) {
    return {
      kind: 'defer-to-handoff',
      restoreRawMode: false,
      releaseStdin: input.useTerminal,
    };
  }
  return {
    kind: 'own-exit',
    restoreRawMode: input.useTerminal,
    releaseStdin: input.useTerminal,
  };
}
