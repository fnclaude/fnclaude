/**
 * Unit tests for the config writer.
 *
 * Two properties matter and neither is obvious from the call site:
 *
 *   - **Merge, don't replace.** The OOBE writes each answer the moment it is
 *     given, which is what makes an interrupted wizard resumable. A writer
 *     that replaced the document would erase every previous answer on the
 *     second write, and erase hand-added keys the schema doesn't cover.
 *   - **`$schema` is always present and first.** It is what gives an editor
 *     completion on a file the wizard created, and a user opening the file
 *     should see what it conforms to before anything else.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeConfig, writeFncConfig } from '../../src/config/write';

const SCHEMA_URL = 'https://json.schemastore.org/rhombus-rocks-fnclaude-config.json';

let tmpRoot: string;
let path: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-write-'));
  path = join(tmpRoot, 'nested', 'config.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('mergeConfig', () => {
  test('nested objects merge key by key', () => {
    expect(mergeConfig({ auto: { tmux: 'never', handoff: 'ask' } }, { auto: { tmux: 'always' } })).toEqual(
      { auto: { tmux: 'always', handoff: 'ask' } },
    );
  });

  test('arrays replace wholesale — defaultArgs is a value, not a namespace', () => {
    expect(
      mergeConfig({ claude: { defaultArgs: ['--chrome', '--brief'] } }, { claude: { defaultArgs: ['--ide'] } }),
    ).toEqual({ claude: { defaultArgs: ['--ide'] } });
  });

  test('scalars replace', () => {
    expect(mergeConfig({ noOobe: false }, { noOobe: true })).toEqual({ noOobe: true });
  });

  test('an object replacing a scalar (and vice versa) replaces rather than merging', () => {
    expect(mergeConfig({ auto: 'nonsense' }, { auto: { tmux: 'never' } })).toEqual({
      auto: { tmux: 'never' },
    });
    expect(mergeConfig({ auto: { tmux: 'never' } }, { auto: 'nonsense' })).toEqual({
      auto: 'nonsense',
    });
  });

  test('an explicit undefined deletes the key', () => {
    expect(mergeConfig({ noopDir: '/x', noOobe: true }, { noopDir: undefined })).toEqual({
      noOobe: true,
    });
  });

  test('neither input is mutated', () => {
    const base = { auto: { tmux: 'never' } };
    const patch = { auto: { handoff: 'ask' } };
    mergeConfig(base, patch);
    expect(base).toEqual({ auto: { tmux: 'never' } });
    expect(patch).toEqual({ auto: { handoff: 'ask' } });
  });
});

describe('writeFncConfig', () => {
  test('creates the directory tree and writes JSON with $schema first', () => {
    writeFncConfig(path, { noOobe: true });
    const doc = read();
    expect(doc.$schema).toBe(SCHEMA_URL);
    expect(Object.keys(doc)[0]).toBe('$schema');
    expect(doc.noOobe).toBe(true);
  });

  test('a second write preserves the first — this is what makes the wizard resumable', () => {
    writeFncConfig(path, { auto: { tmux: 'always' } });
    writeFncConfig(path, { auto: { handoff: '3' } });
    writeFncConfig(path, { noopDir: '~/scratch' });
    expect(read()).toEqual({
      $schema: SCHEMA_URL,
      auto: { tmux: 'always', handoff: '3' },
      noopDir: '~/scratch',
    });
  });

  test('keys the schema does not describe survive a write', () => {
    mkdirSync(join(tmpRoot, 'nested'), { recursive: true });
    writeFileSync(path, JSON.stringify({ somethingCustom: { a: 1 } }));
    writeFncConfig(path, { noOobe: true });
    expect(read().somethingCustom).toEqual({ a: 1 });
  });

  test('an unparseable existing file is replaced rather than throwing', () => {
    mkdirSync(join(tmpRoot, 'nested'), { recursive: true });
    writeFileSync(path, 'not json at all {{{');
    writeFncConfig(path, { noOobe: true });
    expect(read().noOobe).toBe(true);
  });

  test('a stale $schema is rewritten to the current URL, not duplicated', () => {
    mkdirSync(join(tmpRoot, 'nested'), { recursive: true });
    writeFileSync(path, JSON.stringify({ $schema: 'https://example.invalid/old.json', noOobe: true }));
    writeFncConfig(path, { noopDir: '/x' });
    const doc = read();
    expect(doc.$schema).toBe(SCHEMA_URL);
    expect(Object.keys(doc).filter((k) => k === '$schema').length).toBe(1);
  });

  test('the file ends with a newline', () => {
    writeFncConfig(path, { noOobe: true });
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
  });
});
