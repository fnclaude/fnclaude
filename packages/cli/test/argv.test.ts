// Mirrors the buildArgv + withAppendedSystemPrompts + buildFnclaudeMCPConfigJSON
// tests in src/main_test.go and src/prompts_test.go (Go reference).
//
// Coverage:
//   - withAppendedSystemPrompts: empty/single/multi fragment merge, existing
//     space-form, existing =form, mixed-empty drop, input-not-mutated.
//   - buildFnclaudeMCPConfigJSON: shape of the inline JSON; --noop bit.
//   - buildArgv: extra-dir flag emission (absolute + relative), .mcp.json
//     auto-injection, .claude/settings.json auto-injection, suppression by
//     --setting-sources, multiple extra-dir ordering, auto-tmux gates,
//     pitfall-warning presence/absence per session type.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brandIntercepted,
  type BaseArgs,
  type InterceptedArgs,
  type InterceptedFields,
} from '../src/args.js';
import {
  buildArgv,
  buildFnclaudeMCPConfigJSON,
  withAppendedSystemPrompts,
} from '../src/argv.js';
import { defaultConfig } from '../src/config.js';
import type { PromptSet } from '../src/prompts.js';

// ── shared fixtures ────────────────────────────────────────────────────────

/**
 * testPromptSet mirrors the Go `testPromptSet` — short marker strings so
 * assertContainsSubstring can pinpoint exactly which fragment landed in
 * the merged --append-system-prompt value.
 */
const testPromptSet: PromptSet = {
  agentPitfall: 'TEST-AGENT-PITFALL',
  projectSwitch: 'TEST-PROJECT-SWITCH',
  spawn: 'TEST-SPAWN',
  restart: 'TEST-RESTART',
  noopRouter: 'TEST-NOOP-ROUTER',
};

/**
 * Empty PromptSet — used by tests that want to assert behaviour with no
 * fragments injected so the argv stays tractable.
 */
const emptyPromptSet: PromptSet = {
  agentPitfall: '',
  projectSwitch: '',
  spawn: '',
  restart: '',
  noopRouter: '',
};

function baseArgs(
  overrides: Partial<BaseArgs & InterceptedFields> = {},
): InterceptedArgs {
  return brandIntercepted({
    cwd: '/p/main',
    extraDirs: [],
    passthrough: [],
    noTmux: false,
    worktreeSet: false,
    worktreeArg: undefined,
    usedNoopFallback: false,
    worktreeMatched: false,
    ...overrides,
  });
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── assert helpers (mirror the Go assertContains family) ───────────────────

function assertContains(argv: readonly string[], token: string): void {
  if (!argv.includes(token)) {
    throw new Error(`argv missing ${JSON.stringify(token)}: ${JSON.stringify(argv)}`);
  }
}

function assertNotContains(argv: readonly string[], token: string): void {
  if (argv.includes(token)) {
    throw new Error(
      `argv contains unexpected ${JSON.stringify(token)}: ${JSON.stringify(argv)}`,
    );
  }
}

function assertContainsSubstring(argv: readonly string[], needle: string): void {
  if (!argv.some((a) => a.includes(needle))) {
    throw new Error(
      `argv missing substring ${JSON.stringify(needle)}: ${JSON.stringify(argv)}`,
    );
  }
}

// ── withAppendedSystemPrompts ──────────────────────────────────────────────

describe('withAppendedSystemPrompts', () => {
  test('no existing, single fragment → appended as new value', () => {
    expect(withAppendedSystemPrompts(['--verbose'], ['FRAG-A'])).toEqual([
      '--verbose',
      '--append-system-prompt',
      'FRAG-A',
    ]);
  });

  test('no existing, multiple fragments → joined with blank-line separator', () => {
    expect(
      withAppendedSystemPrompts(['--verbose'], ['FRAG-A', 'FRAG-B', 'FRAG-C']),
    ).toEqual(['--verbose', '--append-system-prompt', 'FRAG-A\n\nFRAG-B\n\nFRAG-C']);
  });

  test('empty fragments → passthrough unchanged', () => {
    expect(withAppendedSystemPrompts(['--verbose'], [])).toEqual(['--verbose']);
  });

  test('all-empty-strings fragments → passthrough unchanged', () => {
    expect(withAppendedSystemPrompts(['--verbose'], ['', '', ''])).toEqual([
      '--verbose',
    ]);
  });

  test('mixed empty-string fragments → empties dropped, no double blank-line', () => {
    expect(withAppendedSystemPrompts(['--verbose'], ['FRAG-A', '', 'FRAG-B'])).toEqual([
      '--verbose',
      '--append-system-prompt',
      'FRAG-A\n\nFRAG-B',
    ]);
  });

  test('existing space-form --append-system-prompt → merged into the value', () => {
    expect(
      withAppendedSystemPrompts(
        ['--append-system-prompt', "user's text"],
        ['FRAG-A'],
      ),
    ).toEqual(['--append-system-prompt', "user's text\n\nFRAG-A"]);
  });

  test('existing =form --append-system-prompt= → merged into the value', () => {
    expect(
      withAppendedSystemPrompts(["--append-system-prompt=user's text"], ['FRAG-A']),
    ).toEqual(["--append-system-prompt=user's text\n\nFRAG-A"]);
  });

  test('does not mutate the input passthrough slice', () => {
    const input = ['--verbose', '--model', 'sonnet'];
    withAppendedSystemPrompts(input, ['FRAG-A']);
    expect(input).toEqual(['--verbose', '--model', 'sonnet']);
  });

  test('passthrough contains `--` sentinel → fragment inserted BEFORE the sentinel', () => {
    // Repro of the live `fnc -- "say hi"` argv bug: when the user's
    // prompt is delimited by `--`, the appended --append-system-prompt
    // must land in the options section (before `--`), not in the prompt
    // (after `--`). Landing after `--` makes claude treat the flag and
    // its value as additional prompt text.
    expect(
      withAppendedSystemPrompts(['--name', 'say-hi', '--', 'say hi'], ['FRAG-A']),
    ).toEqual([
      '--name',
      'say-hi',
      '--append-system-prompt',
      'FRAG-A',
      '--',
      'say hi',
    ]);
  });

  test('passthrough is just `--` followed by prompt → fragment inserted before `--`', () => {
    expect(withAppendedSystemPrompts(['--', 'say hi'], ['FRAG-A'])).toEqual([
      '--append-system-prompt',
      'FRAG-A',
      '--',
      'say hi',
    ]);
  });

  test('only the first `--` is recognized as sentinel — subsequent `--` tokens are prompt text', () => {
    expect(
      withAppendedSystemPrompts(['--verbose', '--', 'say', '--', 'hi'], ['FRAG-A']),
    ).toEqual([
      '--verbose',
      '--append-system-prompt',
      'FRAG-A',
      '--',
      'say',
      '--',
      'hi',
    ]);
  });
});

// ── buildFnclaudeMCPConfigJSON ─────────────────────────────────────────────

describe('buildFnclaudeMCPConfigJSON', () => {
  test('returns null on failure path is not exercised here — happy-path shape only', () => {
    const r = buildFnclaudeMCPConfigJSON(false);
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers.fnclaude).toBeDefined();
    expect(parsed.mcpServers.fnclaude!.args).toEqual(['mcp']);
    expect(parsed.mcpServers.fnclaude!.command).toBeTruthy();
  });

  test('--noop bit appends "--noop" after "mcp" in args', () => {
    const r = buildFnclaudeMCPConfigJSON(true);
    const parsed = JSON.parse(r!) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers.fnclaude!.args).toEqual(['mcp', '--noop']);
  });
});

// ── buildArgv: structural / extra-dirs ─────────────────────────────────────

describe('buildArgv', () => {
  test('no extra dirs → claude + passthrough, fragments appended, no --add-dir', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', passthrough: ['--verbose'] }),
      '/shell',
      defaultConfig(),
      testPromptSet,
    );
    assertContains(argv, 'claude');
    assertContains(argv, '--verbose');
    assertContains(argv, '--append-system-prompt');
    assertContainsSubstring(argv, testPromptSet.agentPitfall);
    assertContainsSubstring(argv, testPromptSet.projectSwitch);
    assertContainsSubstring(argv, testPromptSet.restart);
    assertNotContains(argv, '--add-dir');
  });

  test('absolute extra dir → --add-dir flag, no settings (file missing)', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', extraDirs: ['/p/extra'] }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--add-dir');
    assertContains(argv, '/p/extra');
    assertNotContains(argv, '--settings');
  });

  test('relative extra dir → resolved against shellCWD', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', extraDirs: ['relative/dir'] }),
      '/shell/cwd',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--add-dir');
    assertContains(argv, '/shell/cwd/relative/dir');
  });

  test('.mcp.json next to extra dir → --mcp-config injected with that path', () => {
    const dir = tmp('fnc-argv-');
    const mcpPath = join(dir, '.mcp.json');
    writeFileSync(mcpPath, '{}');
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', extraDirs: [dir] }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--mcp-config');
    assertContains(argv, mcpPath);
  });

  test('.claude/settings.json next to extra dir → --settings injected', () => {
    const dir = tmp('fnc-argv-');
    mkdirSync(join(dir, '.claude'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    writeFileSync(settingsPath, '{}');
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', extraDirs: [dir] }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--settings');
    assertContains(argv, settingsPath);
  });

  test('--setting-sources in passthrough suppresses extra-dir --settings injection', () => {
    const dir = tmp('fnc-argv-');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        extraDirs: [dir],
        passthrough: ['--setting-sources=user'],
      }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--setting-sources=user');
    assertNotContains(argv, '--settings');
  });

  test('multiple extra dirs preserve order', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', extraDirs: ['/p/b', '/p/c'] }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '/p/b');
    assertContains(argv, '/p/c');
    expect(argv.indexOf('/p/b')).toBeLessThan(argv.indexOf('/p/c'));
  });

  test('default config does NOT inject --dangerously-skip-permissions', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main' }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertNotContains(argv, '--dangerously-skip-permissions');
  });

  test('explicit -D (already translated to --dangerously-skip-permissions) passes through', () => {
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        passthrough: ['--dangerously-skip-permissions'],
      }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--dangerously-skip-permissions');
  });

  test('default config does NOT inject --ide', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main' }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertNotContains(argv, '--ide');
  });

  test('explicit --ide passes through', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', passthrough: ['--ide'] }),
      '/shell',
      defaultConfig(),
      emptyPromptSet,
    );
    assertContains(argv, '--ide');
  });

  // ── auto-tmux ────────────────────────────────────────────────────────────

  test('auto.tmux="never" → never inject --tmux', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'never';
    const argv = buildArgv(baseArgs({ cwd: '/p/main' }), '/shell', cfg, emptyPromptSet);
    assertNotContains(argv, '--tmux');
  });

  test('auto.tmux="worktree" but noTmux=true → suppressed', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        worktreeSet: true,
        noTmux: true,
        passthrough: ['--worktree', 'feat'],
      }),
      '/shell',
      cfg,
      emptyPromptSet,
    );
    assertNotContains(argv, '--tmux');
  });

  test('auto.tmux="worktree" + --tmux already in passthrough → no duplicate', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        worktreeSet: true,
        passthrough: ['--worktree', 'feat', '--tmux'],
      }),
      '/shell',
      cfg,
      emptyPromptSet,
    );
    const count = argv.filter((t) => t === '--tmux').length;
    expect(count).toBe(1);
  });

  test('auto.tmux="worktree" + new worktree (worktreeSet & !worktreeMatched) → injected', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        worktreeSet: true,
        // worktreeMatched stays false: -w went through to passthrough.
        passthrough: ['--worktree', 'feat'],
      }),
      '/shell',
      cfg,
      emptyPromptSet,
    );
    assertContains(argv, '--tmux');
  });

  test('auto.tmux="worktree" but worktreeMatched=true → NOT injected', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/feat',
        worktreeSet: true,
        worktreeMatched: true,
      }),
      '/shell',
      cfg,
      emptyPromptSet,
    );
    assertNotContains(argv, '--tmux');
  });

  test('auto.tmux="worktree" without --worktree → NOT injected', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(baseArgs({ cwd: '/p/main' }), '/shell', cfg, emptyPromptSet);
    assertNotContains(argv, '--tmux');
  });

  test('auto.tmux="worktree" + explicit --tmux value form → no duplicate', () => {
    const cfg = defaultConfig();
    cfg.auto.tmux = 'worktree';
    const argv = buildArgv(
      baseArgs({
        cwd: '/p/main',
        worktreeSet: true,
        passthrough: ['--worktree', 'feat', '--tmux', 'mywin'],
      }),
      '/shell',
      cfg,
      emptyPromptSet,
    );
    const count = argv.filter((t) => t === '--tmux').length;
    expect(count).toBe(1);
  });

  // ── pitfall warning gate (integration with selectFragments) ──────────────

  test('default-config project session → pitfall fragment present', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main' }),
      '/shell',
      defaultConfig(),
      testPromptSet,
    );
    assertContains(argv, '--append-system-prompt');
    assertContainsSubstring(argv, testPromptSet.agentPitfall);
  });

  test('-p print-mode session → no --append-system-prompt at all', () => {
    const argv = buildArgv(
      baseArgs({ cwd: '/p/main', passthrough: ['-p', 'the prompt'] }),
      '/shell',
      defaultConfig(),
      testPromptSet,
    );
    assertNotContains(argv, '--append-system-prompt');
  });
});
