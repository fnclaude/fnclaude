import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUILTIN_HOST_ALIASES,
  hostAliasesUserPath,
  loadHostAliases,
  mergeHostAliases,
  missingHostShortError,
  readHostAliasesFile,
} from '../src/hostAliases.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fnclaude-ha-'));
}

describe('loadHostAliases', () => {
  test('BUILTIN_HOST_ALIASES covers the canonical 4 forges', () => {
    // Pin the builtin set explicitly so changes are deliberate (CHANGELOG-
    // worthy) and the npm-install path always has these without a user file.
    expect(BUILTIN_HOST_ALIASES).toEqual({
      'github.com': 'gh',
      'gitlab.com': 'gl',
      'bitbucket.org': 'bb',
      'codeberg.org': 'cb',
    });
  });

  test('returns bundled builtin aliases when no user file exists', () => {
    const home = tmp();
    const got = loadHostAliases(home);
    expect(got.aliases['github.com']).toBe('gh');
    expect(got.aliases['gitlab.com']).toBe('gl');
    expect(got.aliases['bitbucket.org']).toBe('bb');
    expect(got.aliases['codeberg.org']).toBe('cb');
    expect(got.warnings).toEqual([]);
  });

  test('user file overrides builtin per key', () => {
    const home = tmp();
    const userPath = hostAliasesUserPath(home);
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(userPath, '{"github.com":"ghd"}');
    const got = loadHostAliases(home);
    // user override wins
    expect(got.aliases['github.com']).toBe('ghd');
    // other builtins still present
    expect(got.aliases['gitlab.com']).toBe('gl');
    expect(got.aliases['bitbucket.org']).toBe('bb');
    expect(got.aliases['codeberg.org']).toBe('cb');
    expect(got.warnings).toEqual([]);
  });

  test('user file can add hosts not in builtins', () => {
    const home = tmp();
    const userPath = hostAliasesUserPath(home);
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(userPath, '{"git.example.com":"ex"}');
    const got = loadHostAliases(home);
    expect(got.aliases['git.example.com']).toBe('ex');
    // builtins still present
    expect(got.aliases['github.com']).toBe('gh');
  });
});

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

  test('later file overrides earlier (later wins per key)', () => {
    const dir = tmp();
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, '{"github.com":"gh","gitlab.com":"gl"}');
    writeFileSync(b, '{"github.com":"ghub","bitbucket.org":"bb"}');
    const got = mergeHostAliases([a, b]);
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

  test('mentions user path only (not system path)', () => {
    const e = missingHostShortError('any', '/home/u');
    expect(e.message).toContain(hostAliasesUserPath('/home/u'));
    expect(e.message).not.toContain('/usr/share/fnrhombus');
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
