/**
 * §8.5 — Kill sequence + process image replacement.
 *
 * `killAndExec` runs once the parent's `awaitTrigger()` resolves. It:
 *   1. Sends SIGTERM to claude.
 *   2. Waits 200ms.
 *   3. If still alive, sends SIGKILL.
 *   4. Awaits proc.exited.
 *   5. Calls execve with the stashed argv (Bun.spawn-based re-exec
 *      under the hood; see docs/decisions.md for the deviation from
 *      Go's true execve).
 *
 * All side-effecting bits — signal delivery, sleep, execve — are
 * injectable so tests can run them as pure callbacks.
 *
 * Design: docs/design.mcp.md §6.
 */

import { describe, expect, test } from 'bun:test';

import { killAndExec, type KillAndExecArgs } from '../../src/handoff/kill-and-exec';

interface FakeProc {
  killed: boolean;
  exitedResolved: boolean;
  exited: Promise<number>;
  resolveExited: (code: number) => void;
}

function makeFakeProc(): FakeProc {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const fake: FakeProc = {
    killed: false,
    exitedResolved: false,
    exited,
    resolveExited: (code: number) => {
      fake.exitedResolved = true;
      resolveExited(code);
    },
  };
  return fake;
}

describe('killAndExec — SIGTERM works', () => {
  test('proc exits after SIGTERM → no SIGKILL, then execve', async () => {
    const fake = makeFakeProc();
    const signals: string[] = [];
    const sleeps: number[] = [];
    let execveCall: { argv: string[] } | null = null;

    const args: KillAndExecArgs = {
      proc: { exited: fake.exited } as unknown as Bun.Subprocess,
      stashedArgv: ['fnc', '/tmp/dest', '--resume', 'uuid-1'],
      signalSend: (sig) => {
        signals.push(sig);
        // SIGTERM-respecting proc: resolves exited synchronously after
        // the first signal arrives.
        if (sig === 'SIGTERM') {
          fake.resolveExited(0);
        }
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      execve: (argv) => {
        execveCall = { argv };
      },
      platform: 'linux',
    };

    await killAndExec(args);

    expect(signals).toEqual(['SIGTERM']);
    expect(sleeps).toEqual([200]);
    expect(execveCall).not.toBeNull();
    expect(execveCall!.argv).toEqual(['fnc', '/tmp/dest', '--resume', 'uuid-1']);
  });
});

describe('killAndExec — escalation to SIGKILL', () => {
  test('proc ignoring SIGTERM gets SIGKILL after 200ms wait', async () => {
    const fake = makeFakeProc();
    const signals: string[] = [];
    const sleeps: number[] = [];
    let execveCall: { argv: string[] } | null = null;

    const args: KillAndExecArgs = {
      proc: { exited: fake.exited } as unknown as Bun.Subprocess,
      stashedArgv: ['fnc', '/tmp/escalated'],
      signalSend: (sig) => {
        signals.push(sig);
        // Only SIGKILL kills the unresponsive child in this fake.
        if (sig === 'SIGKILL') {
          fake.resolveExited(137);
        }
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      execve: (argv) => {
        execveCall = { argv };
      },
      platform: 'linux',
    };

    await killAndExec(args);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(sleeps).toEqual([200]);
    expect(execveCall).not.toBeNull();
    expect(execveCall!.argv).toEqual(['fnc', '/tmp/escalated']);
  });
});

describe('killAndExec — execve carries stashed argv exactly', () => {
  test('argv passed to execve is the array we stashed (identity preserved)', async () => {
    const fake = makeFakeProc();
    const stashed = ['fnc', 'opus', 'max', '/work', '--name', 'thing'];
    let received: string[] | null = null;

    const args: KillAndExecArgs = {
      proc: { exited: fake.exited } as unknown as Bun.Subprocess,
      stashedArgv: stashed,
      signalSend: (sig) => {
        if (sig === 'SIGTERM') fake.resolveExited(0);
      },
      sleep: async () => {},
      execve: (argv) => {
        received = argv;
      },
      platform: 'linux',
    };

    await killAndExec(args);
    expect(received).toEqual(stashed);
  });
});

describe('killAndExec — windows path', () => {
  test('windows: TerminateProcess-equivalent (single kill), then execve', async () => {
    const fake = makeFakeProc();
    const signals: string[] = [];
    let execveCall: { argv: string[] } | null = null;

    const args: KillAndExecArgs = {
      proc: { exited: fake.exited } as unknown as Bun.Subprocess,
      stashedArgv: ['fnc.exe', '/work'],
      signalSend: (sig) => {
        signals.push(sig);
        // TerminateProcess on Windows is a single hard-kill.
        fake.resolveExited(1);
      },
      sleep: async () => {},
      execve: (argv) => {
        execveCall = { argv };
      },
      platform: 'win32',
    };

    await killAndExec(args);

    // No SIGTERM/SIGKILL distinction on win32 per design.mcp.md §6.1.
    // We pass a single kill signal — exact wire is platform-specific.
    expect(signals.length).toBe(1);
    expect(execveCall).not.toBeNull();
    expect(execveCall!.argv).toEqual(['fnc.exe', '/work']);
  });
});
