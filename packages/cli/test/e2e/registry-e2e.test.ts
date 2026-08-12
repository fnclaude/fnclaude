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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readStarttime } from '../../src/registry/liveness';
import type { RegistryEntry } from '../../src/registry/RegistryEntry';
import { runWithFakeClaude } from '../fixtures/run-with-fake-claude';

const SKIP_WINDOWS = process.platform === 'win32';
const BIN = resolve(import.meta.dir, '..', '..', 'bin', 'fnc.js');

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

describe.skipIf(SKIP_WINDOWS)('fnc sessions — subcommand', () => {
  test('lists live entries, skips + GCs dead ones', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'fnc-sessions-e2e-'));
    const registryDir = join(stateRoot, 'fnclaude', 'registry');
    try {
      mkdirSync(registryDir, { recursive: true });
      // Live entry: THIS test process's pid + real starttime.
      const liveEntry: RegistryEntry = {
        session: { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'live-session' },
        owner: { pid: process.pid, starttime: readStarttime(process.pid) },
        cwd: '/home/u/src/live',
        startedAt: '2026-08-11T12:00:00.000Z',
        claims: [{ key: '/home/u/src/live', mode: 'exclusive', implicit: 'cwd' }],
      };
      // Dead entry: same pid but a starttime that can't match (pid reuse shape).
      const deadEntry: RegistryEntry = {
        ...liveEntry,
        session: { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'dead-session' },
        owner: { pid: process.pid, starttime: '1' },
      };
      writeFileSync(join(registryDir, `${liveEntry.session.id}.json`), JSON.stringify(liveEntry));
      writeFileSync(join(registryDir, `${deadEntry.session.id}.json`), JSON.stringify(deadEntry));

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) {
          env[k] = v;
        }
      }
      env.XDG_STATE_HOME = stateRoot;
      env.FNC_ARGS_JSON = JSON.stringify(['sessions']);

      const result = Bun.spawnSync([process.execPath, BIN], { env, stdout: 'pipe', stderr: 'pipe' });
      const stdout = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      expect(stdout).toContain('live-session');
      expect(stdout).toContain('/home/u/src/live');
      expect(stdout).not.toContain('dead-session');
      // The dead entry got lazily GC'd by the read.
      expect(readdirSync(registryDir)).toEqual([`${liveEntry.session.id}.json`]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
