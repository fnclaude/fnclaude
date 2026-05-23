import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, '..', 'package.json'), 'utf8'),
) as {
  name: string;
  dependencies: Record<string, string>;
  bin: Record<string, string>;
};

describe('fnclaude (umbrella)', () => {
  it('declares the expected name and bin', () => {
    expect(pkg.name).toBe('fnclaude');
    expect(pkg.bin).toEqual({ fnc: './bin/fnc.js' });
  });

  it('depends on the cli and renderer packages (workspace-resolved)', () => {
    // npm's workspaces use bare "*" — pnpm-style "workspace:*" isn't
    // supported. npm publish rewrites "*" to the resolved version.
    expect(pkg.dependencies['@fnclaude/cli']).toBe('*');
    expect(pkg.dependencies['@fnclaude/renderer']).toBe('*');
  });
});
