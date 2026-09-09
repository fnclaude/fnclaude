/**
 * The channel round-trip probe: does a pushed event reach an IDLE session?
 *
 * The question cannot be answered from inside a turn. While the model is
 * running it is not idle, so an event it triggers and immediately observes
 * only proves the busy path — which the docs already describe. The probe
 * therefore splits into two tools that the model calls at two different
 * moments, with the idle window in between:
 *
 *   `fnc_channel_test_arm`  — called in the OPENING turn. Starts a timer and
 *                             returns immediately, so the turn ends and the
 *                             session goes quiet.
 *   (timer fires)           — the subprocess pushes a channel event into a
 *                             session that is now sitting at an empty prompt.
 *   `fnc_channel_test_ack`  — the event asks the model to call this. It
 *                             records the arrival time.
 *
 * The verdict is in the log file: an `arm` line, a `push` line, and an `ack`
 * line means an idle session woke, and the push→ack gap is how long it took.
 * An `arm` and a `push` with no `ack` means it did not.
 *
 * Both tools are handled HERE, in the MCP subprocess, rather than dispatched
 * to the parent over the socket. The subprocess owns the stdio transport to
 * claude, and the notification has to be written on it.
 *
 * Dev-gated: these register only in a source checkout, alongside the channel
 * registration they exist to test.
 */

import { appendFileSync } from 'node:fs';

import { pushChannelMessage, type ChannelWriter } from '../channel';

/** Default idle window. Long enough that a turn has certainly ended. */
export const DEFAULT_ARM_DELAY_SECONDS = 90;

/** Where the probe writes its timeline. */
export const CHANNEL_TEST_LOG_ENV = 'FNC_CHANNEL_TEST_LOG';

export interface ChannelTestDeps {
  /** Writes a line on the transport claude reads. */
  write: ChannelWriter;
  /** Absolute path of the timeline log. */
  logPath: string;
  /** Timer seam — tests pass a synchronous stub. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Clock seam, so a test can assert exact stamps. */
  now?: () => Date;
}

interface ArmPayload {
  delay_seconds?: unknown;
}

interface AckPayload {
  note?: unknown;
}

/** One timeline entry. Append-only; the file IS the result. */
function record(deps: ChannelTestDeps, event: string, fields: Record<string, unknown>): string {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const line = JSON.stringify({ at, event, ...fields });
  try {
    appendFileSync(deps.logPath, `${line}\n`);
  } catch {
    // A probe that cannot write its log still pushes; the transcript is the
    // fallback record. Never let logging failure abort the test.
  }
  return at;
}

/**
 * `fnc_channel_test_arm` — start the timer, return at once.
 *
 * Returning immediately is the point: the model must be free to end its turn
 * so the push lands on an idle session.
 */
export function createChannelTestArmHandler(
  deps: ChannelTestDeps,
): (payload: unknown) => Promise<object> {
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  return async (payload: unknown): Promise<object> => {
    const requested = (payload as ArmPayload | null)?.delay_seconds;
    const seconds =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : DEFAULT_ARM_DELAY_SECONDS;

    const armedAt = record(deps, 'arm', { delay_seconds: seconds });

    schedule(() => {
      const pushedAt = record(deps, 'push', { delay_seconds: seconds });
      pushChannelMessage(deps.write, {
        content:
          `Channel probe: this event was pushed ${seconds}s after arming, with no turn in ` +
          `flight. If you are reading it, an idle session woke. Call ` +
          `\`fnc_channel_test_ack\` now — that call is the measurement.`,
        meta: { probe: 'idle_wake', pushed_at: pushedAt, delay_seconds: String(seconds) },
      });
    }, seconds * 1000);

    return {
      ok: true,
      armed_at: armedAt,
      delay_seconds: seconds,
      log_path: deps.logPath,
      instructions:
        'End your turn now and do not call another tool. The event arrives while the ' +
        'session is idle; acknowledge it with `fnc_channel_test_ack` when it does.',
    };
  };
}

/** `fnc_channel_test_ack` — the other tool. Calling it is the evidence. */
export function createChannelTestAckHandler(
  deps: ChannelTestDeps,
): (payload: unknown) => Promise<object> {
  return async (payload: unknown): Promise<object> => {
    const note = (payload as AckPayload | null)?.note;
    const at = record(deps, 'ack', {
      note: typeof note === 'string' ? note : null,
    });
    return { ok: true, acked_at: at, log_path: deps.logPath };
  };
}
