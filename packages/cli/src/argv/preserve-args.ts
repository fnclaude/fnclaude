/**
 * Shared argv-preservation + override helpers.
 *
 * Foundation for transfer (§8.x) and silent-relaunch (§9.3) flows: both
 * need to take the user's original argv, strip a destination/state-bound
 * subset of flags, and optionally splice in caller-supplied overrides
 * before re-execing fnc.
 *
 * Ports the Go canonical `preserveArgs` + `applyOverrides` from
 * `fnclaude/src/preserve_args.go` — same three-phase walk
 * (magic → positionals → flags) and the same three-state override
 * semantics (string non-empty replaces; bool undefined preserves; bool
 * true/false enforces presence/absence).
 *
 * Pure module: no I/O, no spawn, no relaunch wiring. The §8/§9 commits
 * compose this with side-effect code at the boundary.
 */

import { EFFORTS, MODELS } from './classify';

// ─────────────────────────────────────────────────────────────────────────────
// Transfer denylists (consumed by §8.x — re-exported here so callers don't
// duplicate the lists)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flag tokens stripped when preserving args across a project transfer
 * (`fnc_switch_project`). These are destination-bound or session-state-
 * bound — carrying them into the new session would either be wrong
 * (--add-dir is the OLD project's dir, -A the OLD extras, --mcp-config
 * the OLD config, --settings the OLD settings) or actively bogus
 * (--resume / --continue / --fork-session / --from-pr reference the
 * OLD session id or PR; -w/--worktree is the OLD worktree name; --name
 * is the OLD session name and the transfer supplies a new one).
 */
export const TRANSFER_DENY_FLAGS: ReadonlySet<string> = new Set([
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
 * Subset of `TRANSFER_DENY_FLAGS` that may appear in bare (no-value) form.
 * For these, `preserveArgs` only consumes the following token when it
 * doesn't itself look like another flag — leaving subsequent flags alone.
 */
export const TRANSFER_DENY_BARE_OK: ReadonlySet<string> = new Set([
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

// ─────────────────────────────────────────────────────────────────────────────
// Magic-word membership (private — callers reach for `splitLeadingMagic`)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_SET: ReadonlySet<string> = new Set(MODELS);
const EFFORT_SET: ReadonlySet<string> = new Set(EFFORTS);

function isMagicWord(tok: string): boolean {
  return MODEL_SET.has(tok) || EFFORT_SET.has(tok);
}

function isFlag(tok: string): boolean {
  return tok.startsWith('-');
}

// ─────────────────────────────────────────────────────────────────────────────
// splitLeadingMagic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walks args left-to-right and returns the leading run of magic words
 * (model alias / effort level — subcommands are NOT included). The first
 * non-magic token ends the run. Used by transfer/restart callers that
 * need to keep the user's magic prefix at the front of the relaunched
 * argv without re-parsing it.
 */
export function splitLeadingMagic(args: readonly string[]): {
  magic: string[];
  rest: string[];
} {
  let i = 0;
  while (i < args.length && isMagicWord(args[i]!)) {
    i++;
  }
  return { magic: args.slice(0, i), rest: args.slice(i) };
}

// ─────────────────────────────────────────────────────────────────────────────
// preserveArgs — three-phase walk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the subset of `origArgs` to carry across an fnclaude relaunch.
 *
 *  - Phase 1: collect leading magic words (model alias / effort level).
 *  - Phase 2: skip contiguous non-flag, non-magic positional tokens
 *    (cwd + optional worktree-name slot).
 *  - Phase 3: keep flag-region tokens, minus any flag listed in `deny`.
 *    For each denied flag, the flag token AND the immediately-following
 *    value token are stripped — UNLESS the flag is in `bareOK`, in which
 *    case the bare form is allowed and the next token is only consumed
 *    when it doesn't itself look like a flag. The `--flag=value` form
 *    is always handled as a single token.
 *
 * Pass an empty set for `deny` to preserve all flags.
 */
export function preserveArgs(
  origArgs: readonly string[],
  deny: ReadonlySet<string>,
  bareOK: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  let i = 0;

  // Phase 1 — leading magic words.
  while (i < origArgs.length && isMagicWord(origArgs[i]!)) {
    out.push(origArgs[i]!);
    i++;
  }

  // Phase 2 — skip contiguous positional tokens (non-flag, non-magic).
  while (i < origArgs.length && !isFlag(origArgs[i]!)) {
    i++;
  }

  // Phase 3 — flag region with denylist applied.
  while (i < origArgs.length) {
    const tok = origArgs[i]!;

    // Equals-form: match deny by the prefix before `=`.
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const flagPart = tok.slice(0, eq);
      if (deny.has(flagPart)) {
        i++;
        continue;
      }
    }

    // Bare-token deny check.
    if (deny.has(tok)) {
      i++;
      if (i < origArgs.length) {
        const next = origArgs[i]!;
        if (bareOK.has(tok)) {
          // bareOK: only consume next if it's not itself a flag.
          if (!isFlag(next)) {
            i++;
          }
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

// ─────────────────────────────────────────────────────────────────────────────
// applyOverrides
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three-state override request. String fields use empty-string-or-undefined
 * = "preserve" semantics. Boolean fields use the explicit three-state form
 * (undefined = preserve; true = ensure-present; false = ensure-absent).
 */
export interface OverrideRequest {
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string;
  agent?: string;
  brief?: boolean;
  chrome?: boolean;
  ide?: boolean;
  verbose?: boolean;
}

/**
 * Takes a preserved arg slice and replaces or appends flags according to
 * `req`'s override fields. Per design.md §13:
 *
 *  - String field set (non-empty): strip any existing occurrence of the
 *    corresponding flag (including the bare-magic-word form for `--model`
 *    and `--effort` — `opus`/`sonnet`/`haiku` and `low`/`medium`/`high`/
 *    `xhigh`/`max`/`auto`), then append `--flag <value>` at the end.
 *  - Boolean field undefined: preserve existing occurrences.
 *  - Boolean field true: strip existing, append `--flag`.
 *  - Boolean field false: strip existing, do NOT append.
 *
 * Overrides always emit flag form (`--model sonnet`), never the magic-
 * positional form, to avoid awkward mixing.
 */
export function applyOverrides(
  preserved: readonly string[],
  req: OverrideRequest,
): string[] {
  let out: string[] = [...preserved];

  // String overrides — strip any existing form, then append flag-pair.
  if (req.model !== undefined && req.model !== '') {
    out = stripFlag(out, '--model');
    out = stripBareMagic(out, MODEL_SET);
    out.push('--model', req.model);
  }
  if (req.effort !== undefined && req.effort !== '') {
    out = stripFlag(out, '--effort');
    out = stripBareMagic(out, EFFORT_SET);
    out.push('--effort', req.effort);
  }
  if (req.permissionMode !== undefined && req.permissionMode !== '') {
    out = stripFlag(out, '--permission-mode');
    out.push('--permission-mode', req.permissionMode);
  }
  if (req.allowedTools !== undefined && req.allowedTools !== '') {
    out = stripFlag(out, '--allowedTools');
    out.push('--allowedTools', req.allowedTools);
  }
  if (req.agent !== undefined && req.agent !== '') {
    out = stripFlag(out, '--agent');
    out.push('--agent', req.agent);
  }

  // Boolean overrides — undefined = preserve; true = strip + append; false = strip.
  out = applyBoolOverride(out, '--brief', req.brief);
  out = applyBoolOverride(out, '--chrome', req.chrome);
  out = applyBoolOverride(out, '--ide', req.ide);
  out = applyBoolOverride(out, '--verbose', req.verbose);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// strip helpers (private)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove every occurrence of `flag` (consuming the following value token
 * if it's not itself a flag) and every `flag=value` token in `args`.
 */
function stripFlag(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  const eqPrefix = `${flag}=`;
  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok === flag) {
      i++;
      if (i < args.length && !isFlag(args[i]!)) {
        i++;
      }
      continue;
    }
    if (tok.startsWith(eqPrefix)) {
      i++;
      continue;
    }
    result.push(tok);
    i++;
  }
  return result;
}

/**
 * Remove every bare-token occurrence of `flag` (no value consumed).
 * Used for boolean flags that take no argument.
 */
function stripFlagBare(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  for (const tok of args) {
    if (tok !== flag) result.push(tok);
  }
  return result;
}

/**
 * Remove any token whose value is in `magic`. Used so a `--model` or
 * `--effort` override strips the bare magic-positional form (e.g. `opus`
 * or `max`) — the resulting argv carries only the explicit flag-pair
 * appended afterward.
 */
function stripBareMagic(args: readonly string[], magic: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const tok of args) {
    if (!magic.has(tok)) result.push(tok);
  }
  return result;
}

/**
 * Apply a tri-state bool override for a bare flag (e.g. `--ide`):
 * undefined = preserve; true = strip + append once; false = strip.
 */
function applyBoolOverride(
  args: readonly string[],
  flag: string,
  b: boolean | undefined,
): string[] {
  if (b === undefined) return [...args];
  const out = stripFlagBare(args, flag);
  if (b) out.push(flag);
  return out;
}
