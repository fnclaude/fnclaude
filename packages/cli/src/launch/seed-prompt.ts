/**
 * Ultracode seed-prompt orchestrator.
 *
 * The `ultracode` effort can't ride on claude's `--effort` flag — claude
 * rejects the value. Instead fnc rewrites claude's initial-prompt positional
 * to the slash command `/effort ultracode`, which sets the effort on boot.
 * That consumes the single prompt slot, so any prompt the user actually typed
 * has to be delivered SEPARATELY: as a follow-up submitted into the live TUI
 * once claude is ready to receive it.
 *
 * This module is that follow-up step, factored out of main.ts so it is
 * unit-testable without a real terminal or a real `~/.claude`. All IO is
 * behind injected seams:
 *   - `write`        — the PTY input sink (`Bun.Terminal.write` wrapper).
 *   - `waitForReady` — resolves when claude is ready to receive input. In
 *                      production this is the "session JSONL appears" poll
 *                      (with a fixed-time fallback); tests inject a
 *                      controllable promise.
 *   - `schedule`     — threaded into {@link injectSubmittedLine} for the
 *                      separate CR write; tests pass a synchronous seam.
 *
 * Contract: a no-op when `seedPrompt` is empty (and in that case
 * `waitForReady` is never even awaited — there is nothing to submit). When
 * non-empty, it awaits readiness then submits the seed via the same two-write
 * bracketed-paste + CR shape every other injector uses.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { injectSubmittedLine, type PtyWriter } from '../mcp/handlers/inject-slash';
import { encodeCWDForProjects } from './live-permission-reader';

export interface SeedUltracodePromptArgs {
  /** The user-supplied prompt body to submit as a follow-up. Empty → no-op. */
  seedPrompt: string;
  /** PTY input sink — `Bun.Terminal.write` wrapper in production. */
  write: PtyWriter;
  /**
   * Resolves once claude is ready to receive the follow-up. Production: the
   * session-JSONL-appears poll with a fixed fallback. Tests: a resolved or
   * controllable promise. Never awaited when `seedPrompt` is empty.
   */
  waitForReady: () => Promise<void>;
  /**
   * Timer seam threaded into {@link injectSubmittedLine} for the separate CR
   * write. Defaults (inside the primitive) to {@link setTimeout}; tests pass a
   * synchronous `(fn) => fn()`.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
}

/**
 * Submit the user's prompt as a follow-up after claude boots under the
 * `/effort ultracode` initial prompt. No-op (and never awaits readiness) when
 * `seedPrompt` is empty.
 */
export async function seedUltracodePrompt(args: SeedUltracodePromptArgs): Promise<void> {
  if (args.seedPrompt === '') return;
  await args.waitForReady();
  injectSubmittedLine(args.seedPrompt, {
    write: args.write,
    schedule: args.schedule,
    enterDelayMs: args.enterDelayMs,
  });
}

/** Default poll interval (ms) for the session-JSONL-appears readiness probe. */
export const READY_POLL_INTERVAL_MS = 100;
/** Default cap (ms) after which the readiness probe gives up and fires anyway. */
export const READY_FALLBACK_MS = 5000;

export interface WaitForSessionJsonlArgs {
  /** Launch cwd — resolves the encoded `~/.claude/projects/<cwd>` dir. */
  launchCWD: string;
  /** Poll interval. Defaults to {@link READY_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Cap before resolving regardless. Defaults to {@link READY_FALLBACK_MS}. */
  fallbackMs?: number;
  /**
   * Directory `*.jsonl` lister. Defaults to a real readdir over the encoded
   * project dir; tests inject a scripted lister. Returns basenames.
   */
  listJsonls?: (launchCWD: string) => string[];
  /** Sleep seam. Defaults to a real `setTimeout`-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam. Defaults to {@link Date.now}. */
  now?: () => number;
}

function defaultListJsonls(launchCWD: string): string[] {
  const home = process.env.HOME !== undefined && process.env.HOME !== '' ? process.env.HOME : homedir();
  const dir = join(home, '.claude', 'projects', encodeCWDForProjects(launchCWD));
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/**
 * Build a `waitForReady` that resolves when a NEW session `*.jsonl` appears
 * under the cwd's project dir — claude's readiness signal, since it creates
 * its session file lazily after spawn. Snapshots the existing set at
 * construction, then polls on `intervalMs` for a file not in that snapshot.
 * Always resolves by `fallbackMs` even if no new file is detected (e.g. claude
 * crashes on boot — injecting into a dead PTY is harmless).
 */
export function makeSessionJsonlReady(args: WaitForSessionJsonlArgs): () => Promise<void> {
  const intervalMs = args.intervalMs ?? READY_POLL_INTERVAL_MS;
  const fallbackMs = args.fallbackMs ?? READY_FALLBACK_MS;
  const list = args.listJsonls ?? defaultListJsonls;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.now ?? (() => Date.now());

  const baseline = new Set(list(args.launchCWD));
  const deadline = now() + fallbackMs;

  return async (): Promise<void> => {
    while (now() < deadline) {
      const fresh = list(args.launchCWD).some((n) => !baseline.has(n));
      if (fresh) return;
      await sleep(intervalMs);
    }
  };
}
