import { describe, expect, test } from 'bun:test';
import { name } from '../src/index.js';

describe('@fnclaude/renderer', () => {
  test('exposes its package name', () => {
    expect(name).toBe('@fnclaude/renderer');
  });
});
