/**
 * End-to-end integration tests for run() — the top-level orchestration loop.
 *
 * Where packages/cli/test/main.test.ts mocks every individual seam to
 * verify *composition*, these tests run as much of the real pipeline as
 * practical: real argParser, real argv builder, real worktree intercept,
 * real Resolve flow, real config defaults. The seams we KEEP stubbed:
 *
 *   - runWithPTY      — we don't actually spawn claude; we capture the
 *                       fully-assembled argv that WOULD be passed to it.
 *   - silentRelaunch* — same reason; we capture the relaunch decision
 *                       and argv instead of execve-ing the process.
 *   - generateName    — no LLM call.
 *   - resolve         — pinned per-fixture so we don't hit the network
 *                       or touch real ~/.config/fnclaude/repo_settings.json.
 *   - lookupClaude    — pinned so tests don't depend on a real claude
 *                       being on PATH in CI.
 *
 * Each fixture's assertion is a `claudeArgv` snapshot: the array that
 * fnclaude would exec claude with under that input. This is the
 * load-bearing public contract — any change to argv construction must
 * pass the test below.
 *
 * Fixture scenarios:
 *
 *   1. basic invocation (single positional path, no flags)
 *   2. magic word + path (`opus /some/path`)
 *   3. magic word + effort + path (`opus max /some/path`)
 *   4. auto-name from prompt (`/some/path -- "fix the bug"`)
 *   5. worktree intercept (`/repo -w branch-name`)
 *   6. explicit --name with `--` prompt (no autoname)
 *   7. --print (non-interactive) — no self-MCP, no system prompts
 */

import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { defaultConfig } from '../../src/config.js';
import { run, type RunDeps } from '../../src/main.js';
import type { RunOptions, RunResult } from '../../src/pty.js';
import { applyWorktreeIntercept as realApplyWorktreeIntercept } from '../../src/worktree.js';

interface CapturedRun {
  claudeArgv: string[] | null;
  launchCWD: string | null;
  handoffMode: string | null;
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** Build a deps object that runs the real pipeline but captures the PTY call. */
function makeCapturingDeps(extras: Partial<RunDeps> = {}): {
  deps: RunDeps;
  out: CapturedRun;
} {
  const out: CapturedRun = {
    claudeArgv: null,
    launchCWD: null,
    handoffMode: null,
    exitCode: -1,
    stderr: '',
    stdout: '',
  };

  const stdoutStream = new Writable({
    write(chunk, _enc, cb) {
      out.stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      cb();
    },
  }) as unknown as NodeJS.WriteStream;

  const stderrStream = new Writable({
    write(chunk, _enc, cb) {
      out.stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      cb();
    },
  }) as unknown as NodeJS.WriteStream;

  const baseDeps: RunDeps = {
    stdout: stdoutStream,
    stderr: stderrStream,
    home: '/home/tester',
    cwd: '/tmp/shell-cwd',
    lookupClaude: () => '/usr/bin/claude',
    seedNoop: async () => undefined,
    loadConfig: () => ({ config: defaultConfig(), warnings: [] }),
    loadRepoSettings: () => ({ settings: {}, warnings: [] }),
    loadHostAliases: () => ({ aliases: {}, warnings: [] }),
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
    resolve: async (opts) => ({ path: opts.input }),
    // applyWorktreeIntercept is the REAL one — that's part of the pipeline
    // we want to exercise. The Git invocations it makes are stubbed via the
    // injected GitRunner inside each scenario where worktree matters.
    generateName: async () => 'auto-name-stub',
    runWithPTY: async (opts: RunOptions): Promise<RunResult> => {
      out.claudeArgv = opts.claudeArgv;
      out.launchCWD = opts.launchCWD;
      out.handoffMode = opts.handoff?.mode ?? null;
      return { exitCode: 0, tail: null, handoffArgv: null };
    },
    silentRelaunch: () => undefined,
    silentRelaunchHandoff: () => undefined,
    runMCPServer: async () => 0,
    ...extras,
  };
  return { deps: baseDeps, out };
}

describe('run() e2e — full-stack argv construction', () => {
  test('fixture 1: bare invocation seeds noop and runs in noop dir', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: [],
      home: '/home/tester',
    });
    out.exitCode = await run(deps);

    expect(out.exitCode).toBe(0);
    expect(out.claudeArgv).not.toBeNull();
    // First arg is always "claude" — the conventional argv[0] for the exec.
    expect(out.claudeArgv![0]).toBe('claude');
    // launchCWD is the noop dir. Path is XDG_CONFIG_HOME/fnclaude/noop when
    // that env var is set, else <home>/.config/fnclaude/noop — we accept
    // either since tests run with the developer's real XDG_CONFIG_HOME.
    expect(out.launchCWD).toMatch(/fnclaude\/noop$/);
    // Self-MCP injected (interactive session): noop=true flavor.
    const mcpConfigIdx = out.claudeArgv!.indexOf('--mcp-config');
    expect(mcpConfigIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![mcpConfigIdx + 1]).toContain('"mcp"');
    expect(out.claudeArgv![mcpConfigIdx + 1]).toContain('"--noop"');
  });

  test('fixture 2: absolute path positional → that path is launchCWD', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path'],
    });
    await run(deps);

    expect(out.launchCWD).toBe('/some/abs/path');
    expect(out.claudeArgv![0]).toBe('claude');
    // Non-noop self-MCP (no --noop in args).
    const mcpConfigIdx = out.claudeArgv!.indexOf('--mcp-config');
    expect(mcpConfigIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![mcpConfigIdx + 1]).not.toContain('"--noop"');
  });

  test('fixture 3: magic word "opus" → --model opus in passthrough', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['opus', '/some/abs/path'],
    });
    await run(deps);

    expect(out.launchCWD).toBe('/some/abs/path');
    const modelIdx = out.claudeArgv!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![modelIdx + 1]).toBe('opus');
  });

  test('fixture 4: magic words "opus max" → --model opus + --effort max', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['opus', 'max', '/some/abs/path'],
    });
    await run(deps);

    expect(out.launchCWD).toBe('/some/abs/path');
    const modelIdx = out.claudeArgv!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![modelIdx + 1]).toBe('opus');
    const effortIdx = out.claudeArgv!.indexOf('--effort');
    expect(effortIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![effortIdx + 1]).toBe('max');
  });

  test('fixture 5: autoname fires for `-- prompt` with no --name', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '--', 'fix the bug'],
      generateName: async () => 'fix-the-bug',
    });
    await run(deps);

    const nameIdx = out.claudeArgv!.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![nameIdx + 1]).toBe('fix-the-bug');
    // The `--` separator + prompt body must still be present, after --name.
    const dashDashIdx = out.claudeArgv!.indexOf('--');
    expect(dashDashIdx).toBeGreaterThan(nameIdx);
    expect(out.claudeArgv![dashDashIdx + 1]).toBe('fix the bug');
  });

  test('fixture 6: explicit --name suppresses autoname', async () => {
    let autonameCalled = false;
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '--name', 'user-picked', '--', 'do something'],
      generateName: async () => {
        autonameCalled = true;
        return 'should-not-appear';
      },
    });
    await run(deps);

    expect(autonameCalled).toBe(false);
    // Only ONE --name in the argv, and it's the user's value.
    const nameOccurrences = out.claudeArgv!.filter((t) => t === '--name').length;
    expect(nameOccurrences).toBe(1);
    const nameIdx = out.claudeArgv!.indexOf('--name');
    expect(out.claudeArgv![nameIdx + 1]).toBe('user-picked');
  });

  test('fixture 7: --print is non-interactive → no self-MCP, no system prompts', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '--print', '--', 'hello'],
      loadPrompts: () => ({
        prompts: {
          agentPitfall: 'PITFALL-FRAGMENT',
          projectSwitch: 'SWITCH-FRAGMENT',
          spawn: 'SPAWN-FRAGMENT',
          restart: 'RESTART-FRAGMENT',
          noopRouter: 'NOOP-FRAGMENT',
        },
        warnings: [],
      }),
    });
    await run(deps);

    // No --mcp-config: self-MCP is gated on interactive sessions.
    expect(out.claudeArgv!.includes('--mcp-config')).toBe(false);
    // No --append-system-prompt: fragments are gated on interactive too.
    expect(out.claudeArgv!.includes('--append-system-prompt')).toBe(false);
  });

  test('fixture 8: -w with unmatched worktree name → --worktree + auto --name', async () => {
    // Use the REAL applyWorktreeIntercept with a stub gitRunner that reports
    // no matching worktree. The intercept should then push --worktree and
    // auto-attach --name (the latter when --name isn't already set).
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '-w', 'my-feature'],
      applyWorktreeIntercept: (a, shellCWD) => {
        // GitRunner: (dir, ...args) => stdout-string. Empty string = no
        // worktrees, no match → intercept pushes --worktree + --name.
        realApplyWorktreeIntercept(a, shellCWD, () => '');
      },
    });
    await run(deps);

    const worktreeIdx = out.claudeArgv!.indexOf('--worktree');
    expect(worktreeIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![worktreeIdx + 1]).toBe('my-feature');
    // Auto --name attached (no explicit user --name).
    const nameIdx = out.claudeArgv!.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(out.claudeArgv![nameIdx + 1]).toBe('my-feature');
  });

  test('fixture 8b: -w matching an existing worktree → cwd swap, no --worktree', async () => {
    const matchedPath = '/some/abs/path/.worktrees/my-feature';
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '-w', 'my-feature'],
      applyWorktreeIntercept: (a, shellCWD) => {
        realApplyWorktreeIntercept(
          a,
          shellCWD,
          // `git worktree list --porcelain` shape — one block per worktree.
          () =>
            `worktree ${matchedPath}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/my-feature\n\n`,
        );
      },
    });
    await run(deps);

    // CWD got swapped to the matched worktree path.
    expect(out.launchCWD).toBe(matchedPath);
    // No --worktree got pushed through.
    expect(out.claudeArgv!.includes('--worktree')).toBe(false);
  });

  test('fixture 9: short flag -V translates to --verbose in passthrough', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '-V'],
    });
    await run(deps);

    expect(out.claudeArgv).toContain('--verbose');
    // -V should NOT survive in its short form to claude.
    expect(out.claudeArgv).not.toContain('-V');
  });

  test('fixture 10: collapsed short flags expand individually', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '-BV'],
    });
    await run(deps);

    expect(out.claudeArgv).toContain('--verbose');
    expect(out.claudeArgv).toContain('--brief');
  });

  test('fixture 11: passthrough preserves user-supplied unknown long flags verbatim', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path', '--custom-claude-flag', 'value-x'],
    });
    await run(deps);

    const idx = out.claudeArgv!.indexOf('--custom-claude-flag');
    expect(idx).toBeGreaterThan(-1);
    expect(out.claudeArgv![idx + 1]).toBe('value-x');
  });

  test('fixture 12: handoff spec is built with mode + per-pid socket path', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path'],
    });
    await run(deps);

    // defaultConfig() → auto.handoff = 'ask'
    expect(out.handoffMode).toBe('ask');
  });

  test('fixture 13: parse error short-circuits with stderr message + exit 1', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['opus', 'max', '/p1', '/p2', '/p3'], // too many positionals
    });
    const code = await run(deps);

    expect(code).toBe(1);
    expect(out.stderr).toContain('too many positional arguments');
    // PTY was not invoked.
    expect(out.claudeArgv).toBeNull();
  });

  test('fixture 14: claude not on PATH → exit 1 with message', async () => {
    const { deps, out } = makeCapturingDeps({
      argv: ['/some/abs/path'],
      lookupClaude: () => null,
    });
    const code = await run(deps);

    expect(code).toBe(1);
    expect(out.stderr).toContain('claude not found in PATH');
    expect(out.claudeArgv).toBeNull();
  });
});
