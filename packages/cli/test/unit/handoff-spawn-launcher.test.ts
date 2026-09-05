/**
 * §8.3 — unit tests for the spawn-launcher decision + dispatch.
 *
 * Ports the Go canonical's buildSpawnArgv / autoDetectSpawnCommand /
 * spawnSibling tests from `fnclaude/src/spawn_test.go`.
 * Substitution shape, dest-with-spaces handling, empty-template error
 * mode, and the decision order (config → $TMUX → paste-flow) all
 * translate directly.
 */

import { describe, expect, test } from 'bun:test';

import {
  buildSpawnArgv,
  chooseAndSpawn,
  renderSpawnCommand,
  type SpawnFn,
} from '../../src/handoff/spawn-launcher';

const noopSpawn: SpawnFn = () => ({ unref() {} });

const recordingSpawn = (): {
  spawn: SpawnFn;
  calls: { argv: readonly string[]; env: Record<string, string> }[];
} => {
  const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
  const spawn: SpawnFn = (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return { unref() {} };
  };
  return { spawn, calls };
};

describe('buildSpawnArgv — substitutions', () => {
  test('kitty template with all placeholders', () => {
    const got = buildSpawnArgv(
      'kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}',
      '/usr/bin/fnclaude',
      'arch-setup@fnclaude',
      'fix-thing',
      '/tmp/handoff-abc.md',
    );
    expect(got).toEqual([
      'kitty',
      '@',
      'launch',
      '--type=os-window',
      '/usr/bin/fnclaude',
      'arch-setup@fnclaude',
      '--name',
      'fix-thing',
      '@/tmp/handoff-abc.md',
    ]);
  });

  test('dest with spaces stays one argv entry', () => {
    // Substitution is per-token after whitespace splitting — a {dest}
    // expanding to a path with spaces must remain a single argv entry.
    const got = buildSpawnArgv(
      'wezterm cli spawn -- {bin} {dest}',
      '/usr/bin/fnclaude',
      '/home/user/My Project',
      'x',
      '/tmp/x',
    );
    expect(got).toEqual([
      'wezterm',
      'cli',
      'spawn',
      '--',
      '/usr/bin/fnclaude',
      '/home/user/My Project',
    ]);
  });

  test('empty template → empty argv', () => {
    expect(buildSpawnArgv('', '/bin', 'd', 'n', '/s')).toEqual([]);
  });

  test('whitespace-only template → empty argv', () => {
    expect(buildSpawnArgv('   \t  ', '/bin', 'd', 'n', '/s')).toEqual([]);
  });

  test('leading and trailing whitespace are trimmed', () => {
    const got = buildSpawnArgv('  tmux new-window {bin}  ', '/bin/fnclaude', 'd', 'n', '/s');
    expect(got).toEqual(['tmux', 'new-window', '/bin/fnclaude']);
  });
});

describe('chooseAndSpawn — decision order', () => {
  test('autoSpawnCommand set → tokenizes, substitutes, dispatches', () => {
    const { spawn, calls } = recordingSpawn();
    const r = chooseAndSpawn({
      autoSpawnCommand: 'kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}',
      env: {},
      spawnEnv: { PATH: '/bin' },
      fncBin: '/usr/bin/fnclaude',
      dest: 'arch-setup@fnclaude',
      name: 'side-thing',
      summary: '/tmp/handoff-abc.md',
      extraArgs: [],
      spawn,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      'kitty',
      '@',
      'launch',
      '--type=os-window',
      '/usr/bin/fnclaude',
      'arch-setup@fnclaude',
      '--name',
      'side-thing',
      '@/tmp/handoff-abc.md',
    ]);
    expect(calls[0]?.env).toEqual({ PATH: '/bin' });
  });

  test('autoSpawnCommand wins over $TMUX', () => {
    const { spawn, calls } = recordingSpawn();
    chooseAndSpawn({
      autoSpawnCommand: 'custom {bin} {dest}',
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      spawnEnv: {},
      fncBin: '/fnc',
      dest: 'd',
      name: 'n',
      summary: '/s',
      extraArgs: [],
      spawn,
    });
    // First token must be `custom`, not `tmux`.
    expect(calls[0]?.argv[0]).toBe('custom');
  });

  test('$TMUX set, no autoSpawnCommand → uses tmux template', () => {
    const { spawn, calls } = recordingSpawn();
    const r = chooseAndSpawn({
      autoSpawnCommand: '',
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      spawnEnv: {},
      fncBin: '/usr/bin/fnclaude',
      dest: 'dest@owner',
      name: 'x',
      summary: '/tmp/s',
      extraArgs: [],
      spawn,
    });
    expect(r.ok).toBe(true);
    expect(calls[0]?.argv).toEqual([
      'tmux',
      'new-window',
      '-d',
      '/usr/bin/fnclaude',
      'dest@owner',
      '--name',
      'x',
      '@/tmp/s',
    ]);
  });

  test('neither set → paste-flow fallback ({ok:false, command})', () => {
    const { spawn, calls } = recordingSpawn();
    const r = chooseAndSpawn({
      autoSpawnCommand: '',
      env: {},
      spawnEnv: {},
      fncBin: '/usr/bin/fnclaude',
      dest: 'dest@owner',
      name: 'x',
      summary: '/tmp/s',
      extraArgs: [],
      spawn,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.command).toBe('fnclaude dest@owner --name x @/tmp/s');
    }
    expect(calls).toHaveLength(0);
  });

  test('$TMUX empty string is treated as unset', () => {
    const { spawn, calls } = recordingSpawn();
    const r = chooseAndSpawn({
      autoSpawnCommand: '',
      env: { TMUX: '' },
      spawnEnv: {},
      fncBin: '/fnc',
      dest: 'd',
      name: 'n',
      summary: '/s',
      extraArgs: [],
      spawn,
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('extraArgs are appended after the templated argv', () => {
    const { spawn, calls } = recordingSpawn();
    chooseAndSpawn({
      autoSpawnCommand: 'tmux new-window -d {bin} {dest}',
      env: {},
      spawnEnv: {},
      fncBin: '/fnc',
      dest: 'd',
      name: 'n',
      summary: '/s',
      extraArgs: ['--model', 'sonnet', '--ide'],
      spawn,
    });
    expect(calls[0]?.argv).toEqual([
      'tmux',
      'new-window',
      '-d',
      '/fnc',
      'd',
      '--model',
      'sonnet',
      '--ide',
    ]);
  });

  test('whitespace-only template (after splitting empty) → throws', () => {
    // chooseAndSpawn defends against the resolved-template-but-empty
    // case (matches Go canonical's "spawn template produced empty argv"
    // path). Note that pickTemplate returns "" for an empty config and
    // no $TMUX — the only way to hit this branch is a config whose value
    // is whitespace-only, which still satisfies `!== ''`.
    expect(() =>
      chooseAndSpawn({
        autoSpawnCommand: '   ',
        env: {},
        spawnEnv: {},
        fncBin: '/fnc',
        dest: 'd',
        name: 'n',
        summary: '/s',
        extraArgs: [],
        spawn: noopSpawn,
      }),
    ).toThrow(/empty argv/);
  });
});

describe('renderSpawnCommand', () => {
  test('no extra args', () => {
    expect(
      renderSpawnCommand({
        dest: 'dest@owner',
        name: 'x',
        summary: '/tmp/handoff-abc.md',
        extraArgs: [],
      }),
    ).toBe('fnclaude dest@owner --name x @/tmp/handoff-abc.md');
  });

  test('appends override flags space-joined', () => {
    expect(
      renderSpawnCommand({
        dest: 'd',
        name: 'n',
        summary: '/s',
        extraArgs: ['--model', 'sonnet', '--ide'],
      }),
    ).toBe('fnclaude d --name n @/s --model sonnet --ide');
  });
});
