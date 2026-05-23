// Mirror of src/preserve_args_test.go in the Go reference (1:1 ports of
// preserveCases and overrideCases). Adding/removing a case here without a
// matching change there is the contract violation.

import { describe, expect, test } from 'bun:test';
import {
  applyOverrides,
  flagPresent,
  isFlag,
  isMagicWord,
  preserveArgs,
  splitLeadingMagic,
  transferDenyBareOK,
  transferDenyFlags,
} from '../../src/args/preserve.js';
import type { Request } from '../../src/mcp/protocol.js';

// ── preserveArgs cases (mirror Go preserveCases) ──────────────────────────

interface PreserveCase {
  name: string;
  args: string[];
  deny?: ReadonlySet<string>;
  bareOK?: ReadonlySet<string>;
  expected: string[];
}

const preserveCases: PreserveCase[] = [
  { name: 'empty input', args: [], expected: [] },
  { name: 'magic only', args: ['opus', 'max'], expected: ['opus', 'max'] },
  { name: 'single path', args: ['src/'], expected: [] },
  { name: 'two paths', args: ['src/', 'extra-wt'], expected: [] },
  {
    name: 'magic then path',
    args: ['opus', 'max', 'src/'],
    expected: ['opus', 'max'],
  },
  {
    name: 'magic + path + flags',
    args: ['opus', 'max', 'src/', '--ide', '--brief'],
    expected: ['opus', 'max', '--ide', '--brief'],
  },
  { name: 'flags only', args: ['--verbose'], expected: ['--verbose'] },
  {
    name: 'flag with value (space form)',
    args: ['src/', '--model', 'sonnet', '-V'],
    expected: ['--model', 'sonnet', '-V'],
  },
  {
    name: 'flag with value (equals form)',
    args: ['src/', '--model=sonnet'],
    expected: ['--model=sonnet'],
  },
  {
    name: 'deny strips --add-dir + value',
    args: ['src/', '--ide', '--add-dir', 'docs', '--brief'],
    deny: new Set(['--add-dir']),
    expected: ['--ide', '--brief'],
  },
  {
    name: 'deny strips --add-dir=val (single token)',
    args: ['src/', '--ide', '--add-dir=docs', '--brief'],
    deny: new Set(['--add-dir']),
    expected: ['--ide', '--brief'],
  },
  {
    name: 'deny strips short flag + value',
    args: ['src/', '-A', 'extra/', '--ide'],
    deny: new Set(['-A', '--also']),
    expected: ['--ide'],
  },
  {
    name: 'bareOK keeps following positional when flag is bare',
    args: ['src/', '-w', '--ide'],
    deny: new Set(['-w', '--worktree']),
    bareOK: new Set(['-w', '--worktree']),
    expected: ['--ide'],
  },
  {
    name: 'denied flag without value-form still removes flag',
    args: ['src/', '--continue', '--ide'],
    deny: new Set(['--continue', '-c']),
    bareOK: new Set(['--continue', '-c']),
    expected: ['--ide'],
  },
  {
    name: 'deny applies multiple times',
    args: ['src/', '-A', 'x/', '--ide', '-A', 'y/', '--brief'],
    deny: new Set(['-A']),
    expected: ['--ide', '--brief'],
  },
  {
    name: 'nil deny preserves everything past path',
    args: ['src/', '--add-dir', 'x', '--ide'],
    expected: ['--add-dir', 'x', '--ide'],
  },
  {
    name: 'transfer denylist sample',
    args: [
      'src/',
      '--ide',
      '-A',
      'docs/',
      '--mcp-config',
      '/tmp/x.json',
      '--from-pr',
      '42',
      '--brief',
    ],
    deny: transferDenyFlags,
    bareOK: transferDenyBareOK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'transfer bareOK keeps non-flag following bare worktree',
    args: ['src/', '-w', '--ide', '--brief'],
    deny: transferDenyFlags,
    bareOK: transferDenyBareOK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'transfer denylist removes --resume + uuid',
    args: ['src/', '--ide', '--resume', '01234567-89ab-cdef-0123-456789abcdef'],
    deny: transferDenyFlags,
    bareOK: transferDenyBareOK,
    expected: ['--ide'],
  },
  {
    name: 'transfer denylist removes --name + name',
    args: ['src/', '--ide', '--name', 'topic', '--brief'],
    deny: transferDenyFlags,
    bareOK: transferDenyBareOK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'deny equals-form when flag-token in deny',
    args: ['src/', '--ide', '--from-pr=42', '--brief'],
    deny: transferDenyFlags,
    bareOK: transferDenyBareOK,
    expected: ['--ide', '--brief'],
  },
];

describe('preserveArgs', () => {
  for (const tc of preserveCases) {
    test(tc.name, () => {
      const got = preserveArgs(
        tc.args,
        tc.deny ?? null,
        tc.bareOK ?? null,
      );
      expect(got).toEqual(tc.expected);
    });
  }
});

// ── applyOverrides cases (mirror Go overrideCases) ────────────────────────

interface OverrideCase {
  name: string;
  preserved: string[];
  req: Request;
  expected: string[];
}

const overrideCases: OverrideCase[] = [
  {
    name: 'no overrides preserves input',
    preserved: ['opus', 'max', '--ide'],
    req: { op: 'restart' },
    expected: ['opus', 'max', '--ide'],
  },
  {
    name: 'model override strips bare magic and appends flag',
    preserved: ['opus', 'max', '--ide'],
    req: { op: 'restart', model: 'sonnet' },
    expected: ['max', '--ide', '--model', 'sonnet'],
  },
  {
    name: 'model override strips --model flag form',
    preserved: ['--ide', '--model', 'opus'],
    req: { op: 'restart', model: 'sonnet' },
    expected: ['--ide', '--model', 'sonnet'],
  },
  {
    name: 'model override strips --model=val equals form',
    preserved: ['--ide', '--model=opus', '--brief'],
    req: { op: 'restart', model: 'sonnet' },
    expected: ['--ide', '--brief', '--model', 'sonnet'],
  },
  {
    name: 'effort override strips bare magic and appends flag',
    preserved: ['opus', 'max', '--ide'],
    req: { op: 'restart', effort: 'high' },
    expected: ['opus', '--ide', '--effort', 'high'],
  },
  {
    name: 'effort override strips --effort flag form',
    preserved: ['--ide', '--effort', 'max'],
    req: { op: 'restart', effort: 'high' },
    expected: ['--ide', '--effort', 'high'],
  },
  {
    name: 'both model and effort overrides strip both bare magics',
    preserved: ['opus', 'max', '--ide'],
    req: { op: 'restart', model: 'sonnet', effort: 'low' },
    expected: ['--ide', '--model', 'sonnet', '--effort', 'low'],
  },
  {
    name: 'ide=true with no existing appends flag',
    preserved: ['--brief'],
    req: { op: 'restart', ide: true },
    expected: ['--brief', '--ide'],
  },
  {
    name: 'ide=true with existing strips and re-appends (no dup)',
    preserved: ['--ide', '--brief'],
    req: { op: 'restart', ide: true },
    expected: ['--brief', '--ide'],
  },
  {
    name: 'ide=false strips existing and does not append',
    preserved: ['--ide', '--brief'],
    req: { op: 'restart', ide: false },
    expected: ['--brief'],
  },
  {
    name: 'ide nil preserves existing',
    preserved: ['--ide', '--brief'],
    req: { op: 'restart' },
    expected: ['--ide', '--brief'],
  },
  {
    name: 'brief=true appends',
    preserved: ['--ide'],
    req: { op: 'restart', brief: true },
    expected: ['--ide', '--brief'],
  },
  {
    name: 'chrome=false strips existing',
    preserved: ['--chrome', '--ide'],
    req: { op: 'restart', chrome: false },
    expected: ['--ide'],
  },
  {
    name: 'verbose=true with no existing',
    preserved: [],
    req: { op: 'restart', verbose: true },
    expected: ['--verbose'],
  },
  {
    name: 'permission_mode string overrides existing',
    preserved: ['--permission-mode', 'default'],
    req: { op: 'restart', permission_mode: 'bypassPermissions' },
    expected: ['--permission-mode', 'bypassPermissions'],
  },
  {
    name: 'allowed_tools string appends when absent',
    preserved: ['--ide'],
    req: { op: 'restart', allowed_tools: 'Bash,Read' },
    expected: ['--ide', '--allowedTools', 'Bash,Read'],
  },
  {
    name: 'allowed_tools strips existing --allowedTools value',
    preserved: ['--allowedTools', 'Bash', '--ide'],
    req: { op: 'restart', allowed_tools: 'Read' },
    expected: ['--ide', '--allowedTools', 'Read'],
  },
  {
    name: 'agent override replaces --agent',
    preserved: ['--agent', 'foo'],
    req: { op: 'restart', agent: 'bar' },
    expected: ['--agent', 'bar'],
  },
  {
    name: 'all 9 overrides applied together',
    preserved: ['opus', 'max', '--ide', '--brief'],
    req: {
      op: 'restart',
      model: 'haiku',
      effort: 'low',
      permission_mode: 'default',
      allowed_tools: 'Bash',
      agent: 'myagent',
      brief: false,
      chrome: true,
      ide: true,
      verbose: true,
    },
    expected: [
      '--model',
      'haiku',
      '--effort',
      'low',
      '--permission-mode',
      'default',
      '--allowedTools',
      'Bash',
      '--agent',
      'myagent',
      '--chrome',
      '--ide',
      '--verbose',
    ],
  },
];

describe('applyOverrides', () => {
  for (const tc of overrideCases) {
    test(tc.name, () => {
      const got = applyOverrides(tc.preserved, tc.req);
      expect(got).toEqual(tc.expected);
    });
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

describe('isMagicWord', () => {
  test('models and efforts are magic', () => {
    for (const m of ['opus', 'sonnet', 'haiku']) expect(isMagicWord(m)).toBe(true);
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isMagicWord(e)).toBe(true);
  });
  test('other tokens are not magic', () => {
    expect(isMagicWord('foo')).toBe(false);
    expect(isMagicWord('--ide')).toBe(false);
    expect(isMagicWord('')).toBe(false);
  });
});

describe('isFlag', () => {
  test('tokens starting with - are flags', () => {
    expect(isFlag('-V')).toBe(true);
    expect(isFlag('--ide')).toBe(true);
    expect(isFlag('--model=foo')).toBe(true);
  });
  test('non-flag tokens', () => {
    expect(isFlag('src/')).toBe(false);
    expect(isFlag('opus')).toBe(false);
    expect(isFlag('')).toBe(false);
  });
});

describe('splitLeadingMagic', () => {
  test('all magic', () => {
    expect(splitLeadingMagic(['opus', 'max'])).toEqual({
      magic: ['opus', 'max'],
      rest: [],
    });
  });
  test('partial magic then path', () => {
    expect(splitLeadingMagic(['opus', '/cwd', '--ide'])).toEqual({
      magic: ['opus'],
      rest: ['/cwd', '--ide'],
    });
  });
  test('no magic', () => {
    expect(splitLeadingMagic(['/cwd', '--ide'])).toEqual({
      magic: [],
      rest: ['/cwd', '--ide'],
    });
  });
});

describe('flagPresent', () => {
  test('bare and =value forms', () => {
    expect(flagPresent(['--ide', '--brief'], '--ide')).toBe(true);
    expect(flagPresent(['--brief', '--permission-mode=plan'], '--permission-mode')).toBe(true);
    expect(flagPresent(['--brief'], '--ide')).toBe(false);
  });
});
