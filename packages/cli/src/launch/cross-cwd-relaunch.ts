/**
 * §9.3 — Cross-cwd silent relaunch decision.
 *
 * After claude exits the parent fnclaude scans the captured PTY tail
 * for the "To resume, run: cd <dir> && claude --resume <uuid>" hint
 * claude prints when the user picks a session from a different
 * directory via Ctrl-A. When the hint is present (and no other handoff
 * is already in flight), fnclaude silently re-execs itself with a
 * reconstructed argv pointing at the new cwd + session uuid.
 *
 * This module is the *pure* part of that flow: takes the post-exit
 * inputs, returns a relaunch decision (yes/no + argv). The side-
 * effecting re-exec lives in `handoff/awaiter.ts` (shared with §8.5's
 * MCP handoff path) and the call-site lives in `main.ts`.
 *
 * Port of Go canonical `detectCrossCwd` + `reconstructArgv` + the
 * post-exit check in `main.go::run()`. See Go pty_run.go:84+ and
 * main.go:1006+.
 */

import {
  applyOverrides,
  preserveArgs,
  splitLeadingMagic,
} from '../argv/preserve-args.ts';
import { parseCrossCwdHint } from './cross-cwd-parse.ts';

export interface CrossCwdRelaunchInput {
  /** claude's exit code. Non-zero short-circuits — no relaunch. */
  exitCode: number;
  /**
   * Whether the handoff trigger has already accepted a stash. True
   * means an MCP-handoff is in motion; cross-cwd would race it and we
   * defer to the handoff path. Mirrors Go canonical's `len(handoffArgv) > 0`
   * gate in main.go::run().
   */
  alreadyStashed: boolean;
  /**
   * Tail of PTY output captured during the session (§9.1's ring
   * buffer). Decoded to text via TextDecoder; the hint matcher tolerates
   * surrounding ANSI escapes.
   */
  ringSnapshot: Uint8Array;
  /**
   * `process.argv.slice(2)` from the original fnclaude invocation —
   * the user-supplied argv before any internal massaging. This is what
   * survives across the relaunch (modulo positional path → dest swap
   * + injected `--resume`).
   */
  origArgs: readonly string[];
}

export type CrossCwdRelaunchDecision =
  | { relaunch: false }
  | { relaunch: true; argv: string[] };

/**
 * Decide whether to silently relaunch fnclaude in a different cwd.
 *
 * Returns `{relaunch: false}` when any gate fails (non-zero exit,
 * handoff already stashed, no hint, unsafe hint). Returns
 * `{relaunch: true, argv}` when all gates pass — argv is the
 * reconstructed user-side argv ready to feed to the re-exec primitive.
 *
 * Reconstruction mirrors Go canonical's `reconstructArgv`:
 *   1. `preserveArgs(origArgs, {}, {})` — keep magic + flags, drop
 *      positionals (the dest replaces them).
 *   2. `applyOverrides(preserved, {})` — no-op since we don't override
 *      anything cross-cwd; included for parity with the
 *      transfer/restart shape so future overrides have a place to land.
 *   3. `splitLeadingMagic` to peel the magic prefix off the front.
 *   4. `[...magic, dest, '--resume', uuid, ...rest]`.
 */
export function decideCrossCwdRelaunch(
  input: CrossCwdRelaunchInput,
): CrossCwdRelaunchDecision {
  if (input.exitCode !== 0) return { relaunch: false };
  if (input.alreadyStashed) return { relaunch: false };
  if (input.ringSnapshot.length === 0) return { relaunch: false };

  const text = new TextDecoder().decode(input.ringSnapshot);
  const hint = parseCrossCwdHint(text);
  if (hint === null) return { relaunch: false };

  const preserved = preserveArgs(input.origArgs, EMPTY_DENY, EMPTY_BARE_OK);
  const withOverrides = applyOverrides(preserved, {});
  const { magic, rest } = splitLeadingMagic(withOverrides);

  const argv: string[] = [...magic, hint.cwd, '--resume', hint.uuid, ...rest];
  return { relaunch: true, argv };
}

// Pre-allocated empty sets so we don't allocate per call.
const EMPTY_DENY: ReadonlySet<string> = new Set();
const EMPTY_BARE_OK: ReadonlySet<string> = new Set();
