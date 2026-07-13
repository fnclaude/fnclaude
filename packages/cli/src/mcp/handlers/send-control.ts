/**
 * Tagged control-injection seam (#299).
 *
 * fnc emits three kinds of CONTROL traffic into a live session that are not
 * user turns: context-size ladder notices, `/compact` requests, and compact
 * follow-up handoffs. Historically each one was written straight into claude's
 * raw PTY input via {@link injectSubmittedLine} — the exact same keystroke
 * seam the user's own typing goes through. Two problems followed:
 *
 *   1. **No structural marker.** From claude's (and the renderer's) point of
 *      view an injected control message is indistinguishable from a typed
 *      turn; downstream consumers had to string-sniff the body to classify it,
 *      which drifts as body formats change.
 *   2. **In-flight corruption.** Because the write lands at whatever cursor
 *      position the terminal happens to be at, a notice that fires while the
 *      user is mid-typing splices its bytes into the partial draft (observed
 *      live on 2.13.2 — see the issue).
 *
 * `sendControl(kind, text)` is the dedicated path that fixes both. Every
 * control message carries an explicit {@link ControlKind} — the STRUCTURAL
 * marker the renderer-side filter (#288) keys off, which a user typing the
 * same body text can never spoof (it never goes through this seam). The PTY
 * implementation additionally defers a control message while a user draft is
 * in flight, flushing it only once the line is submitted or cleared, so it
 * can never interleave into a partially-typed prompt.
 *
 * Two seam implementations share the {@link SendControl} shape:
 *   - {@link createPtyControlSeam} — PTY-launch mode. Wraps
 *     {@link injectSubmittedLine}; tracks draft state via {@link noteUserInput}.
 *   - {@link createRendererControlSeam} — renderer mode. Routes through the
 *     renderer mount API's matching `sendControl(kind, text)` surface (falling
 *     back to a plain user turn on an old handle), so control messages are
 *     wired in renderer mode for the first time.
 *
 * {@link createControlSeamHolder} bridges the wiring gap: the MCP `/compact`
 * handler is built BEFORE the launch mode is decided / the terminal exists, so
 * it takes the holder's `sendControl` now and the real seam is bound later.
 */

import { DEFAULT_CR_INTERVAL_MS, injectSubmittedLine, type PtyWriter } from './inject-slash';

/**
 * How many submit CRs a control message fires. Control bodies (notices,
 * `/compact`, follow-ups) are often long, and a single CR after a large paste
 * is unreliably swallowed while claude ingests it — so we re-send the submit a
 * few times, draft-guarded, until it takes. See {@link createPtyControlSeam}.
 */
const CONTROL_CR_COUNT = 3;
/** Gap (ms) between a control message's successive retry CRs. */
const CONTROL_CR_INTERVAL_MS = DEFAULT_CR_INTERVAL_MS;

/** The closed set of control-message kinds the seam tags. */
export type ControlKind = 'notice' | 'compact' | 'followup';

/** A tagged control message: the {@link ControlKind} is the structural marker. */
export interface ControlEnvelope {
  kind: ControlKind;
  text: string;
}

/** The dedicated control-injection seam shared by both launch modes. */
export type SendControl = (kind: ControlKind, text: string) => void;

/** Seams for {@link createPtyControlSeam} — injectable for unit tests. */
export interface CreatePtyControlSeamArgs {
  /** The PTY input sink (`Bun.Terminal.write` wrapper in production). */
  write: PtyWriter;
  /** Timer seam threaded into {@link injectSubmittedLine} for the separate CR(s). */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the first CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
  /** How many retry CRs each control message fires. Defaults to {@link CONTROL_CR_COUNT}. */
  crCount?: number;
  /** Gap between successive retry CRs. Defaults to {@link CONTROL_CR_INTERVAL_MS}. */
  crIntervalMs?: number;
}

/** PTY-mode control seam plus the draft-tracking input observer. */
export interface PtyControlSeam {
  /** Emit a tagged control message (deferred while a draft is in flight). */
  sendControl: SendControl;
  /**
   * Observe a raw user-input chunk forwarded to the PTY, to track whether the
   * user has a partially-typed line in flight. Wire this into the stdin
   * forwarder alongside `term.write(chunk)`.
   */
  noteUserInput: (chunk: string) => void;
}

/** True iff `s` contains any visible/typed character (a draft-dirtying byte). */
function hasPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c !== 0x7f) return true;
  }
  return false;
}

/**
 * The index of the last byte in `chunk` that truly ENDS the current input line
 * — a submit or a line-clear — or -1 when the chunk contains none. After such a
 * byte the draft is empty, so deferred control can safely flush.
 *
 * The subtlety is that not every CR/LF ends a line. claude's multi-line editor
 * emits CR/LF bytes for keys that ADD a newline to the prompt without
 * submitting it, and a Unix bracketed paste carries literal `\n`s between
 * pasted lines. Treating those as "line submitted" clears the draft guard early
 * and splices a deferred notice into the still-open prompt. So we classify:
 *
 *   - `\x03` (Ctrl-C) and `\x15` (Ctrl-U) ALWAYS end the line (clear it).
 *   - `\r` (0x0d, Enter) ends the line ONLY when it is a bare Enter — i.e. its
 *     immediately-preceding byte is neither `\` (0x5c, backslash-continuation)
 *     nor ESC (0x1b, Alt-Enter). Both of those are soft newlines.
 *   - `\n` (0x0a) is NEVER a submit: it's Ctrl-J (soft newline) or a paste's
 *     embedded newline.
 *
 * `prevByte` is the last byte of the PREVIOUS chunk (-1 if none), so a `\r` at
 * index 0 can still see whether a `\`/ESC preceded it across a chunk boundary
 * (backslash-Enter and Alt-Enter routinely arrive as two separate stdin
 * chunks).
 */
function lastLineEndIndex(chunk: string, prevByte: number): number {
  let idx = -1;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk.charCodeAt(i);
    if (c === 0x03 || c === 0x15) {
      idx = i;
    } else if (c === 0x0d) {
      const before = i === 0 ? prevByte : chunk.charCodeAt(i - 1);
      if (before !== 0x5c && before !== 0x1b) idx = i;
    }
    // 0x0a (LF) is always a soft newline — never ends the line.
  }
  return idx;
}

/**
 * Build the PTY-mode control seam.
 *
 * `sendControl` submits the message via {@link injectSubmittedLine} (bracketed-
 * paste body + separate CRs) — UNLESS the user currently has a partially-typed
 * line in flight, in which case it is queued and flushed once the user submits
 * or clears the line. This is what stops a notice from splicing into a draft.
 *
 * Retry + draft guard. Control bodies are often long, and a single CR after a
 * large paste is unreliably swallowed while claude ingests it (the submit is
 * dropped and the line never sends). So each control message fires
 * {@link CONTROL_CR_COUNT} CRs spaced {@link CONTROL_CR_INTERVAL_MS} apart via
 * `injectSubmittedLine`, retrying the submit until it takes. The retry is
 * draft-guarded through `shouldSubmit: () => !drafting`, re-checked at each CR's
 * fire time: the moment the user starts typing, the remaining retry CRs are
 * skipped so a late Return can't submit their fresh draft.
 *
 * The PTY wire carries only the body bytes (behavior unchanged for the user);
 * the {@link ControlKind} marker is the in-process contract this seam upholds
 * and is what travels structurally in renderer mode.
 */
export function createPtyControlSeam(args: CreatePtyControlSeamArgs): PtyControlSeam {
  let drafting = false;
  const queue: ControlEnvelope[] = [];
  const injectDeps = {
    write: args.write,
    schedule: args.schedule,
    enterDelayMs: args.enterDelayMs,
    crCount: args.crCount ?? CONTROL_CR_COUNT,
    crIntervalMs: args.crIntervalMs ?? CONTROL_CR_INTERVAL_MS,
    // Re-checked at each CR's fire time — skip a retry once the user drafts.
    shouldSubmit: (): boolean => !drafting,
  };
  // Last byte of the previous non-empty chunk (-1 if none). Lets a `\r` at the
  // start of a chunk see whether a `\`/ESC preceded it in the prior chunk, so
  // backslash-Enter / Alt-Enter split across two stdin chunks read as soft.
  let lastByte = -1;

  function inject(env: ControlEnvelope): void {
    injectSubmittedLine(env.text, injectDeps);
  }

  function flush(): void {
    while (queue.length > 0) inject(queue.shift()!);
  }

  return {
    sendControl: (kind, text) => {
      if (drafting) {
        queue.push({ kind, text });
        return;
      }
      inject({ kind, text });
    },
    noteUserInput: (chunk) => {
      if (chunk === '') return;
      const end = lastLineEndIndex(chunk, lastByte);
      // Record the preceding-byte context for the NEXT chunk before returning.
      lastByte = chunk.charCodeAt(chunk.length - 1);
      if (end >= 0) {
        // The line was really submitted/cleared — the draft is empty. Flush any
        // control we deferred, then re-arm drafting if the chunk started a
        // fresh partial line after the terminator.
        drafting = false;
        flush();
        drafting = hasPrintable(chunk.slice(end + 1));
        return;
      }
      // No real terminator (soft newlines included): any visible byte means the
      // user is still building a draft.
      if (hasPrintable(chunk)) drafting = true;
    },
  };
}

/**
 * The subset of the renderer mount handle this seam drives. The renderer's
 * `sendControl(kind, text)` (landing alongside #288) is preferred; an older
 * handle exposes only `sendUserTurn`, which we degrade to so the control
 * message still reaches claude (unhidden) rather than being silently dropped.
 */
export interface RendererControlTarget {
  sendControl?: (kind: ControlKind, text: string) => void;
  sendUserTurn?: (text: string) => void;
}

/**
 * Build the renderer-mode control seam over a mount handle. Delivers the
 * {@link ControlKind} structurally through `handle.sendControl` when available
 * — that field is the marker #288's filter classifies on — and falls back to a
 * plain user turn on an old handle.
 */
export function createRendererControlSeam(target: RendererControlTarget): SendControl {
  return (kind, text) => {
    if (typeof target.sendControl === 'function') {
      target.sendControl(kind, text);
      return;
    }
    if (typeof target.sendUserTurn === 'function') {
      target.sendUserTurn(text);
    }
  };
}

/**
 * Deferred-binding holder for the {@link SendControl} seam.
 *
 * The MCP `/compact` handler is wired into the parent dispatcher BEFORE the
 * launch mode (PTY vs renderer) is decided and before the terminal/renderer
 * exists. Hand it `holder.sendControl` at wiring time; call `holder.bind(seam)`
 * once the real seam is constructed. Unlike the fire-and-forget keystroke
 * holder, control messages sent before bind are QUEUED and replayed on bind —
 * a control message is worth keeping, not dropping.
 */
export interface ControlSeamHolder {
  /** The {@link SendControl} to hand to handlers at wiring time. */
  sendControl: SendControl;
  /** Bind the real seam once it exists; replays anything queued. Last bind wins. */
  bind: (seam: SendControl) => void;
  /** True once a seam has been bound — for diagnostics/tests. */
  isBound: () => boolean;
}

export function createControlSeamHolder(): ControlSeamHolder {
  let seam: SendControl | null = null;
  const pending: ControlEnvelope[] = [];
  return {
    sendControl: (kind, text) => {
      if (seam !== null) {
        seam(kind, text);
        return;
      }
      pending.push({ kind, text });
    },
    bind: (s) => {
      seam = s;
      while (pending.length > 0) {
        const e = pending.shift()!;
        s(e.kind, e.text);
      }
    },
    isBound: () => seam !== null,
  };
}
