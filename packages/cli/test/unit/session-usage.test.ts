/**
 * Unit tests for `session-usage` — the shared reader that parses a
 * session JSONL into per-model token totals, per-model + total cost, and
 * the current context size (latest assistant turn's tokens).
 *
 * The reader's file-read seam is injectable: `computeSessionUsage` takes
 * raw JSONL *content* (so these tests never touch a real `~/.claude` dir),
 * and `readSessionUsage(cwd, sid)` is the on-disk convenience wrapper that
 * resolves the path via `sessionJSONLPath` and feeds the content through.
 *
 * Fixture: a hand-authored 3-assistant-turn session across two models with
 * known token numbers, so every assertion (token sums, cost = pricing ×
 * tokens, context = latest turn) is arithmetic against constants defined
 * here — independent of the module's own pricing table where it matters.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MODEL_PRICING,
  computeSessionUsage,
  readSessionUsage,
} from '../../src/usage/session-usage';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function assistantTurn(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model, usage },
  });
}

// Two-model, three-turn session.
//   Turn 1 (opus):   in=100 out=50  cacheCreate=200 cacheRead=1000
//   Turn 2 (sonnet): in=10  out=5   cacheCreate=20  cacheRead=100
//   Turn 3 (opus):   in=7   out=3   cacheCreate=11  cacheRead=500   ← latest
const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-4-7';

const FIXTURE_LINES = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  assistantTurn(OPUS, {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 1000,
  }),
  assistantTurn(SONNET, {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 100,
  }),
  assistantTurn(OPUS, {
    input_tokens: 7,
    output_tokens: 3,
    cache_creation_input_tokens: 11,
    cache_read_input_tokens: 500,
  }),
];
const FIXTURE = FIXTURE_LINES.join('\n');

// Expected per-model token sums.
const EXPECT_OPUS = { input: 107, output: 53, cacheCreation: 211, cacheRead: 1500 };
const EXPECT_SONNET = { input: 10, output: 5, cacheCreation: 20, cacheRead: 100 };

// ─────────────────────────────────────────────────────────────────────────────
// computeSessionUsage — token totals
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSessionUsage — token totals', () => {
  test('per-model input/output/cache token sums across the session', () => {
    const u = computeSessionUsage(FIXTURE);

    const opus = u.perModel[OPUS];
    expect(opus).toBeDefined();
    expect(opus!.tokens).toEqual(EXPECT_OPUS);

    const sonnet = u.perModel[SONNET];
    expect(sonnet).toBeDefined();
    expect(sonnet!.tokens).toEqual(EXPECT_SONNET);
  });

  test('session-wide token totals are the sum across models', () => {
    const u = computeSessionUsage(FIXTURE);
    expect(u.totalTokens).toEqual({
      input: EXPECT_OPUS.input + EXPECT_SONNET.input,
      output: EXPECT_OPUS.output + EXPECT_SONNET.output,
      cacheCreation: EXPECT_OPUS.cacheCreation + EXPECT_SONNET.cacheCreation,
      cacheRead: EXPECT_OPUS.cacheRead + EXPECT_SONNET.cacheRead,
    });
  });

  test('user / non-assistant records contribute no tokens', () => {
    const u = computeSessionUsage(FIXTURE);
    // Only two model keys despite the leading user record.
    expect(Object.keys(u.perModel).sort()).toEqual([OPUS, SONNET].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSessionUsage — cost
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSessionUsage — cost', () => {
  function expectedCost(
    model: string,
    t: { input: number; output: number; cacheCreation: number; cacheRead: number },
  ): number {
    const p = MODEL_PRICING[model];
    expect(p).toBeDefined();
    return (
      (t.input * p!.inputPerMtok +
        t.output * p!.outputPerMtok +
        t.cacheCreation * p!.cacheWritePerMtok +
        t.cacheRead * p!.cacheReadPerMtok) /
      1_000_000
    );
  }

  test('opus cost matches a pinned dollar figure (catches a wrong pricing constant)', () => {
    // Independent of MODEL_PRICING: opus tokens are in=107 out=53
    // cacheCreate=211 cacheRead=1500, priced at $15/$75/$18.75/$1.50 per Mtok.
    //   107*15 + 53*75 + 211*18.75 + 1500*1.50 = 1605 + 3975 + 3956.25 + 2250
    //   = 11786.25 (per Mtok) → / 1e6 = 0.01178625 USD
    const u = computeSessionUsage(FIXTURE);
    expect(u.perModel[OPUS]!.costUsd).toBeCloseTo(0.01178625, 10);
  });

  test('per-model cost = tokens × pricing table / 1e6', () => {
    const u = computeSessionUsage(FIXTURE);
    expect(u.perModel[OPUS]!.costUsd).toBeCloseTo(expectedCost(OPUS, EXPECT_OPUS), 10);
    expect(u.perModel[SONNET]!.costUsd).toBeCloseTo(expectedCost(SONNET, EXPECT_SONNET), 10);
  });

  test('session total cost = sum of per-model costs', () => {
    const u = computeSessionUsage(FIXTURE);
    const expected =
      expectedCost(OPUS, EXPECT_OPUS) + expectedCost(SONNET, EXPECT_SONNET);
    expect(u.totalCostUsd).toBeCloseTo(expected, 10);
  });

  test('unknown model contributes tokens but zero cost', () => {
    const content = [
      assistantTurn('mystery-model-9000', {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(u.perModel['mystery-model-9000']!.tokens.input).toBe(1000);
    expect(u.perModel['mystery-model-9000']!.costUsd).toBe(0);
    expect(u.totalCostUsd).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSessionUsage — context size
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSessionUsage — context size', () => {
  test('context = latest assistant turn input + cache tokens', () => {
    const u = computeSessionUsage(FIXTURE);
    // Latest turn is opus turn 3: in=7, cacheCreate=11, cacheRead=500.
    expect(u.context.tokens).toBe(7 + 11 + 500);
    expect(u.context.model).toBe(OPUS);
  });

  test('context tracks the LAST assistant turn even when an earlier turn is larger', () => {
    const content = [
      assistantTurn(OPUS, {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 999_999,
      }),
      assistantTurn(SONNET, {
        input_tokens: 1,
        output_tokens: 0,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      }),
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(u.context.tokens).toBe(1 + 2 + 3);
    expect(u.context.model).toBe(SONNET);
  });

  test('no assistant turns → context is null', () => {
    const u = computeSessionUsage(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    );
    expect(u.context).toBeNull();
  });

  test('a trailing synthetic all-zero record does NOT clobber context', () => {
    // Claude writes a `model: "<synthetic>"` assistant record (all-zero usage)
    // for interrupted / partial turns. Letting one overwrite `context` would
    // drop the running size to 0 and make the context monitor re-arm its
    // watermark as if a /compact had happened (issue #283). Context must stay
    // the latest REAL turn's value.
    const content = [
      assistantTurn(OPUS, {
        input_tokens: 150_000,
        output_tokens: 10,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 3_800,
      }),
      assistantTurn('<synthetic>', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(u.context!.tokens).toBe(150_000 + 5_000 + 3_800);
    expect(u.context!.model).toBe(OPUS);
  });

  test('a trailing real-model all-zero record does NOT clobber context', () => {
    // The guard isn't keyed on the `<synthetic>` model alone: any record whose
    // effective context tokens (input + cacheCreation + cacheRead) sum to 0
    // carries no usable reading and must not overwrite the real turn.
    const content = [
      assistantTurn(OPUS, {
        input_tokens: 160_000,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistantTurn(SONNET, {
        input_tokens: 0,
        output_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(u.context!.tokens).toBe(160_000);
    expect(u.context!.model).toBe(OPUS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSessionUsage — robustness
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSessionUsage — robustness', () => {
  test('empty content → empty usage, null context, zero cost', () => {
    const u = computeSessionUsage('');
    expect(u.perModel).toEqual({});
    expect(u.context).toBeNull();
    expect(u.totalCostUsd).toBe(0);
    expect(u.totalTokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
  });

  test('malformed lines are skipped, not thrown', () => {
    const content = [
      'not-json',
      assistantTurn(OPUS, { input_tokens: 5, output_tokens: 5 }),
      '{broken',
      '',
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(u.perModel[OPUS]!.tokens.input).toBe(5);
    expect(u.perModel[OPUS]!.tokens.output).toBe(5);
    // Missing cache fields default to 0.
    expect(u.perModel[OPUS]!.tokens.cacheRead).toBe(0);
  });

  test('assistant record without a usage block is skipped', () => {
    const content = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: OPUS } }),
      assistantTurn(SONNET, { input_tokens: 9, output_tokens: 1 }),
    ].join('\n');
    const u = computeSessionUsage(content);
    // No opus entry — its record carried no usage.
    expect(u.perModel[OPUS]).toBeUndefined();
    expect(u.perModel[SONNET]!.tokens.input).toBe(9);
    // And it didn't become the context turn.
    expect(u.context!.model).toBe(SONNET);
  });

  test('assistant record without a model is skipped', () => {
    const content = [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5 } } }),
      assistantTurn(SONNET, { input_tokens: 9, output_tokens: 1 }),
    ].join('\n');
    const u = computeSessionUsage(content);
    expect(Object.keys(u.perModel)).toEqual([SONNET]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readSessionUsage — on-disk wrapper
// ─────────────────────────────────────────────────────────────────────────────

const cleanupPaths: string[] = [];
let savedHome: string | undefined;
const SID = '01234567-89ab-cdef-0123-456789abcdef';

beforeEach(() => {
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-session-usage-home-'));
  cleanupPaths.push(dir);
  process.env.HOME = dir;
  return dir;
}

function seedJSONL(home: string, encodedCwd: string, sessionID: string, content: string): void {
  const projDir = join(home, '.claude', 'projects', encodedCwd);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${sessionID}.jsonl`), content, { mode: 0o600 });
}

describe('readSessionUsage', () => {
  test('reads + parses the on-disk JSONL for cwd/sid', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, FIXTURE);
    const u = readSessionUsage('/cwd', SID);
    expect(u.perModel[OPUS]!.tokens).toEqual(EXPECT_OPUS);
    expect(u.context!.model).toBe(OPUS);
  });

  test('missing file → empty usage (no throw)', () => {
    makeHome();
    const u = readSessionUsage('/cwd/missing', SID);
    expect(u.perModel).toEqual({});
    expect(u.context).toBeNull();
  });
});
