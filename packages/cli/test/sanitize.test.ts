import { describe, expect, test } from 'bun:test';
import { sanitizeName, sanitizeNamesInPassthrough } from '../src/sanitize.js';

// Mirrors src/sanitize_test.go from the Go reference; sanitizeName is the
// TS-side rename of sanitizeForPath and returns undefined instead of (string,
// false) when sanitization yields nothing usable.

type Case = { name: string; in: string; want: string | undefined };

const sanitizeCases: Case[] = [
  // passthrough
  { name: 'already safe lowercase', in: 'hello-world', want: 'hello-world' },
  { name: 'mixed case allowed', in: 'Foo_Bar', want: 'Foo_Bar' },
  { name: 'versioned', in: 'v1.2.3', want: 'v1.2.3' },
  { name: 'digits', in: 'abc123', want: 'abc123' },

  // single forbidden chars become hyphens
  { name: 'space', in: 'foo bar', want: 'foo-bar' },
  { name: 'backslash', in: 'foo\\bar', want: 'foo-bar' },
  { name: 'colon', in: 'foo:bar', want: 'foo-bar' },
  { name: 'star', in: 'foo*bar', want: 'foo-bar' },
  { name: 'qmark', in: 'foo?bar', want: 'foo-bar' },
  { name: 'pipe', in: 'foo|bar', want: 'foo-bar' },
  { name: 'tilde', in: 'foo~bar', want: 'foo-bar' },
  { name: 'caret', in: 'foo^bar', want: 'foo-bar' },

  // slash allowed
  { name: 'slash preserved', in: 'foo/bar', want: 'foo/bar' },
  { name: 'nested feature branch', in: 'feat/foo', want: 'feat/foo' },
  { name: 'deeply nested', in: 'team/x/y/z', want: 'team/x/y/z' },
  { name: 'mixed dashes and slashes', in: 'foo-/-bar', want: 'foo-/-bar' },

  // runs collapse
  { name: 'multi-space', in: 'foo   bar', want: 'foo-bar' },
  { name: 'mixed punct', in: 'foo!@#$bar', want: 'foo-bar' },
  { name: 'double slash collapsed', in: 'foo//bar', want: 'foo/bar' },
  { name: 'run of hyphens', in: 'foo---bar', want: 'foo-bar' },

  // trim leading/trailing
  { name: 'leading hyphen', in: '-foo', want: 'foo' },
  { name: 'leading hyphens', in: '---foo', want: 'foo' },
  { name: 'leading dot', in: '.hidden', want: 'hidden' },
  { name: 'leading dots', in: '..parent', want: 'parent' },
  { name: 'leading mixed', in: '.-.-foo', want: 'foo' },
  { name: 'trailing hyphen', in: 'foo-', want: 'foo' },
  { name: 'trailing slash', in: 'foo/', want: 'foo' },
  { name: 'trailing slashes collapse and strip', in: 'foo///', want: 'foo' },

  // middle dots preserved
  { name: 'middle dots', in: 'foo.bar.baz', want: 'foo.bar.baz' },

  // non-ASCII forbidden
  { name: 'accent stripped', in: 'café', want: 'caf' },
  { name: 'diaeresis', in: 'naïve-attempt', want: 'na-ve-attempt' },

  // empty results
  { name: 'empty input', in: '', want: undefined },
  { name: 'only spaces', in: '   ', want: undefined },
  { name: 'only punct', in: '???', want: undefined },
  { name: 'only hyphens', in: '---', want: undefined },
  { name: 'only dots', in: '...', want: undefined },
  { name: 'only slashes', in: '///', want: undefined },
  { name: 'only non-ASCII', in: '日本語', want: undefined },

  // path escape / git ref-format rejections
  { name: 'leading slash', in: '/foo', want: undefined },
  { name: 'path escape via dotdot', in: 'foo/../bar', want: undefined },
  { name: 'double-dot anywhere', in: 'foo..bar', want: undefined },
  { name: 'trailing double-dot', in: 'foo..', want: undefined },

  // control chars
  { name: 'NUL', in: 'foo\x00bar', want: 'foo-bar' },
  { name: 'newline', in: 'foo\nbar', want: 'foo-bar' },
  { name: 'tab', in: 'foo\tbar', want: 'foo-bar' },
];

describe('sanitizeName', () => {
  for (const tc of sanitizeCases) {
    test(tc.name, () => {
      expect(sanitizeName(tc.in)).toBe(tc.want);
    });
  }
});

describe('sanitizeNamesInPassthrough', () => {
  type PCase = {
    name: string;
    in: string[];
    wantOut: string[];
    wantWarnings: number;
  };
  const cases: PCase[] = [
    {
      name: 'no name present',
      in: ['--', 'fix the bug'],
      wantOut: ['--', 'fix the bug'],
      wantWarnings: 0,
    },
    {
      name: 'clean --name split form',
      in: ['--name', 'fix-bug', '--', 'go'],
      wantOut: ['--name', 'fix-bug', '--', 'go'],
      wantWarnings: 0,
    },
    {
      name: 'dirty --name split form',
      in: ['--name', 'foo/bar baz', '--', 'go'],
      wantOut: ['--name', 'foo/bar-baz', '--', 'go'],
      wantWarnings: 1,
    },
    {
      name: 'clean --name= form with slash',
      in: ['--name=foo/bar', '--', 'go'],
      wantOut: ['--name=foo/bar', '--', 'go'],
      wantWarnings: 0,
    },
    {
      name: 'dirty -n split form',
      in: ['-n', 'weird name!', '--'],
      wantOut: ['-n', 'weird-name', '--'],
      wantWarnings: 1,
    },
    {
      name: 'clean -n= form with slash',
      in: ['-n=foo/bar'],
      wantOut: ['-n=foo/bar'],
      wantWarnings: 0,
    },
    {
      name: 'all-unsafe value passes through with warning',
      in: ['--name', '???', '--', 'go'],
      wantOut: ['--name', '???', '--', 'go'],
      wantWarnings: 1,
    },
    {
      name: 'multiple names: slash form clean, space form sanitized',
      in: ['--name=foo/bar', '-n', 'baz qux'],
      wantOut: ['--name=foo/bar', '-n', 'baz-qux'],
      wantWarnings: 1,
    },
    {
      name: '--name at end with no value passes through untouched',
      in: ['--name'],
      wantOut: ['--name'],
      wantWarnings: 0,
    },
    {
      name: '-n at end with no value passes through untouched',
      in: ['-n'],
      wantOut: ['-n'],
      wantWarnings: 0,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const { args, warnings } = sanitizeNamesInPassthrough(tc.in);
      expect(args).toEqual(tc.wantOut);
      expect(warnings).toHaveLength(tc.wantWarnings);
    });
  }

  test('does not mutate input array', () => {
    const input = ['--name', 'foo bar'];
    const snapshot = [...input];
    sanitizeNamesInPassthrough(input);
    expect(input).toEqual(snapshot);
  });
});
