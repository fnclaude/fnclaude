/**
 * Unit coverage for the optional in-process renderer mount
 * (design.renderer.md §2–§3, spawn-args.md §(b)/§(c)).
 *
 * Contract:
 *   shouldUseRenderer(env):
 *     - true only for FNC_RENDERER ∈ {"1","true"} (case-insensitive, trimmed)
 *     - false for unset / "" / "0" / "false" / "yes" / arbitrary garbage
 *   buildRendererArgs(claudeArgs):
 *     - strips --tmux and the --print/--verbose/--input-format/--output-format
 *       family (the renderer re-adds them)
 *     - drops the prompt-body `--` tail (the prompt rides as initialPrompt)
 *     - keeps the self-MCP --mcp-config, --model/--effort/--resume/
 *       --append-system-prompt + generic passthrough
 *     - appends --permission-mode bypassPermissions (explicit; the renderer's
 *       child must not silently inherit settings.json's defaultMode)
 *   maybeMountRenderer({ env, claudeBin, childEnv, cwd, rendererArgs,
 *                        initialPrompt, importRenderer, warn, logger, exit }):
 *     - selector set + module with mountRenderer ⇒ builds an fnc SpawnFn
 *       (cmd[0] swapped to claudeBin, env = childEnv, stderr piped), calls
 *       mountRenderer({ cwd, extraArgs: rendererArgs, spawnFn, initialPrompt }),
 *       awaits exit, and (when the handle exposes close) exits with claude's code
 *     - selector set + module without mountRenderer ⇒ returns false, warns
 *     - selector set + importer throws ⇒ returns false, warns
 *     - selector unset ⇒ returns false, importer NEVER called
 *     - defensive: an old mountRenderer that ignores opts / lacks close still
 *       mounts + awaits and returns true (no exit() with a code)
 */

import { describe, expect, test } from 'bun:test';

import {
  buildRendererArgs,
  maybeMountRenderer,
  shouldUseRenderer,
  type MountOptions,
  type RendererHandle,
  type SpawnFn,
  type SpawnResult,
} from '../../src/launch/renderer-mount';

function fakeHandle(over: Partial<RendererHandle> = {}): RendererHandle {
  return {
    waitUntilExit: async () => {},
    unmount() {},
    sendUserTurn() {},
    close: async () => 0,
    ...over,
  };
}

/** A minimal old-style handle: only the two methods the original shipped. */
function oldHandle(onWait?: () => void): { waitUntilExit: () => Promise<void>; unmount: () => void } {
  return {
    waitUntilExit: async () => {
      onWait?.();
    },
    unmount() {},
  };
}

function noopExit(_code: number): never {
  // Tests stub process.exit; throwing here would mask the real assertion.
  return undefined as never;
}

describe('shouldUseRenderer', () => {
  test('true for "1" and "true" (case-insensitive, trimmed)', () => {
    expect(shouldUseRenderer({ FNC_RENDERER: '1' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: 'true' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: 'TRUE' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: '  true  ' })).toBe(true);
  });

  test('false when unset', () => {
    expect(shouldUseRenderer({})).toBe(false);
  });

  test('false for empty / "0" / "false" / garbage', () => {
    expect(shouldUseRenderer({ FNC_RENDERER: '' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: '0' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'false' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'yes' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'on' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'banana' })).toBe(false);
  });
});

describe('buildRendererArgs', () => {
  test('strips --tmux (PTY-only, no PTY in renderer mode)', () => {
    const out = buildRendererArgs(['--model', 'opus', '--tmux', '--effort', 'high']);
    expect(out).not.toContain('--tmux');
    expect(out).toContain('--model');
    expect(out).toContain('opus');
    expect(out).toContain('--effort');
    expect(out).toContain('high');
  });

  test('strips the --print/--verbose/--input-format/--output-format family', () => {
    const out = buildRendererArgs([
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      'opus',
    ]);
    expect(out).not.toContain('--print');
    expect(out).not.toContain('--verbose');
    expect(out).not.toContain('--input-format');
    expect(out).not.toContain('--output-format');
    expect(out).not.toContain('stream-json');
    expect(out).toEqual(['--model', 'opus', '--permission-mode', 'bypassPermissions']);
  });

  test('keeps the self-MCP --mcp-config (claude→fnc MCP must survive)', () => {
    const cfg = '{"mcpServers":{"fnclaude":{"command":"bun","args":["/fnc","mcp"]}}}';
    const out = buildRendererArgs(['--mcp-config', cfg, '--model', 'opus']);
    expect(out).toContain('--mcp-config');
    expect(out).toContain(cfg);
  });

  test('drops the prompt-body `--` tail (prompt rides as initialPrompt)', () => {
    const out = buildRendererArgs(['--model', 'opus', '--', 'do', 'the', 'thing']);
    expect(out).not.toContain('--');
    expect(out).not.toContain('do');
    expect(out).not.toContain('thing');
    expect(out).toEqual(['--model', 'opus', '--permission-mode', 'bypassPermissions']);
  });

  test('keeps --resume/--append-system-prompt + generic passthrough', () => {
    const out = buildRendererArgs([
      '--resume',
      'abc-123',
      '--append-system-prompt',
      'be terse',
      '--add-dir',
      '/x',
    ]);
    expect(out).toContain('--resume');
    expect(out).toContain('abc-123');
    expect(out).toContain('--append-system-prompt');
    expect(out).toContain('be terse');
    expect(out).toContain('--add-dir');
    expect(out).toContain('/x');
  });

  test('appends --permission-mode bypassPermissions exactly once', () => {
    const out = buildRendererArgs(['--model', 'opus']);
    expect(out.filter((a) => a === '--permission-mode')).toHaveLength(1);
    const i = out.indexOf('--permission-mode');
    expect(out[i + 1]).toBe('bypassPermissions');
  });

  test('does not duplicate --permission-mode when the user already set one', () => {
    const out = buildRendererArgs(['--permission-mode', 'acceptEdits', '--model', 'opus']);
    expect(out.filter((a) => a === '--permission-mode')).toHaveLength(1);
    // user's choice wins — we don't override an explicit mode
    const i = out.indexOf('--permission-mode');
    expect(out[i + 1]).toBe('acceptEdits');
  });
});

describe('maybeMountRenderer — threading', () => {
  test('forwards cwd/rendererArgs/initialPrompt and builds an fnc SpawnFn', async () => {
    let captured: MountOptions | undefined;
    let exitCode: number | undefined;
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: { FNC_SOCKET: '/tmp/sock', PATH: '/usr/bin' },
      cwd: '/work/dir',
      rendererArgs: ['--model', 'opus', '--permission-mode', 'bypassPermissions'],
      initialPrompt: 'hello world',
      importRenderer: async () => ({
        mountRenderer: (opts?: MountOptions) => {
          captured = opts;
          return fakeHandle({ close: async () => 7 });
        },
      }),
      exit: (code) => {
        exitCode = code;
        return undefined as never;
      },
    });

    expect(result).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.cwd).toBe('/work/dir');
    expect(captured!.extraArgs).toEqual([
      '--model',
      'opus',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(captured!.initialPrompt).toBe('hello world');
    expect(typeof captured!.spawnFn).toBe('function');
    expect(exitCode).toBe(7);
  });

  test('the SpawnFn swaps cmd[0]→claudeBin, sets env, pipes stderr', async () => {
    let spawnFn: SpawnFn | undefined;
    let spawnedCmd: string[] | undefined;
    let spawnedOpts: { cwd?: string } | undefined;

    await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: { FNC_SOCKET: '/tmp/sock' },
      cwd: '/work/dir',
      rendererArgs: ['--model', 'opus'],
      importRenderer: async () => ({
        mountRenderer: (opts?: MountOptions) => {
          spawnFn = opts?.spawnFn;
          return fakeHandle();
        },
      }),
      // Inject the low-level Bun.spawn equivalent so we can observe what the
      // fnc SpawnFn closure actually does without spawning a real process.
      spawnProc: (cmd, o): SpawnResult & { __cmd: string[]; __opts: typeof o } => {
        spawnedCmd = cmd;
        spawnedOpts = { cwd: o.cwd };
        return {
          stdout: new ReadableStream<Uint8Array>(),
          stdin: new WritableStream<Uint8Array>(),
          exited: Promise.resolve(0),
          kill: () => {},
          __cmd: cmd,
          __opts: o,
        } as SpawnResult & { __cmd: string[]; __opts: typeof o };
      },
      exit: noopExit,
    });

    expect(spawnFn).toBeDefined();
    // The renderer hard-codes "claude" as cmd[0]; the fnc SpawnFn swaps it.
    spawnFn!(['claude', '--print', '--model', 'opus'], { cwd: '/work/dir' });
    expect(spawnedCmd?.[0]).toBe('/resolved/claude');
    expect(spawnedCmd?.slice(1)).toEqual(['--print', '--model', 'opus']);
    expect(spawnedOpts?.cwd).toBe('/work/dir');
  });
});

describe('maybeMountRenderer — ultracode follow-up turn', () => {
  test('followUpPrompt is sent via sendUserTurn after mount (§7 handle)', async () => {
    const turns: string[] = [];
    await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: ['--model', 'opus'],
      initialPrompt: '/effort ultracode',
      followUpPrompt: 'build the thing',
      importRenderer: async () => ({
        mountRenderer: (opts?: MountOptions) => {
          if (opts?.initialPrompt) turns.push(opts.initialPrompt);
          return fakeHandle({
            sendUserTurn: (t) => turns.push(t),
            close: async () => 0,
          });
        },
      }),
      exit: noopExit,
    });
    expect(turns).toEqual(['/effort ultracode', 'build the thing']);
  });

  test('followUpPrompt is dropped (not crashed) when handle lacks sendUserTurn', async () => {
    let waited = false;
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: ['--model', 'opus'],
      initialPrompt: '/effort ultracode',
      followUpPrompt: 'build the thing',
      importRenderer: async () => ({
        mountRenderer: () =>
          oldHandle(() => {
            waited = true;
          }) as unknown as RendererHandle,
      }),
      exit: noopExit,
    });
    expect(result).toBe(true);
    expect(waited).toBe(true);
  });
});

describe('maybeMountRenderer — defensive degradation', () => {
  test('old handle (no close, ignores opts) ⇒ mounts, awaits, returns true, no exit(code)', async () => {
    let waited = false;
    let exitCalled = false;
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: ['--model', 'opus'],
      importRenderer: async () => ({
        // Old shape: takes no opts, returns a handle without close/sendUserTurn.
        mountRenderer: () =>
          oldHandle(() => {
            waited = true;
          }) as unknown as RendererHandle,
      }),
      exit: () => {
        exitCalled = true;
        return undefined as never;
      },
    });
    expect(result).toBe(true);
    expect(waited).toBe(true);
    expect(exitCalled).toBe(false);
  });

  test('selector set + module without mountRenderer ⇒ returns false, warns once', async () => {
    const warnings: string[] = [];
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: [],
      importRenderer: async () => ({}),
      warn: (line) => warnings.push(line),
      exit: noopExit,
    });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('mountRenderer unavailable');
  });

  test('selector set + importer throws ⇒ returns false, warns once', async () => {
    const warnings: string[] = [];
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: 'true' },
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: [],
      importRenderer: async () => {
        throw new Error('Cannot find package "@fnclaude/renderer"');
      },
      warn: (line) => warnings.push(line),
      exit: noopExit,
    });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not installed');
  });

  test('selector unset ⇒ returns false, importer never called', async () => {
    let called = false;
    const result = await maybeMountRenderer({
      env: {},
      claudeBin: '/resolved/claude',
      childEnv: {},
      cwd: '/work/dir',
      rendererArgs: [],
      importRenderer: async () => {
        called = true;
        return { mountRenderer: () => fakeHandle() };
      },
      exit: noopExit,
    });
    expect(result).toBe(false);
    expect(called).toBe(false);
  });
});
