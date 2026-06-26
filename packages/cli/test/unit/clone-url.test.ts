import { describe, expect, test } from 'bun:test';

import { parseCloneUrl } from '../../src/repo/clone-url';

describe('parseCloneUrl', () => {
  test('parses the canonical https .git form', () => {
    expect(parseCloneUrl('https://github.com/rhombus-toolkit/ioc.git')).toEqual({
      host: 'github.com',
      owner: 'rhombus-toolkit',
      name: 'ioc',
    });
  });

  test('parses without the .git suffix', () => {
    expect(parseCloneUrl('https://github.com/anthropics/cool')).toEqual({
      host: 'github.com',
      owner: 'anthropics',
      name: 'cool',
    });
  });

  test('parses an enterprise host', () => {
    expect(parseCloneUrl('https://git.example.com/team/proj.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      name: 'proj',
    });
  });

  test('returns null for a non-url', () => {
    expect(parseCloneUrl('not a url')).toBeNull();
    expect(parseCloneUrl('')).toBeNull();
  });

  test('returns null when owner or name is missing', () => {
    expect(parseCloneUrl('https://github.com/onlyowner')).toBeNull();
  });
});
