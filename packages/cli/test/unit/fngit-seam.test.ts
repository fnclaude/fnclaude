/**
 * Unit tests for the fngit CLI seam.
 *
 * `makeFngitRunner` is exercised against real subprocesses — small shell
 * scripts standing in for fngit — because what it has to get right is process
 * plumbing: capture stdout and stderr separately, don't inherit stderr (fngit
 * writes clone progress there, and inheriting would interleave it with fnc's
 * own diagnostics), and surface the exit code.
 *
 * `locateRepo` is tested through an injected runner, which is also how the
 * rest of fnc consumes it. The npm build available while this was written
 * (1.3.0) predates the CLI contract in specs/rhombus-rocks-config.md, so the
 * seam is the only thing that can be tested honestly today.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FngitRunner, locateRepo, makeFngitRunner, missingFngitError } from '../../src/repo/fngit';

const SKIP_WINDOWS = process.platform === 'win32';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-fngit-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write an executable stand-in for the fngit binary. */
function fakeFngit(body: string): string {
  const path = join(tmpRoot, 'fngit');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(SKIP_WINDOWS)('makeFngitRunner — process plumbing', () => {
  test('captures stdout, trims it, and reports success', async () => {
    const run = makeFngitRunner(fakeFngit('echo "/src/thing@owner"'));
    const r = await run(['clone', 'thing@owner']);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('/src/thing@owner');
    expect(r.exitCode).toBe(0);
  });

  test('passes its arguments through in order', async () => {
    const run = makeFngitRunner(fakeFngit('echo "$@"'));
    expect((await run(['clone', 'a', '--depth', '1'])).stdout).toBe('clone a --depth 1');
  });

  test('captures stderr separately from stdout', async () => {
    const run = makeFngitRunner(fakeFngit('echo out; echo err >&2'));
    const r = await run(['clone', 'x']);
    expect(r.stdout).toBe('out');
    expect(r.stderr).toBe('err');
  });

  test('stderr is PIPED, not inherited — clone progress must not reach the terminal', async () => {
    // If stderr were inherited, this child's noise would land on the test
    // runner's stderr and `r.stderr` would come back empty.
    const run = makeFngitRunner(fakeFngit('echo "Cloning into ..." >&2; echo /p'));
    const r = await run(['clone', 'x']);
    expect(r.stderr).toBe('Cloning into ...');
    expect(r.stdout).toBe('/p');
  });

  test('a non-zero exit is reported with its code and stderr', async () => {
    const run = makeFngitRunner(fakeFngit('echo "no such repo" >&2; exit 4'));
    const r = await run(['clone', 'nope']);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toBe('no such repo');
  });
});

describe('missingFngitError', () => {
  test('names `fnc install`, so the user has something to run next', () => {
    const msg = missingFngitError('fnclaude');
    expect(msg).toContain('fnc install');
    expect(msg).toContain('fngit is not installed');
  });

  test('quotes the reference so an empty or odd one is still legible', () => {
    expect(missingFngitError('')).toContain('""');
  });

  test('says what still works, not only what does not', () => {
    expect(missingFngitError('x')).toContain('absolute');
  });
});

describe('locateRepo', () => {
  const ok =
    (stdout: string): FngitRunner =>
    async () => ({ ok: true, stdout, stderr: '', exitCode: 0 });

  test('calls `fngit clone <ref>` and returns the printed path', async () => {
    const calls: string[][] = [];
    const run: FngitRunner = async (a) => {
      calls.push([...a]);
      return { ok: true, stdout: '/src/x', stderr: '', exitCode: 0 };
    };
    expect(await locateRepo({ ref: 'x', fngit: run })).toEqual({ ok: true, path: '/src/x' });
    expect(calls).toEqual([['clone', 'x']]);
  });

  test('reports progress before running, so a network clone is not a silent pause', async () => {
    const lines: string[] = [];
    await locateRepo({ ref: 'x', fngit: ok('/p'), onProgress: (l) => lines.push(l) });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('x');
  });

  test('with no fngit, returns the `fnc install` error without running anything', async () => {
    const r = await locateRepo({ ref: 'x', fngit: null });
    expect(r).toEqual({ ok: false, error: missingFngitError('x') });
  });

  test('relays stderr verbatim — fnc must not reinterpret fngit diagnostics', async () => {
    const run: FngitRunner = async () => ({
      ok: false,
      stdout: '',
      stderr: 'gh: not authenticated. Run `gh auth login`.',
      exitCode: 1,
    });
    const r = await locateRepo({ ref: 'x', fngit: run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('gh: not authenticated. Run `gh auth login`.');
  });

  test('a silent failure still names the exit code', async () => {
    const run: FngitRunner = async () => ({ ok: false, stdout: '', stderr: '', exitCode: 9 });
    const r = await locateRepo({ ref: 'x', fngit: run });
    if (!r.ok) expect(r.error).toContain('fngit exited 9');
  });

  test('success with no path is an error, not a launch in ""', async () => {
    const r = await locateRepo({ ref: 'x', fngit: ok('   \n  \n') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('printed no path');
  });

  test('the LAST non-empty stdout line is the path', async () => {
    expect(await locateRepo({ ref: 'x', fngit: ok('noise\n/real/path\n') })).toEqual({
      ok: true,
      path: '/real/path',
    });
  });

  test('a runner that throws becomes an error, not an unhandled rejection', async () => {
    const boom: FngitRunner = async () => {
      throw new Error('spawn EACCES');
    };
    const r = await locateRepo({ ref: 'x', fngit: boom });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('spawn EACCES');
  });
});
