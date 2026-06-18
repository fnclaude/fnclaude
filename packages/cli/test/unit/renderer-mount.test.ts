/**
 * Unit coverage for the optional in-process renderer mount
 * (design.renderer.md §2–§3).
 *
 * Contract:
 *   shouldUseRenderer(env):
 *     - true only for FNC_RENDERER ∈ {"1","true"} (case-insensitive, trimmed)
 *     - false for unset / "" / "0" / "false" / "yes" / arbitrary garbage
 *   maybeMountRenderer({ env, importRenderer, warn }):
 *     - selector set + importer → { mountRenderer } ⇒ mounts, awaits exit,
 *       returns true
 *     - selector set + importer → {} (no mountRenderer) ⇒ returns false, warns
 *     - selector set + importer throws ⇒ returns false, warns
 *     - selector unset ⇒ returns false, importer NEVER called
 */

import { describe, expect, test } from 'bun:test';

import {
  maybeMountRenderer,
  shouldUseRenderer,
  type RendererHandle,
} from '../../src/launch/renderer-mount.ts';

function fakeHandle(onWait?: () => void): RendererHandle {
  return {
    waitUntilExit: async () => {
      onWait?.();
    },
    unmount() {},
  };
}

describe('shouldUseRenderer', () => {
  test('true for "1" and "true" (case-insensitive, trimmed)', () => {
    expect(shouldUseRenderer({ FNC_RENDERER: '1' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: 'true' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: 'TRUE' })).toBe(true);
    expect(shouldUseRenderer({ FNC_RENDERER: '  true  ' })).toBe(true);
  });

  test('false when unset', () => {
    expect(shouldUseRenderer({})).toBe(false);
  });

  test('false for empty / "0" / "false" / garbage', () => {
    expect(shouldUseRenderer({ FNC_RENDERER: '' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: '0' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'false' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'yes' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'on' })).toBe(false);
    expect(shouldUseRenderer({ FNC_RENDERER: 'banana' })).toBe(false);
  });
});

describe('maybeMountRenderer', () => {
  test('(a) selector set + module with mountRenderer ⇒ mounts, returns true', async () => {
    let mounted = false;
    let waited = false;
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      importRenderer: async () => ({
        mountRenderer: () => {
          mounted = true;
          return fakeHandle(() => {
            waited = true;
          });
        },
      }),
    });
    expect(result).toBe(true);
    expect(mounted).toBe(true);
    expect(waited).toBe(true);
  });

  test('(b) selector set + module without mountRenderer ⇒ returns false, warns once', async () => {
    const warnings: string[] = [];
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: '1' },
      importRenderer: async () => ({}),
      warn: (line) => warnings.push(line),
    });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('mountRenderer unavailable');
  });

  test('(c) selector set + importer throws ⇒ returns false, warns once', async () => {
    const warnings: string[] = [];
    const result = await maybeMountRenderer({
      env: { FNC_RENDERER: 'true' },
      importRenderer: async () => {
        throw new Error('Cannot find package "@fnclaude/renderer"');
      },
      warn: (line) => warnings.push(line),
    });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not installed');
  });

  test('(d) selector unset ⇒ returns false, importer never called', async () => {
    let called = false;
    const result = await maybeMountRenderer({
      env: {},
      importRenderer: async () => {
        called = true;
        return { mountRenderer: () => fakeHandle() };
      },
    });
    expect(result).toBe(false);
    expect(called).toBe(false);
  });
});
