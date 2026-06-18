import { describe, expect, test } from 'bun:test';

import { getVersion, helpText, wantsHelp, wantsVersion } from '../../src/help-version.ts';

describe('wantsHelp', () => {
  test('returns false for empty args', () => {
    expect(wantsHelp([])).toBe(false);
  });

  test('detects --help', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['opus', '--help'])).toBe(true);
  });

  test('detects -h', () => {
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['opus', '-h'])).toBe(true);
  });

  test('returns false for -h / --help AFTER -- sentinel (prompt content)', () => {
    expect(wantsHelp(['--', '--help'])).toBe(false);
    expect(wantsHelp(['--', '-h'])).toBe(false);
    expect(wantsHelp(['~/src/proj', '--', 'tell me about -h'])).toBe(false);
  });

  test('detects -h BEFORE -- even if -- is later', () => {
    expect(wantsHelp(['-h', '--', 'prompt'])).toBe(true);
  });

  test('false on similar-looking flags', () => {
    expect(wantsHelp(['--helpful'])).toBe(false);
    expect(wantsHelp(['-hh'])).toBe(false);
    expect(wantsHelp(['--help-me'])).toBe(false);
  });
});

describe('wantsVersion', () => {
  test('detects --version', () => {
    expect(wantsVersion(['--version'])).toBe(true);
    expect(wantsVersion(['opus', '--version'])).toBe(true);
  });

  test('detects -v', () => {
    expect(wantsVersion(['-v'])).toBe(true);
  });

  test('false after --', () => {
    expect(wantsVersion(['--', '--version'])).toBe(false);
    expect(wantsVersion(['--', '-v'])).toBe(false);
  });

  test('false on similar flags', () => {
    expect(wantsVersion(['--verbose'])).toBe(false);
    expect(wantsVersion(['-vv'])).toBe(false);
  });
});

describe('helpText', () => {
  test('starts with "fnclaude"', () => {
    expect(helpText.startsWith('fnclaude')).toBe(true);
  });

  test('mentions key sections so users can find what they need', () => {
    // Tight sanity checks — full content is the helpText constant itself.
    expect(helpText).toContain('Usage:');
    expect(helpText).toContain('Magic positional');
    expect(helpText).toContain('opus | sonnet | haiku | fable');
    expect(helpText).toContain('low | medium | high | xhigh | max | auto');
    expect(helpText).toContain('resume');
    expect(helpText).toContain('-h, --help');
    expect(helpText).toContain('-v, --version');
    expect(helpText).toContain('--no-tmux');
    expect(helpText).toContain('-A, --also');
  });

  test('documents every capital-letter short flag (§4.5 surface)', () => {
    for (const ch of ['B', 'C', 'D', 'F', 'G', 'I', 'M', 'P', 'R', 'T', 'V', 'W']) {
      expect(helpText).toContain(`-${ch}`);
    }
    // And the long-form targets users would search for.
    for (const long of [
      '--brief',
      '--chrome',
      '--dangerously-skip-permissions',
      '--fork-session',
      '--agent',
      '--ide',
      '--permission-mode',
      '--from-pr',
      '--remote-control',
      '--tmux',
      '--verbose',
      '--allowedTools',
    ]) {
      expect(helpText).toContain(long);
    }
  });

  test('documents env vars that influence launcher behavior (§10.2)', () => {
    // The env vars main.ts actually reads from process.env.
    expect(helpText).toContain('ANTHROPIC_API_KEY');
    expect(helpText).toContain('XDG_CONFIG_HOME');
    expect(helpText).toContain('FNC_PROMPTS_DIR');
    expect(helpText).toContain('FNC_NOOP_TEMPLATE_PATH');
  });

  test('documents the config.toml surface ([exec.env], [auto], [name])', () => {
    expect(helpText).toContain('config.toml');
    expect(helpText).toContain('[exec.env]');
    expect(helpText).toContain('[auto]');
    expect(helpText).toContain('[name]');
  });

  test('points users at ~/.claude/settings.json for repo settings', () => {
    expect(helpText).toContain('.claude/settings.json');
    expect(helpText).toContain('cloneTemplate');
  });

  test('includes the -w / --worktree flag with name argument', () => {
    expect(helpText).toContain('-w, --worktree');
  });

  test('mentions cross-cwd resume and worktree intercept (the two big launcher features)', () => {
    expect(helpText.toLowerCase()).toContain('cross-cwd resume');
    expect(helpText.toLowerCase()).toContain('worktree intercept');
  });

  test('mentions the mcp subcommand is internal-use only', () => {
    expect(helpText).toContain('mcp');
    expect(helpText.toLowerCase()).toContain('not for direct use');
  });

  test('has an Examples section', () => {
    expect(helpText).toContain('Examples:');
  });

  test('ends with a trailing newline so terminal output is clean', () => {
    expect(helpText.endsWith('\n')).toBe(true);
  });
});

describe('getVersion', () => {
  test('returns a semver-shaped string', async () => {
    const v = await getVersion();
    // Either real semver or fallback "0.0.0-dev"
    expect(v).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });

  test('caches: repeated calls return the same string', async () => {
    const v1 = await getVersion();
    const v2 = await getVersion();
    expect(v1).toBe(v2);
  });
});
