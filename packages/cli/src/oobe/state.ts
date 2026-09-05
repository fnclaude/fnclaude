/**
 * The interview's state, and the three operations the MCP tools expose.
 *
 * The shape that makes this work is: **plan in code, relay in the model.**
 * `fnc_oobe_next` hands back the next batch as data; the model presents it
 * with one `AskUserQuestion` and posts each answer to `fnc_oobe_answer`;
 * `fnc_oobe_reask` re-presents one question when the user asks to change
 * something from the Apply screen. The model decides nothing.
 *
 * **Every answer is written to the config file as it arrives.** That is what
 * makes an interrupted wizard resumable without any resume machinery: the next
 * launch reads the config, sees those keys set, and skips their questions. The
 * cost is that the config is briefly half-configured, which is fine — every
 * key it holds is one the user actually chose.
 *
 * What does NOT get written before Apply: anything outside the config file.
 * Creating the starting directory, installing tools, PATH edits, `noOobe`,
 * and the restart all wait for the signoff. Abort therefore leaves the answers
 * saved and the system untouched, and the wizard is offered again next launch.
 */

import { fncConfigWritePath, type XdgEnv, sharedConfigDir } from '../config/paths';
import { writeFncConfig } from '../config/write';
import { type SpawnCandidate, type ToolPresence } from './detect';
import { type PlannedBatch, buildSpawnQuestion, nextBatch, progressLabel } from './plan';
import { type Question, type QuestionId, findQuestion } from './questions';
import { join } from 'node:path';

/** A single answer as the model posts it. */
export type AnswerValue = string | string[];

export interface OobeStateArgs {
  env: XdgEnv;
  tools: ToolPresence;
  spawnCandidates: readonly SpawnCandidate[];
  /** Config keys already set on disk, as dotted paths. */
  configured: ReadonlySet<string>;
  /**
   * Write seam for the fnc config. Defaults to the real writer. The shared
   * config is written by `fngit install`, not here — fnc owns the interview,
   * fngit owns its own file (specs/rhombus-rocks-config.md).
   */
  writeFnc?: (path: string, patch: Record<string, unknown>) => void;
}

export interface NextResult {
  /** null when the interview is over. */
  batch: PlannedBatch | null;
}

export interface AnswerResult {
  ok: boolean;
  /** Why an answer was rejected. Absent on success. */
  error?: string;
  /** True once Apply has been answered — the caller runs the actions. */
  applied?: boolean;
  /** True when the user aborted at the Apply screen. */
  aborted?: boolean;
}

/**
 * Turn a dotted path into a nested patch object: `auto.tmux` + `never`
 * becomes `{ auto: { tmux: 'never' } }`. The writer merges it in, so setting
 * one key under `auto` leaves the others alone.
 */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const out: Record<string, unknown> = {};
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]!] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]!] = value;
  return out;
}

/**
 * Coerce a posted answer into what the config should hold.
 *
 * Two questions need it. `claude.defaultArgs` is an array in the config but
 * arrives either as the multi-select's list or as a free-text string of
 * space-separated flags. `repos.additionalSrcDirs` is an array in the config
 * but is presented, and typed, as a comma-separated line.
 */
export function coerceAnswer(id: QuestionId, value: AnswerValue): unknown {
  if (id === 'claude-flags') {
    const list = Array.isArray(value) ? value : [value];
    return list
      .flatMap((v) => v.split(/\s+/))
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  if (id === 'additional-src-dirs') {
    const raw = Array.isArray(value) ? value.join(',') : value;
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return Array.isArray(value) ? value.join(' ') : value;
}

export class OobeState {
  private readonly args: OobeStateArgs;
  private readonly answers = new Map<QuestionId, AnswerValue>();
  /** Config paths written during this run, on top of what was already set. */
  private readonly written = new Set<string>();
  /**
   * Config paths a `reask` re-opened. These override `configured`: a user who
   * asks to change the clone template must be asked again even though the key
   * is on disk — which, after the first answer, it always is.
   */
  private readonly reopened = new Set<string>();
  /** Set when Apply is answered, so `next` stops handing out batches. */
  private finished: 'applied' | 'aborted' | null = null;

  constructor(args: OobeStateArgs) {
    this.args = args;
  }

  /** Answers collected so far, for the Apply preview and the install actions. */
  answersSnapshot(): ReadonlyMap<QuestionId, AnswerValue> {
    return new Map(this.answers);
  }

  outcome(): 'applied' | 'aborted' | null {
    return this.finished;
  }

  /**
   * The next batch, or null when the interview is over.
   *
   * Recomputed from the current answers each time rather than walked as a
   * cursor: declining fngit removes the whole Repos batch, so a precomputed
   * sequence would go stale exactly when it mattered.
   */
  next(): NextResult {
    if (this.finished !== null) return { batch: null };
    const batch = nextBatch({
      tools: this.args.tools,
      configured: this.union(),
      spawnCandidates: this.args.spawnCandidates,
      answers: this.answers,
    });
    return { batch };
  }

  /**
   * Record one answer, and write it to the config immediately when it maps to
   * a config key. A `decision` answer (install fngit, install the plugin, the
   * git shim, Apply itself) is held in memory: it isn't a setting, it's an
   * instruction for the Apply step.
   */
  answer(id: string, value: AnswerValue): AnswerResult {
    if (this.finished !== null) {
      return { ok: false, error: 'the interview is already finished' };
    }
    const question = this.resolve(id);
    if (question === undefined) {
      return { ok: false, error: `unknown question id ${JSON.stringify(id)}` };
    }

    if (question.id === 'apply') {
      const choice = Array.isArray(value) ? value[0] : value;
      if (choice === 'abort') {
        this.finished = 'aborted';
        return { ok: true, aborted: true };
      }
      this.answers.set('apply', 'apply');
      this.finished = 'applied';
      return { ok: true, applied: true };
    }

    this.answers.set(question.id, value);

    if (question.target.kind !== 'decision') {
      const coerced = coerceAnswer(question.id, value);
      // fnc's own keys are written here. Shared-config keys (`repos.*`) are
      // collected and handed to `fngit install -y`, which owns that file —
      // two writers on one document is how merge conflicts start.
      if (question.target.kind === 'fnc') {
        const write = this.args.writeFnc ?? writeFncConfig;
        try {
          write(fncConfigWritePath(this.args.env), patchFor(question.target.path, coerced));
        } catch (err) {
          return { ok: false, error: `could not save the answer: ${(err as Error).message}` };
        }
      }
      this.written.add(question.target.path);
    }
    return { ok: true };
  }

  /**
   * Re-present one question. Used from the Apply screen's free-text slot: the
   * user says "change the clone template", the model maps that to a question
   * id, and this hands the question back and forgets the previous answer so
   * `next` will ask it again.
   */
  reask(id: string): { ok: boolean; question?: Question; error?: string } {
    const question = this.resolve(id);
    if (question === undefined) {
      return { ok: false, error: `unknown question id ${JSON.stringify(id)}` };
    }
    if (question.id === 'apply') {
      return { ok: false, error: 'the Apply screen cannot be re-asked; answer it instead' };
    }
    this.answers.delete(question.id);
    if (question.target.kind !== 'decision') {
      this.written.delete(question.target.path);
      // The key is still on disk — the answer was written the moment it was
      // given — so forgetting the answer is not enough on its own. Mark the
      // path re-opened so the skip check stops matching it.
      this.reopened.add(question.target.path);
    }
    // Re-opening a question means the interview is no longer finished, so an
    // Apply that was already answered is withdrawn along with it.
    if (this.finished === 'applied') this.finished = null;
    this.answers.delete('apply');
    return { ok: true, question };
  }

  /** Shared-config keys the wizard collected, for `fngit install -y`. */
  sharedAnswers(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, value] of this.answers) {
      const q = this.resolve(id);
      if (q?.target.kind !== 'shared') continue;
      out[q.target.path] = coerceAnswer(id, value);
    }
    return out;
  }

  /** Where the shared config lives, for the closing note. */
  sharedConfigPath(): string {
    return join(sharedConfigDir(this.args.env), 'config.json');
  }

  /**
   * Look a question up. `spawn-command` is rebuilt from detection rather than
   * read from the static catalogue, because its options are machine-specific.
   */
  private resolve(id: string): Question | undefined {
    if (id === 'spawn-command') return buildSpawnQuestion(this.args.spawnCandidates);
    return findQuestion(id);
  }

  /**
   * Keys that count as already answered: configured on disk before this run,
   * plus anything written during it, minus anything a `reask` re-opened.
   */
  private union(): ReadonlySet<string> {
    const set = new Set(this.args.configured);
    for (const p of this.written) set.add(p);
    for (const p of this.reopened) set.delete(p);
    return set;
  }
}

/** Re-exported so callers building a preview don't need plan.ts directly. */
export { progressLabel };
