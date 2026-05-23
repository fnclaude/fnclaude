import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs, parseShortFlag, settingSourcesInPassthrough } from '../src/argParser.js';

const TEST_HOME = '/home/testuser';
const NOOP_DIR = `${TEST_HOME}/.config/fnclaude/noop`;

// Mirror the Go `TestMain` setup — unset XDG_CONFIG_HOME so the default-noop
// path resolves to `$home/.config/fnclaude/noop` deterministically.
let savedXdg: string | undefined;
beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
});

// ── Positional + fallback ──────────────────────────────────────────────────

describe('parseArgs — positionals', () => {
  test('single positional becomes cwd', () => {
    const a = parseArgs(['/proj/foo'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.extraDirs).toEqual([]);
    expect(a.usedNoopFallback).toBe(false);
  });

  test('two positionals: cwd + worktree name', () => {
    const a = parseArgs(['/proj/a', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/a');
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('my-wt');
    expect(a.extraDirs).toEqual([]);
  });

  test('three post-magic positionals → error', () => {
    expect(() => parseArgs(['/proj/a', '/proj/b', '/proj/c'], TEST_HOME)).toThrow(/positional/);
  });

  test('zero positionals falls back to noop dir', () => {
    const a = parseArgs([], TEST_HOME);
    expect(a.cwd).toBe(NOOP_DIR);
    expect(a.usedNoopFallback).toBe(true);
  });

  test('XDG_CONFIG_HOME honored for noop fallback', () => {
    process.env.XDG_CONFIG_HOME = '/xdg';
    const a = parseArgs([], TEST_HOME);
    expect(a.cwd).toBe('/xdg/fnclaude/noop');
  });
});

// ── -A / --also ────────────────────────────────────────────────────────────

describe('parseArgs — -A / --also', () => {
  test('mixed positional + --also and -A', () => {
    const a = parseArgs(['/p/main', 'my-wt', '--also', '/p/extra1', '-A', '/p/extra2'], TEST_HOME);
    expect(a.cwd).toBe('/p/main');
    expect(a.worktreeArg).toBe('my-wt');
    expect(a.extraDirs).toEqual(['/p/extra1', '/p/extra2']);
  });

  test('-A=value form', () => {
    const a = parseArgs(['/p/main', '-A=/p/extra'], TEST_HOME);
    expect(a.extraDirs).toEqual(['/p/extra']);
  });

  test('--also=value form', () => {
    const a = parseArgs(['/p/main', '--also=/p/extra'], TEST_HOME);
    expect(a.extraDirs).toEqual(['/p/extra']);
  });

  test('-A at EOF errors', () => {
    expect(() => parseArgs(['/p/x', '-A'], TEST_HOME)).toThrow();
  });

  test('-A followed by flag errors', () => {
    expect(() => parseArgs(['/p/x', '-A', '--some-flag'], TEST_HOME)).toThrow();
  });

  test('-A= bare errors', () => {
    expect(() => parseArgs(['/p/x', '-A='], TEST_HOME)).toThrow();
  });

  test('--also= bare errors', () => {
    expect(() => parseArgs(['/p/x', '--also='], TEST_HOME)).toThrow();
  });
});

// ── --setting-sources detection ────────────────────────────────────────────

describe('settingSourcesInPassthrough', () => {
  test('bare flag is detected', () => {
    const a = parseArgs(['/p/x', '--setting-sources'], TEST_HOME);
    expect(settingSourcesInPassthrough(a.passthrough)).toBe(true);
  });

  test('=value form is detected', () => {
    const a = parseArgs(['/p/x', '--setting-sources=foo'], TEST_HOME);
    expect(settingSourcesInPassthrough(a.passthrough)).toBe(true);
  });

  test('absent → false', () => {
    const a = parseArgs(['/p/x', '--verbose'], TEST_HOME);
    expect(settingSourcesInPassthrough(a.passthrough)).toBe(false);
  });
});

// ── Passthrough preservation ───────────────────────────────────────────────

describe('parseArgs — passthrough', () => {
  test('preserves order of unknown flags', () => {
    const a = parseArgs(['/p/x', '--foo', '--bar', '--baz'], TEST_HOME);
    expect(a.passthrough).toEqual(['--foo', '--bar', '--baz']);
  });
});

// ── Magic positionals ──────────────────────────────────────────────────────

describe('parseArgs — magic positionals', () => {
  test('model alone, then path', () => {
    const a = parseArgs(['opus', '/proj/p'], TEST_HOME);
    expect(a.cwd).toBe('/proj/p');
    expect(a.passthrough).toEqual(['--model', 'opus']);
  });

  test('model + effort + path', () => {
    const a = parseArgs(['opus', 'max', '/proj/p'], TEST_HOME);
    expect(a.cwd).toBe('/proj/p');
    expect(a.passthrough).toEqual(['--model', 'opus', '--effort', 'max']);
  });

  test('effort alone in pos 1 is NOT magic — becomes cwd', () => {
    const a = parseArgs(['max', '/proj/p'], TEST_HOME);
    expect(a.cwd).toBe('max');
    expect(a.worktreeArg).toBe('/proj/p');
    expect(a.passthrough).toEqual([]);
  });

  test('model then non-effort: pos 2 becomes cwd', () => {
    const a = parseArgs(['opus', 'sonnet', '/proj/p'], TEST_HOME);
    expect(a.passthrough).toEqual(['--model', 'opus']);
    expect(a.cwd).toBe('sonnet');
    expect(a.worktreeArg).toBe('/proj/p');
  });

  test('model+effort then cwd + worktree', () => {
    const a = parseArgs(['opus', 'max', 'sonnet', '/proj/p'], TEST_HOME);
    expect(a.passthrough).toEqual(['--model', 'opus', '--effort', 'max']);
    expect(a.cwd).toBe('sonnet');
    expect(a.worktreeArg).toBe('/proj/p');
  });

  test('model only, no path: noop fallback', () => {
    const a = parseArgs(['opus'], TEST_HOME);
    expect(a.cwd).toBe(NOOP_DIR);
    expect(a.passthrough).toEqual(['--model', 'opus']);
  });

  test('model + effort, no path: noop fallback', () => {
    const a = parseArgs(['opus', 'max'], TEST_HOME);
    expect(a.cwd).toBe(NOOP_DIR);
    expect(a.passthrough).toEqual(['--model', 'opus', '--effort', 'max']);
  });

  test('non-model first turns off magic', () => {
    const a = parseArgs(['/proj/p', 'sonnet'], TEST_HOME);
    expect(a.cwd).toBe('/proj/p');
    expect(a.worktreeArg).toBe('sonnet');
    expect(a.passthrough).toEqual([]);
  });

  test('./opus is literal path, not magic', () => {
    const a = parseArgs(['./opus'], TEST_HOME);
    expect(a.cwd).toBe('./opus');
    expect(a.passthrough).toEqual([]);
  });
});

// ── Subcommand expansion ───────────────────────────────────────────────────

describe('parseArgs — subcommands', () => {
  test('`resume` → --resume', () => {
    const a = parseArgs(['resume'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume']);
    expect(a.cwd).toBe(NOOP_DIR);
  });

  test('`res` shorthand', () => {
    const a = parseArgs(['res'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume']);
  });

  test('`continue` → --continue', () => {
    const a = parseArgs(['continue'], TEST_HOME);
    expect(a.passthrough).toEqual(['--continue']);
  });

  test('`con` shorthand', () => {
    const a = parseArgs(['con'], TEST_HOME);
    expect(a.passthrough).toEqual(['--continue']);
  });

  test('subcommand BEFORE model/effort — expansion lands first', () => {
    const a = parseArgs(['resume', 'opus', 'xhigh'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--model', 'opus', '--effort', 'xhigh']);
  });

  test('subcommand AFTER model/effort — order-agnostic', () => {
    const a = parseArgs(['opus', 'xhigh', 'resume'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--model', 'opus', '--effort', 'xhigh']);
  });

  test('subcommand BETWEEN model and effort', () => {
    const a = parseArgs(['opus', 'resume', 'xhigh'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--model', 'opus', '--effort', 'xhigh']);
  });

  test('cwd before subcommand', () => {
    const a = parseArgs(['/proj/foo', 'resume'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.passthrough).toEqual(['--resume']);
  });

  test('cwd after subcommand', () => {
    const a = parseArgs(['resume', '/proj/foo'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.passthrough).toEqual(['--resume']);
  });

  test('./resume is literal path', () => {
    const a = parseArgs(['./resume'], TEST_HOME);
    expect(a.cwd).toBe('./resume');
    expect(a.passthrough).toEqual([]);
  });

  test('two subcommands → error', () => {
    expect(() => parseArgs(['resume', 'continue'], TEST_HOME)).toThrow(/subcommand/);
  });

  test('res + con → error', () => {
    expect(() => parseArgs(['res', 'con'], TEST_HOME)).toThrow();
  });

  test('`fork` expands to --resume + --fork-session', () => {
    const a = parseArgs(['fork'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--fork-session']);
    expect(a.cwd).toBe(NOOP_DIR);
  });

  test('`fk` shorthand', () => {
    const a = parseArgs(['fk'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--fork-session']);
  });

  test('fork with model + effort', () => {
    const a = parseArgs(['fork', 'opus', 'xhigh'], TEST_HOME);
    expect(a.passthrough).toEqual([
      '--resume',
      '--fork-session',
      '--model',
      'opus',
      '--effort',
      'xhigh',
    ]);
  });

  test('model+effort before fork — same expansion order', () => {
    const a = parseArgs(['opus', 'xhigh', 'fork'], TEST_HOME);
    expect(a.passthrough).toEqual([
      '--resume',
      '--fork-session',
      '--model',
      'opus',
      '--effort',
      'xhigh',
    ]);
  });

  test('fork with cwd', () => {
    const a = parseArgs(['/proj/foo', 'fork'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.passthrough).toEqual(['--resume', '--fork-session']);
  });

  test('./fork is literal path', () => {
    const a = parseArgs(['./fork'], TEST_HOME);
    expect(a.cwd).toBe('./fork');
    expect(a.passthrough).toEqual([]);
  });

  test('fork + resume errors (one-subcommand-only)', () => {
    expect(() => parseArgs(['fork', 'resume'], TEST_HOME)).toThrow(/subcommand/);
  });

  test('fork + continue errors', () => {
    expect(() => parseArgs(['fork', 'continue'], TEST_HOME)).toThrow();
  });

  test('subcommand expansion lands before --', () => {
    const a = parseArgs(['fork', '--', 'the prompt'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--fork-session', '--', 'the prompt']);
  });

  test('resume + -- prompt', () => {
    const a = parseArgs(['resume', '--', 'the prompt'], TEST_HOME);
    expect(a.passthrough).toEqual(['--resume', '--', 'the prompt']);
  });

  test('after --verbose, `resume` is literal passthrough', () => {
    const a = parseArgs(['--verbose', 'resume'], TEST_HOME);
    expect(a.passthrough).not.toContain('--resume');
    expect(a.passthrough).toContain('resume');
  });
});

// ── Short-flag translation ─────────────────────────────────────────────────

describe('parseArgs — short flags', () => {
  test('single -B → --brief', () => {
    const a = parseArgs(['/p/x', '-B'], TEST_HOME);
    expect(a.passthrough).toEqual(['--brief']);
  });

  test.each([
    ['-B', '--brief'],
    ['-C', '--chrome'],
    ['-D', '--dangerously-skip-permissions'],
    ['-F', '--fork-session'],
    ['-I', '--ide'],
    ['-V', '--verbose'],
  ])('%s → %s', (short, long) => {
    const a = parseArgs(['/p/x', short], TEST_HOME);
    expect(a.passthrough).toEqual([long]);
  });

  test('collapsed -BVC → three long flags', () => {
    const a = parseArgs(['/p/x', '-BVC'], TEST_HOME);
    expect(a.passthrough).toEqual(['--brief', '--verbose', '--chrome']);
  });

  test('-G value (space form)', () => {
    const a = parseArgs(['/p/x', '-G', 'myagent'], TEST_HOME);
    expect(a.passthrough).toEqual(['--agent', 'myagent']);
  });

  test('-G=value (equals form)', () => {
    const a = parseArgs(['/p/x', '-G=myagent'], TEST_HOME);
    expect(a.passthrough).toEqual(['--agent=myagent']);
  });

  test('-G with no value errors', () => {
    expect(() => parseArgs(['/p/x', '-G'], TEST_HOME)).toThrow();
  });

  test('-G followed by flag errors', () => {
    expect(() => parseArgs(['/p/x', '-G', '--something'], TEST_HOME)).toThrow();
  });

  test('-GB (G not last in collapsed group) errors', () => {
    expect(() => parseArgs(['/p/x', '-GB', 'val'], TEST_HOME)).toThrow();
  });

  test('-T optional: bare → --tmux (no value)', () => {
    const a = parseArgs(['/p/x', '-T', '--verbose'], TEST_HOME);
    expect(a.passthrough[0]).toBe('--tmux');
  });

  test('-T greedy value', () => {
    const a = parseArgs(['/p/x', '-T', 'mywin'], TEST_HOME);
    expect(a.passthrough).toEqual(['--tmux', 'mywin']);
  });

  test('-T=value', () => {
    const a = parseArgs(['/p/x', '-T=mywin'], TEST_HOME);
    expect(a.passthrough).toEqual(['--tmux=mywin']);
  });

  test('-T at EOF', () => {
    const a = parseArgs(['/p/x', '-T'], TEST_HOME);
    expect(a.passthrough).toEqual(['--tmux']);
  });

  test('-Z unknown short passes through', () => {
    const a = parseArgs(['/p/x', '-Z'], TEST_HOME);
    expect(a.passthrough).toContain('-Z');
  });

  test('-Z=val unknown =form passes through verbatim', () => {
    const a = parseArgs(['/p/x', '-Z=val'], TEST_HOME);
    expect(a.passthrough).toContain('-Z=val');
  });

  test('-W "Bash,Read"', () => {
    const a = parseArgs(['/p/x', '-W', 'Bash,Read'], TEST_HOME);
    expect(a.passthrough).toEqual(['--allowedTools', 'Bash,Read']);
  });

  test('-M=bypass-permissions', () => {
    const a = parseArgs(['/p/x', '-M=bypass-permissions'], TEST_HOME);
    expect(a.passthrough).toEqual(['--permission-mode=bypass-permissions']);
  });
});

// ── Eaten flags ────────────────────────────────────────────────────────────

describe('parseArgs — eaten flags', () => {
  test('--no-tmux is eaten and not forwarded', () => {
    const a = parseArgs(['/p/x', '--no-tmux'], TEST_HOME);
    expect(a.noTmux).toBe(true);
    expect(a.passthrough).not.toContain('--no-tmux');
  });

  test('--no-permissions passes through verbatim (not eaten)', () => {
    const a = parseArgs(['/p/x', '--no-permissions'], TEST_HOME);
    expect(a.passthrough).toContain('--no-permissions');
  });

  test('--no-tmux does not affect explicit -T', () => {
    const a = parseArgs(['/p/x', '--no-tmux', '-T'], TEST_HOME);
    expect(a.noTmux).toBe(true);
    expect(a.passthrough).toContain('--tmux');
  });
});

// ── Worktree (-w / --worktree) ─────────────────────────────────────────────

describe('parseArgs — -w / --worktree', () => {
  test('bare -w', () => {
    const a = parseArgs(['/p/x', '-w'], TEST_HOME);
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('');
  });

  test('-w value', () => {
    const a = parseArgs(['/p/x', '-w', 'feat'], TEST_HOME);
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('feat');
  });

  test('-w=value', () => {
    const a = parseArgs(['/p/x', '-w=feat'], TEST_HOME);
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('feat');
  });

  test('--worktree value', () => {
    const a = parseArgs(['/p/x', '--worktree', 'feat'], TEST_HOME);
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('feat');
  });

  test('--worktree=value', () => {
    const a = parseArgs(['/p/x', '--worktree=feat'], TEST_HOME);
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('feat');
  });

  test('-w intercept means flag is NOT pushed to passthrough', () => {
    const a = parseArgs(['/p/x', '-w', 'feat'], TEST_HOME);
    expect(a.passthrough).not.toContain('--worktree');
    expect(a.passthrough).not.toContain('-w');
  });

  test('positional wt + -w later: -w wins (later in argv)', () => {
    const a = parseArgs(['/proj/foo', 'pos-wt', '-w', 'flag-wt'], TEST_HOME);
    expect(a.worktreeArg).toBe('flag-wt');
  });

  test('-w first, then positional becomes passthrough (flag mode)', () => {
    const a = parseArgs(['-w', 'flag-wt', '/proj/foo', 'pos-wt'], TEST_HOME);
    expect(a.worktreeArg).toBe('flag-wt');
  });
});

// ── Positional worktree with magic / subcommand ────────────────────────────

describe('parseArgs — positional worktree with magic/subcommand', () => {
  test('cwd + worktree (no magic)', () => {
    const a = parseArgs(['/proj/foo', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeSet).toBe(true);
    expect(a.worktreeArg).toBe('my-wt');
  });

  test('single positional sets cwd only, no worktree', () => {
    const a = parseArgs(['/proj/foo'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeSet).toBe(false);
  });

  test('model magic + cwd + worktree', () => {
    const a = parseArgs(['opus', '/proj/foo', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeArg).toBe('my-wt');
    expect(a.passthrough.slice(0, 2)).toEqual(['--model', 'opus']);
  });

  test('model + effort + cwd + worktree', () => {
    const a = parseArgs(['opus', 'xhigh', '/proj/foo', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeArg).toBe('my-wt');
  });

  test('subcommand + cwd + worktree', () => {
    const a = parseArgs(['resume', '/proj/foo', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeArg).toBe('my-wt');
    expect(a.passthrough[0]).toBe('--resume');
  });

  test('sonnet (model) + cwd + worktree', () => {
    const a = parseArgs(['sonnet', '/proj/foo', 'my-wt'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeArg).toBe('my-wt');
  });

  test('3 post-magic positionals → error', () => {
    expect(() => parseArgs(['/proj/foo', 'wt', 'extra'], TEST_HOME)).toThrow(/positional/);
  });

  test('cwd + worktree + -A still works', () => {
    const a = parseArgs(['/proj/foo', 'my-wt', '-A', '/proj/extra'], TEST_HOME);
    expect(a.cwd).toBe('/proj/foo');
    expect(a.worktreeArg).toBe('my-wt');
    expect(a.extraDirs).toEqual(['/proj/extra']);
  });
});

// ── parseShortFlag direct unit ─────────────────────────────────────────────

describe('parseShortFlag (unit)', () => {
  test('single no-value flag', () => {
    expect(parseShortFlag('-B', [])).toEqual({ tokens: ['--brief'], consumed: 0 });
  });

  test('collapsed all no-value', () => {
    expect(parseShortFlag('-BVC', [])).toEqual({
      tokens: ['--brief', '--verbose', '--chrome'],
      consumed: 0,
    });
  });

  test('required-value consumes next', () => {
    expect(parseShortFlag('-G', ['myagent'])).toEqual({
      tokens: ['--agent', 'myagent'],
      consumed: 1,
    });
  });

  test('-G=val equals form', () => {
    expect(parseShortFlag('-G=myagent', [])).toEqual({
      tokens: ['--agent=myagent'],
      consumed: 0,
    });
  });

  test('required-value in middle of group throws', () => {
    expect(() => parseShortFlag('-GB', ['val'])).toThrow();
  });

  test('optional flag at EOF', () => {
    expect(parseShortFlag('-T', [])).toEqual({ tokens: ['--tmux'], consumed: 0 });
  });

  test('optional flag greedy value', () => {
    expect(parseShortFlag('-T', ['win'])).toEqual({
      tokens: ['--tmux', 'win'],
      consumed: 1,
    });
  });

  test('optional flag, next is dash → no value', () => {
    expect(parseShortFlag('-T', ['--verbose'])).toEqual({
      tokens: ['--tmux'],
      consumed: 0,
    });
  });

  test('unknown short passes through verbatim per-char', () => {
    expect(parseShortFlag('-Z', [])).toEqual({ tokens: ['-Z'], consumed: 0 });
  });

  test('unknown -Z=val falls through to original token', () => {
    expect(parseShortFlag('-Z=val', [])).toEqual({ tokens: ['-Z=val'], consumed: 0 });
  });
});
