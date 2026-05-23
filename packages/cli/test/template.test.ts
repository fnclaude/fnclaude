import { describe, expect, test } from 'bun:test';
import { substitute } from '../src/template.js';

// Mirrors the behaviour of buildSpawnArgv's inline substitution logic and the
// generic substitute helper described in the porting spec.

type SubstCase = {
  name: string;
  tpl: string;
  vars: Record<string, string>;
  want: string;
};

const substituteCases: SubstCase[] = [
  // basic single substitution
  {
    name: 'single known key',
    tpl: 'hello {name}',
    vars: { name: 'world' },
    want: 'hello world',
  },
  // multiple distinct keys
  {
    name: 'multiple keys',
    tpl: '{bin} {dest} --name {name} @{summary}',
    vars: { bin: '/usr/bin/fnc', dest: '/tmp/proj', name: 'fix-bug', summary: '/tmp/s.md' },
    want: '/usr/bin/fnc /tmp/proj --name fix-bug @/tmp/s.md',
  },
  // repeated key
  {
    name: 'repeated key',
    tpl: '{x} and {x}',
    vars: { x: 'hi' },
    want: 'hi and hi',
  },
  // empty template
  {
    name: 'empty template',
    tpl: '',
    vars: { key: 'val' },
    want: '',
  },
  // no placeholders in template
  {
    name: 'no placeholders',
    tpl: 'plain text',
    vars: { key: 'val' },
    want: 'plain text',
  },
  // missing key → verbatim
  {
    name: 'missing key left verbatim',
    tpl: 'prefix {missing} suffix',
    vars: {},
    want: 'prefix {missing} suffix',
  },
  // mix of present and missing
  {
    name: 'present and missing keys',
    tpl: '{bin} {unknown}',
    vars: { bin: '/fnc' },
    want: '/fnc {unknown}',
  },
  // empty string value
  {
    name: 'empty value substituted',
    tpl: 'a{x}b',
    vars: { x: '' },
    want: 'ab',
  },
  // value with spaces
  {
    name: 'value with spaces',
    tpl: '{path}',
    vars: { path: '/home/user/my project' },
    want: '/home/user/my project',
  },
  // unterminated brace — passed through literally
  {
    name: 'unterminated open brace',
    tpl: 'foo { bar',
    vars: { bar: 'x' },
    want: 'foo { bar',
  },
  // adjacent placeholders
  {
    name: 'adjacent placeholders',
    tpl: '{a}{b}',
    vars: { a: 'X', b: 'Y' },
    want: 'XY',
  },
  // placeholder at start
  {
    name: 'placeholder at start',
    tpl: '{bin} rest',
    vars: { bin: '/fnc' },
    want: '/fnc rest',
  },
  // placeholder at end
  {
    name: 'placeholder at end',
    tpl: 'rest {bin}',
    vars: { bin: '/fnc' },
    want: 'rest /fnc',
  },
  // empty key name
  {
    name: 'empty key name is unknown',
    tpl: 'a{}b',
    vars: {},
    want: 'a{}b',
  },
  // empty key but provided in vars
  {
    name: 'empty key provided in vars',
    tpl: 'a{}b',
    vars: { '': 'Z' },
    want: 'aZb',
  },
];

describe('substitute', () => {
  for (const tc of substituteCases) {
    test(tc.name, () => {
      expect(substitute(tc.tpl, tc.vars)).toBe(tc.want);
    });
  }
});
