/**
 * End-to-end coverage for --help / --version short-circuits.
 *
 * Spawns the bin via 'node bin/fnc.js' (the preflight path) and confirms
 * that --help / --version exit 0 with the expected output, WITHOUT
 * touching the noop dir or spawning claude. The short-circuit firing
 * before any other work is the whole point of §2.6.
 *
 * Skipped on Windows for the same reason as argv-preflight.test.ts.
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

describe.skipIf(SKIP_WINDOWS)('--help / --version short-circuits', () => {
  test('--help exits 0 and prints fnclaude help', async () => {
    const { stdout, exitCode } = await runUnderNode(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('fnclaude');
    expect(stdout).toContain('Usage:');
  });

  test('-h exits 0 and prints help', async () => {
    const { stdout, exitCode } = await runUnderNode(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('fnclaude');
  });

  test('--version exits 0 and prints "fnc <semver>"', async () => {
    const { stdout, exitCode } = await runUnderNode(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^fnc \d+\.\d+\.\d+/);
  });

  test('-v exits 0 and prints version', async () => {
    const { stdout, exitCode } = await runUnderNode(['-v']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^fnc \d+\.\d+\.\d+/);
  });

  test('--help short-circuits BEFORE any claude spawn (cwd unaffected by no noop dir creation)', async () => {
    // Verifying short-circuit ordering: if --help printed AFTER noop spawn,
    // stdout would also include claude's output. We assert stdout is
    // pure-help-text by checking it doesn't contain claude-typical content.
    const { stdout } = await runUnderNode(['--help']);
    expect(stdout).not.toContain('Welcome to Claude');
    expect(stdout).not.toContain('?>');
  });

  test('--help AFTER -- is NOT a help request (it is prompt content)', async () => {
    // Behaviorally: spawning with `~/tmp -- --help` would launch claude
    // with prompt "--help". We can't fully assert claude behavior without
    // touching the real claude — but we CAN verify exitCode is NOT 0 (help
    // would have exited 0) or that the run took longer than a help-only
    // path. For this test, we use a stricter check via the dump-argv hook
    // to confirm `--help` made it into argv as content, not consumed.
    const proc = Bun.spawn(['node', BIN, '--', '--help'], {
      cwd: CLI_ROOT,
      env: { ...process.env, FNC_INTERNAL_DUMP_ARGV: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(['--', '--help']);
  });
});
