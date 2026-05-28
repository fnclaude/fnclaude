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
      // Use a PATH that contains ONLY this empty dir. node still needs to be
      // resolvable by the parent shell that spawned bun test, but we're
      // invoking via Bun.spawn with an absolute node path... actually we use
      // the `node` binary name. Need to keep something on PATH that contains
      // node. We'll use the real node-containing dir alongside the empty one;
      // findClaude looks specifically for 'claude' and won't find it in
      // either.
      const proc = Bun.spawn(['node', BIN, '--', 'hello'], {
        env: {
          ...process.env,
          // Resolve node's dir so the spawn itself works, plus our empty dir.
          // claude must NOT be in either dir.
          PATH: `${emptyDir}:/usr/bin:/bin`,
          // Disable auto-name; otherwise --help / --version are the only
          // non-spawn paths and we want the spawn path to be reached.
          FNC_INTERNAL_DISABLE_AUTONAME: '1',
          // Use a path that exists so the resolver doesn't error.
          // Run from /tmp so the cwd is valid.
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
      expect(exitCode).toBe(127);
      expect(stderr).toMatch(/claude.*not.*found|PATH/i);
      expect(stdout).toBe('');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
