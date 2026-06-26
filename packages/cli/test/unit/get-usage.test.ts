/**
 * Unit tests for the `get_usage` MCP handler (#171).
 *
 * The handler reads a `SessionUsage` (per-model tokens + cost, latest-turn
 * context size) and shapes it into the #171 response:
 *
 *   { session: { cost_usd, by_model: { <model>: { input, output,
 *       cache_read, cache_write, cost } } },
 *     limits, context: { used, model } }
 *
 * The reader seam (`readUsage`) is injectable, so these tests feed a fixture
 * `SessionUsage` without touching a real `~/.claude`. `limits` MUST be null
 * in v1 (header invisibility — the anthropic-ratelimit-unified-* headers
 * never reach fnc's pty wrapper).
 */

import { describe, expect, test } from 'bun:test';

import {
  buildUsageResponse,
  createGetUsageHandler,
} from '../../src/mcp/handlers/get-usage';
import type { SessionUsage } from '../../src/usage/session-usage';
import type { WireRequest } from '../../src/mcp/wire';

const VALID_SID = '12345678-1234-1234-1234-123456789abc';

// Two-model fixture with known numbers + a known latest-turn context.
const FIXTURE: SessionUsage = {
  perModel: {
    'claude-opus-4-8': {
      tokens: { input: 107, output: 53, cacheCreation: 211, cacheRead: 1500 },
      costUsd: 0.123,
    },
    'claude-sonnet-4-7': {
      tokens: { input: 10, output: 5, cacheCreation: 20, cacheRead: 100 },
      costUsd: 0.004,
    },
  },
  totalTokens: { input: 117, output: 58, cacheCreation: 231, cacheRead: 1600 },
  totalCostUsd: 0.127,
  context: { tokens: 518, model: 'claude-opus-4-8' },
};

describe('buildUsageResponse — #171 shape', () => {
  test('session.by_model maps token categories + cost per model', () => {
    const r = buildUsageResponse(FIXTURE);
    expect(r.session.by_model['claude-opus-4-8']).toEqual({
      input: 107,
      output: 53,
      cache_read: 1500,
      cache_write: 211,
      cost: 0.123,
    });
    expect(r.session.by_model['claude-sonnet-4-7']).toEqual({
      input: 10,
      output: 5,
      cache_read: 100,
      cache_write: 20,
      cost: 0.004,
    });
  });

  test('session.cost_usd is the session-wide total', () => {
    expect(buildUsageResponse(FIXTURE).session.cost_usd).toBe(0.127);
  });

  test('context.used = latest-turn tokens, context.model = latest model', () => {
    const r = buildUsageResponse(FIXTURE);
    expect(r.context.used).toBe(518);
    expect(r.context.model).toBe('claude-opus-4-8');
  });

  test('limits is null in v1 (headers invisible to pty wrapper)', () => {
    expect(buildUsageResponse(FIXTURE).limits).toBeNull();
  });

  test('action tag is "usage"', () => {
    expect(buildUsageResponse(FIXTURE).action).toBe('usage');
  });

  test('empty session → zero cost, empty by_model, null context', () => {
    const empty: SessionUsage = {
      perModel: {},
      totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      totalCostUsd: 0,
      context: null,
    };
    const r = buildUsageResponse(empty);
    expect(r.session.cost_usd).toBe(0);
    expect(r.session.by_model).toEqual({});
    expect(r.context).toEqual({ used: null, model: null });
    expect(r.limits).toBeNull();
  });
});

describe('createGetUsageHandler', () => {
  test('valid session_id → #171 response from injected reader', async () => {
    let seenCwd = '';
    let seenSid = '';
    const handler = createGetUsageHandler({
      launchCWD: '/some/launch/cwd',
      readUsage: (cwd, sid) => {
        seenCwd = cwd;
        seenSid = sid;
        return FIXTURE;
      },
    });

    const res = (await handler({ op: 'get_usage', session_id: VALID_SID } as WireRequest)) as Record<
      string,
      unknown
    >;

    // Reader was called with bound cwd + per-call sid.
    expect(seenCwd).toBe('/some/launch/cwd');
    expect(seenSid).toBe(VALID_SID);

    // session populated with correct per-model cost/tokens.
    const session = res.session as { cost_usd: number; by_model: Record<string, unknown> };
    expect(session.cost_usd).toBe(0.127);
    expect(session.by_model['claude-opus-4-8']).toEqual({
      input: 107,
      output: 53,
      cache_read: 1500,
      cache_write: 211,
      cost: 0.123,
    });

    // context populated.
    expect(res.context).toEqual({ used: 518, model: 'claude-opus-4-8' });

    // limits === null.
    expect(res.limits).toBeNull();
  });

  test('missing session_id → error, reader never called', async () => {
    let called = false;
    const handler = createGetUsageHandler({
      launchCWD: '/x',
      readUsage: () => {
        called = true;
        return FIXTURE;
      },
    });
    const res = await handler({ op: 'get_usage' } as WireRequest);
    expect(res.action).toBe('error');
    expect(called).toBe(false);
  });

  test('malformed (non-UUID) session_id → error', async () => {
    const handler = createGetUsageHandler({
      launchCWD: '/x',
      readUsage: () => FIXTURE,
    });
    const res = await handler({ op: 'get_usage', session_id: 'not-a-uuid' } as WireRequest);
    expect(res.action).toBe('error');
  });
});
