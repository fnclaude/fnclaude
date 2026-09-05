/**
 * Unit tests for the resolver, now that repo location belongs to fngit.
 *
 * What is left for fnc, and therefore what is tested here:
 *   - no argument → the starting directory;
 *   - explicit path forms, which never reach fngit;
 *   - the `+workspace` suffix, which fnc strips and fngit never sees;
 *   - the bare-word-that-is-a-directory case, which wins over fngit;
 *   - handing everything else to fngit and relaying its answer or its error;
 *   - the missing-fngit error, which must name `fnc install`.
 *
 * fngit is driven entirely through the injected runner. That is not just
 * convenience: the npm build available while this was written (1.3.0) predates
 * the CLI contract in specs/rhombus-rocks-config.md, so a test against a real
 * binary would be testing the wrong thing. The seam is the contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FngitResult, FngitRunner } from '../../src/repo/fngit';
import { type ResolveResult, resolveInput } from '../../src/repo/resolve-input';

let tmpRoot: string;
let HOME: string;
let SHELL_CWD: string;
let NOOP: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-resolve-'));
  HOME = join(tmpRoot, 'home');
  SHELL_CWD = join(tmpRoot, 'cwd');
  NOOP = join(HOME, '.config', 'rhombus.rocks', 'fnclaude', 'noop');
  mkdirSync(HOME, { recursive: true });
  mkdirSync(SHELL_CWD, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A runner that records its calls and replies with a canned result. */
function stubFngit(result: Partial<FngitResult>): {
  run: FngitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: FngitRunner = async (args) => {
    calls.push([...args]);
    return { ok: true, stdout: '', stderr: '', exitCode: 0, ...result };
  };
  return { run, calls };
}

/** A runner that fails the test if it is ever called. */
const neverCalled: FngitRunner = async (args) => {
  throw new Error(`fngit should not have been invoked, but got: ${args.join(' ')}`);
};

function args(over: Partial<Parameters<typeof resolveInput>[0]> = {}): Parameters<
  typeof resolveInput
>[0] {
  return {
    input: null,
    shellCwd: SHELL_CWD,
    home: HOME,
    noopDir: NOOP,
    fngit: neverCalled,
    ...over,
  };
}

function assertLaunch(r: ResolveResult): Extract<ResolveResult, { kind: 'launch' }> {
  if (r.kind !== 'launch') throw new Error(`expected launch, got ${r.kind}: ${JSON.stringify(r)}`);
  return r;
}

function assertError(r: ResolveResult): Extract<ResolveResult, { kind: 'error' }> {
  if (r.kind !== 'error') throw new Error(`expected error, got ${r.kind}: ${JSON.stringify(r)}`);
  return r;
}

describe('no argument → the starting directory', () => {
  test('null input', async () => {
    const r = assertLaunch(await resolveInput(args({ input: null })));
    expect(r.launchCwd).toBe(NOOP);
    expect(r.usedNoopFallback).toBe(true);
  });

  test('empty string', async () => {
    const r = assertLaunch(await resolveInput(args({ input: '' })));
    expect(r.launchCwd).toBe(NOOP);
    expect(r.usedNoopFallback).toBe(true);
  });

  test('the caller-supplied noopDir is used verbatim — a configured noopDir wins', async () => {
    const custom = join(tmpRoot, 'elsewhere');
    const r = assertLaunch(await resolveInput(args({ input: null, noopDir: custom })));
    expect(r.launchCwd).toBe(custom);
  });
});

describe('path short-circuit — never reaches fngit', () => {
  test('absolute path', async () => {
    const r = assertLaunch(await resolveInput(args({ input: '/srv/thing' })));
    expect(r.launchCwd).toBe('/srv/thing');
    expect(r.usedNoopFallback).toBe(false);
  });

  test('bare tilde → home', async () => {
    expect(assertLaunch(await resolveInput(args({ input: '~' }))).launchCwd).toBe(HOME);
  });

  test('~/foo → HOME/foo', async () => {
    expect(assertLaunch(await resolveInput(args({ input: '~/foo' }))).launchCwd).toBe(
      join(HOME, 'foo'),
    );
  });

  test('. and .. resolve against the shell cwd', async () => {
    expect(assertLaunch(await resolveInput(args({ input: '.' }))).launchCwd).toBe(
      join(SHELL_CWD, '.'),
    );
    expect(assertLaunch(await resolveInput(args({ input: '..' }))).launchCwd).toBe(
      join(SHELL_CWD, '..'),
    );
  });

  test('./name forces the path reading of a word that could be a repo', async () => {
    const r = assertLaunch(await resolveInput(args({ input: './fnclaude' })));
    expect(r.launchCwd).toBe(join(SHELL_CWD, 'fnclaude'));
  });

  test('the directory need not exist — the user said "go here"', async () => {
    const r = assertLaunch(await resolveInput(args({ input: '/definitely/not/here' })));
    expect(r.launchCwd).toBe('/definitely/not/here');
  });

  test('a path may carry a +workspace suffix too', async () => {
    const r = assertLaunch(await resolveInput(args({ input: '~/src/thing+feat' })));
    expect(r.launchCwd).toBe(join(HOME, 'src', 'thing'));
    expect(r.workspace).toBe('feat');
  });
});

describe('a bare word naming a real directory wins over fngit', () => {
  test('an existing directory in the shell cwd is launched, fngit untouched', async () => {
    mkdirSync(join(SHELL_CWD, 'packages'), { recursive: true });
    const r = assertLaunch(await resolveInput(args({ input: 'packages' })));
    expect(r.launchCwd).toBe(join(SHELL_CWD, 'packages'));
  });

  test('a name@owner form goes to fngit even if a like-named directory exists', async () => {
    mkdirSync(join(SHELL_CWD, 'thing@owner'), { recursive: true });
    const { run, calls } = stubFngit({ stdout: '/resolved/thing' });
    const r = assertLaunch(await resolveInput(args({ input: 'thing@owner', fngit: run })));
    expect(r.launchCwd).toBe('/resolved/thing');
    expect(calls).toEqual([['clone', 'thing@owner']]);
  });

  test('a bare word that is NOT a directory goes to fngit', async () => {
    const { run, calls } = stubFngit({ stdout: '/src/fnclaude@fnclaude' });
    const r = assertLaunch(await resolveInput(args({ input: 'fnclaude', fngit: run })));
    expect(r.launchCwd).toBe('/src/fnclaude@fnclaude');
    expect(calls).toEqual([['clone', 'fnclaude']]);
  });
});

describe('repo references go to fngit', () => {
  test('every reference form is passed through verbatim — fnc does not parse them', async () => {
    for (const ref of [
      'fnclaude',
      'fnclaude@fnclaude',
      'fnclaude/fnclaude',
      'gh:fnclaude/fnclaude',
      'https://github.com/fnclaude/fnclaude',
      'https://github.com/fnclaude/fnclaude.git',
      'git@github.com:fnclaude/fnclaude.git',
      'ssh://git@github.com/fnclaude/fnclaude.git',
    ]) {
      const { run, calls } = stubFngit({ stdout: '/p' });
      const r = assertLaunch(await resolveInput(args({ input: ref, fngit: run })));
      expect(r.launchCwd).toBe('/p');
      expect(calls).toEqual([['clone', ref]]);
    }
  });

  test('the +workspace suffix is stripped before the call and returned separately', async () => {
    const { run, calls } = stubFngit({ stdout: '/src/arch-setup@fnclaude' });
    const r = assertLaunch(
      await resolveInput(args({ input: 'fnclaude/arch-setup+my-feature', fngit: run })),
    );
    expect(calls).toEqual([['clone', 'fnclaude/arch-setup']]);
    expect(r.workspace).toBe('my-feature');
    expect(r.launchCwd).toBe('/src/arch-setup@fnclaude');
  });

  test('a worktree name may itself contain +', async () => {
    const { run, calls } = stubFngit({ stdout: '/p' });
    const r = assertLaunch(await resolveInput(args({ input: 'repo+a+b', fngit: run })));
    expect(calls).toEqual([['clone', 'repo']]);
    expect(r.workspace).toBe('a+b');
  });

  test('a trailing + is a typo, not a request for a worktree named ""', async () => {
    const { run } = stubFngit({ stdout: '/p' });
    const r = assertLaunch(await resolveInput(args({ input: 'repo+', fngit: run })));
    expect(r.workspace).toBe('');
  });

  test('a reference that is only a +suffix is an error', async () => {
    const r = assertError(await resolveInput(args({ input: '+feat' })));
    expect(r.error).toContain('empty repo reference');
  });

  test("only the last stdout line is taken as the path, so a stray line can't corrupt the cwd", async () => {
    const { run } = stubFngit({ stdout: 'Cloning…\n/src/thing\n' });
    expect(assertLaunch(await resolveInput(args({ input: 'thing', fngit: run }))).launchCwd).toBe(
      '/src/thing',
    );
  });
});

describe('fngit failures are relayed, never reinterpreted', () => {
  test("fngit's stderr becomes the error message verbatim", async () => {
    const { run } = stubFngit({
      ok: false,
      exitCode: 4,
      stderr: 'no repository named "nope" and gh reports no owner',
    });
    const r = assertError(await resolveInput(args({ input: 'nope', fngit: run })));
    expect(r.error).toContain('no repository named "nope" and gh reports no owner');
  });

  test('a silent non-zero exit still produces a message naming the code', async () => {
    const { run } = stubFngit({ ok: false, exitCode: 3, stderr: '' });
    const r = assertError(await resolveInput(args({ input: 'nope', fngit: run })));
    expect(r.error).toContain('fngit exited 3');
  });

  test('a zero exit with no path is an error, not a launch in ""', async () => {
    const { run } = stubFngit({ ok: true, stdout: '' });
    const r = assertError(await resolveInput(args({ input: 'thing', fngit: run })));
    expect(r.error).toContain('printed no path');
  });

  test('a runner that throws is caught', async () => {
    const boom: FngitRunner = async () => {
      throw new Error('ENOENT');
    };
    const r = assertError(await resolveInput(args({ input: 'thing', fngit: boom })));
    expect(r.error).toContain('failed to run fngit');
  });
});

describe('fngit not installed', () => {
  test('a repo reference errors, and the message names `fnc install`', async () => {
    const r = assertError(await resolveInput(args({ input: 'fnclaude', fngit: null })));
    expect(r.error).toContain('fnc install');
    expect(r.error).toContain('fngit is not installed');
  });

  test('paths still work — that is the documented degraded mode', async () => {
    expect(assertLaunch(await resolveInput(args({ input: '/srv/x', fngit: null }))).launchCwd).toBe(
      '/srv/x',
    );
    expect(assertLaunch(await resolveInput(args({ input: '~/x', fngit: null }))).launchCwd).toBe(
      join(HOME, 'x'),
    );
    expect(assertLaunch(await resolveInput(args({ input: './x', fngit: null }))).launchCwd).toBe(
      join(SHELL_CWD, 'x'),
    );
  });

  test('and so does the no-argument case', async () => {
    expect(assertLaunch(await resolveInput(args({ input: null, fngit: null }))).usedNoopFallback).toBe(
      true,
    );
  });

  test('a bare word naming a real directory still resolves without fngit', async () => {
    mkdirSync(join(SHELL_CWD, 'here'), { recursive: true });
    expect(assertLaunch(await resolveInput(args({ input: 'here', fngit: null }))).launchCwd).toBe(
      join(SHELL_CWD, 'here'),
    );
  });
});
