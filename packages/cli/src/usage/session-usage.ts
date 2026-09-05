/**
 * Shared session-usage reader.
 *
 * Reads token / cost / context usage from the *live session JSONL* that
 * Claude Code appends under `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 * This is groundwork shared by two upcoming consumers:
 *
 *   - a context-size monitor (#170 part 2) — "should I warn that the
 *     context is getting large?", driven by `usage.context.tokens`.
 *   - a `get_usage` report tool (#171) — "show me the per-model token /
 *     cost breakdown for this session", driven by `usage.perModel` and
 *     `usage.total*`.
 *
 * The CLI does NOT parse stream-json. Usage
 * here comes from the session JSONL's assistant-message records, each of
 * which carries `message.model` and a `message.usage` object of the shape
 * Anthropic's API returns:
 *
 *   {"type":"assistant","message":{"role":"assistant","model":"claude-…",
 *     "usage":{"input_tokens":…,"output_tokens":…,
 *              "cache_creation_input_tokens":…,"cache_read_input_tokens":…}}}
 *
 * Path resolution is reused from `live-permission-reader` (the same
 * `sessionJSONLPath` / encoded-cwd scheme) — not reinvented.
 *
 * The file-read seam is injectable: `computeSessionUsage(content)` is pure
 * over the raw JSONL string (unit-testable without a real `~/.claude`),
 * and `readSessionUsage(cwd, sid)` is the thin on-disk wrapper.
 */

import { readFileSync } from 'node:fs';

import { sessionJSONLPath } from '../launch/live-permission-reader';

// ─────────────────────────────────────────────────────────────────────────────
// Pricing table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-model pricing in USD per **million tokens** (per-Mtok), keyed by the
 * model id Claude writes into `message.model`. Cache *write* (creation)
 * and cache *read* are priced separately from base input.
 *
 * ⚠️ HARDCODED — UPDATE WHEN ANTHROPIC PRICING CHANGES. Source:
 * https://www.anthropic.com/pricing (Claude 4.x tier, as of 2026-05).
 * Cache-write here is the 5-minute-TTL rate (1.25× base input); cache-read
 * is 0.1× base input. Models not listed here contribute tokens but $0 cost
 * (see `computeSessionUsage`) — add a row when a new model id appears.
 */
export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  /** Cache-creation (write) rate — 5m TTL. */
  readonly cacheWritePerMtok: number;
  /** Cache-read (hit) rate. */
  readonly cacheReadPerMtok: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  // Opus 4.x — $15 / $75 base in/out; $18.75 cache-write, $1.50 cache-read.
  'claude-opus-4-8': { inputPerMtok: 15, outputPerMtok: 75, cacheWritePerMtok: 18.75, cacheReadPerMtok: 1.5 },
  'claude-opus-4-7': { inputPerMtok: 15, outputPerMtok: 75, cacheWritePerMtok: 18.75, cacheReadPerMtok: 1.5 },
  'claude-opus-4-1': { inputPerMtok: 15, outputPerMtok: 75, cacheWritePerMtok: 18.75, cacheReadPerMtok: 1.5 },
  'claude-opus-4-0': { inputPerMtok: 15, outputPerMtok: 75, cacheWritePerMtok: 18.75, cacheReadPerMtok: 1.5 },
  // Sonnet 4.x — $3 / $15 base in/out; $3.75 cache-write, $0.30 cache-read.
  'claude-sonnet-4-7': { inputPerMtok: 3, outputPerMtok: 15, cacheWritePerMtok: 3.75, cacheReadPerMtok: 0.3 },
  'claude-sonnet-4-5': { inputPerMtok: 3, outputPerMtok: 15, cacheWritePerMtok: 3.75, cacheReadPerMtok: 0.3 },
  'claude-sonnet-4-0': { inputPerMtok: 3, outputPerMtok: 15, cacheWritePerMtok: 3.75, cacheReadPerMtok: 0.3 },
  // Haiku 4.x — $1 / $5 base in/out; $1.25 cache-write, $0.10 cache-read.
  'claude-haiku-4-5': { inputPerMtok: 1, outputPerMtok: 5, cacheWritePerMtok: 1.25, cacheReadPerMtok: 0.1 },
  'claude-haiku-4-0': { inputPerMtok: 1, outputPerMtok: 5, cacheWritePerMtok: 1.25, cacheReadPerMtok: 0.1 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

/** Token counts, broken out by billing category. */
export interface TokenTotals {
  input: number;
  output: number;
  /** Cache-creation (write) tokens. */
  cacheCreation: number;
  /** Cache-read (hit) tokens. */
  cacheRead: number;
}

/** Per-model rollup: summed tokens + computed cost. */
export interface ModelUsage {
  /** Tokens summed across every assistant turn that used this model. */
  tokens: TokenTotals;
  /**
   * Cost in USD for this model's tokens, per `MODEL_PRICING`. `0` for a
   * model with no pricing row (tokens still counted in `tokens`).
   */
  costUsd: number;
}

/** The current context size, taken from the most recent assistant turn. */
export interface ContextUsage {
  /**
   * Token count standing in the context window after the latest turn:
   * `input + cacheCreation + cacheRead` of that turn. (Output isn't part
   * of the input context.) A consumer compares this against a threshold.
   */
  tokens: number;
  /** Model id of the latest turn. */
  model: string;
}

/**
 * Structured session usage. Designed so both consumers read it directly:
 *
 *   - context monitor → `context?.tokens` vs a threshold.
 *   - usage report → iterate `perModel`, show `totalTokens` / `totalCostUsd`.
 */
export interface SessionUsage {
  /** Per-model token + cost rollup, keyed by model id. */
  perModel: Record<string, ModelUsage>;
  /** Session-wide token totals (sum across all models). */
  totalTokens: TokenTotals;
  /** Session-wide cost in USD (sum across all models). */
  totalCostUsd: number;
  /** Latest assistant turn's context size, or `null` if no assistant turn. */
  context: ContextUsage | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

function zeroTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function costOf(model: string, t: TokenTotals): number {
  const p = MODEL_PRICING[model];
  if (p === undefined) return 0;
  return (
    (t.input * p.inputPerMtok +
      t.output * p.outputPerMtok +
      t.cacheCreation * p.cacheWritePerMtok +
      t.cacheRead * p.cacheReadPerMtok) /
    1_000_000
  );
}

/**
 * Pure reader over raw session JSONL content. Forward-scans assistant
 * records, accumulates per-model token totals, and tracks the latest turn
 * for context size. Malformed lines, non-assistant records, records with no
 * `usage` block, and records with no `model` are all skipped silently
 * (defensive against partial writes / future record shapes).
 */
export function computeSessionUsage(content: string): SessionUsage {
  const perModelTokens: Record<string, TokenTotals> = {};
  let context: ContextUsage | null = null;

  for (const line of content.split('\n')) {
    if (line === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed line
    }
    if (typeof rec !== 'object' || rec === null) continue;
    const obj = rec as Record<string, unknown>;
    if (obj.type !== 'assistant') continue;

    const msg = obj.message;
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;

    const model = m.model;
    if (typeof model !== 'string' || model === '') continue;

    const usage = m.usage;
    if (typeof usage !== 'object' || usage === null) continue;
    const u = usage as Record<string, unknown>;

    const turn: TokenTotals = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
    };

    const acc = (perModelTokens[model] ??= zeroTotals());
    acc.input += turn.input;
    acc.output += turn.output;
    acc.cacheCreation += turn.cacheCreation;
    acc.cacheRead += turn.cacheRead;

    // Latest REAL assistant turn wins for context size. Claude writes a
    // `model: "<synthetic>"` record (all-zero usage) for interrupted / partial
    // turns; any record whose effective context tokens sum to 0 likewise
    // carries no usable reading. Letting one overwrite `context` would drop the
    // running size to 0 and make the context monitor re-arm its watermark as if
    // a /compact had happened, re-firing the same ladder rung (issue #283).
    // Token accumulation above still counts these (zeros are harmless); only
    // the context assignment skips them.
    const contextTokens = turn.input + turn.cacheCreation + turn.cacheRead;
    if (model !== '<synthetic>' && contextTokens > 0) {
      context = { tokens: contextTokens, model };
    }
  }

  const perModel: Record<string, ModelUsage> = {};
  const totalTokens = zeroTotals();
  let totalCostUsd = 0;

  for (const [model, tokens] of Object.entries(perModelTokens)) {
    const costUsd = costOf(model, tokens);
    perModel[model] = { tokens, costUsd };
    totalTokens.input += tokens.input;
    totalTokens.output += tokens.output;
    totalTokens.cacheCreation += tokens.cacheCreation;
    totalTokens.cacheRead += tokens.cacheRead;
    totalCostUsd += costUsd;
  }

  return { perModel, totalTokens, totalCostUsd, context };
}

/**
 * On-disk wrapper: resolve the session JSONL for `launchCWD` / `sessionID`
 * (via `sessionJSONLPath`), read it, and feed the content through
 * `computeSessionUsage`. A missing / unreadable file yields empty usage
 * (`{}` perModel, zero totals, `null` context) rather than throwing.
 */
export function readSessionUsage(launchCWD: string, sessionID: string): SessionUsage {
  const path = sessionJSONLPath(launchCWD, sessionID);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = '';
  }
  return computeSessionUsage(raw);
}
