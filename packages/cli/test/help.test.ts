import { describe, expect, test } from 'bun:test';
import { helpText, wantsHelp, wantsVersion } from '../src/help.js';

describe('wantsHelp', () => {
  test('true for --help anywhere before --', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['some-dir', '-V', '--help'])).toBe(true);
    expect(wantsHelp(['some-dir', '--help', '--', 'prompt'])).toBe(true);
  });

  test('false when absent', () => {
    expect(wantsHelp(['some-dir', '-V'])).toBe(false);
    expect(wantsHelp([])).toBe(false);
  });

  test('false when --help appears AFTER the -- terminator', () => {
    expect(wantsHelp(['some-dir', '--', '--help'])).toBe(false);
    expect(wantsHelp(['some-dir', '--', '-h'])).toBe(false);
  });
});

describe('wantsVersion', () => {
  test('true for --version / -v anywhere before --', () => {
    expect(wantsVersion(['--version'])).toBe(true);
    expect(wantsVersion(['-v'])).toBe(true);
    expect(wantsVersion(['some-dir', '-A', 'docs', '--version'])).toBe(true);
  });

  test('false for -V (capital — that maps to --verbose)', () => {
    expect(wantsVersion(['some-dir', '-V'])).toBe(false);
  });

  test('false when version flag appears AFTER -- terminator', () => {
    expect(wantsVersion(['some-dir', '--', '--version'])).toBe(false);
    expect(wantsVersion(['some-dir', '--', '-v'])).toBe(false);
  });
});

describe('helpText', () => {
  test('mentions every fnclaude-owned flag', () => {
    expect(helpText).toContain('-A, --also');
    expect(helpText).toContain('--no-tmux');
    expect(helpText).toContain('-h, --help');
    expect(helpText).toContain('-v, --version');
  });

  test('lists all capital-letter shortcut translations', () => {
    for (const ch of ['B', 'C', 'D', 'F', 'G', 'I', 'M', 'P', 'R', 'T', 'V', 'W']) {
      expect(helpText).toContain(`-${ch}`);
    }
  });

  test('covers magic-positional + subcommand semantics', () => {
    expect(helpText).toContain('Magic positional words');
    expect(helpText).toContain('Subcommand positionals');
    expect(helpText).toContain('resume | res');
    expect(helpText).toContain('fork | fk');
  });
});
