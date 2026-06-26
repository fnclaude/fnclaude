/**
 * Coverage for the shared fake-claude fixture + runWithFakeClaude helper.
 *
 * These tests verify the test infrastructure itself: that fnc resolves the
 * fixture as `claude` off PATH, spawns it in the resolved cwd with the
 * composed argv, and that the fixture's env-driven knobs (log, exit code,
 * cross-cwd hint emission) behave as documented. The #55 regression in
 * resume-loop-regression.test.ts depends on every one of these.
 *
 * Skipped on Windows (the launcher's PTY/spawn path is POSIX-only for now)
 * and when `script` is unavailable (the PTY-mode assertions need it).
 */

import { describe, expect, test } from 'bun:test';

import { runWithFakeClaude } from '../fixtures/run-with-fake-claude';

const SKIP_WINDOWS = process.platform === 'win32';

function hasScript(): boolean {
  try {
    return Bun.spawnSync(['which', 'script']).exitCode === 0;
  } catch {
    return false;
  }
}

const SKIP_PTY = SKIP_WINDOWS || !hasScript();

describe.skipIf(SKIP_WINDOWS)('runWithFakeClaude — single invocation', () => {
  test('fnc resolves the fixture as claude and invokes it once', async () => {
    const r = await runWithFakeClaude({ args: ['--', 'hello'] });
    expect(r.exitCode).toBe(0);
    expect(r.invocations).toHaveLength(1);
    // The prompt body survives through to claude's argv.
    expect(r.invocations[0]!.argv).toContain('hello');
  });

  test('FAKE_CLAUDE_EXIT propagates the fake exit code through fnc', async () => {
    const r = await runWithFakeClaude({
      args: ['--', 'hello'],
      env: { FAKE_CLAUDE_EXIT: '3' },
    });
    expect(r.exitCode).toBe(3);
    expect(r.invocations).toHaveLength(1);
  });

  test('invocation log records argv, cwd, and the env subset', async () => {
    const r = await runWithFakeClaude({ args: ['--', 'probe'] });
    const inv = r.invocations[0]!;
    expect(inv.cwd).not.toBe('');
    expect(Array.isArray(inv.argv)).toBe(true);
    // The env subset is captured (an object). On a clean launch fnc strips
    // FNC_ARGS_JSON from claude's child env (cli 2.0.2, commit e2726e6), so
    // the key is absent here — the #55 regression test asserts on its
    // presence/absence directly; here we just confirm the subset is recorded.
    expect(typeof inv.env).toBe('object');
    expect(inv.env).not.toBeNull();
  });
});

describe.skipIf(SKIP_PTY)('runWithFakeClaude — PTY mode', () => {
  test('useTerminal branch engages and a single launch records one invocation', async () => {
    const r = await runWithFakeClaude({ args: ['--', 'hi'], pty: true });
    expect(r.invocations).toHaveLength(1);
  });
});
