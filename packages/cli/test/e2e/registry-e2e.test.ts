/**
 * E2E: session-coordination registry auto-registration (#350).
 *
 * Drives the real fnc launcher with the fake-claude fixture and asserts
 * the registry lifecycle around a session:
 *
 *   - WHILE claude runs (observed by the fake at invocation time, via the
 *     FAKE_CLAUDE_CAPTURE_DIR knob), fnc has registered exactly one entry
 *     at <XDG_STATE_HOME>/fnclaude/registry/<session-id>.json, carrying
 *     the implicit exclusive cwd claim, fnc's own pid as owner, and the
 *     same session id fnc injected into claude's argv as --session-id.
 *   - AFTER fnc exits, the entry is unlinked (best-effort exit cleanup).
 *
 * XDG_STATE_HOME points at a per-test temp dir, so live sessions on the
 * host machine never leak into the assertions.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryEntry } from '../../src/registry/RegistryEntry';
import { runWithFakeClaude } from '../fixtures/run-with-fake-claude';

const SKIP_WINDOWS = process.platform === 'win32';

describe.skipIf(SKIP_WINDOWS)('session-coordination registry — launch lifecycle', () => {
  test('registers with the implicit cwd claim while claude runs, unlinks on exit', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'fnc-registry-e2e-'));
    const captureFile = join(stateRoot, 'capture.json');
    const registryDir = join(stateRoot, 'fnclaude', 'registry');
    try {
      const r = await runWithFakeClaude({
        args: ['--', 'hi'],
        env: {
          XDG_STATE_HOME: stateRoot,
          FAKE_CLAUDE_CAPTURE_DIR: `${registryDir}:${captureFile}`,
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.invocations).toHaveLength(1);
      const invocation = r.invocations[0]!;

      // Mid-session capture: exactly one registry entry existed.
      const capture = JSON.parse(readFileSync(captureFile, 'utf8')) as {
        files: Record<string, string>;
      };
      const names = Object.keys(capture.files);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/\.json$/);

      const entry = JSON.parse(capture.files[names[0]!]!) as RegistryEntry;
      // cwd claim: exclusive + implicit, on the launch cwd.
      expect(entry.cwd).toBe(invocation.cwd);
      expect(entry.claims).toEqual([
        { key: invocation.cwd, mode: 'exclusive', implicit: 'cwd' },
      ]);
      // Owner is fnc's own process — the fake's parent.
      expect(entry.owner.pid).toBe(invocation.ppid);
      expect(typeof entry.owner.starttime).toBe('string');
      // File name = the session id fnc injected into claude's argv.
      const sidIdx = invocation.argv.indexOf('--session-id');
      expect(sidIdx).toBeGreaterThanOrEqual(0);
      expect(names[0]).toBe(`${invocation.argv[sidIdx + 1]}.json`);
      expect(entry.session.id).toBe(invocation.argv[sidIdx + 1]!);

      // After exit: the entry is gone.
      expect(readdirSync(registryDir)).toEqual([]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
