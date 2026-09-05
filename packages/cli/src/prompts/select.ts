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
 *   oobe.md           — the `fnc install` wizard session, INSTEAD of every
 *                       other fragment: that session relays an interview and
 *                       must not also be told how to spawn siblings, switch
 *                       projects, or route a no-project request.
 *
 * Print mode (-p / --print anywhere in passthrough) splits in two:
 *   - program-driven streaming (--input-format/--output-format carries
 *     stream-json): no fragments — the driving program owns interaction.
 *   - one-shot non-streaming print: one-shot.md, telling claude it gets a
 *     single non-interactive turn (no clarifying-question-and-wait).
 *
 * Returns fragment FILE NAMES (not contents). Loading is a separate
 * concern in `prompts/load.ts`.
 */

export interface SelectFragmentsArgs {
  usedNoopFallback: boolean;
  passthrough: readonly string[];
  /**
   * True for the wizard session `fnc install` launches. It replaces the whole
   * selection rather than adding to it (owner, 2026-09-04: inject `oobe.md`
   * INSTEAD of `noop-router.md`).
   */
  oobe?: boolean;
}

export function isInteractiveSession(passthrough: readonly string[]): boolean {
  for (const tok of passthrough) {
    if (tok === '-p' || tok === '--print') return false;
  }
  return true;
}

/**
 * True when `--input-format` or `--output-format` carries the value
 * `stream-json`, in either separate-token (`--output-format stream-json`)
 * or inline (`--output-format=stream-json`) form.
 */
export function usesStreamJson(passthrough: readonly string[]): boolean {
  for (let i = 0; i < passthrough.length; i++) {
    const tok = passthrough[i];
    if (tok === '--input-format' || tok === '--output-format') {
      if (passthrough[i + 1] === 'stream-json') return true;
    } else if (
      tok === '--input-format=stream-json'
      || tok === '--output-format=stream-json'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True for a one-shot, non-interactive print run: print mode (`-p`/`--print`)
 * without the streaming-JSON flags. The stream-json case is program-driven
 * and excluded.
 */
export function isOneShotPrint(passthrough: readonly string[]): boolean {
  return !isInteractiveSession(passthrough) && !usesStreamJson(passthrough);
}

export function selectFragments(args: SelectFragmentsArgs): string[] {
  // The wizard session gets exactly one fragment. Everything else fnc injects
  // tells the model to do something — spawn, switch, restart, route — and the
  // one thing this session must not do is act on its own initiative.
  if (args.oobe === true) return ['oobe.md'];

  if (!isInteractiveSession(args.passthrough)) {
    if (usesStreamJson(args.passthrough)) return [];
    return ['one-shot.md'];
  }

  const out: string[] = ['agent-pitfall.md', 'spawn.md', 'budget.md'];
  if (args.usedNoopFallback) {
    out.push('noop-router.md');
  } else {
    out.push('project-switch.md', 'restart.md');
  }
  return out;
}
