/**
 * Unit tests for the fnc config loader at its new home,
 * `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.*`.
 *
 * Three things are being pinned that were not true before:
 *
 *   1. The location. Tests drive `loadConfig` through an XDG env rather than a
 *      literal path, so the layout in specs/rhombus-rocks-config.md is what is
 *      under test, not just the parsing.
 *   2. Format tolerance. json / jsonc / toml / yaml all parse, and the
 *      precedence between them is fixed rather than readdir-dependent.
 *   3. Migration. The pre-restructure `$XDG_CONFIG_HOME/fnclaude/config.toml`
 *      is read once when nothing exists at the new location, its snake_case
 *      keys become camelCase, and it is written out as JSON.
 *
 * The notice-ladder cases carry over from the TOML-era suite unchanged in
 * substance — they exercise per-field degrade and the #331 warnings, which the
 * move must not alter — but now use the camelCase `noticeTiers` /
 * `noticeRepeat` names the schema defines.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../src/config/load';

let tmpRoot: string;
let xdgConfigHome: string;
let fncDir: string;

/** The XDG env `loadConfig` takes; HOME is pointed at the sandbox too. */
function env(): { home: string; xdgConfigHome: string } {
  return { home: tmpRoot, xdgConfigHome };
}

function writeConfig(basename: string, body: string): void {
  mkdirSync(fncDir, { recursive: true });
  writeFileSync(join(fncDir, basename), body);
}

/** Write JSON at the canonical location. Most cases only care about content. */
function writeJson(doc: unknown): void {
  writeConfig('config.json', JSON.stringify(doc, null, 2));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-config-'));
  xdgConfigHome = join(tmpRoot, '.config');
  fncDir = join(xdgConfigHome, 'rhombus.rocks', 'fnclaude');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadConfig — empty / missing', () => {
  test('no config anywhere → defaults', async () => {
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBeUndefined();
    expect(c.noOobe).toBe(false);
    expect(c.noopDir).toBeUndefined();
  });

  test('empty file → defaults', async () => {
    writeConfig('config.json', '');
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBeUndefined();
  });

  test('a directory named config.json → defaults', async () => {
    mkdirSync(join(fncDir, 'config.json'), { recursive: true });
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBeUndefined();
  });

  test('malformed JSON → defaults, no throw', async () => {
    writeConfig('config.json', '{ "auto": { ');
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBeUndefined();
  });

  test('XDG_CONFIG_HOME unset → falls back to ~/.config', async () => {
    // Same directory, reached the other way: HOME/.config === xdgConfigHome.
    writeJson({ auto: { tmux: 'always' } });
    const c = await loadConfig({ env: { home: tmpRoot, xdgConfigHome: undefined } });
    expect(c.autoTmux).toBe('always');
  });
});

describe('loadConfig — every accepted format', () => {
  test('config.json', async () => {
    writeConfig('config.json', '{"auto":{"tmux":"always"}}');
    expect((await loadConfig({ env: env() })).autoTmux).toBe('always');
  });

  // confbox's JSONC parser strips comments but does NOT allow trailing
  // commas. Pinned here so the limit is documented where someone hits it,
  // rather than surfacing as a config that silently loads as defaults.
  test('config.jsonc — comments are stripped', async () => {
    writeConfig(
      'config.jsonc',
      '{\n  // fnc supplies --tmux because Claude Code has no setting for it\n  "auto": { "tmux": "worktree" }\n}\n',
    );
    expect((await loadConfig({ env: env() })).autoTmux).toBe('worktree');
  });

  test('config.jsonc — a trailing comma does not parse, and degrades to defaults', async () => {
    writeConfig('config.jsonc', '{\n  "auto": { "tmux": "worktree" },\n}\n');
    expect((await loadConfig({ env: env() })).autoTmux).toBeUndefined();
  });

  test('config.toml', async () => {
    writeConfig('config.toml', '[auto]\ntmux = "never"\n');
    expect((await loadConfig({ env: env() })).autoTmux).toBe('never');
  });

  test('config.yaml', async () => {
    writeConfig('config.yaml', 'auto:\n  tmux: always\n');
    expect((await loadConfig({ env: env() })).autoTmux).toBe('always');
  });

  test('json wins over toml when both exist — precedence is fixed, not readdir order', async () => {
    writeConfig('config.toml', '[auto]\ntmux = "never"\n');
    writeConfig('config.json', '{"auto":{"tmux":"always"}}');
    expect((await loadConfig({ env: env() })).autoTmux).toBe('always');
  });
});

describe('loadConfig — top-level fields', () => {
  test('noOobe: true', async () => {
    writeJson({ noOobe: true });
    expect((await loadConfig({ env: env() })).noOobe).toBe(true);
  });

  test('noOobe absent → false, so the interview runs', async () => {
    writeJson({ auto: { tmux: 'never' } });
    expect((await loadConfig({ env: env() })).noOobe).toBe(false);
  });

  test('noOobe: "yes" (a string) is not true — only the boolean counts', async () => {
    writeJson({ noOobe: 'yes' });
    expect((await loadConfig({ env: env() })).noOobe).toBe(false);
  });

  test('noopDir is returned verbatim; the caller expands ~', async () => {
    writeJson({ noopDir: '~/scratch/fnc' });
    expect((await loadConfig({ env: env() })).noopDir).toBe('~/scratch/fnc');
  });
});

describe('loadConfig — auto section', () => {
  test('auto.tmux = "always"', async () => {
    writeJson({ auto: { tmux: 'always' } });
    expect((await loadConfig({ env: env() })).autoTmux).toBe('always');
  });

  test('no auto section → undefined', async () => {
    writeJson({ context: { noticeThreshold: 1000 } });
    expect((await loadConfig({ env: env() })).autoTmux).toBeUndefined();
  });

  test('non-string auto.tmux → undefined (defensive; no validation to reject it)', async () => {
    writeJson({ auto: { tmux: 42 } });
    expect((await loadConfig({ env: env() })).autoTmux).toBeUndefined();
  });

  test('auto.handoff accepts "never" / "ask" / a number', async () => {
    writeJson({ auto: { handoff: 'never' } });
    expect((await loadConfig({ env: env() })).autoHandoff).toBe('never');
    writeJson({ auto: { handoff: 'ask' } });
    expect((await loadConfig({ env: env() })).autoHandoff).toBe('ask');
    writeJson({ auto: { handoff: 3 } });
    expect((await loadConfig({ env: env() })).autoHandoff).toBe('3');
  });

  test('auto.handoff of a nonsense type → undefined', async () => {
    writeJson({ auto: { handoff: { seconds: 3 } } });
    expect((await loadConfig({ env: env() })).autoHandoff).toBeUndefined();
  });

  test('auto.spawnCommand (camelCase, per the schema)', async () => {
    writeJson({ auto: { spawnCommand: 'ghostty -e {bin} {dest}' } });
    expect((await loadConfig({ env: env() })).autoSpawnCommand).toBe('ghostty -e {bin} {dest}');
  });

  test('a wrong-shaped auto section costs only auto — context still loads', async () => {
    writeJson({ auto: 'nope', context: { noticeThreshold: 4000 } });
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBeUndefined();
    expect(c.contextNoticeThreshold).toBe(4000);
  });
});

describe('loadConfig — claude.defaultArgs', () => {
  test('an array of strings passes through', async () => {
    writeJson({ claude: { defaultArgs: ['--chrome', '--brief'] } });
    expect((await loadConfig({ env: env() })).claudeDefaultArgs).toEqual(['--chrome', '--brief']);
  });

  test('non-string entries are dropped, the rest kept', async () => {
    writeJson({ claude: { defaultArgs: ['--chrome', 7, null, '--ide'] } });
    expect((await loadConfig({ env: env() })).claudeDefaultArgs).toEqual(['--chrome', '--ide']);
  });

  test('not an array → undefined', async () => {
    writeJson({ claude: { defaultArgs: '--chrome' } });
    expect((await loadConfig({ env: env() })).claudeDefaultArgs).toBeUndefined();
  });

  test('absent → undefined', async () => {
    writeJson({});
    expect((await loadConfig({ env: env() })).claudeDefaultArgs).toBeUndefined();
  });
});

describe('loadConfig — context.noticeThreshold', () => {
  test('positive number', async () => {
    writeJson({ context: { noticeThreshold: 120000 } });
    expect((await loadConfig({ env: env() })).contextNoticeThreshold).toBe(120000);
  });

  test('non-positive → undefined', async () => {
    writeJson({ context: { noticeThreshold: 0 } });
    expect((await loadConfig({ env: env() })).contextNoticeThreshold).toBeUndefined();
  });

  test('missing → undefined', async () => {
    writeJson({ context: {} });
    expect((await loadConfig({ env: env() })).contextNoticeThreshold).toBeUndefined();
  });
});

describe('loadConfig — context.noticeTiers + context.noticeRepeat', () => {
  test('valid tiers parsed, sorted ascending by `at`', async () => {
    writeJson({
      context: {
        noticeTiers: [
          { at: 150000, level: 'now' },
          { at: 100000, level: 'consider' },
        ],
      },
    });
    const c = await loadConfig({ env: env() });
    expect(c.contextNoticeLadder).toEqual({
      tiers: [
        { at: 100000, level: 'consider' },
        { at: 150000, level: 'now' },
      ],
    });
  });

  test('noticeRepeat parsed alongside tiers', async () => {
    writeJson({
      context: {
        noticeTiers: [{ at: 100000, level: 'plan' }],
        noticeRepeat: { every: 20000, level: 'urgent' },
      },
    });
    const c = await loadConfig({ env: env() });
    expect(c.contextNoticeLadder).toEqual({
      tiers: [{ at: 100000, level: 'plan' }],
      repeat: { every: 20000, level: 'urgent' },
    });
  });

  test('invalid entries are dropped (bad level, non-positive at)', async () => {
    const warnings: string[] = [];
    writeJson({
      context: {
        noticeTiers: [
          { at: 100000, level: 'bogus' },
          { at: 0, level: 'now' },
          { at: 120000, level: 'urgent' },
        ],
      },
    });
    const c = await loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(c.contextNoticeLadder).toEqual({ tiers: [{ at: 120000, level: 'urgent' }] });
    expect(warnings.length).toBe(2);
  });

  test('duplicate `at` collapses to one tier', async () => {
    writeJson({
      context: {
        noticeTiers: [
          { at: 100000, level: 'plan' },
          { at: 100000, level: 'urgent' },
        ],
      },
    });
    const c = await loadConfig({ env: env() });
    expect(c.contextNoticeLadder).toEqual({ tiers: [{ at: 100000, level: 'plan' }] });
  });

  test('explicitly empty tiers array with no repeat → disabled ladder', async () => {
    writeJson({ context: { noticeTiers: [] } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toEqual({ tiers: [] });
  });

  test('repeat with no tiers → empty tiers + repeat', async () => {
    writeJson({ context: { noticeRepeat: { every: 20000, level: 'now' } } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toEqual({
      tiers: [],
      repeat: { every: 20000, level: 'now' },
    });
  });

  test('no tier config at all → undefined (falls through to noticeThreshold)', async () => {
    writeJson({ context: { noticeThreshold: 100000 } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toBeUndefined();
  });
});

describe('loadConfig — percentage notice thresholds (#332)', () => {
  test('at = "94%" parses to a percent marker', async () => {
    writeJson({ context: { noticeTiers: [{ at: '94%', level: 'now' }] } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toEqual({
      tiers: [{ at: { pct: 94 }, level: 'now' }],
    });
  });

  test('every = "2.5%" parses to a fractional percent marker', async () => {
    writeJson({ context: { noticeRepeat: { every: '2.5%', level: 'urgent' } } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toEqual({
      tiers: [],
      repeat: { every: { pct: 2.5 }, level: 'urgent' },
    });
  });

  test('percentages above 100% are NOT rejected (auto-compact-disabled sessions)', async () => {
    writeJson({ context: { noticeTiers: [{ at: '140%', level: 'urgent' }] } });
    expect((await loadConfig({ env: env() })).contextNoticeLadder).toEqual({
      tiers: [{ at: { pct: 140 }, level: 'urgent' }],
    });
  });

  test('a non-numeric percent string is dropped with a warning', async () => {
    const warnings: string[] = [];
    writeJson({ context: { noticeTiers: [{ at: 'lots%', level: 'now' }] } });
    const c = await loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(c.contextNoticeLadder).toEqual({ tiers: [] });
    expect(warnings.length).toBe(1);
  });
});

describe('loadConfig — malformed notice config warns instead of dropping silently (#331)', () => {
  test('a bare-number noticeRepeat warns', async () => {
    const warnings: string[] = [];
    writeJson({ context: { noticeRepeat: 50000 } });
    await loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('noticeRepeat');
  });

  test('a repeat object missing `level` warns', async () => {
    const warnings: string[] = [];
    writeJson({ context: { noticeRepeat: { every: 20000 } } });
    await loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(warnings.length).toBe(1);
  });

  test('valid config emits NO warnings', async () => {
    const warnings: string[] = [];
    writeJson({
      context: {
        noticeTiers: [{ at: 100000, level: 'plan' }],
        noticeRepeat: { every: 20000, level: 'urgent' },
      },
    });
    await loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

describe('loadConfig — exec.env', () => {
  test('string values become the env map', async () => {
    writeJson({ exec: { env: { FOO: 'bar', BAZ: 'qux' } } });
    expect((await loadConfig({ env: env() })).execEnv).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('missing → undefined', async () => {
    writeJson({ exec: {} });
    expect((await loadConfig({ env: env() })).execEnv).toBeUndefined();
  });

  test('empty → empty map', async () => {
    writeJson({ exec: { env: {} } });
    expect((await loadConfig({ env: env() })).execEnv).toEqual({});
  });

  test('a non-string value skips that key only', async () => {
    writeJson({ exec: { env: { FOO: 'bar', N: 42 } } });
    expect((await loadConfig({ env: env() })).execEnv).toEqual({ FOO: 'bar' });
  });
});

describe('loadConfig — migration from the pre-restructure config.toml', () => {
  function writeLegacy(body: string): string {
    const dir = join(xdgConfigHome, 'fnclaude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    writeFileSync(path, body);
    return path;
  }

  test('the old TOML is read when nothing exists at the new location', async () => {
    writeLegacy('[auto]\ntmux = "worktree"\nhandoff = "ask"\n');
    const c = await loadConfig({ env: env() });
    expect(c.autoTmux).toBe('worktree');
    expect(c.autoHandoff).toBe('ask');
  });

  test('and is rewritten to config.json at the new location, with a $schema', async () => {
    writeLegacy('[auto]\ntmux = "worktree"\n');
    await loadConfig({ env: env() });
    const written = JSON.parse(readFileSync(join(fncDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written.$schema).toBe(
      'https://json.schemastore.org/rhombus-rocks-fnclaude-config.json',
    );
    expect(written.auto).toEqual({ tmux: 'worktree' });
  });

  test('snake_case keys become the camelCase the schema defines', async () => {
    writeLegacy(
      '[auto]\nspawn_command = "kitty {bin} {dest}"\n\n[context]\nnotice_threshold = 90000\n\n[[context.notice_tiers]]\nat = 100000\nlevel = "plan"\n',
    );
    const c = await loadConfig({ env: env() });
    expect(c.autoSpawnCommand).toBe('kitty {bin} {dest}');
    expect(c.contextNoticeThreshold).toBe(90000);
    expect(c.contextNoticeLadder).toEqual({ tiers: [{ at: 100000, level: 'plan' }] });

    const written = JSON.parse(readFileSync(join(fncDir, 'config.json'), 'utf8')) as {
      auto: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(written.auto.spawnCommand).toBe('kitty {bin} {dest}');
    expect(written.auto.spawn_command).toBeUndefined();
    expect(written.context.noticeThreshold).toBe(90000);
    expect(written.context.notice_threshold).toBeUndefined();
  });

  test('keys fnc does not read ride along rather than being dropped', async () => {
    writeLegacy('[name]\nmodel = "claude-haiku-4-5"\ntimeout = "3s"\n');
    await loadConfig({ env: env() });
    const written = JSON.parse(readFileSync(join(fncDir, 'config.json'), 'utf8')) as {
      name?: Record<string, unknown>;
    };
    expect(written.name).toEqual({ model: 'claude-haiku-4-5', timeout: '3s' });
  });

  test('a file at the new location wins — the old one is not consulted', async () => {
    writeLegacy('[auto]\ntmux = "worktree"\n');
    writeJson({ auto: { tmux: 'never' } });
    expect((await loadConfig({ env: env() })).autoTmux).toBe('never');
  });

  test('no old file either → defaults, and nothing is written', async () => {
    const writes: string[] = [];
    const c = await loadConfig({ env: env(), write: (p) => writes.push(p) });
    expect(c.autoTmux).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test('a write failure is not fatal — the migrated values still load', async () => {
    writeLegacy('[auto]\ntmux = "always"\n');
    const c = await loadConfig({
      env: env(),
      write: () => {
        throw new Error('read-only filesystem');
      },
    });
    expect(c.autoTmux).toBe('always');
  });
});
