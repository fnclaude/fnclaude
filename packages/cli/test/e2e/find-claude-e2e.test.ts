/**
 * End-to-end verification that fnc exits 127 with a clean error when
 * `claude` is missing from PATH — rather than blowing up at Bun.spawn
 * time with a less helpful ENOENT message.
 *
 * Runs without FNC_INTERNAL_DUMP_PLAN so the full launch path executes
 * and we hit the findClaude gate just before spawn.
 *
 * Skipped on Windows pending the Windows launcher.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

describe.skipIf(SKIP_WINDOWS)('fnc — claude not on PATH', () => {
  test('PATH points at a dir with no `claude` → exit 127 with clean error', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'fnc-e2e-no-claude-'));
    try {
      // Invoke via bun directly (skipping the node→bun preflight in bin/fnc.js)
      // so we don't need node on PATH in CI runners. The findClaude path under
      // test runs identically in both modes — it walks env.PATH for `claude`,
      // which is what this test isolates. Use process.execPath (absolute path
      // to the running bun) so Bun.spawn doesn't have to resolve the binary
      // via env.PATH — which we deliberately restrict below. Bun strips `--`
      // from script argv, so hand args via FNC_ARGS_JSON to match what the
      // node preflight would have produced.
      const proc = Bun.spawn([process.execPath, BIN], {
        env: {
          ...process.env,
          // Restricted env.PATH so findClaude can't possibly resolve claude.
          PATH: emptyDir,
          // Disable auto-name; otherwise --help / --version are the only
          // non-spawn paths and we want the spawn path to be reached.
          FNC_INTERNAL_DISABLE_AUTONAME: '1',
          // Args land in main.ts's readArgv() via this env var when set.
          FNC_ARGS_JSON: JSON.stringify(['--', 'hello']),
        },
        cwd: '/tmp',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 127) {
        // Surface stderr in the failure message so CI failures point at the
        // actual problem (e.g. an earlier exit before findClaude is reached).
        throw new Error(`expected exit 127, got ${exitCode}\nstderr: ${stderr}`);
      }
      expect(stderr).toMatch(/claude.*not.*found|PATH/i);
      expect(stdout).toBe('');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
