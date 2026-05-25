import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configFilePath,
  defaultConfig,
  envFromConfig,
  loadConfig,
  normalizeHandoffMode,
  normalizeTmuxMode,
  parseBoolEnv,
} from '../src/config.js';

// ── env helpers ────────────────────────────────────────────────────────────

const FNCLAUDE_ENV_KEYS = [
  'FNCLAUDE_NAME_MODEL',
  'FNCLAUDE_NAME_TIMEOUT',
  'FNCLAUDE_QUIET_MISSING_API_KEY',
  'FNCLAUDE_TMUX',
  'FNCLAUDE_HANDOFF',
  'FNCLAUDE_SPAWN_COMMAND',
];

const SAVED_ENV: Record<string, string | undefined> = {};
let TMPS: string[] = [];

function snapshotEnv() {
  for (const k of [...FNCLAUDE_ENV_KEYS, 'XDG_CONFIG_HOME', 'HOME']) {
    SAVED_ENV[k] = process.env[k];
  }
}
function restoreEnv() {
  for (const k of [...FNCLAUDE_ENV_KEYS, 'XDG_CONFIG_HOME', 'HOME']) {
    const v = SAVED_ENV[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
function clearConfigEnv() {
  for (const k of FNCLAUDE_ENV_KEYS) delete process.env[k];
}
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnclaude-cfg-'));
  TMPS.push(dir);
  return dir;
}
function writeConfigFile(content: string): string {
  const dir = makeTmp();
  const cfgDir = join(dir, 'fnclaude');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), content);
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

beforeEach(() => {
  snapshotEnv();
});
afterEach(() => {
  restoreEnv();
  for (const d of TMPS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  TMPS = [];
});

// ── defaultConfig ──────────────────────────────────────────────────────────

describe('defaultConfig', () => {
  test('built-in defaults', () => {
    const cfg = defaultConfig();
    expect(cfg.name.model).toBe('claude-haiku-4-5');
    expect(cfg.name.timeout).toBe(3000); // 3s expressed as ms
    expect(cfg.name.quietMissingAPIKey).toBe(false);
    expect(cfg.auto.tmux).toBe('never');
    expect(cfg.auto.handoff).toBe('ask');
    expect(cfg.auto.spawnCommand).toBe('');
    expect(Object.keys(cfg.exec.env ?? {}).length).toBe(0);
  });
});

// ── parseBoolEnv ───────────────────────────────────────────────────────────

describe('parseBoolEnv', () => {
  test('truthy values', () => {
    for (const v of ['1', 'true', 'True', 'TRUE', 'yes', 'YES', 'Yes']) {
      expect(parseBoolEnv(v)).toBe(true);
    }
  });
  test('falsy values', () => {
    for (const v of ['0', 'false', 'no', 'maybe', '']) {
      expect(parseBoolEnv(v)).toBe(false);
    }
  });
});

// ── configFilePath ─────────────────────────────────────────────────────────

describe('configFilePath', () => {
  test('XDG set → uses XDG', () => {
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    expect(configFilePath()).toBe('/custom/xdg/fnclaude/config.toml');
  });
  test('XDG unset → $HOME/.config', () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/fake/home';
    expect(configFilePath()).toBe('/fake/home/.config/fnclaude/config.toml');
  });
});

// ── normalizeTmuxMode / normalizeHandoffMode ───────────────────────────────

describe('normalizeTmuxMode', () => {
  test('valid values pass through without warning', () => {
    expect(normalizeTmuxMode('never')).toEqual({ value: 'never', warning: null });
    expect(normalizeTmuxMode('worktree')).toEqual({ value: 'worktree', warning: null });
  });
  test('empty string defaults to "never" without warning', () => {
    expect(normalizeTmuxMode('')).toEqual({ value: 'never', warning: null });
  });
  test('invalid value falls back to "never" with a warning', () => {
    const r = normalizeTmuxMode('always');
    expect(r.value).toBe('never');
    expect(r.warning).toContain('auto.tmux="always"');
    const r2 = normalizeTmuxMode('garbage');
    expect(r2.value).toBe('never');
    expect(r2.warning).toContain('garbage');
  });
});

describe('normalizeHandoffMode', () => {
  test('valid values pass through without warning', () => {
    expect(normalizeHandoffMode('never')).toEqual({ value: 'never', warning: null });
    expect(normalizeHandoffMode('ask')).toEqual({ value: 'ask', warning: null });
    expect(normalizeHandoffMode('0')).toEqual({ value: '0', warning: null });
    expect(normalizeHandoffMode('5')).toEqual({ value: '5', warning: null });
    expect(normalizeHandoffMode('30')).toEqual({ value: '30', warning: null });
  });
  test('empty string defaults to "ask" without warning', () => {
    expect(normalizeHandoffMode('')).toEqual({ value: 'ask', warning: null });
  });
  test('invalid values fall back to "ask" with a warning', () => {
    for (const v of ['-1', 'foo', '5.5', '3s']) {
      const r = normalizeHandoffMode(v);
      expect(r.value).toBe('ask');
      expect(r.warning).not.toBeNull();
      expect(r.warning).toContain(v);
    }
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  test('no file → defaults', () => {
    const dir = makeTmp();
    process.env.XDG_CONFIG_HOME = dir;
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    const def = defaultConfig();
    expect(cfg.name.model).toBe(def.name.model);
    expect(cfg.auto.tmux).toBe(def.auto.tmux);
  });

  test('file overrides defaults', () => {
    writeConfigFile(`
[name]
model = "claude-opus-4-5"
timeout = "10s"
quiet_missing_api_key = true

[auto]
tmux = "worktree"
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.name.model).toBe('claude-opus-4-5');
    expect(cfg.name.timeout).toBe(10_000);
    expect(cfg.name.quietMissingAPIKey).toBe(true);
    expect(cfg.auto.tmux).toBe('worktree');
  });

  test('legacy keys silently ignored', () => {
    writeConfigFile(`
[auto]
tmux = "worktree"
dangerously_skip_permissions = true
ide = "always"
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.auto.tmux).toBe('worktree');
  });

  test('malformed file → defaults', () => {
    writeConfigFile(`this is not valid toml ][[[`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    const def = defaultConfig();
    expect(cfg.name.model).toBe(def.name.model);
  });

  test('env overrides file', () => {
    writeConfigFile(`
[name]
model = "claude-haiku-4-5"

[auto]
tmux = "worktree"
`);
    clearConfigEnv();
    process.env.FNCLAUDE_NAME_MODEL = 'claude-sonnet-4-5';
    process.env.FNCLAUDE_TMUX = 'never';
    const { config: cfg } = loadConfig();
    expect(cfg.name.model).toBe('claude-sonnet-4-5');
    expect(cfg.auto.tmux).toBe('never');
  });

  test('env timeout', () => {
    const dir = makeTmp();
    process.env.XDG_CONFIG_HOME = dir;
    clearConfigEnv();
    process.env.FNCLAUDE_NAME_TIMEOUT = '15s';
    const { config: cfg } = loadConfig();
    expect(cfg.name.timeout).toBe(15_000);
  });

  test('partial file: unset fields stay default', () => {
    writeConfigFile(`
[auto]
tmux = "worktree"
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.auto.tmux).toBe('worktree');
    expect(cfg.name.model).toBe('claude-haiku-4-5');
  });

  test('invalid timeout in file → keeps default', () => {
    writeConfigFile(`
[name]
timeout = "not-a-duration"
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.name.timeout).toBe(defaultConfig().name.timeout);
  });

  test('invalid env timeout → keeps default', () => {
    const dir = makeTmp();
    process.env.XDG_CONFIG_HOME = dir;
    clearConfigEnv();
    process.env.FNCLAUDE_NAME_TIMEOUT = 'garbage';
    const { config: cfg } = loadConfig();
    expect(cfg.name.timeout).toBe(defaultConfig().name.timeout);
  });

  test('env QuietMissingAPIKey', () => {
    const dir = makeTmp();
    process.env.XDG_CONFIG_HOME = dir;
    clearConfigEnv();
    process.env.FNCLAUDE_QUIET_MISSING_API_KEY = '1';
    expect(loadConfig().config.name.quietMissingAPIKey).toBe(true);
  });

  test('spawn command from file', () => {
    writeConfigFile(`
[auto]
spawn_command = "kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}"
`);
    clearConfigEnv();
    expect(loadConfig().config.auto.spawnCommand).toBe(
      'kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}',
    );
  });

  test('spawn command env overrides file', () => {
    writeConfigFile(`
[auto]
spawn_command = "from-file {bin} {dest}"
`);
    clearConfigEnv();
    process.env.FNCLAUDE_SPAWN_COMMAND = 'from-env {bin} {dest}';
    expect(loadConfig().config.auto.spawnCommand).toBe('from-env {bin} {dest}');
  });

  test('handoff from file', () => {
    writeConfigFile(`
[auto]
handoff = "5"
`);
    clearConfigEnv();
    expect(loadConfig().config.auto.handoff).toBe('5');
  });

  test('handoff env overrides file', () => {
    writeConfigFile(`
[auto]
handoff = "5"
`);
    clearConfigEnv();
    process.env.FNCLAUDE_HANDOFF = 'never';
    expect(loadConfig().config.auto.handoff).toBe('never');
  });

  test('handoff unset → ask', () => {
    const dir = makeTmp();
    process.env.XDG_CONFIG_HOME = dir;
    clearConfigEnv();
    expect(loadConfig().config.auto.handoff).toBe('ask');
  });

  test('invalid handoff normalizes to ask', () => {
    writeConfigFile(`
[auto]
handoff = "-1"
`);
    clearConfigEnv();
    expect(loadConfig().config.auto.handoff).toBe('ask');
  });

  test('invalid tmux normalizes to never', () => {
    writeConfigFile(`
[auto]
tmux = "always"
`);
    clearConfigEnv();
    expect(loadConfig().config.auto.tmux).toBe('never');
  });

  // exec.env

  test('default exec.env empty', () => {
    const cfg = defaultConfig();
    expect(Object.keys(cfg.exec.env ?? {}).length).toBe(0);
  });

  test('exec.env empty when no [exec.env] section', () => {
    writeConfigFile(`
[name]
model = "claude-haiku-4-5"
`);
    clearConfigEnv();
    expect(Object.keys(loadConfig().config.exec.env ?? {}).length).toBe(0);
  });

  test('exec.env single entry', () => {
    writeConfigFile(`
[exec.env]
FNCLAUDE_INVOCATION = "1"
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.exec.env?.FNCLAUDE_INVOCATION).toBe('1');
    expect(Object.keys(cfg.exec.env ?? {}).length).toBe(1);
  });

  test('exec.env multiple entries incl empty value', () => {
    writeConfigFile(`
[exec.env]
FNCLAUDE_INVOCATION = "1"
SOME_DOWNSTREAM_FLAG = "true"
EMPTY_VAL = ""
`);
    clearConfigEnv();
    const { config: cfg } = loadConfig();
    expect(cfg.exec.env).toEqual({
      FNCLAUDE_INVOCATION: '1',
      SOME_DOWNSTREAM_FLAG: 'true',
      EMPTY_VAL: '',
    });
  });
});

// ── envFromConfig ─────────────────────────────────────────────────────────

describe('envFromConfig', () => {
  test('empty → []', () => {
    expect(envFromConfig({} as any)).toEqual([]);
  });

  test('single entry', () => {
    const got = envFromConfig({ exec: { env: { FOO: 'bar' } } } as any);
    expect(got).toEqual(['FOO=bar']);
  });

  test('multiple entries sorted', () => {
    const got = envFromConfig({
      exec: { env: { ZED: 'last', ALPHA: 'first', MIDDY: 'middle' } },
    } as any);
    expect(got).toEqual(['ALPHA=first', 'MIDDY=middle', 'ZED=last']);
  });

  test('empty value preserved', () => {
    expect(envFromConfig({ exec: { env: { EMPTY: '' } } } as any)).toEqual([
      'EMPTY=',
    ]);
  });

  test('last-wins precedence when appended after os env', () => {
    // Simulate: process.env-like KEY=VALUE list + config-env appended.
    const osEnv = ['PATH=/usr/bin', 'FNCLAUDE_INVOCATION=inherited'];
    const merged = [
      ...osEnv,
      ...envFromConfig({ exec: { env: { FNCLAUDE_INVOCATION: 'configured' } } } as any),
    ];
    let last = '';
    for (const e of merged)
      if (e.startsWith('FNCLAUDE_INVOCATION=')) last = e;
    expect(last).toBe('FNCLAUDE_INVOCATION=configured');
  });
});
