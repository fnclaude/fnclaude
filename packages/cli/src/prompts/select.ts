/**
 * Prompt-fragment selection (§5.5 / design.md §28, specs.md §12.2).
 *
 * Determines which of the 5 canonical fragment files should be injected
 * via --append-system-prompt for the given launch context.
 *
 * Selection table:
 *   agent-pitfall.md  — every interactive (non -p/--print) session
 *   spawn.md          — every interactive session
 *   budget.md         — every interactive session (#171 get_usage tool)
 *   noop-router.md    — noop fallback only
 *   project-switch.md — non-noop interactive
 *   restart.md        — non-noop interactive
 *
 * Print mode (-p / --print anywhere in passthrough): no fragments
 * injected — claude is being driven non-interactively.
 *
 * Returns fragment FILE NAMES (not contents). Loading is a separate
 * concern in `prompts/load.ts`.
 */

export interface SelectFragmentsArgs {
  usedNoopFallback: boolean;
  passthrough: readonly string[];
}

export function isInteractiveSession(passthrough: readonly string[]): boolean {
  for (const tok of passthrough) {
    if (tok === '-p' || tok === '--print') return false;
  }
  return true;
}

export function selectFragments(args: SelectFragmentsArgs): string[] {
  if (!isInteractiveSession(args.passthrough)) return [];

  const out: string[] = ['agent-pitfall.md', 'spawn.md', 'budget.md'];
  if (args.usedNoopFallback) {
    out.push('noop-router.md');
  } else {
    out.push('project-switch.md', 'restart.md');
  }
  return out;
}
