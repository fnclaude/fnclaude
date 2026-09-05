/**
 * Unit tests for the rhombus.rocks path layout.
 *
 * These are one-line functions, but they encode the contract in
 * specs/rhombus-rocks-config.md § Locations — the paths fngit and the
 * worktree-paths plugin are being written against in parallel. A silent drift
 * here (a missing `rhombus.rocks` segment, `fnclaude` in the wrong position)
 * would not fail any other test in this repo and would only show up as three
 * tools disagreeing about where the config lives.
 *
 * Also pinned: the format precedence `findConfigFile` applies, so two config
 * files in one directory resolve the same way on every machine rather than by
 * readdir order.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultNoopDir,
  findConfigFile,
  fncConfigDir,
  fncConfigWritePath,
  fncStateDir,
  legacyFncConfigPath,
  promptOverridesDir,
  sharedConfigDir,
} from '../../src/config/paths';

const HOME = '/home/tom';
const XDG = { home: HOME, xdgConfigHome: '/xdg/config', xdgStateHome: '/xdg/state' };
const NO_XDG = { home: HOME, xdgConfigHome: undefined, xdgStateHome: undefined };

describe('the documented layout', () => {
  test('with XDG set', () => {
    expect(sharedConfigDir(XDG)).toBe('/xdg/config/rhombus.rocks');
    expect(fncConfigDir(XDG)).toBe('/xdg/config/rhombus.rocks/fnclaude');
    expect(fncConfigWritePath(XDG)).toBe('/xdg/config/rhombus.rocks/fnclaude/config.json');
    expect(promptOverridesDir(XDG)).toBe('/xdg/config/rhombus.rocks/fnclaude/prompts');
    expect(defaultNoopDir(XDG)).toBe('/xdg/config/rhombus.rocks/fnclaude/noop');
    expect(fncStateDir(XDG)).toBe('/xdg/state/rhombus.rocks/fnclaude');
  });

  test('with XDG unset, the spec defaults apply', () => {
    expect(sharedConfigDir(NO_XDG)).toBe('/home/tom/.config/rhombus.rocks');
    expect(fncConfigDir(NO_XDG)).toBe('/home/tom/.config/rhombus.rocks/fnclaude');
    expect(fncStateDir(NO_XDG)).toBe('/home/tom/.local/state/rhombus.rocks/fnclaude');
  });

  test('an empty-string XDG var is treated as unset, per the XDG spec', () => {
    const empty = { home: HOME, xdgConfigHome: '', xdgStateHome: '' };
    expect(fncConfigDir(empty)).toBe('/home/tom/.config/rhombus.rocks/fnclaude');
    expect(fncStateDir(empty)).toBe('/home/tom/.local/state/rhombus.rocks/fnclaude');
  });

  test('the migration source is the OLD location, with no brand directory', () => {
    expect(legacyFncConfigPath(XDG)).toBe('/xdg/config/fnclaude/config.toml');
    expect(legacyFncConfigPath(NO_XDG)).toBe('/home/tom/.config/fnclaude/config.toml');
  });

  test('the fnc config sits UNDER the shared one, not beside it', () => {
    // fngit and the plugin read the shared file; fnc reads the nested one.
    // Getting this inverted would make fnc's keys land in fngit's file.
    expect(fncConfigDir(XDG).startsWith(`${sharedConfigDir(XDG)}/`)).toBe(true);
  });
});

describe('findConfigFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fnc-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('nothing there → null', () => {
    expect(findConfigFile(dir)).toBeNull();
  });

  test('finds each accepted extension', () => {
    for (const base of ['config.json', 'config.jsonc', 'config.toml', 'config.yaml']) {
      const d = mkdtempSync(join(tmpdir(), 'fnc-paths-one-'));
      writeFileSync(join(d, base), '');
      expect(findConfigFile(d)).toBe(join(d, base));
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('precedence is json > jsonc > toml > yaml, regardless of creation order', () => {
    writeFileSync(join(dir, 'config.yaml'), '');
    writeFileSync(join(dir, 'config.toml'), '');
    expect(findConfigFile(dir)).toBe(join(dir, 'config.toml'));
    writeFileSync(join(dir, 'config.jsonc'), '');
    expect(findConfigFile(dir)).toBe(join(dir, 'config.jsonc'));
    writeFileSync(join(dir, 'config.json'), '');
    expect(findConfigFile(dir)).toBe(join(dir, 'config.json'));
  });

  test('a directory named config.json is not a config file', () => {
    mkdirSync(join(dir, 'config.json'));
    writeFileSync(join(dir, 'config.toml'), '');
    expect(findConfigFile(dir)).toBe(join(dir, 'config.toml'));
  });

  test('an unrecognised extension is ignored', () => {
    writeFileSync(join(dir, 'config.ini'), '');
    writeFileSync(join(dir, 'config.json5'), '');
    expect(findConfigFile(dir)).toBeNull();
  });
});
