/**
 * Claude subprocess driver.
 *
 * Spawns `claude --print --verbose --input-format stream-json
 * --output-format stream-json` via Bun.spawn and exposes an async-iterable
 * event stream plus a `sendUserTurn` writer.
 *
 * Design notes:
 * - stdin MUST be a pipe, not a file redirect. Passing a file to claude's
 *   stdin silently produces no output and exits 0 — a painful gotcha
 *   documented in docs/stream-json-findings.md.
 * - `SpawnFn` is injectable so tests can pipe fixture bytes through the real
 *   parser without touching the live binary. Production callers omit it.
 * - `close()` closes stdin (signals EOF to claude) and awaits the process
 *   exit. The process exits cleanly ~250ms after stdin close per the findings.
 */
import { parseNdjsonStream } from "./event-parser.ts";
import type { ClaudeEvent, UserTurn } from "./types/events.ts";

export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

export type SpawnFn = (cmd: string[], opts: { cwd?: string }) => SpawnResult;

export interface SubscribeOptions {
  /** Working directory for the claude process. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra CLI arguments appended after the required flags. */
  extraArgs?: string[];
  /**
   * Injectable spawn function — omit in production, pass a mock in tests.
   * See module header comment for rationale.
   */
  spawnFn?: SpawnFn;
}

export interface ClaudeSubscription {
  events: AsyncIterable<ClaudeEvent>;
  sendUserTurn: (text: string) => void;
  close: () => Promise<number>;
}

const REQUIRED_ARGS = [
  "--print",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
];

export function subscribeToClaude(opts: SubscribeOptions = {}): ClaudeSubscription {
  const { cwd, extraArgs = [], spawnFn } = opts;

  const spawn = spawnFn ?? defaultSpawn;
  const spawnOpts = cwd !== undefined ? { cwd } : {};
  const proc = spawn(["claude", ...REQUIRED_ARGS, ...extraArgs], spawnOpts);

  const encoder = new TextEncoder();
  let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = proc.stdin.getWriter();

  function sendUserTurn(text: string): void {
    if (stdinWriter === null) return;
    const turn: UserTurn = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
    const line = `${JSON.stringify(turn)}\n`;
    // Fire-and-forget write; errors surface as unhandled promise rejections
    // which is acceptable for a stream writer (the process exiting will close
    // the stream cleanly).
    stdinWriter.write(encoder.encode(line)).catch(() => undefined);
  }

  async function close(): Promise<number> {
    if (stdinWriter !== null) {
      try {
        await stdinWriter.close();
      } catch {
        // Already closed — ignore.
      }
      stdinWriter = null;
    }
    return proc.exited;
  }

  return {
    events: parseNdjsonStream(proc.stdout),
    sendUserTurn,
    close,
  };
}

function defaultSpawn(cmd: string[], opts: { cwd?: string }): SpawnResult {
  const bunOpts =
    opts.cwd !== undefined
      ? {
          stdin: "pipe" as const,
          stdout: "pipe" as const,
          stderr: "inherit" as const,
          cwd: opts.cwd,
        }
      : { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "inherit" as const };
  const proc = Bun.spawn(cmd, bunOpts);

  // Wrap Bun's ReadableStream and WritableStream in the standard Web streams
  // API shapes that SpawnResult declares.
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  // Bun.spawn returns a FileSink for stdin when stdin: "pipe".
  // Wrap it in a WritableStream so the surface is consistent.
  const sink = proc.stdin;

  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      await sink.write(chunk);
    },
    async close() {
      await sink.end();
    },
    abort() {
      sink.end();
    },
  });

  return {
    stdout,
    stdin,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}
