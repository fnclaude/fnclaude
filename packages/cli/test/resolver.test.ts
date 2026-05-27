import { describe, expect, test } from 'bun:test';
import { Resolve, type ResolveDeps, type ResolveOpts } from '../src/resolver.js';

// ── Mock helpers ───────────────────────────────────────────────────────────

interface MockState {
  paths: Set<string>;
  login: string;
  orgs: string[];
  ghHits: Set<string>; // "owner/name" keys that should "exist" on GitHub
  cloneCalls: Array<{ ownerRepo: string; dest: string }>;
  cloneError?: Error;
  /**
   * Captures every `deps.log(msg)` call. If `log` isn't stubbed, the
   * resolver's production wiring writes "fnclaude: cloning ..." straight to
   * the test runner's stderr — visually indistinguishable from a real clone
   * and (back when the audit ran) easy to misread as one. Routing the line
   * through deps + recording here keeps the test runner silent and lets us
   * assert intent.
   */
  logs: string[];
}

function makeDeps(init: Partial<MockState> = {}): { deps: ResolveDeps; state: MockState } {
  const state: MockState = {
    paths: new Set(),
    login: 'fnrhombus',
    orgs: [],
    ghHits: new Set(),
    cloneCalls: [],
    logs: [],
    ...init,
  };

  const deps: ResolveDeps = {
    pathExists: async (p: string) => state.paths.has(p),
    ghCmd: async (args: readonly string[]) => {
      // `gh api user --jq .login`
      if (args.length >= 4 && args[0] === 'api' && args[1] === 'user' && args[3] === '.login') {
        return { stdout: state.login + '\n' };
      }
      // `gh api /user/orgs --jq '.[].login'`
      if (args.length >= 4 && args[0] === 'api' && args[1] === '/user/orgs') {
        return { stdout: state.orgs.join('\n') + '\n' };
      }
      // `gh api repos/<owner>/<name> --silent`
      if (args.length >= 2 && args[0] === 'api' && args[1]!.startsWith('repos/')) {
        const key = args[1]!.slice('repos/'.length);
        if (state.ghHits.has(key)) return { stdout: '' };
        throw new Error('404');
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
    runClone: async (ownerRepo, dest) => {
      state.cloneCalls.push({ ownerRepo, dest });
      if (state.cloneError) throw state.cloneError;
      // Pretend the clone produced the directory.
      state.paths.add(dest);
    },
    log: (msg: string) => {
      state.logs.push(msg);
    },
  };

  return { deps, state };
}

// ── Short-circuit paths ────────────────────────────────────────────────────

describe('Resolve — short-circuits', () => {
  test('empty input → error', async () => {
    const { deps } = makeDeps();
    await expect(
      Resolve({ input: '', cwd: '/cwd', home: '/home/tom' }, deps),
    ).rejects.toThrow(/empty/);
  });

  test('absolute path bypasses gh lookup', async () => {
    const { deps, state } = makeDeps();
    const r = await Resolve({ input: '/abs/path', cwd: '/cwd', home: '/home/tom' }, deps);
    expect(r.path).toBe('/abs/path');
    expect(state.cloneCalls.length).toBe(0);
  });

  test('~ alone expands to home', async () => {
    const { deps } = makeDeps();
    const r = await Resolve({ input: '~', cwd: '/cwd', home: '/home/tom' }, deps);
    expect(r.path).toBe('/home/tom');
  });

  test('~/ prefix expands', async () => {
    const { deps } = makeDeps();
    const r = await Resolve({ input: '~/src/foo', home: '/home/tom' }, deps);
    expect(r.path).toBe('/home/tom/src/foo');
  });
});

// ── Path-only ──────────────────────────────────────────────────────────────

describe('Resolve — path hit only', () => {
  test('cwd-relative directory exists', async () => {
    const { deps } = makeDeps({ paths: new Set(['/cwd/notes']) });
    const r = await Resolve({ input: 'notes', cwd: '/cwd', home: '/home/tom' }, deps);
    expect(r.path).toBe('/cwd/notes');
    expect(r.justCloned).toBeFalsy();
  });
});

// ── Repo-only (triggers clone) ─────────────────────────────────────────────

describe('Resolve — repo hit only', () => {
  test('bare name found under login → clones', async () => {
    const { deps, state } = makeDeps({
      ghHits: new Set(['fnrhombus/arch-setup']),
    });
    const r = await Resolve(
      {
        input: 'arch-setup',
        cwd: '/cwd',
        home: '/home/tom',
        settings: { cloneTemplate: '~/src/{repo}@{owner}' },
      },
      deps,
    );
    expect(r.path).toBe('/home/tom/src/arch-setup@fnrhombus');
    expect(r.justCloned).toBe(true);
    expect(state.cloneCalls).toHaveLength(1);
    // The "cloning X → Y" log line must go through `deps.log`, not straight
    // to process.stderr — otherwise `bun test` output is polluted with
    // lines that look like real clones happening.
    expect(state.logs).toContainEqual(
      expect.stringContaining('cloning fnrhombus/arch-setup → /home/tom/src/arch-setup@fnrhombus'),
    );
  });

  test('repo already on disk at template-resolved path: no clone', async () => {
    const { deps, state } = makeDeps({
      ghHits: new Set(['fnrhombus/arch-setup']),
      paths: new Set(['/home/tom/src/arch-setup@fnrhombus']),
    });
    const r = await Resolve(
      {
        input: 'arch-setup',
        cwd: '/different-cwd',
        home: '/home/tom',
        settings: { cloneTemplate: '~/src/{repo}@{owner}' },
      },
      deps,
    );
    expect(r.path).toBe('/home/tom/src/arch-setup@fnrhombus');
    expect(r.justCloned).toBeFalsy();
    expect(state.cloneCalls).toHaveLength(0);
  });
});

// ── Ambiguity ──────────────────────────────────────────────────────────────

describe('Resolve — ambiguous', () => {
  test('path AND repo both hit → error names both', async () => {
    const { deps } = makeDeps({
      ghHits: new Set(['fnrhombus/arch-setup']),
      paths: new Set(['/cwd/arch-setup']),
    });
    await expect(
      Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{repo}@{owner}' },
        },
        deps,
      ),
    ).rejects.toThrow(/ambiguous/);
  });

  test('ambiguity error contains both hit details', async () => {
    const { deps } = makeDeps({
      ghHits: new Set(['fnrhombus/arch-setup']),
      paths: new Set(['/cwd/arch-setup']),
    });
    try {
      await Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{repo}@{owner}' },
        },
        deps,
      );
      throw new Error('should not reach here');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('/cwd/arch-setup');
      expect(msg).toContain('gh:fnrhombus/arch-setup');
    }
  });
});

// ── Neither hit ────────────────────────────────────────────────────────────

describe('Resolve — neither hit', () => {
  test('no path, no repo → clear error', async () => {
    const { deps } = makeDeps();
    await expect(
      Resolve({ input: 'nonexistent-thing', cwd: '/cwd', home: '/home/tom' }, deps),
    ).rejects.toThrow(/could not resolve/);
  });
});

// ── Repo-ref shapes ────────────────────────────────────────────────────────

describe('Resolve — repo-ref input shapes', () => {
  const baseOpts = (input: string): ResolveOpts => ({
    input,
    cwd: '/cwd',
    home: '/home/tom',
    settings: { cloneTemplate: '~/src/{repo}@{owner}' },
  });

  test('gh:owner/name shorthand', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(baseOpts('gh:fnrhombus/arch-setup'), deps);
    expect(r.path).toBe('/home/tom/src/arch-setup@fnrhombus');
  });

  test('owner/name', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(baseOpts('fnrhombus/arch-setup'), deps);
    expect(r.path).toBe('/home/tom/src/arch-setup@fnrhombus');
  });

  test('name@owner', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(baseOpts('arch-setup@fnrhombus'), deps);
    expect(r.path).toBe('/home/tom/src/arch-setup@fnrhombus');
  });

  test('bare name searches orgs after login', async () => {
    const { deps } = makeDeps({
      orgs: ['rhombu5', 'rhombus-redux'],
      ghHits: new Set(['rhombu5/dots']),
    });
    const r = await Resolve(baseOpts('dots'), deps);
    expect(r.path).toBe('/home/tom/src/dots@rhombu5');
  });

  test('+workspace suffix preserved', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(baseOpts('arch-setup+my-feature'), deps);
    expect(r.workspace).toBe('my-feature');
  });
});

// ── cloneTemplate ──────────────────────────────────────────────────────────

describe('Resolve — cloneTemplate', () => {
  test('missing template → error mentions cloneTemplate', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    await expect(
      Resolve({ input: 'arch-setup', cwd: '/cwd', home: '/home/tom' }, deps),
    ).rejects.toThrow(/cloneTemplate/);
  });

  test('{host-short} without LUT → error mentions host-short', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    await expect(
      Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{host-short}/{repo}@{owner}' },
        },
        deps,
      ),
    ).rejects.toThrow(/host-short/);
  });

  test('{host-short} with LUT substitutes', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(
      {
        input: 'arch-setup',
        cwd: '/cwd',
        home: '/home/tom',
        settings: { cloneTemplate: '~/src/{host-short}/{repo}@{owner}' },
        hostAliases: { 'github.com': 'gh' },
      },
      deps,
    );
    expect(r.path).toBe('/home/tom/src/gh/arch-setup@fnrhombus');
  });

  test('{host} and {host-plain}', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    const r = await Resolve(
      {
        input: 'arch-setup',
        cwd: '/cwd',
        home: '/home/tom',
        settings: { cloneTemplate: '~/{host}-{host-plain}/{repo}' },
      },
      deps,
    );
    expect(r.path).toBe('/home/tom/github.com-github/arch-setup');
  });

  test('unknown placeholder → error', async () => {
    const { deps } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    await expect(
      Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{bogus}/{repo}' },
        },
        deps,
      ),
    ).rejects.toThrow(/unknown placeholder/);
  });
});

// ── No stderr leak ─────────────────────────────────────────────────────────

describe('Resolve — test isolation', () => {
  // Regression guard for the audit observation: `bun test` was emitting
  // "fnclaude: cloning fnrhombus/arch-setup → /home/tom/src/arch-setup@fnrhombus"
  // to the real stderr. That came from a `process.stderr.write` inside
  // cloneAndReturn that bypassed the deps seam. The fix routes the line
  // through `deps.log`; this test pins it down.
  test('clone path writes nothing to real process.stderr when deps are injected', async () => {
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const { deps, state } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
      const r = await Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{repo}@{owner}' },
        },
        deps,
      );
      expect(r.justCloned).toBe(true);
      expect(state.logs.length).toBeGreaterThan(0);
      // Nothing should have hit the real stderr during the test.
      expect(captured.join('')).toBe('');
    } finally {
      process.stderr.write = original;
    }
  });
});

// ── Clone failure path ─────────────────────────────────────────────────────

describe('Resolve — clone failure', () => {
  test('runClone error surfaces', async () => {
    const { deps, state } = makeDeps({ ghHits: new Set(['fnrhombus/arch-setup']) });
    state.cloneError = new Error('network down');
    await expect(
      Resolve(
        {
          input: 'arch-setup',
          cwd: '/cwd',
          home: '/home/tom',
          settings: { cloneTemplate: '~/src/{repo}@{owner}' },
        },
        deps,
      ),
    ).rejects.toThrow(/gh repo clone failed/);
  });
});
