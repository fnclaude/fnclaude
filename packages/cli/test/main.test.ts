// Integration tests for run() — the orchestration loop.
//
// The point of these tests is composition: every dependency is faked, and
// we assert that run() calls each one with the values that mirror Go's
// run() ordering. Mocking the seams (loadConfig, runWithPTY, generateName,
// silentRelaunch, etc.) lets us drive the whole loop without launching a
// real PTY, a real claude binary, or talking to the network.

import { describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import type { Args } from '../src/args.js';
import { defaultConfig, type Config } from '../src/config.js';
import type { HandoffSpec } from '../src/handoff.js';
import type { RunDeps, run as runType } from '../src/main.js';
import { run } from '../src/main.js';
import type { RunOptions, RunResult } from '../src/pty.js';
import type { ResolveOpts, ResolveResult } from '../src/resolver.js';

function makeBuf(): { stream: NodeJS.WriteStream; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      cb();
    },
  });
  return { stream: stream as unknown as NodeJS.WriteStream, chunks };
}

// Reusable defaults for non-relevant deps. Each test overrides what it
// cares about.
function baseDeps(extras: Partial<RunDeps> = {}): RunDeps {
  const { stream: stdoutStream } = makeBuf();
  const { stream: stderrStream } = makeBuf();
  return {
    argv: [],
    stdout: stdoutStream,
    stderr: stderrStream,
    home: '/home/tester',
    cwd: '/tmp/cwd',
    lookupClaude: () => '/usr/bin/claude',
    seedNoop: async () => undefined,
    loadConfig: () => defaultConfig(),
    loadRepoSettings: () => ({}),
    loadHostAliases: () => ({}),
    loadPrompts: () => ({
      prompts: {
        agentPitfall: '',
        projectSwitch: '',
        spawn: '',
        restart: '',
        noopRouter: '',
      },
      warnings: [],
    }),
    resolve: async (opts: ResolveOpts): Promise<ResolveResult> => ({ path: opts.input }),
    applyWorktreeIntercept: () => undefined,
    generateName: async () => 'fake-name',
    runWithPTY: async (_opts: RunOptions): Promise<RunResult> => ({
      exitCode: 0,
      tail: null,
      handoffArgv: null,
    }),
    silentRelaunch: () => undefined,
    silentRelaunchHandoff: () => undefined,
    runMCPServer: async () => 0,
    ...extras,
  };
}

describe('run() short-circuits', () => {
  test('--help prints help text and exits 0', async () => {
    const { stream: stdout, chunks } = makeBuf();
    const code = await run(baseDeps({ argv: ['--help'], stdout }));
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('fnclaude — claude CLI launcher');
  });

  test('--version prints version line and exits 0', async () => {
    const { stream: stdout, chunks } = makeBuf();
    const code = await run(baseDeps({ argv: ['--version'], stdout }));
    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/^fnclaude \S+\n$/);
  });

  test('`mcp` dispatches to runMCPServer with noop=false by default', async () => {
    let captured: { noop: boolean; socket: string } | null = null;
    const code = await run(
      baseDeps({
        argv: ['mcp'],
        runMCPServer: async (opts) => {
          captured = { noop: opts.noop, socket: opts.socketPath };
          return 7;
        },
      }),
    );
    expect(code).toBe(7);
    expect(captured).not.toBeNull();
    expect(captured!.noop).toBe(false);
  });

  test('`mcp --noop` sets noop=true on the server options', async () => {
    let noopSeen = false;
    const code = await run(
      baseDeps({
        argv: ['mcp', '--noop'],
        runMCPServer: async (opts) => {
          noopSeen = opts.noop;
          return 0;
        },
      }),
    );
    expect(code).toBe(0);
    expect(noopSeen).toBe(true);
  });

  test('parse error prints to stderr and returns 1', async () => {
    const { stream: stderr, chunks } = makeBuf();
    const code = await run(
      baseDeps({
        // Three positionals after magic is a parse error.
        argv: ['opus', 'max', '/p1', '/p2', '/p3'],
        stderr,
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toMatch(/too many positional arguments/);
  });

  test('claude not on PATH prints to stderr and returns 1', async () => {
    const { stream: stderr, chunks } = makeBuf();
    const code = await run(
      baseDeps({
        argv: [],
        stderr,
        lookupClaude: () => null,
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('claude not found in PATH');
  });
});

describe('run() pipeline composition', () => {
  test('happy path threads parsed argv through every seam in order', async () => {
    const events: string[] = [];
    let claudeArgvSeen: string[] | null = null;
    let launchCWDSeen: string | null = null;
    let handoffSpecSeen: HandoffSpec | null = null;

    const code = await run(
      baseDeps({
        argv: ['/some/abs/path', '--', 'fix the bug'],
        seedNoop: async (d) => {
          events.push(`seedNoop:${d}`);
        },
        loadConfig: () => {
          events.push('loadConfig');
          return defaultConfig();
        },
        loadPrompts: () => {
          events.push('loadPrompts');
          return { prompts: emptyPrompts(), warnings: [] };
        },
        resolve: async () => {
          events.push('resolve');
          return { path: '/some/abs/path' };
        },
        applyWorktreeIntercept: () => {
          events.push('worktree');
        },
        generateName: async () => {
          events.push('autoname');
          return 'fixing-bug';
        },
        runWithPTY: async (opts) => {
          events.push('pty');
          claudeArgvSeen = opts.claudeArgv;
          launchCWDSeen = opts.launchCWD;
          handoffSpecSeen = opts.handoff;
          return { exitCode: 0, tail: null, handoffArgv: null };
        },
      }),
    );

    expect(code).toBe(0);
    // /some/abs/path is absolute → resolve() is skipped, but seedNoop only
    // fires for noop-fallback paths; explicit positional skips it.
    expect(events).toContain('loadConfig');
    expect(events).toContain('worktree');
    expect(events).toContain('autoname'); // -- "fix the bug" qualifies
    expect(events).toContain('pty');

    // The claude argv starts with "claude" and contains the --name we
    // injected before the user's `--`.
    expect(claudeArgvSeen).not.toBeNull();
    expect(claudeArgvSeen![0]).toBe('claude');
    expect(claudeArgvSeen!).toContain('--name');
    expect(claudeArgvSeen!).toContain('fixing-bug');

    expect(launchCWDSeen).toBe('/some/abs/path');

    // Handoff spec is non-null and carries the original argv snapshot.
    expect(handoffSpecSeen).not.toBeNull();
    expect(handoffSpecSeen!.originalArgs).toEqual(['/some/abs/path', '--', 'fix the bug']);
    expect(handoffSpecSeen!.socketPath).toContain('fnclaude-mcp-');
  });

  test('noop fallback seeds the noop dir + skips Resolve', async () => {
    let seeded = false;
    let resolveCalled = false;
    const code = await run(
      baseDeps({
        argv: [],
        seedNoop: async () => {
          seeded = true;
        },
        resolve: async () => {
          resolveCalled = true;
          return { path: '/should-not-be-called' };
        },
      }),
    );
    expect(code).toBe(0);
    expect(seeded).toBe(true);
    expect(resolveCalled).toBe(false);
  });

  test('cwd-relative non-noop input passes through Resolve', async () => {
    let resolveInput: string | null = null;
    const code = await run(
      baseDeps({
        argv: ['my-repo'],
        resolve: async (opts) => {
          resolveInput = opts.input;
          return { path: '/resolved/my-repo' };
        },
      }),
    );
    expect(code).toBe(0);
    expect(resolveInput).toBe('my-repo');
  });

  test('Resolve error short-circuits to exit 1', async () => {
    const { stream: stderr, chunks } = makeBuf();
    const code = await run(
      baseDeps({
        argv: ['some-ref'],
        stderr,
        resolve: async () => {
          throw new Error('repo not found');
        },
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('repo not found');
  });

  test('Resolve workspace propagates to the worktree intercept', async () => {
    let argsCaptured: Args | null = null;
    const code = await run(
      baseDeps({
        argv: ['my-repo+staging'],
        resolve: async () => ({ path: '/resolved/my-repo', workspace: 'staging' }),
        applyWorktreeIntercept: (a) => {
          argsCaptured = { ...a };
        },
      }),
    );
    expect(code).toBe(0);
    expect(argsCaptured).not.toBeNull();
    expect(argsCaptured!.worktreeSet).toBe(true);
    expect(argsCaptured!.worktreeArg).toBe('staging');
  });

  test('Resolve workspace does NOT override an explicit -w flag', async () => {
    let argsCaptured: Args | null = null;
    const code = await run(
      baseDeps({
        argv: ['my-repo+ws-from-suffix', '-w', 'explicit-wt'],
        resolve: async () => ({ path: '/resolved/my-repo', workspace: 'ws-from-suffix' }),
        applyWorktreeIntercept: (a) => {
          argsCaptured = { ...a };
        },
      }),
    );
    expect(code).toBe(0);
    expect(argsCaptured!.worktreeArg).toBe('explicit-wt');
  });
});

describe('run() exit-time decision tree', () => {
  test('claude exit code propagates when no handoff and no cross-cwd marker', async () => {
    const code = await run(
      baseDeps({
        argv: ['/abs/cwd'],
        runWithPTY: async () => ({ exitCode: 13, tail: Buffer.from('nothing interesting'), handoffArgv: null }),
      }),
    );
    expect(code).toBe(13);
  });

  test('handoff argv triggers silentRelaunchHandoff (before cross-cwd check)', async () => {
    let handoffCalled = false;
    let crossCwdCalled = false;
    const code = await run(
      baseDeps({
        argv: ['/abs/cwd'],
        runWithPTY: async () => ({
          exitCode: 0,
          tail: Buffer.from('To resume, run:\ncd /elsewhere && claude --resume 12345678-1234-1234-1234-123456789abc'),
          handoffArgv: ['/handoff/dest', '--name', 'handoff-name'],
        }),
        silentRelaunchHandoff: (argv) => {
          handoffCalled = true;
          expect(argv).toEqual(['/handoff/dest', '--name', 'handoff-name']);
        },
        silentRelaunch: () => {
          crossCwdCalled = true;
        },
      }),
    );
    // When both fire, the cross-cwd one ALSO runs (Go: "If we get here,
    // exec failed; fall through to cross-cwd detection"); in our test the
    // handoff stub returns instead of execve-replacing the process, so the
    // fallthrough fires. That matches Go's documented semantics.
    expect(handoffCalled).toBe(true);
    expect(crossCwdCalled).toBe(true);
    expect(code).toBe(0);
  });

  test('cross-cwd marker triggers silentRelaunch with dest + uuid', async () => {
    let captured: { args: readonly string[]; dest: string; uuid: string } | null = null;
    const code = await run(
      baseDeps({
        argv: ['/abs/cwd', '-V'],
        runWithPTY: async () => ({
          exitCode: 0,
          tail: Buffer.from(
            'noise...\nTo resume, run:\ncd /target && claude --resume abcdef12-1234-1234-1234-1234567890ab\n',
          ),
          handoffArgv: null,
        }),
        silentRelaunch: (args, dest, uuid) => {
          captured = { args, dest, uuid };
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured).not.toBeNull();
    expect(captured!.dest).toBe('/target');
    expect(captured!.uuid).toBe('abcdef12-1234-1234-1234-1234567890ab');
    expect(captured!.args).toEqual(['/abs/cwd', '-V']);
  });

  test('cross-cwd marker is ignored when tail is null (Windows path)', async () => {
    let relaunchCalled = false;
    const code = await run(
      baseDeps({
        argv: ['/abs/cwd'],
        runWithPTY: async () => ({ exitCode: 5, tail: null, handoffArgv: null }),
        silentRelaunch: () => {
          relaunchCalled = true;
        },
      }),
    );
    expect(code).toBe(5);
    expect(relaunchCalled).toBe(false);
  });
});

function emptyPrompts() {
  return {
    agentPitfall: '',
    projectSwitch: '',
    spawn: '',
    restart: '',
    noopRouter: '',
  };
}
