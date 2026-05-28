import { describe, expect, test } from 'bun:test';

import {
  applyOverrides,
  preserveArgs,
  splitLeadingMagic,
  TRANSFER_DENY_BARE_OK,
  TRANSFER_DENY_FLAGS,
} from '../../../src/argv/preserve-args.ts';

// ─────────────────────────────────────────────────────────────────────────────
// splitLeadingMagic — TS-specific helper (no Go analog)
// ─────────────────────────────────────────────────────────────────────────────

describe('splitLeadingMagic', () => {
  test('empty input', () => {
    expect(splitLeadingMagic([])).toEqual({ magic: [], rest: [] });
  });

  test('all magic', () => {
    expect(splitLeadingMagic(['opus', 'max'])).toEqual({
      magic: ['opus', 'max'],
      rest: [],
    });
  });

  test('magic then positional', () => {
    expect(splitLeadingMagic(['opus', 'hard', 'foo', 'bar'])).toEqual({
      // 'hard' is not a model or effort, so first non-magic token ends the run
      magic: ['opus'],
      rest: ['hard', 'foo', 'bar'],
    });
  });

  test('no magic — first token is positional', () => {
    expect(splitLeadingMagic(['foo'])).toEqual({
      magic: [],
      rest: ['foo'],
    });
  });

  test('no magic — first token is flag', () => {
    expect(splitLeadingMagic(['--ide', 'opus'])).toEqual({
      magic: [],
      rest: ['--ide', 'opus'],
    });
  });

  test('model + effort + flags', () => {
    expect(splitLeadingMagic(['opus', 'max', '--ide', '--brief'])).toEqual({
      magic: ['opus', 'max'],
      rest: ['--ide', '--brief'],
    });
  });

  test('effort alone is magic (rewrite extension)', () => {
    expect(splitLeadingMagic(['high', 'src/'])).toEqual({
      magic: ['high'],
      rest: ['src/'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveArgs — ported from preserve_args_test.go
// ─────────────────────────────────────────────────────────────────────────────

interface PreserveCase {
  name: string;
  args: string[];
  deny?: ReadonlySet<string>;
  bareOK?: ReadonlySet<string>;
  expected: string[];
}

const PRESERVE_CASES: PreserveCase[] = [
  {
    name: 'empty input',
    args: [],
    expected: [],
  },
  {
    name: 'magic only',
    args: ['opus', 'max'],
    expected: ['opus', 'max'],
  },
  {
    name: 'single path',
    args: ['src/'],
    expected: [],
  },
  {
    name: 'two paths',
    args: ['src/', 'extra-wt'],
    expected: [],
  },
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
  {
    name: 'flags only',
    args: ['--verbose'],
    expected: ['--verbose'],
  },
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
    name: 'no deny preserves everything past path',
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
    deny: TRANSFER_DENY_FLAGS,
    bareOK: TRANSFER_DENY_BARE_OK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'transfer bareOK keeps non-flag following bare worktree',
    args: ['src/', '-w', '--ide', '--brief'],
    deny: TRANSFER_DENY_FLAGS,
    bareOK: TRANSFER_DENY_BARE_OK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'transfer denylist removes --resume + uuid',
    args: ['src/', '--ide', '--resume', '01234567-89ab-cdef-0123-456789abcdef'],
    deny: TRANSFER_DENY_FLAGS,
    bareOK: TRANSFER_DENY_BARE_OK,
    expected: ['--ide'],
  },
  {
    name: 'transfer denylist removes --name + name',
    args: ['src/', '--ide', '--name', 'topic', '--brief'],
    deny: TRANSFER_DENY_FLAGS,
    bareOK: TRANSFER_DENY_BARE_OK,
    expected: ['--ide', '--brief'],
  },
  {
    name: 'deny equals-form when flag-token in deny',
    args: ['src/', '--ide', '--from-pr=42', '--brief'],
    deny: TRANSFER_DENY_FLAGS,
    bareOK: TRANSFER_DENY_BARE_OK,
    expected: ['--ide', '--brief'],
  },
];

describe('preserveArgs — ported from Go canonical', () => {
  for (const tc of PRESERVE_CASES) {
    test(tc.name, () => {
      const got = preserveArgs(tc.args, tc.deny ?? new Set(), tc.bareOK ?? new Set());
      expect(got).toEqual(tc.expected);
    });
  }
});

describe('preserveArgs — TS-specific edge cases', () => {
  test('empty deny + empty bareOK returns all args past positional phase', () => {
    expect(
      preserveArgs(['opus', 'max', 'src/', '--ide', '--brief'], new Set(), new Set()),
    ).toEqual(['opus', 'max', '--ide', '--brief']);
  });

  test('bare deny without bareOK consumes following token even if flag-shaped', () => {
    // --name is NOT in bareOK, so the next token (even a flag) is consumed
    // as its value. This matches Go semantics: non-bareOK always greedily
    // consumes the following slot.
    expect(
      preserveArgs(
        ['--ide', '--name', '--brief', '--verbose'],
        new Set(['--name']),
        new Set(),
      ),
    ).toEqual(['--ide', '--verbose']);
  });

  test('bareOK deny with flag-shaped next leaves next alone', () => {
    expect(
      preserveArgs(
        ['--ide', '-w', '--brief', '--verbose'],
        new Set(['-w']),
        new Set(['-w']),
      ),
    ).toEqual(['--ide', '--brief', '--verbose']);
  });

  test('only positionals, no flags', () => {
    expect(preserveArgs(['src/', 'wt-name'], new Set(), new Set())).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyOverrides — ported from preserve_args_test.go
// ─────────────────────────────────────────────────────────────────────────────

interface OverrideCase {
  name: string;
  preserved: string[];
  req: Parameters<typeof applyOverrides>[1];
  expected: string[];
}

const OVERRIDE_CASES: OverrideCase[] = [
  {
    name: 'no overrides preserves input',
    preserved: ['opus', 'max', '--ide'],
    req: {},
    expected: ['opus', 'max', '--ide'],
  },
  {
    name: 'model override strips bare magic and appends flag',
    preserved: ['opus', 'max', '--ide'],
    req: { model: 'sonnet' },
    expected: ['max', '--ide', '--model', 'sonnet'],
  },
  {
    name: 'model override strips --model flag form',
    preserved: ['--ide', '--model', 'opus'],
    req: { model: 'sonnet' },
    expected: ['--ide', '--model', 'sonnet'],
  },
  {
    name: 'model override strips --model=val equals form',
    preserved: ['--ide', '--model=opus', '--brief'],
    req: { model: 'sonnet' },
    expected: ['--ide', '--brief', '--model', 'sonnet'],
  },
  {
    name: 'effort override strips bare magic and appends flag',
    preserved: ['opus', 'max', '--ide'],
    req: { effort: 'high' },
    expected: ['opus', '--ide', '--effort', 'high'],
  },
  {
    name: 'effort override strips --effort flag form',
    preserved: ['--ide', '--effort', 'max'],
    req: { effort: 'high' },
    expected: ['--ide', '--effort', 'high'],
  },
  {
    name: 'both model and effort overrides strip both bare magics',
    preserved: ['opus', 'max', '--ide'],
    req: { model: 'sonnet', effort: 'low' },
    expected: ['--ide', '--model', 'sonnet', '--effort', 'low'],
  },
  {
    name: 'ide=true with no existing appends flag',
    preserved: ['--brief'],
    req: { ide: true },
    expected: ['--brief', '--ide'],
  },
  {
    name: 'ide=true with existing strips and re-appends (no dup)',
    preserved: ['--ide', '--brief'],
    req: { ide: true },
    expected: ['--brief', '--ide'],
  },
  {
    name: 'ide=false strips existing and does not append',
    preserved: ['--ide', '--brief'],
    req: { ide: false },
    expected: ['--brief'],
  },
  {
    name: 'ide undefined preserves existing',
    preserved: ['--ide', '--brief'],
    req: {},
    expected: ['--ide', '--brief'],
  },
  {
    name: 'brief=true appends',
    preserved: ['--ide'],
    req: { brief: true },
    expected: ['--ide', '--brief'],
  },
  {
    name: 'chrome=false strips existing',
    preserved: ['--chrome', '--ide'],
    req: { chrome: false },
    expected: ['--ide'],
  },
  {
    name: 'verbose=true with no existing',
    preserved: [],
    req: { verbose: true },
    expected: ['--verbose'],
  },
  {
    name: 'permission_mode string overrides existing',
    preserved: ['--permission-mode', 'default'],
    req: { permissionMode: 'bypassPermissions' },
    expected: ['--permission-mode', 'bypassPermissions'],
  },
  {
    name: 'allowed_tools string appends when absent',
    preserved: ['--ide'],
    req: { allowedTools: 'Bash,Read' },
    expected: ['--ide', '--allowedTools', 'Bash,Read'],
  },
  {
    name: 'allowed_tools strips existing --allowedTools value',
    preserved: ['--allowedTools', 'Bash', '--ide'],
    req: { allowedTools: 'Read' },
    expected: ['--ide', '--allowedTools', 'Read'],
  },
  {
    name: 'agent override replaces --agent',
    preserved: ['--agent', 'foo'],
    req: { agent: 'bar' },
    expected: ['--agent', 'bar'],
  },
  {
    name: 'all 9 overrides applied together',
    preserved: ['opus', 'max', '--ide', '--brief'],
    req: {
      model: 'haiku',
      effort: 'low',
      permissionMode: 'default',
      allowedTools: 'Bash',
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

describe('applyOverrides — ported from Go canonical', () => {
  for (const tc of OVERRIDE_CASES) {
    test(tc.name, () => {
      const got = applyOverrides(tc.preserved, tc.req);
      expect(got).toEqual(tc.expected);
    });
  }
});

describe('applyOverrides — TS-specific edge cases', () => {
  test('empty req returns preserved unchanged', () => {
    const input = ['opus', 'max', '--ide', '--brief'];
    expect(applyOverrides(input, {})).toEqual(input);
  });

  test('returns a new array (does not mutate input)', () => {
    const input = ['--ide'];
    const out = applyOverrides(input, { brief: true });
    expect(out).not.toBe(input);
    expect(input).toEqual(['--ide']);
  });

  test('brief undefined preserves existing --brief occurrences', () => {
    expect(applyOverrides(['--brief', '--ide'], {})).toEqual(['--brief', '--ide']);
  });

  test('brief=true strips existing and appends single copy', () => {
    expect(applyOverrides(['--brief', '--ide', '--brief'], { brief: true })).toEqual([
      '--ide',
      '--brief',
    ]);
  });

  test('brief=false strips all existing occurrences', () => {
    expect(applyOverrides(['--brief', '--ide', '--brief'], { brief: false })).toEqual([
      '--ide',
    ]);
  });
});
