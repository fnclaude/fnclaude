import { describe, expect, test } from 'bun:test';

import { sanitizeForPath } from '../../src/name/sanitize';

describe('sanitizeForPath — unchanged when input is already safe', () => {
  test('plain name', () => {
    expect(sanitizeForPath('feat-foo')).toEqual({ kind: 'unchanged', value: 'feat-foo' });
  });
  test('alphanumeric with underscore (allowed by [A-Za-z0-9._/-])', () => {
    expect(sanitizeForPath('my_thing')).toEqual({ kind: 'unchanged', value: 'my_thing' });
  });
  test('with dot', () => {
    expect(sanitizeForPath('v1.2.3')).toEqual({ kind: 'unchanged', value: 'v1.2.3' });
  });
  test('with slash (allowed for nested refs)', () => {
    expect(sanitizeForPath('feat/foo')).toEqual({ kind: 'unchanged', value: 'feat/foo' });
  });
  test('nested slashes ok', () => {
    expect(sanitizeForPath('team/x/y')).toEqual({ kind: 'unchanged', value: 'team/x/y' });
  });
});

describe('sanitizeForPath — replace bad chars with dash', () => {
  test('space → dash', () => {
    expect(sanitizeForPath('my feature')).toEqual({
      kind: 'changed',
      value: 'my-feature',
      original: 'my feature',
    });
  });
  test('multiple bad chars collapse to single dash (regex replaces RUN)', () => {
    expect(sanitizeForPath('a   b')).toEqual({
      kind: 'changed',
      value: 'a-b',
      original: 'a   b',
    });
  });
  test('emoji → single dash for the run', () => {
    expect(sanitizeForPath('hi🎉there')).toEqual({
      kind: 'changed',
      value: 'hi-there',
      original: 'hi🎉there',
    });
  });
  test('special chars all dashed', () => {
    expect(sanitizeForPath('a!b@c#d$e')).toEqual({
      kind: 'changed',
      value: 'a-b-c-d-e',
      original: 'a!b@c#d$e',
    });
  });
});

describe('sanitizeForPath — collapse dash runs', () => {
  test('-- → -', () => {
    expect(sanitizeForPath('a--b')).toEqual({
      kind: 'changed',
      value: 'a-b',
      original: 'a--b',
    });
  });
  test('--- → -', () => {
    expect(sanitizeForPath('a---b')).toEqual({
      kind: 'changed',
      value: 'a-b',
      original: 'a---b',
    });
  });
});

describe('sanitizeForPath — collapse slash runs', () => {
  test('// → /', () => {
    expect(sanitizeForPath('a//b')).toEqual({
      kind: 'changed',
      value: 'a/b',
      original: 'a//b',
    });
  });
  test('/// → /', () => {
    expect(sanitizeForPath('a///b')).toEqual({
      kind: 'changed',
      value: 'a/b',
      original: 'a///b',
    });
  });
});

describe('sanitizeForPath — trim leading and trailing', () => {
  test('leading dash trimmed', () => {
    expect(sanitizeForPath('-foo')).toEqual({
      kind: 'changed',
      value: 'foo',
      original: '-foo',
    });
  });
  test('leading dot trimmed', () => {
    expect(sanitizeForPath('.hidden')).toEqual({
      kind: 'changed',
      value: 'hidden',
      original: '.hidden',
    });
  });
  test('multiple leading - and . trimmed', () => {
    expect(sanitizeForPath('-.-.foo')).toEqual({
      kind: 'changed',
      value: 'foo',
      original: '-.-.foo',
    });
  });
  test('trailing dash trimmed', () => {
    expect(sanitizeForPath('foo-')).toEqual({
      kind: 'changed',
      value: 'foo',
      original: 'foo-',
    });
  });
  test('trailing slash trimmed', () => {
    expect(sanitizeForPath('foo/')).toEqual({
      kind: 'changed',
      value: 'foo',
      original: 'foo/',
    });
  });
  test('NOT trimmed on the other end: leading slash is invalid (separate test)', () => {
    // covered in invalid section
  });
});

describe('sanitizeForPath — invalid cases', () => {
  test('empty input → invalid', () => {
    const r = sanitizeForPath('');
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.original).toBe('');
  });

  test('absolute path (starts with /) → invalid (path-escape risk)', () => {
    const r = sanitizeForPath('/etc/passwd');
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.original).toBe('/etc/passwd');
  });

  test('result contains `..` → invalid (path-escape prevention)', () => {
    const r = sanitizeForPath('foo..bar');
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.original).toBe('foo..bar');
  });

  test('input that sanitizes to empty → invalid', () => {
    // All-special with leading/trailing trim eats it
    const r = sanitizeForPath('---');
    expect(r.kind).toBe('invalid');
  });

  test('input that becomes `..` after sanitization → invalid', () => {
    // '..' is bare dots, kept by step 3 (.dots are allowed), then leading trim eats them
    const r = sanitizeForPath('..');
    expect(r.kind).toBe('invalid');
  });
});

describe('sanitizeForPath — combined pipeline', () => {
  test('emoji + spaces + dashes: hi 🎉 there!! → hi-there', () => {
    expect(sanitizeForPath('hi 🎉 there!!')).toEqual({
      kind: 'changed',
      value: 'hi-there',
      original: 'hi 🎉 there!!',
    });
  });
  test('"-- foo --" → foo', () => {
    expect(sanitizeForPath('-- foo --')).toEqual({
      kind: 'changed',
      value: 'foo',
      original: '-- foo --',
    });
  });
  test('"feat/foo bar/baz" → feat/foo-bar/baz', () => {
    expect(sanitizeForPath('feat/foo bar/baz')).toEqual({
      kind: 'changed',
      value: 'feat/foo-bar/baz',
      original: 'feat/foo bar/baz',
    });
  });
});
