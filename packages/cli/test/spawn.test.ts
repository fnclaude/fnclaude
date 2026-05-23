import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  autoDetectSpawnCommand,
  buildSpawnArgv,
  cleanEnvForSpawn,
  spawnSibling,
} from '../src/spawn.js';
import { resolveSelfPath } from '../src/paths.js';
import { defaultConfig } from '../src/config.js';

// ── env helpers ────────────────────────────────────────────────────────────

let savedTmux: string | undefined;

beforeEach(() => {
  savedTmux = process.env.TMUX;
});
afterEach(() => {
  if (savedTmux === undefined) {
    delete process.env.TMUX;
  } else {
    process.env.TMUX = savedTmux;
  }
});

// ── cleanEnvForSpawn ──────────────────────────────────────────────────────

describe('cleanEnvForSpawn', () => {
  test('drops FNC_SOCKET', () => {
    const env = ['PATH=/usr/bin', 'FNC_SOCKET=/tmp/fnclaude-mcp-42.sock', 'HOME=/home/tom'];
    const result = cleanEnvForSpawn(env);
    expect(result).not.toContainEqual(expect.stringContaining('FNC_SOCKET'));
    expect(result).toContainEqual('PATH=/usr/bin');
    expect(result).toContainEqual('HOME=/home/tom');
  });

  test('drops FNCLAUDE_HANDOFF', () => {
    const env = ['FNCLAUDE_HANDOFF=ask', 'PATH=/usr/bin'];
    const result = cleanEnvForSpawn(env);
    expect(result).not.toContainEqual(expect.stringContaining('FNCLAUDE_HANDOFF'));
    expect(result).toContainEqual('PATH=/usr/bin');
  });

  test('drops CLAUDE_CODE_SESSION_ID', () => {
    const env = ['CLAUDE_CODE_SESSION_ID=abc123', 'HOME=/home/tom'];
    const result = cleanEnvForSpawn(env);
    expect(result).not.toContainEqual(expect.stringContaining('CLAUDE_CODE_SESSION_ID'));
    expect(result).toContainEqual('HOME=/home/tom');
  });

  test('drops all three simultaneously', () => {
    const env = [
      'PATH=/usr/bin',
      'FNC_SOCKET=/tmp/s.sock',
      'FNCLAUDE_HANDOFF=5',
      'CLAUDE_CODE_SESSION_ID=xyz',
      'HOME=/home/tom',
    ];
    const result = cleanEnvForSpawn(env);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual('PATH=/usr/bin');
    expect(result).toContainEqual('HOME=/home/tom');
  });

  test('passes through unrelated vars unchanged', () => {
    const env = ['XDG_RUNTIME_DIR=/run/user/1000', 'ANTHROPIC_API_KEY=sk-secret'];
    const result = cleanEnvForSpawn(env);
    expect(result).toEqual(env);
  });

  test('handles entries without = (bare keys)', () => {
    const env = ['BARE_KEY', 'FNC_SOCKET=/tmp/s.sock', 'OTHER=val'];
    const result = cleanEnvForSpawn(env);
    expect(result).toContainEqual('BARE_KEY');
    expect(result).not.toContainEqual(expect.stringContaining('FNC_SOCKET'));
  });

  test('empty input returns empty', () => {
    expect(cleanEnvForSpawn([])).toEqual([]);
  });
});

// ── autoDetectSpawnCommand ─────────────────────────────────────────────────

describe('autoDetectSpawnCommand', () => {
  test('$TMUX set → returns tmux template', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    const cmd = autoDetectSpawnCommand();
    expect(cmd).toContain('tmux new-window');
    expect(cmd).toContain('{bin}');
    expect(cmd).toContain('{dest}');
    expect(cmd).toContain('{name}');
    expect(cmd).toContain('{summary}');
  });

  test('$TMUX empty → returns empty string', () => {
    process.env.TMUX = '';
    expect(autoDetectSpawnCommand()).toBe('');
  });

  test('$TMUX unset → returns empty string', () => {
    delete process.env.TMUX;
    expect(autoDetectSpawnCommand()).toBe('');
  });

  test('tmux template uses -d flag (detach)', () => {
    process.env.TMUX = '/tmp/tmux/s,1,0';
    expect(autoDetectSpawnCommand()).toContain('-d');
  });
});

// ── buildSpawnArgv ─────────────────────────────────────────────────────────

describe('buildSpawnArgv', () => {
  type ArgvCase = {
    name: string;
    tmpl: string;
    bin: string;
    dest: string;
    wname: string;
    summary: string;
    want: string[];
  };

  const cases: ArgvCase[] = [
    {
      name: 'tmux template expansion',
      tmpl: 'tmux new-window -d {bin} {dest} --name {name} @{summary}',
      bin: '/usr/bin/fnc',
      dest: '/home/tom/src/proj',
      wname: 'fix-bug',
      summary: '/tmp/s.md',
      want: [
        'tmux',
        'new-window',
        '-d',
        '/usr/bin/fnc',
        '/home/tom/src/proj',
        '--name',
        'fix-bug',
        '@/tmp/s.md',
      ],
    },
    {
      name: 'custom kitty template',
      tmpl: 'kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}',
      bin: '/fnc',
      dest: '/tmp/proj',
      wname: 'task',
      summary: '/tmp/sum.md',
      want: [
        'kitty',
        '@',
        'launch',
        '--type=os-window',
        '/fnc',
        '/tmp/proj',
        '--name',
        'task',
        '@/tmp/sum.md',
      ],
    },
    {
      name: 'path with spaces stays one token',
      tmpl: '{bin} {dest}',
      bin: '/usr/bin/fnc',
      dest: '/home/user/my project',
      wname: 'n',
      summary: '/s.md',
      want: ['/usr/bin/fnc', '/home/user/my project'],
    },
    {
      name: 'empty template produces empty argv',
      tmpl: '',
      bin: '/fnc',
      dest: '/d',
      wname: 'n',
      summary: '/s',
      want: [],
    },
    {
      name: 'leading/trailing whitespace ignored',
      tmpl: '  tmux new-window  ',
      bin: '/fnc',
      dest: '/d',
      wname: 'n',
      summary: '/s',
      want: ['tmux', 'new-window'],
    },
    {
      name: 'unknown placeholder left verbatim in token',
      tmpl: '{bin} {unknown}',
      bin: '/fnc',
      dest: '/d',
      wname: 'n',
      summary: '/s',
      want: ['/fnc', '{unknown}'],
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const got = buildSpawnArgv(tc.tmpl, tc.bin, tc.dest, tc.wname, tc.summary);
      expect(got).toEqual(tc.want);
    });
  }
});

// ── resolveSelfPath ───────────────────────────────────────────────────────

describe('resolveSelfPath', () => {
  test('returns a non-empty string', () => {
    const p = resolveSelfPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});

// ── spawnSibling ───────────────────────────────────────────────────────────

describe('spawnSibling', () => {
  test('returns false when no template configured and $TMUX unset', async () => {
    delete process.env.TMUX;
    const cfg = defaultConfig(); // spawnCommand = ''
    const called: { argv: string[]; env: string[] }[] = [];
    const result = await spawnSibling(cfg, '/dest', 'name', '/sum.md', [], (argv, env) => {
      called.push({ argv, env });
    });
    expect(result).toBe(false);
    expect(called).toHaveLength(0);
  });

  test('returns true and calls spawnFn when $TMUX set', async () => {
    process.env.TMUX = '/tmp/tmux/s,1,0';
    const cfg = defaultConfig();
    const calls: { argv: string[]; env: string[] }[] = [];
    const result = await spawnSibling(cfg, '/home/tom/proj', 'fix', '/tmp/s.md', [], (argv, env) => {
      calls.push({ argv, env });
    });
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.argv[0]).toBe('tmux');
    expect(call.argv).toContain('/home/tom/proj');
    expect(call.argv).toContain('fix');
    expect(call.argv).toContain('@/tmp/s.md');
  });

  test('cfg.auto.spawnCommand takes precedence over auto-detect', async () => {
    process.env.TMUX = '/tmp/tmux/s,1,0'; // would normally give tmux template
    const cfg = { ...defaultConfig(), auto: { ...defaultConfig().auto, spawnCommand: 'myterm launch {bin} {dest}' } };
    const calls: { argv: string[] }[] = [];
    await spawnSibling(cfg, '/dest', 'name', '/s.md', [], (argv) => {
      calls.push({ argv });
    });
    expect(calls[0]!.argv[0]).toBe('myterm');
    expect(calls[0]!.argv[1]).toBe('launch');
    expect(calls[0]!.argv).toContain('/dest');
  });

  test('extraArgs are appended after template argv', async () => {
    process.env.TMUX = '/tmp/tmux/s,1,0';
    const cfg = defaultConfig();
    const calls: { argv: string[] }[] = [];
    await spawnSibling(cfg, '/d', 'n', '/s.md', ['--extra', 'flag'], (argv) => {
      calls.push({ argv });
    });
    const argv = calls[0]!.argv;
    const lastTwo = argv.slice(-2);
    expect(lastTwo).toEqual(['--extra', 'flag']);
  });

  test('env passed to spawnFn has session vars stripped', async () => {
    process.env.TMUX = '/tmp/tmux/s,1,0';
    process.env.FNC_SOCKET = '/tmp/fnclaude-mcp-99.sock';
    const cfg = defaultConfig();
    const calls: { env: string[] }[] = [];
    await spawnSibling(cfg, '/d', 'n', '/s.md', [], (_, env) => {
      calls.push({ env });
    });
    delete process.env.FNC_SOCKET;
    const env = calls[0]!.env;
    expect(env.some((e) => e.startsWith('FNC_SOCKET='))).toBe(false);
  });

  test('throws when template expands to empty argv', async () => {
    process.env.TMUX = '';
    const cfg = { ...defaultConfig(), auto: { ...defaultConfig().auto, spawnCommand: '   ' } };
    const fn = async () => {
      await spawnSibling(cfg, '/d', 'n', '/s.md', [], () => {});
    };
    await expect(fn()).rejects.toThrow('empty argv');
  });
});
