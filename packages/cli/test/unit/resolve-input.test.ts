import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveInput,
  type ResolveInputArgs,
  type ResolveResult,
} from '../../src/repo/resolve-input.ts';

let tmpRoot: string;
let HOME: string;
let SHELL_CWD: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-resolve-input-'));
  HOME = join(tmpRoot, 'home');
  SHELL_CWD = join(tmpRoot, 'cwd');
  mkdirSync(HOME);
  mkdirSync(SHELL_CWD);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function args(overrides: Partial<ResolveInputArgs> = {}): ResolveInputArgs {
  return {
    input: null,
    shellCwd: SHELL_CWD,
    home: HOME,
    xdgConfigHome: undefined,
    settings: {
      cloneTemplate: '~/src/{repo}@{owner}',
      hostAliases: { 'github.com': 'gh' },
    },
    ...overrides,
  };
}

// Helper: assert ok-discriminant
function assertKind<K extends ResolveResult['kind']>(
  r: ResolveResult,
  kind: K,
): Extract<ResolveResult, { kind: K }> {
  expect(r.kind).toBe(kind);
  return r as Extract<ResolveResult, { kind: K }>;
}

describe('resolveInput — null/empty → noop fallback', () => {
  test('null input → launch in noopDir', () => {
    const r = assertKind(resolveInput(args({ input: null })), 'launch');
    expect(r.usedNoopFallback).toBe(true);
    expect(r.launchCwd).toContain('fnclaude/noop');
    expect(r.workspace).toBe('');
  });

  test('empty string → launch in noopDir', () => {
    const r = assertKind(resolveInput(args({ input: '' })), 'launch');
    expect(r.usedNoopFallback).toBe(true);
  });
});

describe('resolveInput — path short-circuit (/, ~, ~/) skips repo lookup', () => {
  test('absolute path → launch there, no clone planned', () => {
    const r = assertKind(resolveInput(args({ input: '/tmp/foo' })), 'launch');
    expect(r.launchCwd).toBe('/tmp/foo');
    expect(r.usedNoopFallback).toBe(false);
  });

  test('bare tilde → launch in home', () => {
    const r = assertKind(resolveInput(args({ input: '~' })), 'launch');
    expect(r.launchCwd).toBe(HOME);
  });

  test('~/foo → launch in HOME/foo', () => {
    const r = assertKind(resolveInput(args({ input: '~/projects/thing' })), 'launch');
    expect(r.launchCwd).toBe(join(HOME, 'projects/thing'));
  });

  test('path short-circuit does NOT check whether the directory exists', () => {
    // /nonexistent shouldn't fail; spec §18.1 says skip the repo lookup,
    // path is taken as-given.
    const r = assertKind(resolveInput(args({ input: '/totally/missing/path' })), 'launch');
    expect(r.launchCwd).toBe('/totally/missing/path');
  });
});

describe('resolveInput — resolved-owner repo refs (owner already known)', () => {
  test('owner/name with clone destination not on disk → needs-clone', () => {
    const r = assertKind(
      resolveInput(args({ input: 'fnrhombus/arch-setup' })),
      'needs-clone',
    );
    expect(r.url).toBe('https://github.com/fnrhombus/arch-setup.git');
    expect(r.destination).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
    expect(r.workspace).toBe('');
  });

  test('owner/name with clone destination on disk → launch', () => {
    mkdirSync(join(HOME, 'src/arch-setup@fnrhombus'), { recursive: true });
    const r = assertKind(
      resolveInput(args({ input: 'fnrhombus/arch-setup' })),
      'launch',
    );
    expect(r.launchCwd).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
  });

  test('name@owner with clone destination on disk → launch', () => {
    mkdirSync(join(HOME, 'src/arch-setup@fnrhombus'), { recursive: true });
    const r = assertKind(
      resolveInput(args({ input: 'arch-setup@fnrhombus' })),
      'launch',
    );
    expect(r.launchCwd).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
  });

  test('gh:owner/name → uses github.com host explicitly', () => {
    const r = assertKind(
      resolveInput(args({ input: 'gh:fnrhombus/arch-setup' })),
      'needs-clone',
    );
    expect(r.url).toBe('https://github.com/fnrhombus/arch-setup.git');
  });

  test('https URL → needs-clone with that URL', () => {
    const r = assertKind(
      resolveInput(args({ input: 'https://gitlab.com/org/thing' })),
      'needs-clone',
    );
    expect(r.url).toBe('https://gitlab.com/org/thing.git');
    expect(r.destination).toBe(join(HOME, 'src/thing@org'));
  });

  test('git@host:owner/name (scp form) → needs-clone with derived https URL', () => {
    const r = assertKind(
      resolveInput(args({ input: 'git@gitlab.com:org/thing' })),
      'needs-clone',
    );
    expect(r.url).toBe('https://gitlab.com/org/thing.git');
  });
});

describe('resolveInput — bare name → needs-owner-lookup', () => {
  test('bare name → needs-owner-lookup with name preserved', () => {
    const r = assertKind(resolveInput(args({ input: 'arch-setup' })), 'needs-owner-lookup');
    expect(r.name).toBe('arch-setup');
    expect(r.workspace).toBe('');
  });

  test('bare name where local dir exists at <shellCwd>/<name> → ambiguous', () => {
    mkdirSync(join(SHELL_CWD, 'arch-setup'));
    const r = assertKind(resolveInput(args({ input: 'arch-setup' })), 'ambiguous');
    expect(r.path).toBe(join(SHELL_CWD, 'arch-setup'));
    expect(r.repoRef).toBe('arch-setup');
  });
});

describe('resolveInput — dual lookup ambiguity', () => {
  test('owner/name where BOTH local <shellCwd>/owner/name AND clone destination exist → ambiguous', () => {
    mkdirSync(join(SHELL_CWD, 'fnrhombus/arch-setup'), { recursive: true });
    mkdirSync(join(HOME, 'src/arch-setup@fnrhombus'), { recursive: true });
    const r = assertKind(resolveInput(args({ input: 'fnrhombus/arch-setup' })), 'ambiguous');
    expect(r.path).toBe(join(SHELL_CWD, 'fnrhombus/arch-setup'));
    expect(r.cloneDestination).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
  });

  test('owner/name where ONLY local path exists → launch in local path', () => {
    mkdirSync(join(SHELL_CWD, 'fnrhombus/arch-setup'), { recursive: true });
    const r = assertKind(resolveInput(args({ input: 'fnrhombus/arch-setup' })), 'launch');
    expect(r.launchCwd).toBe(join(SHELL_CWD, 'fnrhombus/arch-setup'));
  });
});

describe('resolveInput — workspace suffix propagation', () => {
  test('owner/name+workspace → workspace surfaced on needs-clone result', () => {
    const r = assertKind(
      resolveInput(args({ input: 'fnrhombus/arch-setup+my-feature' })),
      'needs-clone',
    );
    expect(r.workspace).toBe('my-feature');
    expect(r.destination).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
  });

  test('owner/name+workspace where destination exists → workspace surfaced on launch', () => {
    mkdirSync(join(HOME, 'src/arch-setup@fnrhombus'), { recursive: true });
    const r = assertKind(
      resolveInput(args({ input: 'fnrhombus/arch-setup+my-feature' })),
      'launch',
    );
    expect(r.workspace).toBe('my-feature');
    expect(r.launchCwd).toBe(join(HOME, 'src/arch-setup@fnrhombus'));
  });

  test('bare-name+workspace → workspace surfaced on needs-owner-lookup', () => {
    const r = assertKind(
      resolveInput(args({ input: 'arch-setup+my-feature' })),
      'needs-owner-lookup',
    );
    expect(r.workspace).toBe('my-feature');
    expect(r.name).toBe('arch-setup');
  });
});

describe('resolveInput — settings errors', () => {
  test('cloneTemplate is empty + repo-shaped input → error names the missing config', () => {
    const r = assertKind(
      resolveInput(
        args({
          input: 'fnrhombus/arch-setup',
          settings: { cloneTemplate: '', hostAliases: {} },
        }),
      ),
      'error',
    );
    expect(r.error).toContain('cloneTemplate');
  });

  test('cloneTemplate empty does NOT block path short-circuit', () => {
    const r = assertKind(
      resolveInput(
        args({
          input: '/some/abs/path',
          settings: { cloneTemplate: '', hostAliases: {} },
        }),
      ),
      'launch',
    );
    expect(r.launchCwd).toBe('/some/abs/path');
  });

  test('cloneTemplate uses {host-short} but alias missing → error names host', () => {
    const r = assertKind(
      resolveInput(
        args({
          input: 'org/name',
          settings: {
            cloneTemplate: '~/src/{host-short}/{owner}/{repo}',
            hostAliases: {}, // no github.com entry
          },
        }),
      ),
      'error',
    );
    expect(r.error).toContain('github.com');
  });
});

describe('resolveInput — bad parses', () => {
  test('a/b/c (ambiguous multi-slash) with no local dir → error', () => {
    const r = assertKind(resolveInput(args({ input: 'a/b/c' })), 'error');
    expect(r.error).toMatch(/ambiguous|unparseable/);
  });

  test('a/b/c WHERE local dir exists → launch in that local dir', () => {
    mkdirSync(join(SHELL_CWD, 'a/b/c'), { recursive: true });
    const r = assertKind(resolveInput(args({ input: 'a/b/c' })), 'launch');
    expect(r.launchCwd).toBe(join(SHELL_CWD, 'a/b/c'));
  });

  test('empty workspace (+ with nothing after) → parser-level error', () => {
    const r = assertKind(resolveInput(args({ input: 'arch-setup+' })), 'error');
    expect(r.error).toMatch(/empty workspace/);
  });
});
