/**
 * Guards the dist-build serialization behind `build-dist.ts --if-stale`.
 *
 * The CI-red regression this prevents: the e2e/unit tiers spawn bin/fnc.js, whose dev path
 * rebuilds dist. On a cold checkout many spawns each started a full ttsc build at once, racing
 * two rm/rebuilds and blowing every test's timeout. `--if-stale` skips the build when dist is
 * already fresh, and an on-disk lock makes concurrent builders serialize into exactly one build.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI_ROOT = resolve(__dirname, '..', '..');
const BUILD_DIST = resolve(CLI_ROOT, 'tools', 'build-dist.ts');
const SENTINEL = resolve(CLI_ROOT, 'dist', '.lowered');

interface RunResult {
  exitCode: number;
  stderr: string;
}

async function runBuildDist(): Promise<RunResult> {
  const proc = Bun.spawn(['bun', BUILD_DIST, '--if-stale'], {
    cwd: CLI_ROOT,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

/** How many of the runs actually performed a build (vs. skipped a fresh dist / waited on the lock). */
function countBuilds(results: readonly RunResult[]): number {
  return results.filter((r) => r.stderr.includes('wrote dist/main.js')).length;
}

describe('build-dist --if-stale', () => {
  test('is a no-op when dist is already fresh', async () => {
    await runBuildDist(); // guarantee a fresh sentinel first
    expect(existsSync(SENTINEL)).toBe(true);
    const before = statSync(SENTINEL).mtimeMs;

    const warm = await runBuildDist();
    expect(warm.exitCode).toBe(0);
    expect(warm.stderr).not.toContain('wrote dist/main.js');
    expect(statSync(SENTINEL).mtimeMs).toBe(before); // sentinel untouched — no rebuild
  }, 180_000);

  test('serializes concurrent stale builders into a single build', async () => {
    rmSync(SENTINEL, { force: true }); // force staleness for every racer

    const results = await Promise.all([runBuildDist(), runBuildDist(), runBuildDist()]);

    for (const result of results) {
      expect(result.exitCode).toBe(0);
    }
    expect(countBuilds(results)).toBe(1); // the lock let exactly one build; the rest waited
    expect(existsSync(SENTINEL)).toBe(true);
  }, 180_000);
});
