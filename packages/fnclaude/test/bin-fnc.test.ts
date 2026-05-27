/**
 * Preflight integration tests for the umbrella `fnc` shim.
 *
 * The shim's job: detect when it's been launched under Node (typically
 * because `npm i -g fnclaude` installed it and the user invoked `fnc`),
 * and either re-exec under Bun or fail with a directive error. The
 * underlying CLI uses Bun-only globals (`Bun.spawn`, `Bun.TOML.parse`,
 * `Bun.which`, `process.execve`) — running it under Node silently
 * degrades (config parse errors, missing claude lookup, etc.) rather
 * than failing loudly.
 *
 * These tests spawn the shim as a subprocess so we exercise the same
 * code path that `fnc` on a user's PATH does. The `decide()` function
 * itself is tested directly in preflight.test.ts.
 *
 * Skipped on Windows: shim is a Unix shebang script; Windows uses
 * npm's .cmd wrapper instead.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const HERE = import.meta.dir;
const BIN = resolve(HERE, '..', 'bin', 'fnc.js');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawnShim(
  runner: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10_000;
  const proc = Bun.spawn([runner, BIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: opts.env ?? process.env,
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(SKIP_WINDOWS)('fnclaude umbrella shim — preflight', () => {
  test('under Bun, --version succeeds (happy path)', async () => {
    const r = await spawnShim('bun', ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^fnclaude \S+\n$/);
  });

  test('under Node with bun on PATH, re-execs and succeeds', async () => {
    // Node binary launches the shim; the shim should notice `typeof Bun
    // === 'undefined'`, find `bun` on PATH, and re-exec itself. The
    // observable result is identical to the direct Bun invocation: same
    // exit code, same stdout shape, no Bun-degraded warnings on stderr.
    const r = await spawnShim('node', ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^fnclaude \S+\n$/);
    // The signature warning from the silent-degradation failure mode
    // ("Bun is not defined" thrown by Bun.TOML.parse). It would only fire
    // if the CLI ran under Node — which is exactly what the re-exec is
    // supposed to prevent. Note: --version short-circuits before config
    // loading, so absence here is necessary-but-not-sufficient; the
    // preflight.test.ts unit tests carry the load-bearing assertion.
    expect(r.stderr).not.toContain('Bun is not defined');
  });

  test('under Node with bun NOT on PATH, emits directive error and exits non-zero', async () => {
    // Strip bun from PATH so the shim's preflight can't find it. Build a
    // minimal PATH that retains the directories Node itself needs but
    // excludes anything containing a bun binary.
    const origPath = process.env.PATH ?? '';
    const filteredPath = origPath
      .split(':')
      .filter((dir) => {
        // Heuristic: drop entries that obviously point at bun. Covers
        // mise's per-tool layout (`.../bun/<ver>/bin`) and the common
        // case of a generic shim dir wrapping bun.
        if (dir.includes('/bun/')) return false;
        if (dir.endsWith('/bun')) return false;
        return true;
      })
      .join(':');

    const r = await spawnShim('node', ['--version'], {
      env: { ...process.env, PATH: filteredPath },
      timeoutMs: 5_000,
    });

    expect(r.exitCode).not.toBe(0);
    // Directive error names Bun explicitly and points at the install URL
    // so a confused user knows what to do next.
    expect(r.stderr).toContain('Bun');
    expect(r.stderr).toMatch(/bun\.sh/);
    // Must NOT degrade into a broken CLI run.
    expect(r.stderr).not.toContain('Bun is not defined');
  });
});
