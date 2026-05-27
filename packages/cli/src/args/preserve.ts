/**
 * preserveArgs + applyOverrides — flag-merging helpers for fnclaude
 * relaunches (restart / transfer). Ported from src/preserve_args.go.
 *
 * preserveArgs picks the subset of os.Args[1:] to carry across a relaunch:
 *   - keeps leading magic words (model alias / effort level) at the front
 *   - strips contiguous non-flag positional tokens (cwd + worktree-name slots)
 *   - keeps everything from the first flag onward, minus any flag in deny
 *     (with its value token if the flag takes a value)
 *
 * applyOverrides folds MCP-supplied Request override fields into the
 * preserved slice — strip-then-append for strings, three-state nil/true/
 * false semantics for booleans.
 *
 * The Go test suite (src/preserve_args_test.go) is the contract; the TS
 * port mirrors every case 1:1.
 */

import type { RequestOverrides } from '../mcp/protocol.js';

// ── Magic-word vocabularies (must match argParser.ts) ──────────────────────

const MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku']);
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** True when tok is a model alias or effort level. */
export function isMagicWord(tok: string): boolean {
  return MODEL_ALIASES.has(tok) || EFFORT_LEVELS.has(tok);
}

/** True when tok looks flag-shaped (starts with "-"). */
export function isFlag(tok: string): boolean {
  return tok.length > 0 && tok.charCodeAt(0) === 0x2d /* '-' */;
}

/**
 * Divide args into [leading-magic-words] and [the rest]. The split stops
 * at the first non-magic token. Used by socket-listener handlers to
 * reposition the magic prefix around the launch cwd / destination.
 */
export function splitLeadingMagic(args: readonly string[]): {
  magic: string[];
  rest: string[];
} {
  let i = 0;
  while (i < args.length && isMagicWord(args[i] as string)) i++;
  return { magic: args.slice(0, i), rest: args.slice(i) };
}

/** True when args contains flag as a standalone token or `flag=value`. */
export function flagPresent(args: readonly string[], flag: string): boolean {
  const prefix = `${flag}=`;
  for (const t of args) {
    if (t === flag || t.startsWith(prefix)) return true;
  }
  return false;
}

// ── preserveArgs ───────────────────────────────────────────────────────────

/**
 * Return the subset of origArgs to carry across an fnclaude relaunch.
 *
 * `deny` is a set of flag tokens (long or short form) to strip. Pass null
 * to preserve all flags. For each denied flag, the flag token AND the
 * immediately-following value token are stripped — UNLESS the flag is in
 * `bareOK`, in which case the bare (no-value) form is allowed and only
 * the flag token is consumed when the following token is itself a flag.
 * The `--flag=value` form is always handled as a single token.
 *
 * Returns a fresh array. Mirrors Go's `preserveArgs(origArgs, deny, bareOK)`.
 */
export function preserveArgs(
  origArgs: readonly string[],
  deny: ReadonlySet<string> | null,
  bareOK: ReadonlySet<string> | null,
): string[] {
  const out: string[] = [];
  let i = 0;

  // Phase 1: collect leading magic words.
  while (i < origArgs.length) {
    const tok = origArgs[i] as string;
    if (isMagicWord(tok)) {
      out.push(tok);
      i++;
      continue;
    }
    break;
  }

  // Phase 2: skip contiguous positional path tokens (non-flag, non-magic).
  while (i < origArgs.length) {
    const tok = origArgs[i] as string;
    if (isFlag(tok)) break; // reached flags — stop skipping paths
    i++;
  }

  // Phase 3: keep flag region, minus any denylisted flag (+ its value).
  while (i < origArgs.length) {
    const tok = origArgs[i] as string;

    // `--` separates flags from the original session's initial prompt
    // (everything after is the prompt body). Carrying it across a
    // relaunch shadows the transfer's @summary file or re-prompts after
    // --resume on restart — drop the separator and the entire tail.
    if (tok === '--') break;

    // Equals-form (--flag=value): match by the flag-prefix-before-= part.
    if (deny !== null) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        const flagPart = tok.slice(0, eq);
        if (deny.has(flagPart)) {
          i++;
          continue;
        }
      }
    }

    // Bare-token deny check.
    if (deny !== null && deny.has(tok)) {
      // Skip the flag token. Also try to consume the following value
      // token unless bareOK says the bare form is acceptable AND the
      // next token is itself a flag.
      i++;
      if (i < origArgs.length) {
        const next = origArgs[i] as string;
        if (bareOK !== null && bareOK.has(tok)) {
          // bareOK: consume the next token only if it's a value
          // (non-flag, doesn't start with '-'). If it's a flag, leave
          // it alone — the bare form is allowed here.
          if (!isFlag(next)) i++;
        } else {
          // Not bareOK: always consume the next token as the value.
          i++;
        }
      }
      continue;
    }

    out.push(tok);
    i++;
  }

  return out;
}

// ── Transfer denylist ──────────────────────────────────────────────────────

/**
 * Flag tokens that must be stripped when preserving args across a project
 * transfer (fnc_switch_project). These are destination-bound or
 * session-state-bound: carrying them into the new session would either be
 * wrong (--add-dir is the OLD project's dir; -A the OLD extras;
 * --mcp-config the OLD config; --settings the OLD settings) or actively
 * bogus (--resume / --continue / --fork-session / --from-pr reference the
 * OLD session id or PR; -w/--worktree is the OLD worktree name; --name is
 * the OLD session name and the transfer supplies a new one).
 *
 * Source of truth: src/preserve_args.go's `transferDenyFlags`.
 */
export const transferDenyFlags: ReadonlySet<string> = new Set([
  '-A',
  '--also',
  '--add-dir',
  '--mcp-config',
  '--settings',
  '-w',
  '--worktree',
  '-P',
  '--from-pr',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
  '-n',
  '--name',
]);

/**
 * Subset of transferDenyFlags that can appear in bare (no-value) form.
 * For these, preserveArgs only consumes the following token when it
 * doesn't look like another flag.
 *
 * Source of truth: src/preserve_args.go's `transferDenyBareOK`.
 */
export const transferDenyBareOK: ReadonlySet<string> = new Set([
  '-w',
  '--worktree',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
  '-P',
  '--from-pr',
]);

// ── applyOverrides ─────────────────────────────────────────────────────────

/**
 * Fold req's override fields into the preserved arg slice.
 *
 * Three-state semantics:
 *   - string field set (non-empty): strip any existing occurrence of the
 *     corresponding flag (including bare-magic-word form for --model and
 *     --effort), then append "--flag <value>" at the end.
 *   - null/undefined boolean: preserve any existing occurrence.
 *   - true boolean: strip existing, append the bare "--flag".
 *   - false boolean: strip existing, do NOT append.
 *
 * Overrides always emit FLAG form (--model sonnet), never magic-positional
 * form, to avoid the awkward case of mixing magic preservation with
 * overrides.
 */
export function applyOverrides(
  preserved: readonly string[],
  req: RequestOverrides,
): string[] {
  let out = preserved.slice();

  // String overrides.
  if (req.model !== undefined && req.model !== '') {
    out = stripFlag(out, '--model');
    out = stripBareMagic(out, MODEL_ALIASES);
    out.push('--model', req.model);
  }
  if (req.effort !== undefined && req.effort !== '') {
    out = stripFlag(out, '--effort');
    out = stripBareMagic(out, EFFORT_LEVELS);
    out.push('--effort', req.effort);
  }
  if (req.permission_mode !== undefined && req.permission_mode !== '') {
    out = stripFlag(out, '--permission-mode');
    out.push('--permission-mode', req.permission_mode);
  }
  if (req.allowed_tools !== undefined && req.allowed_tools !== '') {
    out = stripFlag(out, '--allowedTools');
    out.push('--allowedTools', req.allowed_tools);
  }
  if (req.agent !== undefined && req.agent !== '') {
    out = stripFlag(out, '--agent');
    out.push('--agent', req.agent);
  }

  // Boolean overrides.
  out = applyBoolOverride(out, '--brief', req.brief);
  out = applyBoolOverride(out, '--chrome', req.chrome);
  out = applyBoolOverride(out, '--ide', req.ide);
  out = applyBoolOverride(out, '--verbose', req.verbose);

  return out;
}

/**
 * Remove every occurrence of flag (and its value if present in space-
 * separated form) and every "flag=value" token in args.
 */
export function stripFlag(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i] as string;
    if (tok === flag) {
      // Space form: consume value if present and not another flag.
      i++;
      if (i < args.length && !isFlag(args[i] as string)) {
        i++;
      }
      continue;
    }
    if (tok.startsWith(`${flag}=`)) {
      i++;
      continue;
    }
    result.push(tok);
    i++;
  }
  return result;
}

/** Remove every occurrence of flag as a bare token. */
export function stripFlagBare(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  for (const tok of args) {
    if (tok === flag) continue;
    result.push(tok);
  }
  return result;
}

/**
 * Remove any token that's a member of the given magic-word set. Used so a
 * Model/Effort override strips the bare positional form (e.g. "opus" or
 * "max") and the resulting argv carries only the explicit --model /
 * --effort flag pair appended later.
 */
export function stripBareMagic(
  args: readonly string[],
  magic: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  for (const tok of args) {
    if (magic.has(tok)) continue;
    result.push(tok);
  }
  return result;
}

/**
 * Apply a tri-state boolean override for a bare flag.
 *
 * - undefined/null → preserve existing.
 * - true           → strip existing dupes + append once.
 * - false          → strip existing.
 */
export function applyBoolOverride(
  args: readonly string[],
  flag: string,
  b: boolean | null | undefined,
): string[] {
  if (b === null || b === undefined) {
    return args.slice();
  }
  const out = stripFlagBare(args, flag);
  if (b) out.push(flag);
  return out;
}
