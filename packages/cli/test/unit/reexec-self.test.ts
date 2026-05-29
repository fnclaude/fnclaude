/**
 * §9.3 / §8.5 — `reexecSelf` clears the screen before handing off.
 *
 * Go canonical (`silentRelaunch` / `silentRelaunchHandoff` in
 * pty_run_unix.go) calls `clearScreen()` — writing `\033[2J\033[H` — right
 * before `syscall.Exec`, to hide the flicker of claude's "This conversation
 * is from a different directory." block that already scrolled to the
 * terminal before fnclaude detected the cross-cwd hint. The TS port skipped
 * it. This test pins the ported behavior: the clear sequence is written
 * BEFORE the relaunch spawn.
 */

import { describe, expect, test } from 'bun:test';

import { reexecSelf } from '../../src/handoff/awaiter.ts';

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

describe('reexecSelf — clear screen before relaunch', () => {
  test('writes the clear-screen escape before spawning the child', async () => {
    const events: string[] = [];

    await reexecSelf({
      argv: ['/dest', '--resume', 'x'],
      clearScreen: (seq: string) => {
        events.push(`clear:${seq}`);
      },
      spawn: () => {
        events.push('spawn');
        return {
          exited: Promise.resolve(0),
        } as Pick<Bun.Subprocess, 'exited'>;
      },
      // exit seam so the test process is never actually killed; recording
      // it lets us assert the full ordering: clear → spawn → exit.
      exit: (code: number) => {
        events.push(`exit:${code}`);
        return undefined as never;
      },
    });

    expect(events[0]).toBe(`clear:${CLEAR_SCREEN}`);
    expect(events.indexOf(`clear:${CLEAR_SCREEN}`)).toBeLessThan(
      events.indexOf('spawn'),
    );
    expect(events.indexOf('spawn')).toBeLessThan(events.indexOf('exit:0'));
  });
});
