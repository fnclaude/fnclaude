import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadHostAliases } from '../../src/repo/host-aliases.ts';

let tmpRoot: string;
let systemPath: string;
let userPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-host-aliases-'));
  systemPath = join(tmpRoot, 'system.json');
  userPath = join(tmpRoot, 'user.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSystem(content: string) {
  writeFileSync(systemPath, content);
}
function writeUser(content: string) {
  writeFileSync(userPath, content);
}

describe('loadHostAliases — file presence', () => {
  test('both files missing → empty', () => {
    expect(loadHostAliases({ systemPath, userPath })).toEqual({});
  });

  test('only system file → reads it', () => {
    writeSystem(JSON.stringify({ 'github.com': 'gh' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': 'gh' });
  });

  test('only user file → reads it', () => {
    writeUser(JSON.stringify({ 'gitlab.com': 'gl' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'gitlab.com': 'gl' });
  });

  test('both files: user wins on conflict, both keys present otherwise', () => {
    writeSystem(JSON.stringify({ 'github.com': 'gh-sys', 'gitlab.com': 'gl' }));
    writeUser(JSON.stringify({ 'github.com': 'gh-user', 'bitbucket.org': 'bb' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({
      'github.com': 'gh-user',
      'gitlab.com': 'gl',
      'bitbucket.org': 'bb',
    });
  });
});

describe('loadHostAliases — malformed inputs degrade silently', () => {
  test('malformed JSON in system → drops that file, keeps user', () => {
    writeSystem('{ not valid json');
    writeUser(JSON.stringify({ 'github.com': 'gh' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': 'gh' });
  });

  test('malformed JSON in user → drops that file, keeps system', () => {
    writeSystem(JSON.stringify({ 'github.com': 'gh' }));
    writeUser('}{}{');
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': 'gh' });
  });

  test('non-object root (array) → dropped', () => {
    writeSystem(JSON.stringify(['github.com', 'gh']));
    writeUser(JSON.stringify({ 'gitlab.com': 'gl' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'gitlab.com': 'gl' });
  });

  test('non-object root (string) → dropped', () => {
    writeSystem(JSON.stringify('hello'));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({});
  });

  test('null root → dropped', () => {
    writeSystem('null');
    expect(loadHostAliases({ systemPath, userPath })).toEqual({});
  });

  test('individual non-string value: drop that key, keep others', () => {
    writeSystem(JSON.stringify({ 'github.com': 'gh', 'gitlab.com': 42, 'bitbucket.org': 'bb' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({
      'github.com': 'gh',
      'bitbucket.org': 'bb',
    });
  });

  test('empty object → empty result', () => {
    writeSystem('{}');
    writeUser('{}');
    expect(loadHostAliases({ systemPath, userPath })).toEqual({});
  });
});

describe('loadHostAliases — edge cases', () => {
  test('paths that resolve to directories instead of files → silent skip', () => {
    mkdirSync(systemPath);
    writeUser(JSON.stringify({ 'github.com': 'gh' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': 'gh' });
  });

  test('alias value is empty string: kept (user opted in to empty alias)', () => {
    writeSystem(JSON.stringify({ 'github.com': '' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': '' });
  });

  test('alias with whitespace is preserved verbatim (loader does not normalize)', () => {
    writeSystem(JSON.stringify({ 'github.com': '  gh  ' }));
    expect(loadHostAliases({ systemPath, userPath })).toEqual({ 'github.com': '  gh  ' });
  });
});
