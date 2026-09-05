/**
 * End-to-end coverage for the run root (design.di-architecture §9 PR-4 (g), (h)).
 *
 * Drives the real `fnc` launcher via bin/fnc.js with the fake-claude fixture on PATH:
 *   - a bind failure (unbindable socket dir) exits 2 with the pre-DI stderr byte format
 *     and claude is never spawned;
 *   - a deferred plan-phase warning is flushed to stderr after a plain claude exit.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runWithFakeClaude } from '../fixtures/run-with-fake-claude';

const SKIP_WINDOWS = process.platform === 'win32';

describe.skipIf(SKIP_WINDOWS)('run root — bind failure + warnings flush', () => {
  test('(g) an unbindable MCP socket dir exits 2, prints the stderr byte format, never spawns claude', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fnc-bindfail-'));
    // A runtime dir that does not exist makes Bun.listen({ unix }) fail ENOENT on bind
    // — the socket is bound BEFORE claude spawns, so the fake must never run.
    const missingRuntimeDir = join(tmpdir(), `fnc-no-such-runtime-${Date.now()}`);
    try {
      const result = await runWithFakeClaude({
        args: [cwd],
        cwd,
        env: { XDG_RUNTIME_DIR: missingRuntimeDir, FNC_LOG: 'silent' },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('fnclaude: ');
      expect(result.stderr).toContain('failed to bind');
      expect(result.invocations).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('(h) a deferred plan-phase warning is flushed to stderr after a plain claude exit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fnc-warnflush-'));
    try {
      const result = await runWithFakeClaude({
        args: [cwd, '-w', 'has spaces!'],
        cwd,
        env: { FNC_LOG: 'silent' },
      });

      expect(result.exitCode).toBe(0);
      // The `-w` name-sanitization warning is deferred through the plan and flushed
      // after claude exits (WarningBuffer format: one line, trailing newline).
      expect(result.stderr).toContain('sanitized to');
      expect(result.stderr).toContain('illegal path/branch chars');
      // claude ran exactly once on the plain-exit path.
      expect(result.invocations).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
