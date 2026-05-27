// Integration tests for run() — the orchestration loop.
//
// The point of these tests is composition: we feed run() a deterministic
// `RunIO` (external-behaviour seams) and `RunConfig` (pre-loaded data)
// payload, then assert that the orchestrated calls happen in the right
// order and with the right arguments. Mocking each seam lets us drive
// the whole loop without launching a real PTY, a real claude binary, or
// talking to the network.

import { afterEach, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { defaultConfig } from '../src/config.js';
import type { HandoffSpec } from '../src/handoff.js';
import type { GitRunner } from '../src/worktree.js';
import type { RunDeps, RunIO, RunConfig } from '../src/main.js';
import { run } from '../src/main.js';
import type { RunOptions, RunResult } from '../src/pty.js';
import type { ResolveDeps } from '../src/resolver.js';

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

/**
 * No-op GitRunner: returns "" on every call, which `applyWorktreeIntercept`
 * interprets as "no worktrees / not a git repo". Used as the default in
 * tests that exercise the intercept without caring about its result.
 */
const noopGitRunner: GitRunner = () => '';

/**
 * Stub ResolveDeps that pretends every input exists as a local path. The
 * non-resolver tests don't exercise the resolver branch, but having a
 * default avoids `productionDeps()` being called when a test forgets to
 * stub it (which would shell out to gh).
 */
function stubResolveDeps(
  ghCmdResults: Record<string, string> = {},
): ResolveDeps {
  return {
    pathExists: async () => true,
    ghCmd: async (args) => ({ stdout: ghCmdResults[args.join(' ')] ?? '' }),
    runClone: async () => undefined,
    log: () => undefined,
  };
}

function emptyPrompts() {
  return {
    agentPitfall: '',
    projectSwitch: '',
    spawn: '',
    restart: '',
    noopRouter: '',
  };
}

/**
 * Build a `RunDeps` with the test-friendly defaults set on both groups,
 * plus the test's specific overrides. Each override slot accepts a
 * partial of its corresponding group.
 */
function baseDeps(overrides: {
  io?: Partial<RunIO>;
  data?: Partial<RunConfig>;
} = {}): RunDeps {
  const { stream: stdoutStream } = makeBuf();
  const { stream: stderrStream } = makeBuf();
  const io: RunIO = {
    argv: [],
    stdout: stdoutStream,
    stderr: stderrStream,
    home: '/home/tester',
    cwd: '/tmp/cwd',
    lookupClaude: () => '/usr/bin/claude',
    seedNoop: async () => undefined,
    gitRunner: noopGitRunner,
    resolveDeps: stubResolveDeps(),
    generateName: async () => 'fake-name',
    runWithPTY: async (_opts: RunOptions): Promise<RunResult> => ({
      exitCode: 0,
      tail: undefined,
      handoffArgv: undefined,
    }),
    silentRelaunch: () => undefined,
    silentRelaunchHandoff: () => undefined,
    runMCPServer: async () => 0,
    ...overrides.io,
  };
  const data: RunConfig = {
    config: defaultConfig(),
    repoSettings: {},
    hostAliases: {},
    prompts: emptyPrompts(),
    ...overrides.data,
  };
  return { io, data };
}

describe('run() short-circuits', () => {
  test('--help prints help text and exits 0', async () => {
    const { stream: stdout, chunks } = makeBuf();
    const code = await run(baseDeps({ io: { argv: ['--help'], stdout } }));
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('fnclaude — claude CLI launcher');
  });

  test('--version prints version line and exits 0', async () => {
    const { stream: stdout, chunks } = makeBuf();
    const code = await run(baseDeps({ io: { argv: ['--version'], stdout } }));
    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/^fnclaude \d+\.\d+\.\d+\n$/);
  });

  test('`mcp` dispatches to runMCPServer with noop=false by default', async () => {
    let captured: { noop: boolean; socket: string } | null = null;
    const code = await run(
      baseDeps({
        io: {
          argv: ['mcp'],
          runMCPServer: async (opts) => {
            captured = { noop: opts.noop, socket: opts.socketPath };
            return 7;
          },
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
        io: {
          argv: ['mcp', '--noop'],
          runMCPServer: async (opts) => {
            noopSeen = opts.noop;
            return 0;
          },
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
        io: {
          // Three positionals after magic is a parse error.
          argv: ['opus', 'max', '/p1', '/p2', '/p3'],
          stderr,
        },
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toMatch(/too many positional arguments/);
  });

  test('claude not on PATH prints to stderr and returns 1', async () => {
    const { stream: stderr, chunks } = makeBuf();
    const code = await run(
      baseDeps({
        io: {
          argv: [],
          stderr,
          lookupClaude: () => undefined,
        },
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('claude not found in PATH');
  });
});

describe('run() pipeline composition', () => {
  test('happy path threads parsed argv through the side-effectful seams in order', async () => {
    const events: string[] = [];
    let claudeArgvSeen: string[] | undefined;
    let launchCWDSeen: string | undefined;
    let handoffSpecSeen: HandoffSpec | undefined;

    const code = await run(
      baseDeps({
        io: {
          argv: ['/some/abs/path', '--', 'fix the bug'],
          seedNoop: async (d) => {
            events.push(`seedNoop:${d}`);
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
            return { exitCode: 0, tail: undefined, handoffArgv: undefined };
          },
        },
      }),
    );

    expect(code).toBe(0);
    // /some/abs/path is absolute → resolve() is skipped, AND seedNoop only
    // fires for noop-fallback paths; explicit positional skips it.
    expect(events).toContain('autoname'); // -- "fix the bug" qualifies
    expect(events).toContain('pty');

    // The claude argv starts with "claude" and contains the --name we
    // injected before the user's `--`.
    expect(claudeArgvSeen).not.toBeUndefined();
    expect(claudeArgvSeen![0]).toBe('claude');
    expect(claudeArgvSeen!).toContain('--name');
    expect(claudeArgvSeen!).toContain('fixing-bug');

    expect(launchCWDSeen).toBe('/some/abs/path');

    // Handoff spec is populated and carries the original argv snapshot.
    expect(handoffSpecSeen).not.toBeUndefined();
    expect(handoffSpecSeen!.originalArgs).toEqual(['/some/abs/path', '--', 'fix the bug']);
    expect(handoffSpecSeen!.socketPath).toContain('fnclaude-mcp-');
  });

  test('noop fallback seeds the noop dir + skips Resolve', async () => {
    let seeded = false;
    let resolveCalled = false;
    const code = await run(
      baseDeps({
        io: {
          argv: [],
          seedNoop: async () => {
            seeded = true;
          },
          resolveDeps: {
            pathExists: async () => {
              resolveCalled = true;
              return false;
            },
            ghCmd: async () => {
              resolveCalled = true;
              return { stdout: '' };
            },
            runClone: async () => undefined,
          },
        },
      }),
    );
    expect(code).toBe(0);
    expect(seeded).toBe(true);
    expect(resolveCalled).toBe(false);
  });

  test('cwd-relative non-noop input passes through Resolve', async () => {
    let resolveInputSeen: string | undefined;
    const code = await run(
      baseDeps({
        io: {
          argv: ['my-repo'],
          resolveDeps: {
            pathExists: async (p) => {
              // pathExists is the first probe Resolve does; the candidate
              // path it builds is "<cwd>/<input>", so the input string is
              // recoverable from the basename.
              resolveInputSeen = p.split('/').pop() ?? undefined;
              return true;
            },
            ghCmd: async () => ({ stdout: '' }),
            runClone: async () => undefined,
          },
        },
      }),
    );
    expect(code).toBe(0);
    expect(resolveInputSeen).toBe('my-repo');
  });

  test('Resolve error short-circuits to exit 1', async () => {
    const { stream: stderr, chunks } = makeBuf();
    const code = await run(
      baseDeps({
        io: {
          argv: ['some-ref'],
          stderr,
          resolveDeps: {
            // Both lookups fail → Resolve throws "could not resolve …".
            pathExists: async () => false,
            ghCmd: async () => {
              throw new Error('no gh');
            },
            runClone: async () => undefined,
          },
        },
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('could not resolve');
  });

  test('Resolve workspace promotes to worktreeArg through the intercept', async () => {
    // Non-absolute input → resolver runs, returns workspace="staging".
    // The intercept then sees worktreeSet=true with worktreeArg=staging
    // and (no match) appends --worktree staging plus --name staging.
    let claudeArgvSeen: string[] | undefined;
    const code = await run(
      baseDeps({
        io: {
          argv: ['my-repo+staging'],
          // Resolver `productionDeps` does:
          //   1. pathExists("<cwd>/my-repo")     — return false (not local)
          //   2. ghCmd(["api","user","--jq",".login"]) — return "tester"
          //   3. ghCmd(["api","repos/tester/my-repo","--silent"]) — succeed
          // Bare-name ref → owner promotion picks "tester"; repo exists.
          // cloneTemplate "/resolved/{repo}" → target "/resolved/my-repo".
          // pathExists("/resolved/my-repo") = true → no clone needed.
          resolveDeps: {
            pathExists: async (p) => p === '/resolved/my-repo',
            ghCmd: async (args) => {
              if (args.includes('user') && args.includes('.login')) {
                return { stdout: 'tester\n' };
              }
              return { stdout: '' };
            },
            runClone: async () => undefined,
          },
          runWithPTY: async (opts) => {
            claudeArgvSeen = opts.claudeArgv;
            return { exitCode: 0, tail: undefined, handoffArgv: undefined };
          },
        },
        data: {
          repoSettings: { cloneTemplate: '/resolved/{repo}' },
        },
      }),
    );
    expect(code).toBe(0);
    expect(claudeArgvSeen).not.toBeUndefined();
    const wtIdx = claudeArgvSeen!.indexOf('--worktree');
    expect(wtIdx).toBeGreaterThan(-1);
    expect(claudeArgvSeen![wtIdx + 1]).toBe('staging');
    const nameIdx = claudeArgvSeen!.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(claudeArgvSeen![nameIdx + 1]).toBe('staging');
  });

  test('Resolve workspace does NOT override an explicit -w flag', async () => {
    let claudeArgvSeen: string[] | undefined;
    const code = await run(
      baseDeps({
        io: {
          argv: ['my-repo+ws-from-suffix', '-w', 'explicit-wt'],
          resolveDeps: {
            pathExists: async (p) => p === '/resolved/my-repo',
            ghCmd: async (args) => {
              if (args.includes('user') && args.includes('.login')) {
                return { stdout: 'tester\n' };
              }
              return { stdout: '' };
            },
            runClone: async () => undefined,
          },
          runWithPTY: async (opts) => {
            claudeArgvSeen = opts.claudeArgv;
            return { exitCode: 0, tail: undefined, handoffArgv: undefined };
          },
        },
        data: {
          repoSettings: { cloneTemplate: '/resolved/{repo}' },
        },
      }),
    );
    expect(code).toBe(0);
    const wtIdx = claudeArgvSeen!.indexOf('--worktree');
    expect(wtIdx).toBeGreaterThan(-1);
    // The explicit -w wins; the +workspace suffix is suppressed.
    expect(claudeArgvSeen![wtIdx + 1]).toBe('explicit-wt');
  });
});

describe('run() FNC_ARGS_JSON fallback (bypasses Bun -- stripping)', () => {
  // The umbrella shim (packages/fnclaude/bin/fnc.js) re-execs into Bun
  // with the user's argv serialized into FNC_ARGS_JSON, because Bun
  // strips the first `--` from script argv. The cli has to read its
  // argv from that env var when present, NOT from process.argv.
  afterEach(() => {
    delete process.env.FNC_ARGS_JSON;
  });

  test('reads argv from FNC_ARGS_JSON when io.argv is not supplied', async () => {
    // The umbrella sets FNC_ARGS_JSON to the user's original args.
    // process.argv at this point is whatever Bun left after stripping --
    // (which is the bug). The cli has to honour the env var instead.
    process.env.FNC_ARGS_JSON = JSON.stringify(['--help']);
    const { stream: stdout, chunks } = makeBuf();
    // No io.argv override — exercise the production path that reads from
    // process.argv vs. FNC_ARGS_JSON.
    const code = await run({
      io: {
        stdout,
        stderr: makeBuf().stream,
        home: '/home/tester',
        cwd: '/tmp/cwd',
        lookupClaude: () => '/usr/bin/claude',
        seedNoop: async () => undefined,
        gitRunner: noopGitRunner,
        resolveDeps: stubResolveDeps(),
        generateName: async () => 'fake-name',
        runWithPTY: async () => ({
          exitCode: 0,
          tail: undefined,
          handoffArgv: undefined,
        }),
        silentRelaunch: () => undefined,
        silentRelaunchHandoff: () => undefined,
        runMCPServer: async () => 0,
      },
      data: {
        config: defaultConfig(),
        repoSettings: {},
        hostAliases: {},
        prompts: emptyPrompts(),
      },
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('fnclaude — claude CLI launcher');
  });

  test('FNC_ARGS_JSON with -- + prompt routes prompt to passthrough (not resolver)', async () => {
    // The release-blocker bug: when Bun strips `--`, the cli sees just
    // ['say hi'] and treats it as a cwd positional → resolver fires and
    // 404s. With FNC_ARGS_JSON carrying the full ['--', 'say hi'], the
    // prompt must reach runWithPTY's claudeArgv as passthrough, not be
    // funneled into the resolver as a cwd.
    process.env.FNC_ARGS_JSON = JSON.stringify(['--', 'say hi']);
    let resolveCalled = false;
    let claudeArgvSeen: string[] | undefined;
    const code = await run({
      io: {
        // io.argv intentionally omitted — exercise the env-var path.
        stdout: makeBuf().stream,
        stderr: makeBuf().stream,
        home: '/home/tester',
        cwd: '/tmp/cwd',
        lookupClaude: () => '/usr/bin/claude',
        seedNoop: async () => undefined,
        gitRunner: noopGitRunner,
        resolveDeps: {
          pathExists: async () => {
            resolveCalled = true;
            return false;
          },
          ghCmd: async () => {
            resolveCalled = true;
            return { stdout: '' };
          },
          runClone: async () => undefined,
        },
        generateName: async () => 'fake-name',
        runWithPTY: async (opts) => {
          claudeArgvSeen = opts.claudeArgv;
          return { exitCode: 0, tail: undefined, handoffArgv: undefined };
        },
        silentRelaunch: () => undefined,
        silentRelaunchHandoff: () => undefined,
        runMCPServer: async () => 0,
      },
      data: {
        config: defaultConfig(),
        repoSettings: {},
        hostAliases: {},
        prompts: emptyPrompts(),
      },
    });
    expect(code).toBe(0);
    // Resolver must NOT have been called — `--` means the prompt is
    // passthrough, not a path to resolve.
    expect(resolveCalled).toBe(false);
    // The 'say hi' prompt must have reached the claude argv as
    // passthrough — load-bearing because under the bug, this string
    // would be the cwd instead and would never reach claude's argv.
    expect(claudeArgvSeen).not.toBeUndefined();
    expect(claudeArgvSeen!).toContain('say hi');
  });

  test('consumes FNC_ARGS_JSON from env so it does not leak to child processes', async () => {
    process.env.FNC_ARGS_JSON = JSON.stringify(['--help']);
    await run({
      io: {
        stdout: makeBuf().stream,
        stderr: makeBuf().stream,
        home: '/home/tester',
        cwd: '/tmp/cwd',
        lookupClaude: () => '/usr/bin/claude',
        seedNoop: async () => undefined,
        gitRunner: noopGitRunner,
        resolveDeps: stubResolveDeps(),
        generateName: async () => 'fake-name',
        runWithPTY: async () => ({
          exitCode: 0,
          tail: undefined,
          handoffArgv: undefined,
        }),
        silentRelaunch: () => undefined,
        silentRelaunchHandoff: () => undefined,
        runMCPServer: async () => 0,
      },
      data: {
        config: defaultConfig(),
        repoSettings: {},
        hostAliases: {},
        prompts: emptyPrompts(),
      },
    });
    // After run() consumes the env var, it must be removed so any child
    // processes (claude, gh, etc.) don't inherit a stale value.
    expect(process.env.FNC_ARGS_JSON).toBeUndefined();
  });

  test('explicit io.argv overrides FNC_ARGS_JSON (test seam wins)', async () => {
    // io.argv being supplied means a caller (test or future embedder)
    // is driving directly — they win over the env var. Necessary so
    // existing tests that set io.argv don't pick up env contamination.
    process.env.FNC_ARGS_JSON = JSON.stringify(['--version']);
    const { stream: stdout, chunks } = makeBuf();
    const code = await run(
      baseDeps({ io: { argv: ['--help'], stdout } }),
    );
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('fnclaude — claude CLI launcher');
  });

  test('malformed FNC_ARGS_JSON falls back to process.argv (does not crash)', async () => {
    process.env.FNC_ARGS_JSON = '{not valid json';
    // Should not throw; falls through to process.argv.slice(2). We can't
    // assert on the exact behaviour (process.argv shape is harness-
    // dependent), but `run()` must not crash on the malformed input.
    // We feed --help via io.argv so the run is short-circuited safely
    // regardless of which argv source the production path picked — the
    // load-bearing assertion is the no-throw.
    let threw = false;
    try {
      await run(baseDeps({ io: { argv: ['--help'] } }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test('non-array FNC_ARGS_JSON value falls back to process.argv', async () => {
    // Defensive: a JSON-valid but wrong-shape value (object, string,
    // number) must not be treated as argv.
    process.env.FNC_ARGS_JSON = JSON.stringify({ not: 'an array' });
    let threw = false;
    try {
      await run(baseDeps({ io: { argv: ['--help'] } }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe('run() exit-time decision tree', () => {
  test('claude exit code propagates when no handoff and no cross-cwd marker', async () => {
    const code = await run(
      baseDeps({
        io: {
          argv: ['/abs/cwd'],
          runWithPTY: async () => ({ exitCode: 13, tail: Buffer.from('nothing interesting'), handoffArgv: undefined }),
        },
      }),
    );
    expect(code).toBe(13);
  });

  test('handoff argv triggers silentRelaunchHandoff (before cross-cwd check)', async () => {
    let handoffCalled = false;
    let crossCwdCalled = false;
    const code = await run(
      baseDeps({
        io: {
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
    let captured: { args: readonly string[]; dest: string; uuid: string } | undefined;
    const code = await run(
      baseDeps({
        io: {
          argv: ['/abs/cwd', '-V'],
          runWithPTY: async () => ({
            exitCode: 0,
            tail: Buffer.from(
              'noise...\nTo resume, run:\ncd /target && claude --resume abcdef12-1234-1234-1234-1234567890ab\n',
            ),
            handoffArgv: undefined,
          }),
          silentRelaunch: (args, dest, uuid) => {
            captured = { args, dest, uuid };
          },
        },
      }),
    );
    expect(code).toBe(0);
    expect(captured).not.toBeUndefined();
    expect(captured!.dest).toBe('/target');
    expect(captured!.uuid).toBe('abcdef12-1234-1234-1234-1234567890ab');
    expect(captured!.args).toEqual(['/abs/cwd', '-V']);
  });

  test('cross-cwd marker is ignored when tail is null (Windows path)', async () => {
    let relaunchCalled = false;
    const code = await run(
      baseDeps({
        io: {
          argv: ['/abs/cwd'],
          runWithPTY: async () => ({ exitCode: 5, tail: undefined, handoffArgv: undefined }),
          silentRelaunch: () => {
            relaunchCalled = true;
          },
        },
      }),
    );
    expect(code).toBe(5);
    expect(relaunchCalled).toBe(false);
  });
});
