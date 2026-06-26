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

import { reexecSelf } from '../../src/handoff/awaiter';

const CLEAR_SCREEN = '\x1b[2J\x1b[H';

describe('reexecSelf — clear screen before relaunch', () => {
  test('writes the clear-screen escape before spawning the child', async () => {
    const events: string[] = [];

    await reexecSelf({
      argv: ['/dest', '--resume', 'x'],
      clearScreen: (seq: string) => {
        events.push(`clear:${seq}`);
      },
      // Force the spawn fallback so the test never actually execve's the
      // runner. `false` = "execve unavailable" → reexecSelf spawns instead.
      exec: () => {
        events.push('exec-unavailable');
        return false;
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

describe('reexecSelf — #205 symptom 1: prefers execve, no spawn fallback', () => {
  // The stacking bug came from spawn-and-wait: the parent stayed alive as an
  // ancestor of every relaunch. reexecSelf must attempt a true execve FIRST
  // and, when it succeeds (image replaced — never returns in production),
  // must NOT also spawn a child.
  test('execve available → spawn fallback is never reached', async () => {
    const events: string[] = [];
    // A real execvp never returns; model the success case by recording the
    // call and then short-circuiting via the exit seam (execImage returning
    // anything other than false signals "replaced").
    await reexecSelf({
      argv: ['/dest', '--resume', 'abc'],
      clearScreen: () => {},
      exec: (argv) => {
        events.push(`exec:${argv.join(' ')}`);
        // Truthy-non-false return = "image replaced"; reexecSelf must not
        // fall through to spawn. (Real execvp never returns at all.)
        return true as unknown as false;
      },
      spawn: () => {
        events.push('spawn');
        return { exited: Promise.resolve(0) } as Pick<Bun.Subprocess, 'exited'>;
      },
      exit: () => undefined as never,
    });

    expect(events.some((e) => e.startsWith('exec:'))).toBe(true);
    expect(events).not.toContain('spawn');
  });

  test('execve unavailable → falls back to spawn-and-wait', async () => {
    const events: string[] = [];
    await reexecSelf({
      argv: ['/dest', '--resume', 'abc'],
      clearScreen: () => {},
      exec: () => false, // execve not available on this platform
      spawn: () => {
        events.push('spawn');
        return { exited: Promise.resolve(0) } as Pick<Bun.Subprocess, 'exited'>;
      },
      exit: () => undefined as never,
    });

    expect(events).toContain('spawn');
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
        exec: () => false, // force the spawn fallback for the env assertion
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

describe('reexecSelf — stale captured bin path after mise upgrade', () => {
  // A long-running session captures the fnc bin as the VERSION-PINNED mise
  // path (…/installs/npm-fnclaude-cli/<VER>/…/bin/fnc.js). `mise upgrade`
  // deletes that version dir out from under the live session, so the
  // captured path no longer exists. Re-exec'ing `bun <stale-path>` dies with
  // "Module not found". When the captured bin is gone, reexecSelf must
  // re-resolve the `fnc` COMMAND from PATH (the stable mise shim, which
  // survives version-dir deletion) and exec it directly — no bun prefix,
  // since the shim re-bootstraps the runtime itself.
  const STALE_BIN =
    '/home/tom/.local/share/mise/installs/npm-fnclaude-cli/2.13.1/lib/node_modules/@fnclaude/cli/bin/fnc.js';
  const SHIM = '/home/tom/.local/share/mise/shims/fnc';
  const BUN = '/runtime/bin/bun';

  test('bin gone + PATH resolves → exec the shim directly, no bun prefix', async () => {
    let execArgv: string[] | undefined;
    await reexecSelf({
      argv: ['/dest', '--resume', 'x'],
      bunExec: BUN,
      fncBin: STALE_BIN,
      clearScreen: () => {},
      binExists: () => false, // version dir deleted by `mise upgrade`
      whichFnc: () => SHIM,
      exec: (argv) => {
        execArgv = argv;
        return true as unknown as false;
      },
      spawn: () => ({ exited: Promise.resolve(0) }) as Pick<Bun.Subprocess, 'exited'>,
      exit: () => undefined as never,
    });

    expect(execArgv).toEqual([SHIM, '/dest', '--resume', 'x']);
  });

  test('bin present → unchanged: exec [bunExec, fncBin, ...argv]', async () => {
    let execArgv: string[] | undefined;
    await reexecSelf({
      argv: ['/dest', '--resume', 'x'],
      bunExec: BUN,
      fncBin: STALE_BIN,
      clearScreen: () => {},
      binExists: () => true,
      whichFnc: () => SHIM,
      exec: (argv) => {
        execArgv = argv;
        return true as unknown as false;
      },
      spawn: () => ({ exited: Promise.resolve(0) }) as Pick<Bun.Subprocess, 'exited'>,
      exit: () => undefined as never,
    });

    expect(execArgv).toEqual([BUN, STALE_BIN, '/dest', '--resume', 'x']);
  });

  test('bin gone + PATH resolution fails → best-effort [bunExec, fncBin, ...argv]', async () => {
    let execArgv: string[] | undefined;
    await reexecSelf({
      argv: ['/dest', '--resume', 'x'],
      bunExec: BUN,
      fncBin: STALE_BIN,
      clearScreen: () => {},
      binExists: () => false,
      whichFnc: () => null, // not on PATH either
      exec: (argv) => {
        execArgv = argv;
        return true as unknown as false;
      },
      spawn: () => ({ exited: Promise.resolve(0) }) as Pick<Bun.Subprocess, 'exited'>,
      exit: () => undefined as never,
    });

    expect(execArgv).toEqual([BUN, STALE_BIN, '/dest', '--resume', 'x']);
  });
});
