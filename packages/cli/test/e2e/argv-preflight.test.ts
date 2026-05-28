/**
 * Verifies the full bin → preflight → main.ts chain preserves the `--`
 * sentinel that bun strips from script argv. The unit test for `readArgv`
 * covers the env-var precedence in isolation; this one is the
 * load-bearing integration: does invoking the actual bin under Node
 * end up with the right argv inside main.ts?
 *
 * Test hook used: FNC_INTERNAL_DUMP_ARGV=1 makes main.ts log the parsed
 * argv as JSON and exit 0 before spawning claude.
 *
 * Skipped on Windows for now — the bin's shebang is Unix-only and the
 * Windows launcher path will need its own coverage (separate phase).
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runUnderNode(args: readonly string[]): Promise<RunResult> {
  // Invoke the bin via `node <bin>` to exercise the Node→Bun preflight.
  // `bun bin/fnc.js` would skip the preflight entirely (typeof Bun !== 'undefined'
  // short-circuits in fnc.js) and we'd never see whether the preflight wires
  // FNC_ARGS_JSON correctly.
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env, FNC_INTERNAL_DUMP_ARGV: '1' },
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

describe.skipIf(SKIP_WINDOWS)('bin preflight → main.ts argv chain', () => {
  test('passes a clean argv with no `--` straight through', async () => {
    const { stdout, exitCode } = await runUnderNode(['opus', 'max', '~/src/proj']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(['opus', 'max', '~/src/proj']);
  });

  test('preserves the `--` sentinel that bun would otherwise strip', async () => {
    const { stdout, exitCode } = await runUnderNode(['--', 'say hi']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(['--', 'say hi']);
  });

  test('preserves `--` mid-argv with preceding magic words', async () => {
    const { stdout, exitCode } = await runUnderNode(['opus', '--', 'do something']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(['opus', '--', 'do something']);
  });

  test('preserves multi-word post-sentinel prompts', async () => {
    const { stdout, exitCode } = await runUnderNode(['--', 'word1 word2', 'word3']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual(['--', 'word1 word2', 'word3']);
  });

  test('no argv: empty array', async () => {
    const { stdout, exitCode } = await runUnderNode([]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });
});
