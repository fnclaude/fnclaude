/**
 * Batch-2 MCP tool handlers — thin wrappers over the C0 slash-injection
 * keystone ({@link createInjectSlashHandler} in `./inject-slash.ts`).
 *
 * Four user-facing tools, all sharing the same mechanism: format a slash
 * command and write it into the live claude TUI input exactly where the
 * user's keystrokes go. Fire-and-forget — each returns `{ action:
 * 'queued' }` and captures NO output. The model asked for the command to
 * run; it does not receive the command's result back through this path.
 *
 *   - request_compact   → "/compact [instructions]"  (+ optional follow_up)
 *   - fnc_set_effort     → "/effort <level>"           (validated)
 *   - fnc_set_model      → "/model <name>"             (validated)
 *   - fnc_run_slash_command → "/<raw>"                 (opt-in, generic)
 *
 * Each handler takes the bound {@link PtyWriter} and translates its own
 * wire fields into a keystone call. Validation that's specific to a tool
 * (effort vocabulary, model vocabulary) lives here, NOT in the keystone —
 * the keystone stays generic and only refuses an empty command.
 */

import { EFFORTS, MODELS } from '../../argv/classify.ts';
import type { ParentDispatchHandler } from '../parent-dispatch.ts';
import type { WireRequest, WireResponse } from '../wire.ts';
import { type PtyWriter, formatSlashCommand } from './inject-slash.ts';

const QUEUED: WireResponse = { action: 'queued' };

export interface SlashToolDeps {
  /**
   * The bound PTY input sink — same writer the keystone uses. In
   * production this is a {@link createPtyWriterHolder} `.write`; in tests
   * it's a spy. Synchronous, fire-and-forget.
   */
  write: PtyWriter;
}

/**
 * C1 — `request_compact` (#170).
 *
 * Queues `/compact [instructions]`. When `follow_up` is provided, ALSO
 * queues it as a normal prompt submission (a second write WITHOUT a
 * leading slash) so the model auto-resumes after the compaction settles.
 * Both writes are queued in order: compact first, then follow_up.
 *
 * NO output capture — returns `{ action: 'queued' }` regardless.
 */
export function createRequestCompactHandler(deps: SlashToolDeps): ParentDispatchHandler {
  const { write } = deps;
  return async (req: WireRequest): Promise<WireResponse> => {
    const instructions = typeof req.instructions === 'string' ? req.instructions.trim() : '';
    const args = instructions === '' ? [] : [instructions];
    write(formatSlashCommand('compact', args));

    const followUp = typeof req.follow_up === 'string' ? req.follow_up.trim() : '';
    if (followUp !== '') {
      // A plain prompt line (no leading slash) submitted with the same
      // CR-terminator a real keystroke carries. Queued immediately after
      // /compact so the idle post-compaction TUI picks it up as the next
      // user turn.
      //
      // TODO(#170): a line queued *during* compaction may be consumed
      // after the compact finishes — or dropped, since compaction reloads
      // context. If this simple queued-both version proves lossy in live
      // use, the fallback is to detect post-compact completion (poll the
      // session JSONL for the post-compact summary record) and only then
      // write the follow_up. Not built here — needs live verification first.
      write(`${followUp}\r`);
    }

    return QUEUED;
  };
}

/**
 * C2 — `fnc_set_effort`. Validates the level against fnc's actual effort
 * vocabulary ({@link EFFORTS}) before queueing `/effort <level>`. Rejects
 * anything outside the vocabulary with a clear error and writes nothing.
 *
 * Open question (shipped on the slash-inject default): whether `/effort`
 * is a live TUI slash command. If it turns out NOT to be one, the
 * fallback is the restart-with-effort-override path fnc_restart already
 * supports. See the PR body.
 */
export function createSetEffortHandler(deps: SlashToolDeps): ParentDispatchHandler {
  const { write } = deps;
  const valid = new Set<string>(EFFORTS);
  return async (req: WireRequest): Promise<WireResponse> => {
    const level = typeof req.effort === 'string' ? req.effort.trim() : '';
    if (level === '') {
      return { action: 'error', error: 'fnc_set_effort requires an effort level.' };
    }
    if (!valid.has(level)) {
      return {
        action: 'error',
        error: `invalid effort ${JSON.stringify(level)}; expected one of: ${EFFORTS.join(', ')}.`,
      };
    }
    write(formatSlashCommand('effort', [level]));
    return QUEUED;
  };
}

/**
 * C3 — `fnc_set_model`. Validates the model against fnc's vocabulary
 * ({@link MODELS}) before queueing `/model <name>`. Same slash-vs-restart
 * open question as C2; shipped on the slash-inject default.
 */
export function createSetModelHandler(deps: SlashToolDeps): ParentDispatchHandler {
  const { write } = deps;
  const valid = new Set<string>(MODELS);
  return async (req: WireRequest): Promise<WireResponse> => {
    const model = typeof req.model === 'string' ? req.model.trim() : '';
    if (model === '') {
      return { action: 'error', error: 'fnc_set_model requires a model name.' };
    }
    if (!valid.has(model)) {
      return {
        action: 'error',
        error: `invalid model ${JSON.stringify(model)}; expected one of: ${MODELS.join(', ')}.`,
      };
    }
    write(formatSlashCommand('model', [model]));
    return QUEUED;
  };
}

/**
 * C4 — `fnc_run_slash_command` (OPT-IN). Generic escape hatch: queues
 * `/<command> [args...]` for an arbitrary slash command. Registered only
 * when opted in (see {@link slashToolEnabled}); when off it does not
 * appear in the MCP tool list at all.
 *
 * Refuses an empty command (so we never inject a bare `/\r`). Everything
 * else is the caller's responsibility — this is the deliberately
 * unvalidated generic path.
 */
export function createRunSlashCommandHandler(deps: SlashToolDeps): ParentDispatchHandler {
  const { write } = deps;
  return async (req: WireRequest): Promise<WireResponse> => {
    const command = typeof req.command === 'string' ? req.command.trim() : '';
    if (command === '') {
      return { action: 'error', error: 'fnc_run_slash_command requires a command string.' };
    }
    const args = normalizeArgs(req.args);
    write(formatSlashCommand(command, args));
    return QUEUED;
  };
}

/**
 * Opt-in gate for C4. The generic slash tool is risky (arbitrary command
 * injection into the live TUI), so it is hidden by default and surfaced
 * only when the operator explicitly enables it via `FNC_ENABLE_SLASH_TOOL=1`.
 */
export function slashToolEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FNC_ENABLE_SLASH_TOOL === '1';
}

/** Coerce a wire `args` field into a string array (mirrors inject-slash). */
function normalizeArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  if (Array.isArray(raw)) {
    return raw.filter((v) => v !== undefined && v !== null).map((v) => String(v));
  }
  return [];
}
