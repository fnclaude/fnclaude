import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_ALIASES_SYSTEM_PATH,
  hostAliasesUserPath,
  mergeHostAliases,
  missingHostShortError,
  readHostAliasesFile,
} from '../src/hostAliases.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fnclaude-ha-'));
}

describe('mergeHostAliases', () => {
  test('empty paths → empty map + no warnings', () => {
    const got = mergeHostAliases([]);
    expect(Object.keys(got.aliases).length).toBe(0);
    expect(got.warnings).toEqual([]);
  });

  test('single file loaded', () => {
    const dir = tmp();
    const p = join(dir, 'a.json');
    writeFileSync(p, '{"github.com":"gh","gitlab.com":"gl"}');
    const got = mergeHostAliases([p]);
    expect(got.aliases['github.com']).toBe('gh');
    expect(got.aliases['gitlab.com']).toBe('gl');
    expect(got.warnings).toEqual([]);
  });

  test('user overrides system (later wins per key)', () => {
    const dir = tmp();
    const sys = join(dir, 'sys.json');
    const usr = join(dir, 'usr.json');
    writeFileSync(sys, '{"github.com":"gh","gitlab.com":"gl"}');
    writeFileSync(usr, '{"github.com":"ghub","bitbucket.org":"bb"}');
    const got = mergeHostAliases([sys, usr]);
    expect(got.aliases['github.com']).toBe('ghub');
    expect(got.aliases['gitlab.com']).toBe('gl');
    expect(got.aliases['bitbucket.org']).toBe('bb');
  });

  test('missing file is skipped silently (no warning)', () => {
    const dir = tmp();
    const got = mergeHostAliases([join(dir, 'nope.json')]);
    expect(Object.keys(got.aliases).length).toBe(0);
    expect(got.warnings).toEqual([]);
  });

  test('malformed file produces a warning, later good file still loads', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not valid');
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"github.com":"gh"}');
    const got = mergeHostAliases([bad, good]);
    expect(got.aliases['github.com']).toBe('gh');
    expect(got.warnings.length).toBe(1);
    expect(got.warnings[0]).toContain(bad);
    expect(got.warnings[0]).toContain('malformed');
  });
});

describe('readHostAliasesFile', () => {
  test('non-string values dropped (number, null)', () => {
    const dir = tmp();
    const p = join(dir, 'mixed.json');
    writeFileSync(
      p,
      '{"github.com":"gh","gitlab.com":42,"bitbucket.org":null}',
    );
    const got = readHostAliasesFile(p);
    expect(got.aliases['github.com']).toBe('gh');
    expect('gitlab.com' in got.aliases).toBe(false);
    expect('bitbucket.org' in got.aliases).toBe(false);
    expect(got.warning).toBeNull();
  });

  test('object root only — array root → empty with warning', () => {
    const dir = tmp();
    const p = join(dir, 'arr.json');
    writeFileSync(p, '["github.com","gh"]');
    const got = readHostAliasesFile(p);
    expect(Object.keys(got.aliases).length).toBe(0);
    expect(got.warning).not.toBeNull();
    expect(got.warning).toContain('non-object root');
  });
});

describe('missingHostShortError', () => {
  test('mentions host', () => {
    const e = missingHostShortError('github.example.com', '/home/u');
    expect(e.message).toContain('github.example.com');
  });

  test('mentions both system and user paths', () => {
    const e = missingHostShortError('any', '/home/u');
    expect(e.message).toContain(HOST_ALIASES_SYSTEM_PATH);
    expect(e.message).toContain(hostAliasesUserPath('/home/u'));
  });

  test('includes JSON example', () => {
    const e = missingHostShortError('any', '/home/u');
    expect(e.message).toContain('"github.com": "gh"');
  });
});

describe('hostAliasesUserPath', () => {
  test('expands under given home', () => {
    expect(hostAliasesUserPath('/home/tom')).toBe(
      '/home/tom/.local/share/fnrhombus/host-aliases.json',
    );
  });
});
