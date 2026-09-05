/**
 * The three MCP tools the OOBE wizard session calls.
 *
 *   `fnc_oobe_next()`      → the next batch of questions, as data, or done
 *   `fnc_oobe_answer(id, value)` → record one answer
 *   `fnc_oobe_reask(id)`   → re-present one question
 *
 * These are the whole interface between the model and the interview. The model
 * relays: it never composes a question, never picks which to ask, never
 * decides when the interview is over. `oobe.md` says so in three lines, and
 * this is the surface that makes obeying it the only thing the model *can* do
 * — there is no tool here for inventing a question.
 *
 * The state lives in the fnc PARENT process, not the subprocess: the wizard's
 * answers have to survive across every tool call in the session, and the MCP
 * subprocess is per-connection. That is why these are parent-dispatch handlers
 * bound to one {@link OobeState}, exactly like the restart and switch handlers.
 */

import type { WireRequest, WireResponse } from '../wire';
import type { OobeState } from '../../oobe/state';
import type { PlannedBatch } from '../../oobe/plan';
import type { Question } from '../../oobe/questions';

/**
 * Render a question for the model. Deliberately close to `AskUserQuestion`'s
 * own shape so the relay is mechanical: fewer decisions in the model means
 * fewer ways for the reviewed text to come out paraphrased.
 */
function renderQuestion(q: Question): Record<string, unknown> {
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    ...(q.detail !== undefined ? { detail: q.detail } : {}),
    ...(q.multiSelect === true ? { multi_select: true } : {}),
    options: q.options.map((o) => ({
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
      value: o.value ?? o.label,
    })),
    ...(q.freeText !== undefined ? { other_hint: q.freeText } : {}),
  };
}

function renderBatch(batch: PlannedBatch): Record<string, unknown> {
  return {
    batch: batch.id,
    title: batch.title,
    ...(batch.preamble !== undefined ? { preamble: batch.preamble } : {}),
    // The line to print before asking, e.g. `Repos (2/4)`.
    progress_text: batch.progressText,
    // The header chip every question in this batch carries, e.g. `Repos 2/4`.
    // Separate from the printed line because the chip has a 12-character cap.
    progress: batch.progressLabel,
    index: batch.index,
    total: batch.total,
    questions: batch.questions.map(renderQuestion),
  };
}

export interface OobeHandlerArgs {
  state: OobeState;
  /**
   * Runs the Apply actions once the Apply question is answered. Injected
   * because it touches the system, and because the caller (`fnc install`)
   * owns the restart that follows.
   */
  onApply: () => Promise<{ summary: string }>;
  /** Called when the user aborts at the Apply screen. */
  onAbort?: () => void;
}

/** `fnc_oobe_next` — hand back the next batch, or say the interview is done. */
export function createOobeNextHandler(args: OobeHandlerArgs) {
  return async (_req: WireRequest): Promise<WireResponse> => {
    const { batch } = args.state.next();
    if (batch === null) {
      return { action: 'done', done: true, message: 'The interview is complete.' };
    }
    return { action: 'question', done: false, ...renderBatch(batch) };
  };
}

/**
 * `fnc_oobe_answer` — record one answer.
 *
 * The Apply answer is the one that does something: it runs the actions and
 * returns their summary, which the model prints. Everything else just lands in
 * the config and returns `ok`.
 */
export function createOobeAnswerHandler(args: OobeHandlerArgs) {
  return async (req: WireRequest): Promise<WireResponse> => {
    const id = typeof req.id === 'string' ? req.id : '';
    if (id === '') {
      return { action: 'error', error: 'missing `id`: which question is this answering?' };
    }
    const raw = req.value;
    const value: string | string[] = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string')
      : typeof raw === 'string'
        ? raw
        : '';

    const result = args.state.answer(id, value);
    if (!result.ok) {
      return { action: 'error', error: result.error ?? 'could not record that answer' };
    }
    if (result.aborted === true) {
      args.onAbort?.();
      return {
        action: 'done',
        done: true,
        message:
          'Aborted. Your answers are saved; nothing else was touched. Run `fnc install` again any time.',
      };
    }
    if (result.applied === true) {
      const { summary } = await args.onApply();
      return { action: 'done', done: true, message: summary };
    }
    return { action: 'ok', ok: true };
  };
}

/**
 * `fnc_oobe_reask` — re-present one question.
 *
 * This is what the Apply screen's free-text slot resolves to: the user types
 * "change the clone template", the model maps that to a question id, and the
 * question comes back on its own. "Go back" was dropped as a navigation
 * concept precisely because answers are already written — there is no stack to
 * pop, only a key to set again.
 */
export function createOobeReaskHandler(args: OobeHandlerArgs) {
  return async (req: WireRequest): Promise<WireResponse> => {
    const id = typeof req.id === 'string' ? req.id : '';
    if (id === '') {
      return { action: 'error', error: 'missing `id`: which question should be re-asked?' };
    }
    const result = args.state.reask(id);
    if (!result.ok || result.question === undefined) {
      return { action: 'error', error: result.error ?? 'could not re-ask that question' };
    }
    return { action: 'question', done: false, questions: [renderQuestion(result.question)] };
  };
}
