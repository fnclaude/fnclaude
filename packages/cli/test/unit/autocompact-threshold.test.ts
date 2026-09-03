/**
 * Unit tests for the derived Claude-Code auto-compaction threshold (#332).
 *
 * Percentage context-notice tiers (`at = "94%"`) resolve against this
 * derived threshold — 100% is the exact token count at which Claude Code
 * auto-compacts, computed per active model / surface / env. The formula and
 * its constants are reverse-engineered from Claude Code v2.1.200 and
 * documented in specs/reverse-engineering/claude-code-autocompact-thresholds.md.
 *
 * The whole point is that ONE percentage config self-adjusts to the correct
 * absolute token count across models and surfaces with no re-tuning: 94% is
 * ~878k on a default 1M `cli` session (100% = 934,000) and ~439k on a 500k
 * `local-agent` surface (100% = 467,000).
 */

import { describe, expect, test } from 'bun:test';

import {
  deriveAutoCompactThreshold,
  deriveConfiguredWindow,
  is1MClassModel,
  resolvePctToTokens,
} from '../../src/usage/autocompact-threshold';

describe('deriveConfiguredWindow — precedence', () => {
  test('default cli surface + 1M-class model ([1m] suffix) → 967000', () => {
    expect(deriveConfiguredWindow({ model: 'claude-opus-4-8[1m]', env: {} })).toBe(967_000);
  });

  test('sonnet-5 (1M-class base id) → 967000', () => {
    expect(deriveConfiguredWindow({ model: 'claude-sonnet-5', env: {} })).toBe(967_000);
  });

  test('dated sonnet-5 snapshot still 1M-class → 967000', () => {
    expect(deriveConfiguredWindow({ model: 'claude-sonnet-5-20260101', env: {} })).toBe(967_000);
  });

  test('non-1M model (haiku, no [1m]) → 200000', () => {
    expect(deriveConfiguredWindow({ model: 'claude-haiku-4-5', env: {} })).toBe(200_000);
  });

  test('plain opus without [1m] → 200000 (non-extended boundary)', () => {
    expect(deriveConfiguredWindow({ model: 'claude-opus-4-8', env: {} })).toBe(200_000);
  });

  test('local-agent surface overrides model → 500000', () => {
    expect(
      deriveConfiguredWindow({
        model: 'claude-opus-4-8[1m]',
        env: { CLAUDE_CODE_ENTRYPOINT: 'local-agent' },
      }),
    ).toBe(500_000);
  });

  test('remote_cowork surface → 500000', () => {
    expect(
      deriveConfiguredWindow({ model: 'claude-haiku-4-5', env: { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' } }),
    ).toBe(500_000);
  });

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT drops a 1M-class model to 200000', () => {
    expect(
      deriveConfiguredWindow({
        model: 'claude-opus-4-8[1m]',
        env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
      }),
    ).toBe(200_000);
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW env wins, clamped to 100k–1M', () => {
    expect(
      deriveConfiguredWindow({ model: 'claude-opus-4-8[1m]', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }),
    ).toBe(300_000);
    expect(
      deriveConfiguredWindow({ model: 'claude-opus-4-8[1m]', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' } }),
    ).toBe(100_000);
    expect(
      deriveConfiguredWindow({ model: 'claude-opus-4-8[1m]', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '2000000' } }),
    ).toBe(1_000_000);
  });

  test('settings autoCompactWindow honored below the env var, clamped', () => {
    expect(
      deriveConfiguredWindow({ model: 'claude-opus-4-8', env: {}, settingsAutoCompactWindow: 400_000 }),
    ).toBe(400_000);
    // env var beats settings
    expect(
      deriveConfiguredWindow({
        model: 'claude-opus-4-8',
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' },
        settingsAutoCompactWindow: 400_000,
      }),
    ).toBe(300_000);
  });
});

describe('deriveAutoCompactThreshold — configuredWindow − 33000', () => {
  test('default cli 1M session → 934000 (= 967000 − 33000)', () => {
    expect(deriveAutoCompactThreshold({ model: 'claude-opus-4-8[1m]', env: {} })).toBe(934_000);
  });

  test('500k local-agent surface → 467000', () => {
    expect(
      deriveAutoCompactThreshold({
        model: 'claude-opus-4-8[1m]',
        env: { CLAUDE_CODE_ENTRYPOINT: 'local-agent' },
      }),
    ).toBe(467_000);
  });

  test('DISABLE_1M → 167000', () => {
    expect(
      deriveAutoCompactThreshold({
        model: 'claude-opus-4-8[1m]',
        env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
      }),
    ).toBe(167_000);
  });

  test('CLAUDE_CODE_MAX_OUTPUT_TOKENS below 20000 shrinks the reserve offset', () => {
    // offset = min(maxOut, 20000) + 13000 = 10000 + 13000 = 23000
    expect(
      deriveAutoCompactThreshold({
        model: 'claude-opus-4-8[1m]',
        env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '10000' },
      }),
    ).toBe(967_000 - 23_000);
  });
});

describe('resolvePctToTokens — percent of threshold, no clamp above 100%', () => {
  test('94% of the default 1M threshold ≈ 878k', () => {
    const threshold = deriveAutoCompactThreshold({ model: 'claude-opus-4-8[1m]', env: {} });
    expect(resolvePctToTokens(94, threshold)).toBe(Math.round(0.94 * 934_000)); // 877960
  });

  test('SAME 94% config self-adjusts on a 500k surface (≈439k)', () => {
    const threshold = deriveAutoCompactThreshold({
      model: 'claude-opus-4-8[1m]',
      env: { CLAUDE_CODE_ENTRYPOINT: 'local-agent' },
    });
    expect(resolvePctToTokens(94, threshold)).toBe(Math.round(0.94 * 467_000)); // 438980
  });

  test('fractional percent (2.5%) resolves', () => {
    expect(resolvePctToTokens(2.5, 934_000)).toBe(Math.round(0.025 * 934_000)); // 23350
  });

  test('above 100% is NOT clamped (auto-compact-disabled sessions climb past the wall)', () => {
    expect(resolvePctToTokens(104, 934_000)).toBe(Math.round(1.04 * 934_000));
  });
});

describe('is1MClassModel', () => {
  test('[1m] suffix → true', () => {
    expect(is1MClassModel('claude-opus-4-8[1m]')).toBe(true);
  });
  test('sonnet-5 base → true', () => {
    expect(is1MClassModel('claude-sonnet-5')).toBe(true);
    expect(is1MClassModel('claude-sonnet-5-20260101')).toBe(true);
  });
  test('plain opus / haiku without [1m] → false', () => {
    expect(is1MClassModel('claude-opus-4-8')).toBe(false);
    expect(is1MClassModel('claude-haiku-4-5')).toBe(false);
  });
});
