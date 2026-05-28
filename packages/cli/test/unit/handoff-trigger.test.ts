/**
 * §8.5 — Handoff trigger primitive.
 *
 * `createHandoffTrigger()` is the one-shot signal the parent's MCP
 * dispatcher fires when a `restart` or non-`never`-mode `switch` arrives.
 * Per docs/design.mcp.md §6.1:
 *   - stashArgv mutex: first stash wins; subsequent stashes are dropped
 *     silently (concurrent restart+switch races; rare in practice).
 *   - fire() is idempotent — second fire is a no-op. Wraps a sync.Once-
 *     equivalent so multiple dispatches don't double-trigger the kill.
 *   - awaitTrigger() resolves after fire(); resolves immediately if
 *     fire() already ran before await.
 */

import { describe, expect, test } from 'bun:test';

import { createHandoffTrigger } from '../../src/handoff/trigger.ts';

describe('createHandoffTrigger — stashArgv', () => {
  test('first stash returns true; getStashedArgv returns it', () => {
    const t = createHandoffTrigger();
    const argv = ['fnc', '/tmp/dest', '--resume', 'uuid-1'];
    expect(t.stashArgv(argv)).toBe(true);
    expect(t.getStashedArgv()).toEqual(argv);
  });

  test('second stash returns false; getStashedArgv still returns first', () => {
    const t = createHandoffTrigger();
    const first = ['fnc', '/tmp/a'];
    const second = ['fnc', '/tmp/b'];
    expect(t.stashArgv(first)).toBe(true);
    expect(t.stashArgv(second)).toBe(false);
    expect(t.getStashedArgv()).toEqual(first);
  });

  test('getStashedArgv returns null before any stash', () => {
    const t = createHandoffTrigger();
    expect(t.getStashedArgv()).toBeNull();
  });
});

describe('createHandoffTrigger — fire / awaitTrigger', () => {
  test('awaitTrigger resolves after fire()', async () => {
    const t = createHandoffTrigger();
    let resolved = false;
    const p = t.awaitTrigger().then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    t.fire();
    await p;
    expect(resolved).toBe(true);
  });

  test('fire() called twice resolves once (idempotent)', async () => {
    const t = createHandoffTrigger();
    let count = 0;
    const p = t.awaitTrigger().then(() => {
      count += 1;
    });

    t.fire();
    t.fire();
    await p;
    // Yield a few microtasks to be sure no second resolution sneaks in.
    await new Promise((r) => setTimeout(r, 10));
    expect(count).toBe(1);
  });

  test('awaitTrigger after fire() already called resolves immediately', async () => {
    const t = createHandoffTrigger();
    t.fire();
    // Ordering check: the await should complete in the same microtask
    // sweep — no externally observable suspension required.
    let resolved = false;
    await t.awaitTrigger().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  test('multiple awaitTrigger callers all resolve on fire()', async () => {
    const t = createHandoffTrigger();
    let a = false;
    let b = false;
    const pa = t.awaitTrigger().then(() => {
      a = true;
    });
    const pb = t.awaitTrigger().then(() => {
      b = true;
    });

    t.fire();
    await Promise.all([pa, pb]);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
