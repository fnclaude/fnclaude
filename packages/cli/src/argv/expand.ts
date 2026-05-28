/**
 * Expand magic-captured aliases into the passthrough flag list claude
 * eventually receives. The parser captures `model`/`effort`/`subcommand`
 * into structured fields; this module emits the corresponding
 * `--model`/`--effort`/`--resume`/`--fork-session` flags and prepends
 * them to the original passthrough.
 *
 * Order: magic flags first (so explicit user-supplied flags appear later
 * and win via claude's last-occurrence semantics). Within the magic
 * block: model → effort → subcommand.
 *
 * §4.3 (effort-without-model → opus) is already handled in the parser
 * by setting `model = 'opus'` when a bare effort is captured at the
 * first magic slot; this module just emits whatever the parser captured.
 *
 * Subcommand mapping (§4.4 / design.md §1):
 *   resume   → --resume
 *   continue → --continue
 *   fork     → --resume --fork-session
 *
 * Mirrors Go canonical `buildClaudeArgs` (`src/main.go` near the magic
 * + subcommand merge point).
 */

import type { CanonicalSubcommand } from './classify.ts';
import type { ParsedArgsOk } from './parse.ts';

const SUBCOMMAND_FLAGS: Record<CanonicalSubcommand, readonly string[]> = {
  resume: ['--resume'],
  continue: ['--continue'],
  fork: ['--resume', '--fork-session'],
};

export function expandAliases(parsed: ParsedArgsOk): string[] {
  const out: string[] = [];

  if (parsed.model !== null) {
    out.push('--model', parsed.model);
  }
  if (parsed.effort !== null) {
    out.push('--effort', parsed.effort);
  }
  if (parsed.subcommand !== null) {
    for (const f of SUBCOMMAND_FLAGS[parsed.subcommand]) out.push(f);
  }

  // Append the original passthrough verbatim.
  for (const tok of parsed.passthrough) out.push(tok);

  return out;
}
