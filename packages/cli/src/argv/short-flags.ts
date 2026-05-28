/**
 * Capital-letter short-flag → long-flag translation.
 *
 * Mirrors Go canonical `src/main.go:350-423` (parseShortFlag and cluster
 * walking). Operates on the passthrough token stream after parseArgs.
 *
 * Three tables govern translation. Lowercase short flags (and any
 * capital not in the tables) pass through verbatim — claude handles
 * those itself.
 *
 *   shortNoValue: B C D F I V        — toggle flags, no value
 *   shortRequired: G M W             — must take a value
 *   shortOptional: P R T             — may take a value if not flag-shaped
 *
 * Cluster mechanics:
 *   - Each char walks independently.
 *   - shortRequired NOT at last position → ERROR (can't absorb value mid-cluster).
 *   - shortRequired at last position consumes next argv token; ERROR if next
 *     starts with `-` or there's no next token.
 *   - shortOptional at last position consumes next token if it does NOT
 *     start with `-`; otherwise emits the long flag with no value.
 *   - shortOptional NOT at last position emits the long flag with no value
 *     (no token to consume; let walking continue).
 *   - `-X=val` single-token form (only single-char clusters) → `--long=val`.
 *
 * Sentinel: anything after `--` passes through verbatim — that's prompt
 * body / claude-handled flags / etc., not for us to touch.
 */

const SHORT_NO_VALUE: Record<string, string> = {
  B: '--brief',
  C: '--chrome',
  D: '--dangerously-skip-permissions',
  F: '--fork-session',
  I: '--ide',
  V: '--verbose',
};

const SHORT_REQUIRED: Record<string, string> = {
  G: '--agent',
  M: '--permission-mode',
  W: '--allowedTools',
};

const SHORT_OPTIONAL: Record<string, string> = {
  P: '--from-pr',
  R: '--remote-control',
  T: '--tmux',
};

export type ExpandShortFlagsResult =
  | { ok: true; tokens: string[] }
  | { ok: false; error: string };

export function expandShortFlags(tokens: readonly string[]): ExpandShortFlagsResult {
  const out: string[] = [];
  let i = 0;
  let pastSentinel = false;

  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (pastSentinel) {
      out.push(tok);
      i++;
      continue;
    }
    if (tok === '--') {
      pastSentinel = true;
      out.push(tok);
      i++;
      continue;
    }

    // Anything not starting with `-`, or just `-`, or `--long…` passes through.
    if (!tok.startsWith('-') || tok === '-' || tok.startsWith('--')) {
      out.push(tok);
      i++;
      continue;
    }

    // Short cluster.
    const body = tok.slice(1);

    // -X=val single-char form (only for single-char clusters, per Go spec).
    const eqIdx = body.indexOf('=');
    if (eqIdx === 1) {
      const ch = body[0]!;
      const val = body.slice(2);
      const long = SHORT_NO_VALUE[ch] ?? SHORT_REQUIRED[ch] ?? SHORT_OPTIONAL[ch];
      if (long !== undefined) {
        out.push(`${long}=${val}`);
        i++;
        continue;
      }
      // Unknown short with `=` → pass through verbatim.
      out.push(tok);
      i++;
      continue;
    }

    // Walk each cluster char.
    let advanceConsumedNext = false;
    let errored: string | null = null;

    for (let j = 0; j < body.length; j++) {
      const ch = body[j]!;
      const isLast = j === body.length - 1;

      if (SHORT_NO_VALUE[ch] !== undefined) {
        out.push(SHORT_NO_VALUE[ch]!);
        continue;
      }
      if (SHORT_REQUIRED[ch] !== undefined) {
        if (!isLast) {
          errored = `fnclaude: flag -${ch} cannot be in middle of collapsed group, requires a value`;
          break;
        }
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith('-')) {
          errored = `fnclaude: -${ch} requires a value`;
          break;
        }
        out.push(SHORT_REQUIRED[ch]!, next);
        advanceConsumedNext = true;
        continue;
      }
      if (SHORT_OPTIONAL[ch] !== undefined) {
        if (isLast) {
          const next = tokens[i + 1];
          if (next !== undefined && !next.startsWith('-')) {
            out.push(SHORT_OPTIONAL[ch]!, next);
            advanceConsumedNext = true;
            continue;
          }
        }
        out.push(SHORT_OPTIONAL[ch]!);
        continue;
      }
      // Unknown short — pass through verbatim as `-<char>`.
      out.push(`-${ch}`);
    }

    if (errored !== null) {
      return { ok: false, error: errored };
    }

    i += advanceConsumedNext ? 2 : 1;
  }

  return { ok: true, tokens: out };
}
