import { describe, expect, test } from 'bun:test';

import { parseArgs } from '../../src/argv/parse';

const ok = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  model: null,
  effort: null,
  subcommand: null,
  firstPath: null,
  worktreeSet: false,
  worktreeArg: '',
  extraDirs: [] as string[],
  noTmux: false,
  passthrough: [] as string[],
  ...overrides,
});

describe('parseArgs — trivial', () => {
  test('empty argv', () => {
    expect(parseArgs([])).toEqual(ok());
  });

  test('single positional becomes firstPath', () => {
    expect(parseArgs(['~/src/proj'])).toEqual(ok({ firstPath: '~/src/proj' }));
  });

  test('two positionals: first → firstPath, second → worktreeArg', () => {
    expect(parseArgs(['~/src/proj', 'feature-branch'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'feature-branch' }),
    );
  });

  test('three positionals is an error', () => {
    const r = parseArgs(['~/src/proj', 'feature', 'extra']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('too many positional');
  });
});

describe('parseArgs — magic', () => {
  test('opus max ~/src/proj', () => {
    expect(parseArgs(['opus', 'max', '~/src/proj'])).toEqual(
      ok({ model: 'opus', effort: 'max', firstPath: '~/src/proj' }),
    );
  });

  test('effort-only at position 1 implies opus', () => {
    expect(parseArgs(['max', '~/src/proj'])).toEqual(
      ok({ model: 'opus', effort: 'max', firstPath: '~/src/proj' }),
    );
  });

  test('subcommand at position 1', () => {
    expect(parseArgs(['resume', '~/src/proj'])).toEqual(
      ok({ subcommand: 'resume', firstPath: '~/src/proj' }),
    );
  });

  test('subcommand AFTER firstPath still recognized (any positional slot)', () => {
    expect(parseArgs(['~/src/proj', 'resume'])).toEqual(
      ok({ subcommand: 'resume', firstPath: '~/src/proj' }),
    );
  });

  test('subcommand AFTER firstPath + worktreeArg still recognized', () => {
    expect(parseArgs(['~/src/proj', 'feature', 'resume'])).toEqual(
      ok({
        subcommand: 'resume',
        firstPath: '~/src/proj',
        worktreeSet: true,
        worktreeArg: 'feature',
      }),
    );
  });

  test('two subcommands across positions is an error', () => {
    const r = parseArgs(['resume', '~/src/proj', 'fork']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('only one');
  });
});

describe('parseArgs — flags transition (inFlags is sticky)', () => {
  test('flag after firstPath: subsequent positionals NOT collected', () => {
    // Once a flag appears, no more positional collection. `--verbose foo bar`
    // pushes all three to passthrough; foo/bar don't become worktreeArg.
    expect(parseArgs(['~/src/proj', '--verbose', 'foo', 'bar'])).toEqual(
      ok({ firstPath: '~/src/proj', passthrough: ['--verbose', 'foo', 'bar'] }),
    );
  });

  test('flag at position 1: no positional ever collected', () => {
    expect(parseArgs(['--help'])).toEqual(ok({ passthrough: ['--help'] }));
  });

  test('positionals + multiple flags', () => {
    expect(parseArgs(['~/src/proj', 'feature', '--verbose', '--print'])).toEqual(
      ok({
        firstPath: '~/src/proj',
        worktreeSet: true,
        worktreeArg: 'feature',
        passthrough: ['--verbose', '--print'],
      }),
    );
  });
});

describe('parseArgs — --no-tmux (fnclaude-eaten)', () => {
  test('--no-tmux sets the flag and does NOT appear in passthrough', () => {
    expect(parseArgs(['~/src/proj', '--no-tmux'])).toEqual(
      ok({ firstPath: '~/src/proj', noTmux: true }),
    );
  });

  test('--no-tmux mid-argv', () => {
    expect(parseArgs(['~/src/proj', '--no-tmux', '--verbose'])).toEqual(
      ok({ firstPath: '~/src/proj', noTmux: true, passthrough: ['--verbose'] }),
    );
  });

  test('--no-tmux is NEVER in passthrough — guards against forwarding regression', () => {
    // §10.5: fnclaude-owned flag, must not reach claude's argv. The toEqual
    // checks above already imply this via the empty passthrough; the
    // explicit not-included assertion here is the regression guard the
    // build-plan calls for.
    const r = parseArgs(['~/src/proj', '--no-tmux', '--verbose', '--', 'do it']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.noTmux).toBe(true);
      expect(r.passthrough).not.toContain('--no-tmux');
    }
  });

  test('--no-tmux ahead of positional still eaten', () => {
    const r = parseArgs(['--no-tmux', '~/src/proj']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.noTmux).toBe(true);
      expect(r.passthrough).not.toContain('--no-tmux');
    }
  });
});

describe('parseArgs — -A / --also (fnclaude-eaten extraDirs)', () => {
  test('-A <dir>', () => {
    expect(parseArgs(['~/src/proj', '-A', '~/src/tools'])).toEqual(
      ok({ firstPath: '~/src/proj', extraDirs: ['~/src/tools'] }),
    );
  });

  test('--also <dir>', () => {
    expect(parseArgs(['~/src/proj', '--also', '~/src/tools'])).toEqual(
      ok({ firstPath: '~/src/proj', extraDirs: ['~/src/tools'] }),
    );
  });

  test('-A=<dir>', () => {
    expect(parseArgs(['~/src/proj', '-A=~/src/tools'])).toEqual(
      ok({ firstPath: '~/src/proj', extraDirs: ['~/src/tools'] }),
    );
  });

  test('--also=<dir>', () => {
    expect(parseArgs(['~/src/proj', '--also=~/src/tools'])).toEqual(
      ok({ firstPath: '~/src/proj', extraDirs: ['~/src/tools'] }),
    );
  });

  test('multiple -A accumulates', () => {
    expect(parseArgs(['~/src/proj', '-A', '~/src/a', '--also', '~/src/b'])).toEqual(
      ok({ firstPath: '~/src/proj', extraDirs: ['~/src/a', '~/src/b'] }),
    );
  });

  test('-A with no following value is an error', () => {
    const r = parseArgs(['~/src/proj', '-A']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('requires a directory');
  });

  test('-A followed by a flag is an error', () => {
    const r = parseArgs(['~/src/proj', '-A', '--verbose']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('requires a directory');
  });

  test('-A= (empty value) is an error', () => {
    const r = parseArgs(['~/src/proj', '-A=']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('requires a directory');
  });
});

describe('parseArgs — -w / --worktree (fnclaude-eaten worktree flag)', () => {
  test('-w <name>', () => {
    expect(parseArgs(['~/src/proj', '-w', 'feature'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'feature' }),
    );
  });

  test('--worktree <name>', () => {
    expect(parseArgs(['~/src/proj', '--worktree', 'feature'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'feature' }),
    );
  });

  test('-w=<name>', () => {
    expect(parseArgs(['~/src/proj', '-w=feature'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'feature' }),
    );
  });

  test('--worktree=<name>', () => {
    expect(parseArgs(['~/src/proj', '--worktree=feature'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'feature' }),
    );
  });

  test('bare -w (no value): worktreeSet but worktreeArg empty', () => {
    expect(parseArgs(['~/src/proj', '-w'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: '' }),
    );
  });

  test('-w with next token being a flag: bare form (do not consume value)', () => {
    expect(parseArgs(['~/src/proj', '-w', '--verbose'])).toEqual(
      ok({
        firstPath: '~/src/proj',
        worktreeSet: true,
        worktreeArg: '',
        passthrough: ['--verbose'],
      }),
    );
  });

  test('-w overrides a 2nd-positional worktreeArg (later wins)', () => {
    // `~/src/proj feature -w override` → worktreeArg ends up 'override'
    // (matches Go canonical: a later -w overwrites the positional).
    expect(parseArgs(['~/src/proj', 'feature', '-w', 'override'])).toEqual(
      ok({ firstPath: '~/src/proj', worktreeSet: true, worktreeArg: 'override' }),
    );
  });
});

describe('parseArgs — `--` sentinel', () => {
  test('-- passes through verbatim along with everything after', () => {
    expect(parseArgs(['~/src/proj', '--', 'say hi'])).toEqual(
      ok({ firstPath: '~/src/proj', passthrough: ['--', 'say hi'] }),
    );
  });

  test('-- at position 1: no firstPath, just passthrough', () => {
    expect(parseArgs(['--', 'say hi'])).toEqual(ok({ passthrough: ['--', 'say hi'] }));
  });

  test('opus -- "do it": magic consumed, sentinel + prompt in passthrough', () => {
    expect(parseArgs(['opus', '--', 'do it'])).toEqual(
      ok({ model: 'opus', passthrough: ['--', 'do it'] }),
    );
  });

  test('subcommand -- "do it"', () => {
    expect(parseArgs(['resume', '--', 'do it'])).toEqual(
      ok({ subcommand: 'resume', passthrough: ['--', 'do it'] }),
    );
  });
});

describe('parseArgs — combined magic + worktree + flags', () => {
  test('opus max ~/src/proj -w feature --verbose', () => {
    expect(parseArgs(['opus', 'max', '~/src/proj', '-w', 'feature', '--verbose'])).toEqual(
      ok({
        model: 'opus',
        effort: 'max',
        firstPath: '~/src/proj',
        worktreeSet: true,
        worktreeArg: 'feature',
        passthrough: ['--verbose'],
      }),
    );
  });

  test('resume opus ~/src/proj -A ~/src/tools --no-tmux', () => {
    expect(parseArgs(['resume', 'opus', '~/src/proj', '-A', '~/src/tools', '--no-tmux'])).toEqual(
      ok({
        model: 'opus',
        subcommand: 'resume',
        firstPath: '~/src/proj',
        extraDirs: ['~/src/tools'],
        noTmux: true,
      }),
    );
  });
});
