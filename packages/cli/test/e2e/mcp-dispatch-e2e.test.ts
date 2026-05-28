/**
 * End-to-end coverage for the 'mcp' subcommand dispatch wiring.
 *
 * The MCP server itself isn't implemented yet (§7 / §8); this test
 * confirms that:
 *   - 'fnc mcp' routes to runMcpServer (no parseArgs, no claude spawn)
 *   - the stub exits non-zero so silence can't masquerade as success
 *   - the stderr message names the mode and points at the build plan
 *   - '--noop' is recognized as a mode flag
 *
 * When §7 lands, the stub is replaced with the real server and these
 * tests need to be reworked (or replaced).
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

async function runUnderNode(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env },
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

describe.skipIf(SKIP_WINDOWS)('mcp subcommand dispatch — stub', () => {
  test('fnc mcp routes to stub: exit 2, project mode, no claude output', async () => {
    const { stdout, stderr, exitCode } = await runUnderNode(['mcp']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('MCP server not yet implemented');
    expect(stderr).toContain('project mode');
    expect(stdout).toBe('');
  });

  test('fnc mcp --noop sets noop mode in the stub message', async () => {
    const { stderr, exitCode } = await runUnderNode(['mcp', '--noop']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('noop mode');
  });

  test('fnc mcp does NOT spawn claude (short-circuits parseArgs)', async () => {
    // If parseArgs had run, we'd see 'too many positional' style behavior
    // for surplus args. Stub doesn't care about args — they're tail flags.
    const { stderr, exitCode } = await runUnderNode(['mcp', 'opus', 'extra']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('MCP server not yet implemented');
  });
});
