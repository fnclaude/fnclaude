/**
 * Unit coverage for the ultracode seed-prompt orchestrator.
 *
 * After fnc rewrites claude's initial-prompt slot to `/effort ultracode`,
 * any user-supplied prompt is submitted as a SEPARATE follow-up once claude
 * is ready. seedUltracodePrompt waits on an injected `waitForReady` promise
 * then submits the seed via the same two-write injectSubmittedLine shape the
 * slash-injection keystone uses. An empty seed is a no-op.
 */

import { describe, expect, test } from 'bun:test';

import { seedUltracodePrompt } from '../../src/launch/seed-prompt.ts';
import type { PtyWriter } from '../../src/mcp/handlers/inject-slash.ts';

function spyWriter(): { write: PtyWriter; calls: string[] } {
  const calls: string[] = [];
  return { write: (p) => calls.push(p), calls };
}

/** Synchronous schedule seam so the separate CR write lands deterministically. */
const syncSchedule = (fn: () => void): void => fn();

/** The two writes injectSubmittedLine produces for one submitted line. */
function submitWrites(body: string): string[] {
  return [`\x1b[200~${body}\x1b[201~`, '\r'];
}

describe('seedUltracodePrompt', () => {
  test('non-empty seed → waits for ready, then submits via two writes', async () => {
    const spy = spyWriter();
    await seedUltracodePrompt({
      seedPrompt: 'fix the bug',
      write: spy.write,
      waitForReady: () => Promise.resolve(),
      schedule: syncSchedule,
    });
    expect(spy.calls).toEqual(submitWrites('fix the bug'));
  });

  test('empty seed → no writes at all', async () => {
    const spy = spyWriter();
    await seedUltracodePrompt({
      seedPrompt: '',
      write: spy.write,
      waitForReady: () => Promise.resolve(),
      schedule: syncSchedule,
    });
    expect(spy.calls).toEqual([]);
  });

  test('empty seed → waitForReady is never awaited (no-op short-circuit)', async () => {
    let readyCalled = false;
    await seedUltracodePrompt({
      seedPrompt: '',
      write: () => {},
      waitForReady: () => {
        readyCalled = true;
        return Promise.resolve();
      },
      schedule: syncSchedule,
    });
    expect(readyCalled).toBe(false);
  });

  test('submission happens only AFTER waitForReady resolves', async () => {
    const spy = spyWriter();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done = seedUltracodePrompt({
      seedPrompt: 'later',
      write: spy.write,
      waitForReady: () => gate,
      schedule: syncSchedule,
    });
    // Before the gate resolves, nothing has been written.
    await Promise.resolve();
    expect(spy.calls).toEqual([]);
    release!();
    await done;
    expect(spy.calls).toEqual(submitWrites('later'));
  });
});
