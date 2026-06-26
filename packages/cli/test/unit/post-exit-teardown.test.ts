/**
 * §8.5 regression — post-`proc.exited` teardown vs. MCP-handoff handover.
 *
 * Bug (real run): `restart yourself` / project transfer crash the relaunched
 * fnc with `setRawMode failed with errno: 5` (EIO). Root cause is a race in
 * main.ts after `proc.exited` resolves:
 *
 *   - The MCP restart/switch handler stashes argv + fires the handoff
 *     trigger. The awaiter side-promise SIGTERMs claude, awaits its exit,
 *     then `reexecSelf` spawns the new fnc as a CHILD of the old fnc and
 *     keeps the old fnc alive (foreground pgrp shared) until the child
 *     exits.
 *   - MEANWHILE the main flow's `await proc.exited` ALSO resolves and, in
 *     the buggy code, unconditionally runs its own teardown tail:
 *     `setRawMode(false)` + `process.exit(exitCode)`.
 *   - When the main flow's `process.exit` wins the race the old fnc dies,
 *     the shell reclaims the controlling tty's foreground process group,
 *     the just-spawned child is orphaned, and the child's
 *     `setRawMode(true)` → tcsetattr from a non-foreground pgrp → EIO.
 *
 * The fix: after `proc.exited`, when a handoff has been stashed, the parent
 * must NOT run its own teardown+exit tail. It must instead hand the tty
 * over to the re-exec'd child — stop reading its own stdin, leave termios
 * alone (let the child own raw mode), and await the awaiter promise (which
 * keeps the parent alive + foreground until the child exits, then exits
 * with the child's code).
 *
 * This exercises the pure decision that encodes that branch. The buggy
 * pre-fix behaviour returns `{ kind: 'own-exit' }` (restore raw mode, run
 * own exit) even when a handoff was stashed; the fix returns
 * `{ kind: 'defer-to-handoff' }` so main.ts skips its teardown tail.
 */

import { describe, expect, test } from 'bun:test';

import { decidePostExitTeardown } from '../../src/handoff/post-exit-teardown';

describe('decidePostExitTeardown — MCP handoff stashed', () => {
  test('handoff stashed → defer to awaiter, do NOT restore raw mode or self-exit', () => {
    const decision = decidePostExitTeardown({
      handoffStashed: true,
      useTerminal: true,
    });

    // The crux of the regression: when a handoff is in flight the parent
    // must hand the tty to the child, not tear it down + exit itself.
    expect(decision.kind).toBe('defer-to-handoff');
    if (decision.kind === 'defer-to-handoff') {
      // It must release its own stdin so the child reads the tty alone
      // (two processes on the same stdin fd is its own bug)...
      expect(decision.releaseStdin).toBe(true);
      // ...and it must NOT flip termios back to cooked — the child owns
      // raw mode now; flipping off then having the child flip on races
      // the brief window where the child isn't yet foreground.
      expect(decision.restoreRawMode).toBe(false);
    }
  });

  test('handoff stashed but non-terminal branch → still defer, no stdin release needed', () => {
    const decision = decidePostExitTeardown({
      handoffStashed: true,
      useTerminal: false,
    });
    expect(decision.kind).toBe('defer-to-handoff');
    if (decision.kind === 'defer-to-handoff') {
      // No raw-mode forwarding in the inherit branch, so nothing to
      // restore; stdin wasn't being read by the parent either.
      expect(decision.restoreRawMode).toBe(false);
      expect(decision.releaseStdin).toBe(false);
    }
  });
});

describe('decidePostExitTeardown — no handoff (normal exit)', () => {
  test('terminal branch, no handoff → own teardown: restore raw mode + self-exit', () => {
    const decision = decidePostExitTeardown({
      handoffStashed: false,
      useTerminal: true,
    });
    expect(decision.kind).toBe('own-exit');
    if (decision.kind === 'own-exit') {
      expect(decision.restoreRawMode).toBe(true);
    }
  });

  test('inherit branch, no handoff → own teardown, no raw mode to restore', () => {
    const decision = decidePostExitTeardown({
      handoffStashed: false,
      useTerminal: false,
    });
    expect(decision.kind).toBe('own-exit');
    if (decision.kind === 'own-exit') {
      expect(decision.restoreRawMode).toBe(false);
    }
  });
});
