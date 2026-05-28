/**
 * End-to-end coverage for the `fnc mcp` subcommand dispatch wiring.
 *
 * §7.5 — MCP subprocess entry point. The subprocess is invoked by claude
 * via the injected `--mcp-config`; it inherits `$FNC_SOCKET` from the
 * parent fnclaude process. Without that env var, the subprocess can't do
 * anything useful — it MUST exit non-zero immediately with a pointer at
 * the launcher (per design.mcp.md §8: "FNC_SOCKET not set").
 *
 * These tests exercise the dispatch → entry-point wiring without standing
 * up a real socket; the server-loop behavior (stdin → handlers → stdout)
 * is covered by the unit tests since spinning up a parent + child here
 * just to verify a no-op would be expensive.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

async function runUnderNode(
  args: readonly string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  // Strip FNC_SOCKET from the inherited env unless an override sets it,
  // so tests aren't sensitive to stray launcher state.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'FNC_SOCKET') env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: CLI_ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe.skipIf(SKIP_WINDOWS)('mcp subcommand dispatch', () => {
  test('fnc mcp without FNC_SOCKET → exit 2 with FNC_SOCKET error', async () => {
    const { stdout, stderr, exitCode } = await runUnderNode(['mcp']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('FNC_SOCKET not set');
    expect(stderr).toContain('fnclaude launcher');
    expect(stdout).toBe('');
  });

  test('fnc mcp --noop without FNC_SOCKET → same exit 2 error', async () => {
    const { stderr, exitCode } = await runUnderNode(['mcp', '--noop']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('FNC_SOCKET not set');
  });

  test('fnc mcp does NOT spawn claude or run parseArgs', async () => {
    // If parseArgs had run, surplus positionals like "opus" / "extra" would
    // be interpreted as model/effort/positional tokens. The mcp subcommand
    // short-circuits the launcher entirely.
    const { stderr, exitCode } = await runUnderNode(['mcp', 'opus', 'extra']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('FNC_SOCKET not set');
  });
});
