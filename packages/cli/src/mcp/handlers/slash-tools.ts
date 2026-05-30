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

import { writeFileSync } from 'node:fs';

import { EFFORTS, MODELS } from '../../argv/classify.ts';
import { createCompactAcceptGate } from '../../usage/context-monitor.ts';
import type { ParentDispatchHandler } from '../parent-dispatch.ts';
import type { WireRequest, WireResponse } from '../wire.ts';
import { type PtyWriter, formatSlashCommand, injectSubmittedLine } from './inject-slash.ts';

const QUEUED: WireResponse = { action: 'queued' };

export interface SlashToolDeps {
  /**
   * The bound PTY input sink — same writer the keystone uses. In
   * production this is a {@link createPtyWriterHolder} `.write`; in tests
   * it's a spy. Synchronous, fire-and-forget.
   */
  write: PtyWriter;
  /**
   * Timer seam threaded into {@link injectSubmittedLine} for the separate
   * CR write. Defaults (inside the primitive) to {@link setTimeout}. Tests
   * pass a synchronous `(fn) => fn()` so the two writes land deterministically.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
}

/** Follow-up spill threshold — longer than this (chars) goes to a file. */
const FOLLOW_UP_SPILL_LIMIT = 200;

/**
 * Compact handler deps. Extends {@link SlashToolDeps} with the follow-up
 * spill + accept-gate seams so the follow_up submits as its OWN line, AFTER
 * claude accepts the `/compact` prompt — never in the same synchronous burst.
 */
export interface RequestCompactDeps extends SlashToolDeps {
  /**
   * Persist a long/multi-line follow_up to a file and return its path. The
   * handler then injects a pointer line instead of the raw body. Defaults to
   * writing `/tmp/fnc-followup-<pid>-<ts>.md`. Tests inject a fake that
   * records the content and returns a fixed path.
   */
  spillFollowUp?: (content: string) => string;
  /**
   * The gate awaited between submitting `/compact` and submitting the
   * follow_up. Defaults to {@link createCompactAcceptGate} bound to
   * `launchCWD`. If injected, `launchCWD` is ignored.
   */
  awaitAccepted?: () => Promise<void>;
  /** Launch cwd — builds the DEFAULT accept-gate. Ignored if `awaitAccepted` is injected. */
  launchCWD?: string;
  /**
   * Test hook: receives the detached follow_up promise so tests can await
   * the gated work deterministically. Undefined in production =>
   * fire-and-forget.
   */
  trackFollowUp?: (p: Promise<void>) => void;
}

/** Default file-spill: write the follow_up to a unique /tmp markdown file. */
function defaultSpillFollowUp(content: string): string {
  const path = `/tmp/fnc-followup-${process.pid}-${Date.now()}.md`;
  writeFileSync(path, content, 'utf8');
  return path;
}

/** A follow_up needs file-spill when it is multi-line or long. */
function followUpNeedsFile(followUp: string): boolean {
  return followUp.includes('\n') || followUp.length > FOLLOW_UP_SPILL_LIMIT;
}

/** Pointer line injected in place of a spilled follow_up body. */
function followUpPointer(path: string): string {
  return `Read the file ${path} and follow the instructions in it.`;
}

/**
 * C1 — `request_compact` (#170).
 *
 * Submits `/compact [instructions]` through {@link injectSubmittedLine} so it
 * is actually dispatched (bracketed-paste body + separate CR), not just
 * dropped into the input box.
 *
 * When `follow_up` is provided it is submitted as its OWN, SEPARATE
 * `injectSubmittedLine` call — never back-to-back with `/compact`. The
 * handler returns `{ action: 'queued' }` IMMEDIATELY, then a detached promise:
 *
 *   1. awaits the accept gate (`awaitAccepted`) — by default this polls the
 *      live session JSONL for a post-submit size change so the follow_up only
 *      lands once claude has accepted the `/compact` prompt;
 *   2. spills a long/multi-line follow_up to a file and injects a POINTER
 *      line instead of the raw body, otherwise injects it inline.
 *
 * The follow_up submit happening as its own gated write is the "never
 * back-to-back" guarantee: a line written in the same synchronous burst as
 * `/compact` would be swallowed by the compact prompt rather than run as the
 * next user turn.
 *
 * NO output capture — returns `{ action: 'queued' }` regardless.
 */
export function createRequestCompactHandler(deps: RequestCompactDeps): ParentDispatchHandler {
  const { write } = deps;
  const injectDeps = { write, schedule: deps.schedule, enterDelayMs: deps.enterDelayMs };
  const spill = deps.spillFollowUp ?? defaultSpillFollowUp;
  const gate = deps.awaitAccepted ?? createCompactAcceptGate({ launchCWD: deps.launchCWD ?? '' });

  return async (req: WireRequest): Promise<WireResponse> => {
    const instructions = typeof req.instructions === 'string' ? req.instructions.trim() : '';
    // KEEP the instructions arg as-is — it steers compaction.
    const args = instructions === '' ? [] : [instructions];
    injectSubmittedLine(formatSlashCommand('compact', args), injectDeps);

    const followUp = typeof req.follow_up === 'string' ? req.follow_up.trim() : '';
    if (followUp !== '') {
      const p = (async (): Promise<void> => {
        // Gate on /compact acceptance: the follow_up must NOT land in the
        // same synchronous burst as /compact (it would be eaten by the
        // compact prompt). Resolve once claude has accepted, then submit.
        await gate();
        const line = followUpNeedsFile(followUp)
          ? followUpPointer(spill(followUp))
          : followUp;
        injectSubmittedLine(line, injectDeps);
      })();
      deps.trackFollowUp?.(p); // undefined in prod => fire-and-forget
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
    injectSubmittedLine(formatSlashCommand('effort', [level]), {
      write,
      schedule: deps.schedule,
      enterDelayMs: deps.enterDelayMs,
    });
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
    injectSubmittedLine(formatSlashCommand('model', [model]), {
      write,
      schedule: deps.schedule,
      enterDelayMs: deps.enterDelayMs,
    });
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
    injectSubmittedLine(formatSlashCommand(command, args), {
      write,
      schedule: deps.schedule,
      enterDelayMs: deps.enterDelayMs,
    });
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
