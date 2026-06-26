import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  injectFragments,
  loadFragments,
} from '../../src/prompts/load';

let tmpRoot: string;
let promptsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-prompts-'));
  promptsDir = join(tmpRoot, 'prompts');
  mkdirSync(promptsDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFragment(name: string, content: string) {
  writeFileSync(join(promptsDir, name), content);
}

describe('loadFragments', () => {
  test('empty names → empty content, no warnings', () => {
    const r = loadFragments([], promptsDir);
    expect(r.content).toBe('');
    expect(r.warnings).toEqual([]);
  });

  test('single fragment loaded verbatim', () => {
    writeFragment('one.md', 'hello from one');
    const r = loadFragments(['one.md'], promptsDir);
    expect(r.content).toBe('hello from one');
  });

  test('multiple fragments joined with double newline', () => {
    writeFragment('a.md', 'fragment A');
    writeFragment('b.md', 'fragment B');
    const r = loadFragments(['a.md', 'b.md'], promptsDir);
    expect(r.content).toBe('fragment A\n\nfragment B');
  });

  test('missing fragment → warning, skip, others loaded', () => {
    writeFragment('a.md', 'fragment A');
    writeFragment('b.md', 'fragment B');
    const r = loadFragments(['a.md', 'missing.md', 'b.md'], promptsDir);
    expect(r.content).toBe('fragment A\n\nfragment B');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('missing.md');
  });

  test('all fragments missing → empty content, all warned', () => {
    const r = loadFragments(['x.md', 'y.md'], promptsDir);
    expect(r.content).toBe('');
    expect(r.warnings.length).toBe(2);
  });

  test('fragment with trailing newline preserved (no trim)', () => {
    writeFragment('a.md', 'has trailing\n');
    writeFragment('b.md', 'second');
    const r = loadFragments(['a.md', 'b.md'], promptsDir);
    expect(r.content).toBe('has trailing\n\n\nsecond');
  });
});

describe('injectFragments — passthrough mutation', () => {
  test('empty content → passthrough unchanged', () => {
    expect(injectFragments(['--verbose', '--', 'hi'], '')).toEqual([
      '--verbose',
      '--',
      'hi',
    ]);
  });

  test('no existing --append-system-prompt → splice before --', () => {
    expect(injectFragments(['--verbose', '--', 'hi'], 'INJECTED')).toEqual([
      '--verbose',
      '--append-system-prompt',
      'INJECTED',
      '--',
      'hi',
    ]);
  });

  test('no `--` sentinel → push to end', () => {
    expect(injectFragments(['--verbose'], 'INJECTED')).toEqual([
      '--verbose',
      '--append-system-prompt',
      'INJECTED',
    ]);
  });

  test('existing --append-system-prompt → append content', () => {
    expect(
      injectFragments(['--append-system-prompt', 'EXISTING', '--verbose'], 'INJECTED'),
    ).toEqual(['--append-system-prompt', 'EXISTING\n\nINJECTED', '--verbose']);
  });

  test('existing --append-system-prompt=val (single-token) → append after =', () => {
    expect(
      injectFragments(['--append-system-prompt=EXISTING', '--verbose'], 'INJECTED'),
    ).toEqual(['--append-system-prompt=EXISTING\n\nINJECTED', '--verbose']);
  });

  test('empty passthrough + content → just the flag', () => {
    expect(injectFragments([], 'INJECTED')).toEqual(['--append-system-prompt', 'INJECTED']);
  });

  test('multiple --append-system-prompt (defensive: last existing one wins)', () => {
    // claude takes last anyway; we append to the last occurrence to keep merge ordered.
    expect(
      injectFragments(
        ['--append-system-prompt', 'first', '--append-system-prompt', 'second'],
        'INJECTED',
      ),
    ).toEqual([
      '--append-system-prompt',
      'first',
      '--append-system-prompt',
      'second\n\nINJECTED',
    ]);
  });
});
