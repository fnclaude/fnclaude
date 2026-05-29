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

describe('reexecSelf — relaunch argv overrides inherited FNC_ARGS_JSON', () => {
  // Regression for the `fnc resume` picker loop (#55). The relaunch child is
  // spawned with the parent's env, which still carries the FNC_ARGS_JSON the
  // node→bun shim stuffed in for the *original* invocation (e.g. `["resume"]`).
  // main.ts's readArgv() reads FNC_ARGS_JSON *before* process.argv, so a stale
  // value shadows the reconstructed cross-cwd argv — the relaunched process
  // re-runs `resume`, lands back in the picker, and loops forever. reexecSelf
  // must hand the child a FNC_ARGS_JSON matching the argv it relaunches with.
  test('child env FNC_ARGS_JSON is the relaunch argv, not the inherited value', async () => {
    const prev = process.env.FNC_ARGS_JSON;
    process.env.FNC_ARGS_JSON = JSON.stringify(['resume']); // the stale loop trigger
    let capturedEnv: Record<string, string | undefined> | undefined;
    try {
      await reexecSelf({
        argv: ['/home/tom/src/proj', '--resume', 'abc-123'],
        clearScreen: () => {},
        spawn: (_argv, env) => {
          capturedEnv = env;
          return { exited: Promise.resolve(0) } as Pick<Bun.Subprocess, 'exited'>;
        },
        exit: () => undefined as never,
      });
    } finally {
      if (prev === undefined) delete process.env.FNC_ARGS_JSON;
      else process.env.FNC_ARGS_JSON = prev;
    }

    expect(capturedEnv?.FNC_ARGS_JSON).toBe(
      JSON.stringify(['/home/tom/src/proj', '--resume', 'abc-123']),
    );
  });
});
