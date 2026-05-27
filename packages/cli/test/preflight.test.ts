/**
 * Unit tests for the cli bin shim's preflight decision function.
 *
 * The shim itself is tested via subprocess in test/e2e/bin-preflight.test.ts;
 * this file exercises the pure decision branch — given a `(hasBun,
 * lookupBun)` pair, does the function return the right action?
 */

import { describe, expect, test } from 'bun:test';
// @ts-expect-error — JS module without ambient .d.ts, type narrowing on
// the discriminated-union return is what we're testing here, no need
// for TS to know the import-side types.
import { decide } from '../bin/preflight.js';

describe('preflight.decide', () => {
  test('returns {kind: "run"} when Bun is the runtime', () => {
    const d = decide({
      hasBun: true,
      lookupBun: () => {
        throw new Error('lookupBun must not be called when hasBun=true');
      },
    });
    expect(d).toEqual({ kind: 'run' });
  });

  test('returns {kind: "reexec"} when Bun is missing but bun is on PATH', () => {
    const d = decide({
      hasBun: false,
      lookupBun: () => 'bun',
    });
    expect(d).toEqual({ kind: 'reexec', bun: 'bun' });
  });

  test('returns {kind: "error"} with directive message when bun is not on PATH', () => {
    const d = decide({
      hasBun: false,
      lookupBun: () => null,
    });
    expect(d.kind).toBe('error');
    if (d.kind !== 'error') throw new Error('unreachable');
    // Directive content: names Bun explicitly, points at install URL.
    expect(d.message).toContain('Bun');
    expect(d.message).toContain('bun.sh');
    // Mentions Node so a confused user knows which runtime they're on.
    expect(d.message).toMatch(/Node|node/);
  });
});
