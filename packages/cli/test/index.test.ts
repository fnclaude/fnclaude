import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('@fnclaude/cli', () => {
  it('exposes its package name', () => {
    expect(name).toBe('@fnclaude/cli');
  });
});
