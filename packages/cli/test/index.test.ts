import { describe, expect, test } from 'bun:test';
import { name } from '../src/index.js';

describe('@fnclaude/cli', () => {
  test('exposes its package name', () => {
    expect(name).toBe('@fnclaude/cli');
  });
});
