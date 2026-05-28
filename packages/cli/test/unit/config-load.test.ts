import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../src/config/load.ts';

let tmpRoot: string;
let configPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-config-'));
  configPath = join(tmpRoot, 'config.toml');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadConfig — empty / missing', () => {
  test('missing file → defaults (autoTmux undefined)', async () => {
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });

  test('empty file → defaults', async () => {
    writeFileSync(configPath, '');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });

  test('directory at the path → defaults', async () => {
    mkdirSync(configPath);
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });
});

describe('loadConfig — [auto] section', () => {
  test('auto.tmux = "worktree" → autoTmux: "worktree"', async () => {
    writeFileSync(configPath, '[auto]\ntmux = "worktree"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBe('worktree');
  });

  test('auto.tmux = "never" → autoTmux: "never"', async () => {
    writeFileSync(configPath, '[auto]\ntmux = "never"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBe('never');
  });

  test('no [auto] section → undefined', async () => {
    writeFileSync(configPath, '[name]\nmodel = "claude-haiku-4-5"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });

  test('non-string auto.tmux → undefined (defensive)', async () => {
    writeFileSync(configPath, '[auto]\ntmux = 42\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });
});

describe('loadConfig — malformed inputs', () => {
  test('malformed TOML → defaults', async () => {
    writeFileSync(configPath, '[unterminated\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoTmux).toBeUndefined();
  });
});

describe('loadConfig — auto.handoff', () => {
  test('auto.handoff = "never" → autoHandoff: "never"', async () => {
    writeFileSync(configPath, '[auto]\nhandoff = "never"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoHandoff).toBe('never');
  });

  test('auto.handoff = "ask" → autoHandoff: "ask"', async () => {
    writeFileSync(configPath, '[auto]\nhandoff = "ask"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoHandoff).toBe('ask');
  });

  test('auto.handoff = 3 (integer) → autoHandoff: "3"', async () => {
    writeFileSync(configPath, '[auto]\nhandoff = 3\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoHandoff).toBe('3');
  });

  test('missing auto.handoff → undefined', async () => {
    writeFileSync(configPath, '[auto]\ntmux = "never"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoHandoff).toBeUndefined();
  });

  test('non-string non-number auto.handoff → undefined', async () => {
    writeFileSync(configPath, '[auto]\nhandoff = true\n');
    const c = await loadConfig({ path: configPath });
    expect(c.autoHandoff).toBeUndefined();
  });
});

describe('loadConfig — [exec.env] table', () => {
  test('[exec.env] with string values → execEnv map', async () => {
    writeFileSync(
      configPath,
      '[exec.env]\nFOO = "bar"\nBAZ = "qux"\n',
    );
    const c = await loadConfig({ path: configPath });
    expect(c.execEnv).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('missing [exec.env] → undefined', async () => {
    writeFileSync(configPath, '[auto]\ntmux = "never"\n');
    const c = await loadConfig({ path: configPath });
    expect(c.execEnv).toBeUndefined();
  });

  test('empty [exec.env] → empty map', async () => {
    writeFileSync(configPath, '[exec.env]\n');
    const c = await loadConfig({ path: configPath });
    expect(c.execEnv).toEqual({});
  });

  test('[exec.env] with non-string value → that key skipped (defensive)', async () => {
    writeFileSync(
      configPath,
      '[exec.env]\nGOOD = "ok"\nBAD = 42\n',
    );
    const c = await loadConfig({ path: configPath });
    expect(c.execEnv).toEqual({ GOOD: 'ok' });
  });
});
