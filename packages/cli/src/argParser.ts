/**
 * Bespoke argv parser for fnclaude — ported from the Go implementation at
 * src/main.go in the upstream Go repo. Hand-rolled (no commander/cac) because
 * fnclaude's magic-positional rules don't map cleanly onto generic parsers.
 *
 * Phases, in order:
 *   1. Subcommand expansion   (resume/res/continue/con/fork/fk → long flags)
 *   2. Short-flag translation (-B → --brief, -Gval → --agent val, etc.)
 *   3. Magic-word positional  (model + effort aliases consumed off the front)
 *   4. Positional consumption (path, optional worktree name)
 *   5. Pass-through           (unrecognized flags forwarded to claude)
 *
 * See src/main.go in the Go repo for the canonical spec and src/main_test.go
 * + src/subcommand_test.go + src/positional_worktree_test.go for behavior
 * the TS port preserves.
 */

import { join as pathJoin } from 'node:path';
import type { Args } from './args.js';

// ── Magic-word vocabularies ────────────────────────────────────────────────

const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Capital short flags with no value.
const SHORT_NO_VALUE: Record<string, string> = {
  B: '--brief',
  C: '--chrome',
  D: '--dangerously-skip-permissions',
  F: '--fork-session',
  I: '--ide',
  V: '--verbose',
};

// Capital short flags that REQUIRE a value (next argv token or =val).
const SHORT_REQUIRED: Record<string, string> = {
  G: '--agent',
  M: '--permission-mode',
  W: '--allowedTools',
};

// Capital short flags that optionally take a value (greedy; only consumed
// when the next token is non-flag).
const SHORT_OPTIONAL: Record<string, string> = {
  P: '--from-pr',
  R: '--remote-control',
  T: '--tmux',
};

// Subcommand-style positionals → long-flag expansion. `fork` includes
// --resume because --fork-session requires it on claude's side.
const SUBCOMMAND_FLAGS: Record<string, readonly string[]> = {
  resume: ['--resume'],
  res: ['--resume'],
  continue: ['--continue'],
  con: ['--continue'],
  fork: ['--resume', '--fork-session'],
  fk: ['--resume', '--fork-session'],
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return the default cwd for invocations with no positional path —
 * `$XDG_CONFIG_HOME/fnclaude/noop`, falling back to `$home/.config/fnclaude/noop`.
 * Matches Go's `defaultNoopDir`.
 */
export function defaultNoopDir(home: string): string {
  const base = process.env.XDG_CONFIG_HOME || pathJoin(home, '.config');
  return pathJoin(base, 'fnclaude', 'noop');
}

/**
 * Look up the long form of a value-taking short flag char.
 */
function valueShortLong(ch: string): string | undefined {
  return SHORT_REQUIRED[ch] ?? SHORT_OPTIONAL[ch];
}

export interface ParseShortFlagResult {
  tokens: string[];
  consumed: number;
}

/**
 * Parse a single short-flag token like `-B`, `-BVC`, `-G=val`, `-G`, `-Gval`.
 *
 * Returns the long-form tokens to emit and the number of extra argv elements
 * consumed from `rest` (the slice starting AFTER the current token). The
 * caller is responsible for advancing its own cursor by `1 + consumed`.
 *
 * Throws on:
 *   - A required-value short flag in the middle of a collapsed group
 *   - A required-value short flag at EOF with no value
 *   - A required-value short flag followed by another flag
 */
export function parseShortFlag(arg: string, rest: readonly string[]): ParseShortFlagResult {
  // Strip the leading '-'.
  const body = arg.slice(1);

  // -X=val form: only valid for known value-taking single-char flags. Anything
  // else falls through and we emit the token verbatim.
  if (body.length >= 3 && body[1] === '=') {
    const ch = body[0] as string;
    const val = body.slice(2);
    const long = valueShortLong(ch);
    if (long === undefined) {
      // Unknown -X=val — pass the original token verbatim. Same fallthrough
      // as Go's parseShortFlag.
      return { tokens: [arg], consumed: 0 };
    }
    return { tokens: [`${long}=${val}`], consumed: 0 };
  }

  const out: string[] = [];
  for (let pos = 0; pos < body.length; pos++) {
    const ch = body[pos] as string;
    const isLast = pos === body.length - 1;

    if (SHORT_NO_VALUE[ch]) {
      out.push(SHORT_NO_VALUE[ch]!);
      continue;
    }

    const required = SHORT_REQUIRED[ch];
    if (required) {
      if (!isLast) {
        throw new Error(
          `fnclaude: flag -${ch} cannot be in middle of collapsed group, requires a value`,
        );
      }
      if (rest.length === 0 || rest[0]!.startsWith('-')) {
        throw new Error(`fnclaude: -${ch} requires a value`);
      }
      return { tokens: [...out, required, rest[0]!], consumed: 1 };
    }

    const optional = SHORT_OPTIONAL[ch];
    if (optional) {
      if (!isLast) {
        throw new Error(
          `fnclaude: flag -${ch} cannot be in middle of collapsed group, requires a value`,
        );
      }
      if (rest.length > 0 && !rest[0]!.startsWith('-')) {
        return { tokens: [...out, optional, rest[0]!], consumed: 1 };
      }
      return { tokens: [...out, optional], consumed: 0 };
    }

    // Unknown single-char short flag — pass through verbatim. Lets claude
    // either accept it or surface its own error.
    out.push(`-${ch}`);
  }

  return { tokens: out, consumed: 0 };
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * parseArgs is the canonical argv parser. `home` is the user's home dir
 * (typically `os.homedir()`); it's used to derive the noop fallback path.
 *
 * Throws Error on invalid input (too many positionals, missing values,
 * collapsed-group misuse, two subcommands, etc.). The Go original returns
 * `(Args, error)`; TS uses throw for the natural shape.
 */
export function parseArgs(argv: readonly string[], home: string): Args {
  let firstPath = '';
  const extraDirs: string[] = [];
  const passthrough: string[] = [];
  let noTmux = false;
  let worktreeSet = false;
  let worktreeArg = '';

  // Magic slots: filled at most once each, in strict order.
  let magicModel = '';
  let magicEffort = '';

  // Subcommand expansion: long-flag tokens to prepend to passthrough.
  let subcommandExpansion: readonly string[] | undefined;
  let subcommandToken = '';

  // 0 = position 1 (check model)
  // 1 = position 2 (check effort, only if model matched)
  // 2 = magic done
  let magicState = 0;

  let inFlags = false;
  let firstPathSet = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;

    // ── Positional phase (before first flag-shaped token) ───────────────
    if (!inFlags && !arg.startsWith('-')) {
      // Subcommand check fires at every positional slot, independent of
      // magic state — does NOT advance magicState, so `fnc resume opus xhigh`
      // and `fnc opus xhigh resume` parse equivalently.
      const subFlags = SUBCOMMAND_FLAGS[arg];
      if (subFlags) {
        if (subcommandExpansion !== undefined) {
          throw new Error(
            `fnclaude: only one subcommand allowed (got "${subcommandToken}" and "${arg}")`,
          );
        }
        subcommandExpansion = subFlags;
        subcommandToken = arg;
        i++;
        continue;
      }

      if (magicState === 0) {
        if (MODEL_ALIASES.has(arg)) {
          magicModel = arg;
          magicState = 1; // advance to effort check at position 2
          i++;
          continue;
        }
        magicState = 2; // not a model alias → magic done; arg is cwd
      } else if (magicState === 1) {
        if (EFFORT_LEVELS.has(arg)) {
          magicEffort = arg;
          magicState = 2;
          i++;
          continue;
        }
        magicState = 2; // not an effort level → magic done; arg is cwd
      }

      if (!firstPathSet) {
        firstPath = arg;
        firstPathSet = true;
      } else if (!worktreeSet) {
        worktreeSet = true;
        worktreeArg = arg;
      } else {
        throw new Error(
          `fnclaude: too many positional arguments (got "${arg}"; max is 2 — cwd and worktree-name)`,
        );
      }
      i++;
      continue;
    }

    // ── Flag territory ──────────────────────────────────────────────────
    inFlags = true;

    if (arg === '--no-tmux') {
      noTmux = true;
      i++;
      continue;
    }

    // -A / --also (space form).
    if (arg === '-A' || arg === '--also') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        const which = next === undefined ? arg : `${arg} ${next}`;
        throw new Error(`fnclaude: ${which} requires a directory argument`);
      }
      extraDirs.push(next);
      i += 2;
      continue;
    }
    // -A=val / --also=val.
    if (arg.startsWith('-A=')) {
      const val = arg.slice(3);
      if (val === '') throw new Error('fnclaude: -A= requires a directory argument');
      extraDirs.push(val);
      i++;
      continue;
    }
    if (arg.startsWith('--also=')) {
      const val = arg.slice('--also='.length);
      if (val === '') throw new Error('fnclaude: --also= requires a directory argument');
      extraDirs.push(val);
      i++;
      continue;
    }

    // -w / --worktree (intercepted; NOT pushed to passthrough here).
    if (arg === '-w' || arg === '--worktree') {
      worktreeSet = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        worktreeArg = next;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (arg.startsWith('-w=')) {
      worktreeSet = true;
      worktreeArg = arg.slice(3);
      i++;
      continue;
    }
    if (arg.startsWith('--worktree=')) {
      worktreeSet = true;
      worktreeArg = arg.slice('--worktree='.length);
      i++;
      continue;
    }

    // Single-dash short flags (length >= 2, second char is not '-').
    if (arg.length >= 2 && arg[0] === '-' && arg[1] !== '-') {
      const { tokens, consumed } = parseShortFlag(arg, argv.slice(i + 1));
      passthrough.push(...tokens);
      i += 1 + consumed;
      continue;
    }

    // Everything else passes through.
    passthrough.push(arg);
    i++;
  }

  // Build the magic prefix (--model + --effort) and the subcommand prefix.
  const magicPrefix: string[] = [];
  if (magicModel) magicPrefix.push('--model', magicModel);
  if (magicEffort) magicPrefix.push('--effort', magicEffort);

  let finalPassthrough: string[];
  if (magicPrefix.length > 0) {
    finalPassthrough = [...magicPrefix, ...passthrough];
  } else {
    finalPassthrough = passthrough;
  }
  if (subcommandExpansion && subcommandExpansion.length > 0) {
    finalPassthrough = [...subcommandExpansion, ...finalPassthrough];
  }

  // CWD fallback.
  const cwd = firstPathSet ? firstPath : defaultNoopDir(home);
  const usedNoopFallback = !firstPathSet;

  return {
    cwd,
    extraDirs,
    passthrough: finalPassthrough,
    noTmux,
    worktreeSet,
    worktreeArg,
    usedNoopFallback,
    worktreeMatched: false,
  };
}

// ── Passthrough inspection helpers ─────────────────────────────────────────
//
// The canonical implementations live in passthrough.ts. Re-exported here
// for back-compat with callers that grew up importing them from argParser.
// New code should import from passthrough.ts directly.

export {
  nameInPassthrough,
  settingSourcesInPassthrough,
  tokenInPassthrough,
} from './passthrough.js';
