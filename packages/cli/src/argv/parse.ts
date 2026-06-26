/**
 * Full argv parser. Consumes the user's raw argv (post-intake) and produces
 * a structured Args record for the launcher and MCP pipeline.
 *
 * Mirrors Go canonical `parseArgs` (`fnclaude@fnrhombus/src/main.go:130–343`):
 * one left-to-right walk with a sticky `inFlags` boundary. Magic positionals
 * (model/effort/subcommand) consume the leading prefix; then a maximum of
 * two non-flag positionals fill firstPath and worktreeArg; once the first
 * flag-shape token is seen, all subsequent tokens are flag territory.
 *
 * fnclaude-eaten flags (NOT forwarded to claude):
 *   --no-tmux              → noTmux = true
 *   -A | --also <dir>      → push to extraDirs
 *   -A=<dir> | --also=<dir>
 *   -w | --worktree <name> → worktreeSet, worktreeArg
 *   -w=<name> | --worktree=<name>
 *   bare -w or --worktree  → worktreeSet, worktreeArg = ''
 *
 * Subcommand tokens (resume/res/continue/con/fork/fk) are recognized at
 * any positional slot, are order-independent with magic, and do not
 * advance the magic state. At most one per invocation.
 *
 * Short-flag clusters (-BVC, -BVCM plan) are NOT expanded here — they
 * land in passthrough verbatim and §4.5 transforms them later. Unknown
 * long flags also pass through unchanged.
 */

import {
  canonicalSubcommand,
  classifyToken,
  type CanonicalSubcommand,
  type Effort,
  type Model,
} from './classify';

export interface ParsedArgsOk {
  ok: true;
  model: Model | null;
  effort: Effort | null;
  subcommand: CanonicalSubcommand | null;
  firstPath: string | null;
  worktreeSet: boolean;
  worktreeArg: string;
  extraDirs: string[];
  noTmux: boolean;
  passthrough: string[];
}

export interface ParsedArgsErr {
  ok: false;
  error: string;
}

export type ParsedArgs = ParsedArgsOk | ParsedArgsErr;

const ERR_DUPLICATE_SUBCOMMAND = 'fnc: only one of resume/continue/fork may be used per invocation';
const ERR_TOO_MANY_POSITIONALS = (got: string): string =>
  `fnc: too many positional arguments (got ${JSON.stringify(got)}; max is 2 — cwd and worktree-name)`;

export function parseArgs(args: readonly string[]): ParsedArgs {
  let model: Model | null = null;
  let effort: Effort | null = null;
  let subcommand: CanonicalSubcommand | null = null;
  let firstPath: string | null = null;
  let worktreeSet = false;
  let worktreeArg = '';
  const extraDirs: string[] = [];
  let noTmux = false;
  const passthrough: string[] = [];

  let magicState: 0 | 1 | 2 = 0;
  let inFlags = false;

  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;

    // ── Positional territory (before the first flag-shape token) ────────────
    if (!inFlags && !tok.startsWith('-')) {
      const kind = classifyToken(tok);

      // Subcommand: any positional slot, doesn't advance magic state.
      if (kind === 'subcommand') {
        if (subcommand !== null) {
          return { ok: false, error: ERR_DUPLICATE_SUBCOMMAND };
        }
        subcommand = canonicalSubcommand(tok);
        i++;
        continue;
      }

      // Magic state 0 → check model OR effort (effort implies opus).
      if (magicState === 0) {
        if (kind === 'model') {
          model = tok as Model;
          magicState = 1;
          i++;
          continue;
        }
        if (kind === 'effort') {
          effort = tok as Effort;
          model = 'opus';
          magicState = 2;
          i++;
          continue;
        }
        // Not magic — fall through to positional slot assignment, but advance
        // magicState so position 2's effort check doesn't re-fire.
        magicState = 2;
      } else if (magicState === 1) {
        // Magic state 1 → check effort (model was matched at state 0).
        if (kind === 'effort') {
          effort = tok as Effort;
          magicState = 2;
          i++;
          continue;
        }
        magicState = 2;
      }
      // magicState === 2 from here on.

      // Positional slot assignment.
      if (firstPath === null) {
        firstPath = tok;
      } else if (!worktreeSet) {
        worktreeSet = true;
        worktreeArg = tok;
      } else {
        return { ok: false, error: ERR_TOO_MANY_POSITIONALS(tok) };
      }
      i++;
      continue;
    }

    // ── Flag territory (sticky) ─────────────────────────────────────────────
    inFlags = true;

    // fnclaude-eaten: --no-tmux
    if (tok === '--no-tmux') {
      noTmux = true;
      i++;
      continue;
    }

    // fnclaude-eaten: -A / --also (extra dirs)
    if (tok === '-A' || tok === '--also') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        const which = next === undefined ? tok : `${tok} ${next}`;
        return { ok: false, error: `fnc: ${which} requires a directory argument` };
      }
      extraDirs.push(next);
      i += 2;
      continue;
    }
    if (tok.startsWith('-A=')) {
      const val = tok.slice(3);
      if (val === '') return { ok: false, error: 'fnc: -A= requires a directory argument' };
      extraDirs.push(val);
      i++;
      continue;
    }
    if (tok.startsWith('--also=')) {
      const val = tok.slice(7);
      if (val === '') return { ok: false, error: 'fnc: --also= requires a directory argument' };
      extraDirs.push(val);
      i++;
      continue;
    }

    // fnclaude-eaten: -w / --worktree (worktree flag)
    if (tok === '-w' || tok === '--worktree') {
      worktreeSet = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        worktreeArg = next;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (tok.startsWith('-w=')) {
      worktreeSet = true;
      worktreeArg = tok.slice(3);
      i++;
      continue;
    }
    if (tok.startsWith('--worktree=')) {
      worktreeSet = true;
      worktreeArg = tok.slice('--worktree='.length);
      i++;
      continue;
    }

    // Everything else (including `--` and following prompt body) → passthrough
    passthrough.push(tok);
    i++;
  }

  return {
    ok: true,
    model,
    effort,
    subcommand,
    firstPath,
    worktreeSet,
    worktreeArg,
    extraDirs,
    noTmux,
    passthrough,
  };
}
