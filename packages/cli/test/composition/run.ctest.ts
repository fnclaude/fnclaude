// Composition tier for the run root (design.di-architecture §9 PR-4).
//
// Authored in the registration dialect, so it runs only after the composition lane
// lowers it. It covers what the validators cannot on their own: the container's
// disposal happens-before the execve tail (a), the cross-cwd tail's snapshot gate (b),
// the four-variant build+identity matrix (c), the win32 undefined-listener session (d),
// and the listener→spawn→monitor start order (e).

import { expect, test } from 'bun:test';
import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';
import type { IServiceProvider } from '@rhombus-std/di.core';

import type { FnConfig } from '../../src/config/load';
import { runSession } from '../../src/entry/run';
import { registerRunServices } from '../../src/launch/register';
import { Session } from '../../src/launch/session';
import type { IProcessSpawner } from '../../src/ports/contracts';
import type {
  IContextMonitor,
  IControlSeamHolder,
  IDispatcher,
  IHandoffDetector,
  IHandoffTrigger,
  ILivePermissionReader,
  ILogger,
  IMcpListener,
  IPtyWriterHolder,
  IRingBuffer,
  ISession,
  ITerminalHost,
  IWarningBuffer,
  LaunchPlan,
  OobeContext,
  SessionOutcome,
} from '../../src/launch/contracts';

// Silence file logging so resolving ILogger stays hermetic (no state dir touched).
process.env.FNC_LOG = 'silent';

function newBuilder() {
  return Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime());
}

function fakeConfig(): FnConfig {
  return {
    noOobe: false,
    noopDir: undefined,
    autoTmux: undefined,
    autoHandoff: undefined,
    autoSpawnCommand: 'SPAWN_ME',
    claudeDefaultArgs: undefined,
    contextNoticeThreshold: undefined,
    contextNoticeLadder: undefined,
    execEnv: undefined,
  };
}

interface PlanShape {
  mcpEnabled: boolean;
  useTerminal: boolean;
  socketPath?: string;
}

function fakePlan(shape: PlanShape): LaunchPlan {
  return {
    launchCWD: '/tmp/fnc-run-ctest',
    claudeArgv: ['--'],
    usedNoopFallback: false,
    env: { PATH: '' },
    config: fakeConfig(),
    xdg: { home: '/home/ctest', xdgConfigHome: undefined, xdgStateHome: undefined },
    warnings: [],
    useTerminal: shape.useTerminal,
    mcpEnabled: shape.mcpEnabled,
    ...(shape.socketPath !== undefined ? { socketPath: shape.socketPath } : {}),
    sessionID: null,
    isUltracode: false,
    ultracodeSeedPrompt: '',
    isOobeLaunch: false,
    claudeBin: { ok: true, path: '/fake/claude' },
    origArgs: ['/tmp/fnc-run-ctest'],
  };
}

function fakeOobe(): OobeContext {
  return {
    tools: { fngit: false, plugin: false, gitShim: false },
    spawnCandidates: [],
    configured: new Set<string>(),
    packagedPromptsDir: null,
    applyArgv: ['/tmp/fnc-run-ctest'],
  };
}

// ── (a) + (b): run.ts orchestration with a fake container + fake tails ────────────

/** A run scope whose session returns `outcome` and whose disposal records into `log`. */
function fakeScope(outcome: SessionOutcome, log: string[]) {
  return {
    session: { run: async (): Promise<SessionOutcome> => outcome } satisfies ISession,
    async [Symbol.asyncDispose](): Promise<void> {
      log.push('dispose');
    },
  };
}

test('(a) the container disposes BEFORE the handoff tail, and the handoff path skips the flush', async () => {
  const order: string[] = [];
  const handoffArgv = ['/dest', '--resume', 'x'];
  const seen: string[][] = [];
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let code: number;
  try {
    code = await runSession(fakePlan({ mcpEnabled: true, useTerminal: false }), ['orig'], {
      openSession: () =>
        fakeScope(
          { exitCode: 7, handoff: handoffArgv, ringSnapshot: new Uint8Array(0), warnings: ['w'] },
          order,
        ),
      reexec: async (argv) => {
        order.push('reexec');
        seen.push([...argv]);
      },
    });
  } finally {
    process.stderr.write = realWrite;
  }

  expect(order).toEqual(['dispose', 'reexec']);
  expect(seen).toEqual([handoffArgv]);
  expect(code).toBe(7);
  // Warnings are NOT flushed on the handoff path (the flush is past both tails).
  expect(written.join('')).not.toContain('w\n');
});

test('(b) a snapshot-dropping outcome takes no cross-cwd tail; warnings flush, exit code returned', async () => {
  const order: string[] = [];
  let reexeced = false;
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let code: number;
  try {
    code = await runSession(fakePlan({ mcpEnabled: true, useTerminal: true }), ['orig'], {
      openSession: () =>
        fakeScope(
          { exitCode: 0, ringSnapshot: new Uint8Array(0), warnings: ['deferred warning'] },
          order,
        ),
      reexec: async () => {
        reexeced = true;
      },
    });
  } finally {
    process.stderr.write = realWrite;
  }

  expect(reexeced).toBe(false);
  expect(code).toBe(0);
  expect(order).toEqual(['dispose']);
  expect(written.join('')).toContain('deferred warning\n');
});

// ── (c) + (d): the four-variant build + resolve-twice identity matrix ──────────────

/** Resolve each type twice and assert the container hands back one shared instance. */
function assertSingletonIdentity(provider: IServiceProvider): void {
  expect(provider.resolve<ISession>()).toBe(provider.resolve<ISession>());
  expect(provider.resolve<IHandoffTrigger>()).toBe(provider.resolve<IHandoffTrigger>());
  expect(provider.resolve<IHandoffDetector>()).toBe(provider.resolve<IHandoffDetector>());
  expect(provider.resolve<ILivePermissionReader>()).toBe(provider.resolve<ILivePermissionReader>());
  expect(provider.resolve<IWarningBuffer>()).toBe(provider.resolve<IWarningBuffer>());
  expect(provider.resolve<ITerminalHost>()).toBe(provider.resolve<ITerminalHost>());
}

test('(c) unix + pty + normal builds, validates, and shares every singleton', async () => {
  await using provider = newBuilder()
    .withServices((m) =>
      registerRunServices(m, fakePlan({ mcpEnabled: true, useTerminal: true, socketPath: '/tmp/s.sock' })),
    )
    .build();
  assertSingletonIdentity(provider);
  expect(provider.resolve<IDispatcher>()).toBe(provider.resolve<IDispatcher>());
  expect(provider.resolve<IMcpListener>()).toBe(provider.resolve<IMcpListener>());
  expect(provider.resolve<IPtyWriterHolder>()).toBe(provider.resolve<IPtyWriterHolder>());
  expect(provider.resolve<IControlSeamHolder>()).toBe(provider.resolve<IControlSeamHolder>());
  expect(provider.resolve<IRingBuffer>()).toBe(provider.resolve<IRingBuffer>());
  expect(provider.resolve<IContextMonitor>()).toBe(provider.resolve<IContextMonitor>());
});

test('(c) unix + pty + oobe builds, validates, and shares the OobeState singleton', async () => {
  await using provider = newBuilder()
    .withServices((m) =>
      registerRunServices(
        m,
        fakePlan({ mcpEnabled: true, useTerminal: true, socketPath: '/tmp/s.sock' }),
        fakeOobe(),
      ),
    )
    .build();
  assertSingletonIdentity(provider);
  expect(provider.resolve<IDispatcher>()).toBe(provider.resolve<IDispatcher>());
  expect(provider.resolve<IContextMonitor>()).toBe(provider.resolve<IContextMonitor>());
});

test('(c) unix + inherit builds and validates (listener present, no pty tier)', async () => {
  await using provider = newBuilder()
    .withServices((m) =>
      registerRunServices(m, fakePlan({ mcpEnabled: true, useTerminal: false, socketPath: '/tmp/s.sock' })),
    )
    .build();
  assertSingletonIdentity(provider);
  expect(provider.resolve<IMcpListener>()).toBe(provider.resolve<IMcpListener>());
});

test('(c)/(d) win32 inherit builds and validates with no listener registered', async () => {
  await using provider = newBuilder()
    .withServices((m) => registerRunServices(m, fakePlan({ mcpEnabled: false, useTerminal: false })))
    .build();
  assertSingletonIdentity(provider);
  // The container resolves the session with its optional listener self-supplied undefined.
  expect(provider.resolve<ISession>()).toBe(provider.resolve<ISession>());
});

// ── (d) + (e): Session.run start order + the win32 undefined-listener path ─────────

function fakeProc(exitCode: number): Bun.Subprocess {
  return {
    exited: Promise.resolve(exitCode),
    pid: 4242,
    signalCode: null,
    kill: () => true,
  } as unknown as Bun.Subprocess;
}

function fakeTerminalHost(): ITerminalHost {
  return {
    createTerminal: () => ({ write: () => {}, resize: () => {} }) as unknown as Bun.Terminal,
    columns: () => 80,
    rows: () => 24,
    setRawMode: () => {},
    onStdinData: () => {},
    onStdoutResize: () => {},
    pauseStdin: () => {},
  };
}

const NOOP_LOG: ILogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const NOOP_WARNINGS: IWarningBuffer = { add: () => {}, drain: () => [] };

test('(e) run() starts the listener before spawn and the monitor after spawn', async () => {
  const order: string[] = [];
  const spawner: IProcessSpawner = {
    spawnPty: () => {
      order.push('spawn');
      return fakeProc(0);
    },
    spawnInherit: () => {
      order.push('spawn');
      return fakeProc(0);
    },
  };
  const detector: IHandoffDetector = { race: async () => undefined };
  const listener: IMcpListener = {
    start: async () => {
      order.push('listener');
    },
    async [Symbol.asyncDispose]() {},
  };
  const monitor: IContextMonitor = {
    start: () => {
      order.push('monitor');
    },
    [Symbol.dispose]() {},
  };
  const ring: IRingBuffer = { push: () => {}, snapshot: () => new Uint8Array(0) } as unknown as IRingBuffer;
  const ptyWriter: IPtyWriterHolder = { write: () => {}, bind: () => {}, isBound: () => false };
  const controlSeam: IControlSeamHolder = {
    sendControl: () => {},
    bind: () => {},
    isBound: () => false,
  };

  const session = new Session(
    fakePlan({ mcpEnabled: true, useTerminal: true, socketPath: '/tmp/s.sock' }),
    spawner,
    detector,
    fakeTerminalHost(),
    NOOP_LOG,
    NOOP_WARNINGS,
    listener,
    monitor,
    ring,
    ptyWriter,
    controlSeam,
  );
  const outcome = await session.run();

  expect(order).toEqual(['listener', 'spawn', 'monitor']);
  expect(outcome.exitCode).toBe(0);
});

test('(d) run() with an undefined listener takes the inherit path and never binds', async () => {
  const order: string[] = [];
  const spawner: IProcessSpawner = {
    spawnPty: () => {
      order.push('pty');
      return fakeProc(0);
    },
    spawnInherit: () => {
      order.push('inherit');
      return fakeProc(0);
    },
  };
  const detector: IHandoffDetector = { race: async () => undefined };

  const session = new Session(
    fakePlan({ mcpEnabled: false, useTerminal: false }),
    spawner,
    detector,
    fakeTerminalHost(),
    NOOP_LOG,
    NOOP_WARNINGS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const outcome = await session.run();

  expect(order).toEqual(['inherit']);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.handoff).toBeUndefined();
});
