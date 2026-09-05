/**
 * The plan builder: what to ask, in what order, on THIS machine.
 *
 * This is the deterministic half of the OOBE. The model never decides which
 * questions exist or what they say (`oobe.md` is three lines and forbids
 * inventing any); it calls `fnc_oobe_next` and relays. So everything that
 * could go wrong in an interview — asking about something already configured,
 * asking for a branch template when the hook was declined, offering five
 * options to a tool that takes four — is a bug in this file, and testable
 * without a session.
 *
 * Four rules, all from specs/oobe-interview.md:
 *
 *   1. **Skips.** A question whose key is already configured isn't asked. A
 *      batch whose questions are all skipped isn't shown.
 *   2. **Dependencies.** The Repos batch asks only what the chosen tools need:
 *      clone template and "other places" only if fngit was accepted, worktree
 *      template if either tool was, branch template only if the plugin was.
 *      Both declined → the batch is skipped entirely. The git-shim question
 *      needs fngit.
 *   3. **Caps.** At most 4 questions per batch and 4 options per question.
 *      Both are `AskUserQuestion` limits; the free-text "Other" slot the tool
 *      adds does not count against the option cap.
 *   4. **Progress.** The denominator counts the batches that will actually be
 *      shown, after skips — a user who has fngit already should see `(1/3)`,
 *      not `(1/6)` with three screens that never arrive.
 */

import {
  BATCH_SPECS,
  type BatchId,
  type BatchSpec,
  type Question,
  type QuestionId,
  SPAWN_COMMAND_QUESTION,
} from './questions';
import { TMUX_SPAWN_TEMPLATE, type SpawnCandidate, type ToolPresence } from './detect';

/** `AskUserQuestion` limits, verified live 2026-09-04. */
export const MAX_QUESTIONS_PER_BATCH = 4;
export const MAX_OPTIONS_PER_QUESTION = 4;

export interface PlanContext {
  /** What is already installed. Drives the tool-question skips. */
  tools: ToolPresence;
  /**
   * Config keys already set, as dotted paths — `auto.tmux`, `repos.cloneTemplate`.
   * A question whose target path is in here is skipped.
   */
  configured: ReadonlySet<string>;
  /** Spawn-command options, from `detectSpawnCandidates`. */
  spawnCandidates: readonly SpawnCandidate[];
  /**
   * Answers already given in THIS run (or recovered from config). Drives the
   * dependency rules, and skips anything already answered on a resume.
   */
  answers: ReadonlyMap<QuestionId, string | string[]>;
}

export interface PlannedBatch {
  id: BatchId;
  title: string;
  preamble?: string;
  /** 1-based, counting only the batches that will be shown. */
  index: number;
  /** How many batches will be shown in total. */
  total: number;
  /**
   * The line printed in the session before the batch, in the spec's form:
   * `Repos (2/4)`.
   */
  progressText: string;
  /**
   * The `AskUserQuestion` header chip. At most 12 characters, which is why it
   * uses the compact `Repos 2/4` form rather than the printed one — the
   * parenthesised version costs two more characters than "Sessions" can spare.
   */
  progressLabel: string;
  questions: readonly Question[];
}

/** Was a yes/no question answered yes? Unanswered counts as no. */
function saidYes(answers: PlanContext['answers'], id: QuestionId): boolean {
  return answers.get(id) === 'yes';
}

/**
 * Would this tool be present after Apply? True if it is already installed
 * (so the question was skipped) or the user just said yes to installing it.
 */
function willHave(ctx: PlanContext, id: QuestionId, alreadyInstalled: boolean): boolean {
  if (alreadyInstalled) return true;
  return saidYes(ctx.answers, id);
}

/** Should this question be asked at all, given tools, config, and answers? */
function isRelevant(ctx: PlanContext, q: Question): boolean {
  const fngit = willHave(ctx, 'install-fngit', ctx.tools.fngit);
  const plugin = willHave(ctx, 'install-plugin', ctx.tools.plugin);

  switch (q.id) {
    case 'install-fngit':
      return !ctx.tools.fngit;
    case 'install-plugin':
      return !ctx.tools.plugin;
    // Clone destinations and the search list are fngit's to act on.
    case 'clone-template':
    case 'additional-src-dirs':
      return fngit;
    // The worktree template is read by both, so either tool justifies it.
    case 'worktree-template':
      return fngit || plugin;
    // Only the plugin reads the branch template.
    case 'branch-template':
      return plugin;
    case 'git-shim':
      return fngit;
    default:
      return true;
  }
}

/** Is this question's answer already on disk? */
function isConfigured(ctx: PlanContext, q: Question): boolean {
  if (q.target.kind === 'decision') return false;
  return ctx.configured.has(q.target.path);
}

/**
 * Trim an option list to the cap, keeping the recommended option first. The
 * free-text "Other" slot the tool adds automatically is not one of these, so
 * a trimmed list still lets a user type anything that got cut.
 */
export function capOptions(q: Question): Question {
  if (q.options.length <= MAX_OPTIONS_PER_QUESTION) return q;
  return { ...q, options: q.options.slice(0, MAX_OPTIONS_PER_QUESTION) };
}

/**
 * Build the spawn-command question from what's installed.
 *
 * The current terminal is the recommended option because it is the one the
 * user demonstrably has running. Beyond that the ordering from
 * `detectSpawnCandidates` decides which survive the 4-option cap.
 *
 * With nothing detected the question still gets an option — the tmux form,
 * which is the one command that works without knowing the emulator — so the
 * screen is never a bare free-text prompt.
 */
export function buildSpawnQuestion(candidates: readonly SpawnCandidate[]): Question {
  const options = candidates.map((c) => ({
    label: c.isCurrent ? `${c.template} (Recommended)` : c.template,
    description: c.isCurrent
      ? 'your current terminal'
      : c.isTmux
        ? 'when running inside tmux'
        : 'also installed',
    value: c.template,
  }));
  if (options.length === 0) {
    options.push({
      label: `${TMUX_SPAWN_TEMPLATE} (Recommended)`,
      description: 'when running inside tmux',
      value: TMUX_SPAWN_TEMPLATE,
    });
  }
  return capOptions({ ...SPAWN_COMMAND_QUESTION, options });
}

/** Resolve one spec batch to the questions that will actually be asked. */
function resolveBatch(ctx: PlanContext, spec: BatchSpec): Question[] {
  const source: Question[] =
    spec.id === 'sessions'
      ? // The spawn question sits after the starting-directory question, per
        // the interview's order; it is built here because its options depend
        // on the machine.
        [spec.questions[0]!, buildSpawnQuestion(ctx.spawnCandidates), ...spec.questions.slice(1)]
      : [...spec.questions];

  return source
    .filter((q) => isRelevant(ctx, q))
    .filter((q) => !isConfigured(ctx, q))
    .filter((q) => !ctx.answers.has(q.id))
    .map(capOptions)
    .slice(0, MAX_QUESTIONS_PER_BATCH);
}

/**
 * Build the whole plan: every batch that will be shown, in order, with its
 * progress label already resolved. A batch with nothing left to ask is
 * dropped, which is also what ends the interview: once Apply is answered
 * every batch is empty and the plan is empty.
 *
 * Apply is never skippable on its own — its question is a decision, so it is
 * never "already configured", and it is never irrelevant. It is the signoff
 * before anything on the system is touched.
 */
export function buildPlan(ctx: PlanContext): PlannedBatch[] {
  const resolved: { spec: BatchSpec; questions: Question[] }[] = [];
  for (const spec of BATCH_SPECS) {
    const questions = resolveBatch(ctx, spec);
    if (questions.length === 0) continue;
    resolved.push({ spec, questions });
  }

  const total = resolved.length;
  return resolved.map(({ spec, questions }, i) => ({
    id: spec.id,
    title: spec.title,
    ...(spec.preamble !== undefined ? { preamble: spec.preamble } : {}),
    index: i + 1,
    total,
    progressText: progressText(spec.title, i + 1, total),
    progressLabel: progressLabel(spec.title, i + 1, total),
    questions,
  }));
}

/** The printed progress line: `Repos (2/4)`, exactly as the spec writes it. */
export function progressText(title: string, index: number, total: number): string {
  return `${title} (${index}/${total})`;
}

/** The chip's hard limit. */
export const MAX_CHIP_LENGTH = 12;

/**
 * The `AskUserQuestion` header chip, at most {@link MAX_CHIP_LENGTH}
 * characters.
 *
 * The compact `Repos 2/4` form rather than the printed `Repos (2/4)`: the
 * parentheses cost two characters that "Sessions" and "Claude and git" cannot
 * spare, and truncating a batch's name to fit ("Sessio") reads like a bug. The
 * printed line above the batch carries the full form, so nothing is lost.
 *
 * A title still too long for the counter is truncated at a word boundary where
 * one exists, because the counter is the part the user can't get elsewhere.
 */
export function progressLabel(title: string, index: number, total: number): string {
  const counter = ` ${index}/${total}`;
  const room = MAX_CHIP_LENGTH - counter.length;
  if (title.length <= room) return `${title}${counter}`;
  const cutAtSpace = title.lastIndexOf(' ', room);
  const name = cutAtSpace > 0 ? title.slice(0, cutAtSpace) : title.slice(0, Math.max(0, room));
  return `${name}${counter}`;
}

/**
 * The next batch to present, or null when the interview is over.
 *
 * Recomputed from scratch on every call rather than held as a cursor: an
 * answer can change which later questions are relevant (declining fngit
 * removes the whole Repos batch), so a precomputed list would go stale the
 * moment it mattered.
 */
export function nextBatch(ctx: PlanContext): PlannedBatch | null {
  const plan = buildPlan(ctx);
  return plan[0] ?? null;
}
