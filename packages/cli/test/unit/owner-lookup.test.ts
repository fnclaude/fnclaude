import { describe, expect, test } from 'bun:test';

import { findOwner, type GhApiCall, type GhApiResult } from '../../src/repo/owner-lookup.ts';

function makeGhApi(table: Record<string, GhApiResult>): GhApiCall {
  return async (path: string) => {
    return table[path] ?? { ok: false, status: 404, error: 'not in mock table' };
  };
}

describe('findOwner — happy path', () => {
  test('user owns the repo → user login wins', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: 'fnrhombus\n' },
      '/user/orgs': { ok: true, body: 'anthropics\nopenai\n' },
      'repos/fnrhombus/myrepo': { ok: true, body: '{"id":1}' },
    });
    const r = await findOwner({ name: 'myrepo', ghApi });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.owner).toBe('fnrhombus');
  });

  test('user does not own → first matching org wins', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: 'fnrhombus\n' },
      '/user/orgs': { ok: true, body: 'anthropics\nopenai\n' },
      'repos/anthropics/coolthing': { ok: true, body: '{"id":2}' },
    });
    const r = await findOwner({ name: 'coolthing', ghApi });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.owner).toBe('anthropics');
  });

  test('owner check order is user → orgs (in API order)', async () => {
    const calls: string[] = [];
    const ghApi: GhApiCall = async (path: string) => {
      calls.push(path);
      if (path === 'user') return { ok: true, body: 'me\n' };
      if (path === '/user/orgs') return { ok: true, body: 'orgA\norgB\n' };
      if (path === 'repos/orgB/x') return { ok: true, body: '{}' };
      return { ok: false, status: 404, error: 'not found' };
    };
    const r = await findOwner({ name: 'x', ghApi });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.owner).toBe('orgB');
    // Should have checked me, then orgA, then orgB in that order
    expect(calls).toEqual([
      'user',
      '/user/orgs',
      'repos/me/x',
      'repos/orgA/x',
      'repos/orgB/x',
    ]);
  });
});

describe('findOwner — failure paths', () => {
  test('gh api user fails → reason=gh-failed', async () => {
    const ghApi = makeGhApi({
      'user': { ok: false, status: 401, error: 'not logged in' },
    });
    const r = await findOwner({ name: 'x', ghApi });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('gh-failed');
  });

  test('gh api /user/orgs fails → continue with user only', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: 'me\n' },
      '/user/orgs': { ok: false, status: 500, error: 'srv err' },
      'repos/me/x': { ok: true, body: '{}' },
    });
    const r = await findOwner({ name: 'x', ghApi });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.owner).toBe('me');
  });

  test('no owner matches → reason=not-found', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: 'me\n' },
      '/user/orgs': { ok: true, body: 'orgA\norgB\n' },
      // all repos/... default to 404 via makeGhApi fallback
    });
    const r = await findOwner({ name: 'nothere', ghApi });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  test('user with empty stdout → reason=gh-failed (no candidates)', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: '\n' },
      '/user/orgs': { ok: false, status: 500, error: 'srv err' },
    });
    const r = await findOwner({ name: 'x', ghApi });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('gh-failed');
  });
});

describe('findOwner — parsing', () => {
  test('orgs body with blank lines and CR are filtered', async () => {
    const ghApi = makeGhApi({
      'user': { ok: true, body: 'me\n' },
      '/user/orgs': { ok: true, body: '\norgA\r\n\norgB\n\n' },
      'repos/orgB/x': { ok: true, body: '{}' },
    });
    const r = await findOwner({ name: 'x', ghApi });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.owner).toBe('orgB');
  });
});
