/**
 * Magic-positional state machine.
 *
 * Walks the prefix of argv consuming model/effort/subcommand tokens per
 * the rules in docs/design.md §1. Subcommands are order-independent and
 * do not advance the model/effort state; model+effort move through a
 * three-state machine:
 *
 *   state 0 → next token may be model OR effort (effort implies opus,
 *             rewrite extension)
 *   state 1 → next token may be effort (model already consumed)
 *   state 2 → magic scanning is done
 *
 * Magic also ends as soon as a flag (token starting with `-`) is seen.
 *
 * Only one subcommand per invocation; the second is an error.
 *
 * The fn returns `consumed` (the count of leading tokens absorbed by the
 * scan) rather than slicing — the caller still owns the original argv
 * for downstream phases that need indices into it.
 */

import {
  canonicalSubcommand,
  classifyToken,
  type CanonicalSubcommand,
  type Effort,
  type Model,
} from './classify';

export interface MagicResultOk {
  ok: true;
  model: Model | null;
  effort: Effort | null;
  subcommand: CanonicalSubcommand | null;
  consumed: number;
}

export interface MagicResultErr {
  ok: false;
  error: string;
}

export type MagicResult = MagicResultOk | MagicResultErr;

const ERR_DUPLICATE_SUBCOMMAND = 'fnc: only one of resume/continue/fork may be used per invocation';

export function scanMagic(args: readonly string[]): MagicResult {
  let model: Model | null = null;
  let effort: Effort | null = null;
  let subcommand: CanonicalSubcommand | null = null;
  let state: 0 | 1 | 2 = 0;
  let i = 0;

  while (i < args.length) {
    const tok = args[i]!;
    const kind = classifyToken(tok);

    if (kind === 'flag') break;

    if (kind === 'subcommand') {
      if (subcommand !== null) {
        return { ok: false, error: ERR_DUPLICATE_SUBCOMMAND };
      }
      subcommand = canonicalSubcommand(tok);
      i++;
      continue;
    }

    if (state === 0) {
      if (kind === 'model') {
        model = tok as Model;
        state = 1;
        i++;
        continue;
      }
      if (kind === 'effort') {
        // Rewrite extension: effort-only at pos 1 implies opus.
        effort = tok as Effort;
        model = 'opus';
        state = 2;
        i++;
        continue;
      }
      break;
    }

    if (state === 1) {
      if (kind === 'effort') {
        effort = tok as Effort;
        state = 2;
        i++;
        continue;
      }
      break;
    }

    // state === 2 — magic is done, leave the rest to downstream phases.
    break;
  }

  return { ok: true, model, effort, subcommand, consumed: i };
}
