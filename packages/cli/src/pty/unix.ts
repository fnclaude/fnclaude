/**
 * Unix PTY runner — spawn claude under a node-pty pseudo-terminal, tee its
 * output to stdout + a ring buffer, forward stdin / SIGWINCH, integrate the
 * AF_UNIX socket listener for handoff, and return the exit code + tail +
 * (optional) handoff argv.
 *
 * Ported from src/pty_run_unix.go in the Go reference (fnclaude@fnrhombus).
 *
 * Library choice: `node-pty` (Microsoft, MIT, currently v1.2.0-beta.13).
 * Pinned to a 1.2.0 beta because 1.1.0 ships only macOS + Windows
 * prebuilds; 1.2.0-beta.2 is the first version with linux-{x64,arm64}
 * prebuilds. Without them, `npm i -g @fnclaude/cli` forces every Linux
 * user to install Python + make + a C++ toolchain so node-gyp can rebuild
 * the native binding at install time. Verified to load under Bun 1.3.x
 * via the N-API compat layer — both spawn() and the onData/onExit/kill
 * surface work as documented. There's no native Bun PTY primitive yet;
 * if/when Bun ships one, this file is the natural place to swap
 * implementations behind the shared RunOptions API.
 *
 * Lifecycle: each setup phase that needs an undo step returns a small
 * disposable wrapper (`using` / `await using`). The orchestration function
 * stays linear and the teardown happens implicitly when the block exits —
 * including every early-return error path. The disposables are LIFO at
 * dispose time, so order them top-to-bottom from "last to clean" to "first
 * to clean".
 */

import { spawn as ptySpawn, type IPty } from 'node-pty';
import { envFromConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { handoffEnv } from '../handoff.js';
import { SocketListener } from '../mcp/socketListener.js';
import {
  ensureCWD,
  type EnsureCWDHandle,
  RING_BUFFER_SIZE,
  RingBuffer,
  type RunOptions,
  type RunResult,
} from '../pty.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** Convert a `KEY=VALUE` string array into the object shape node-pty wants. */
function envArrayToObject(
  base: NodeJS.ProcessEnv,
  extras: readonly string[],
): { [k: string]: string | undefined } {
  // Start from the inherited env. Last-wins, so extras override on
  // duplicate keys (matches Go's append semantics in exec.Command).
  const out: { [k: string]: string | undefined } = { ...base };
  for (const kv of extras) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function getTerminalSize(): { cols: number; rows: number } {
  // node:tty `WriteStream` exposes columns/rows when stdout is a TTY.
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows };
}

function isTTY(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true;
}

// ── disposable wrappers ────────────────────────────────────────────────────

/**
 * Wraps a SocketListener so it's auto-closed on scope exit. Held as
 * `await using` because close() is async. Disposed LAST (declared first)
 * so callers can extract the handoff argv before the socket goes away.
 */
class ListenerHandle {
  private constructor(readonly inner: SocketListener) {}

  static async start(
    opts: Parameters<typeof SocketListener.start>[0],
  ): Promise<ListenerHandle> {
    return new ListenerHandle(await SocketListener.start(opts));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.inner.close();
  }
}

/**
 * Wraps `ensureCWD`'s fabricated-tree cleanup. The normal lifecycle is
 * `unwindNow()` right after spawn (claude has chdir'd, the path on disk
 * is no longer load-bearing). The asyncDispose is the safety net for any
 * early-return path where spawn never happened.
 */
class CwdHandle {
  private done = false;

  private constructor(private readonly h: EnsureCWDHandle) {}

  static async ensure(dir: string): Promise<CwdHandle> {
    return new CwdHandle(await ensureCWD(dir));
  }

  /**
   * Eager cleanup — call once spawn has succeeded. Marks the disposer as
   * a no-op so dispose-on-exit doesn't double-fire.
   */
  async unwindNow(): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await this.h.cleanup();
    } catch (err) {
      process.stderr.write(`fnclaude: ${errorMessage(err)}\n`);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.done) return;
    this.done = true;
    // Safety-net path (early error before spawn) — swallow & ignore. We
    // already surfaced the original error to the caller; a secondary
    // cleanup failure here would just add noise.
    await this.h.cleanup().catch(() => undefined);
  }
}

/**
 * Wraps an IPty so it's defensively killed on scope exit. In the happy
 * path the child has already exited (we awaited its exit before falling
 * out of the block); kill() on a dead pty is a no-op. In the error path
 * (something between spawn and exit-await threw) this guarantees we don't
 * leak a child process.
 */
class PtyHandle {
  constructor(readonly inner: IPty) {}

  [Symbol.dispose](): void {
    try {
      this.inner.kill();
    } catch {
      // already dead — fine
    }
  }
}

/**
 * Raw mode on the controlling TTY. Restores to whatever the original
 * `isRaw` was. Returns undefined when stdin isn't a real TTY (test harness,
 * piped invocation) — disposable then becomes a no-op via `?.`.
 */
class RawModeHandle {
  private constructor(
    private readonly stdin: NodeJS.ReadStream,
    private readonly wasRaw: boolean,
  ) {}

  static enter(): RawModeHandle | undefined {
    if (!isTTY(process.stdin)) return undefined;
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch {
      // not a real TTY in some test harnesses — skip raw mode silently
      return undefined;
    }
    return new RawModeHandle(stdin, wasRaw);
  }

  [Symbol.dispose](): void {
    try {
      this.stdin.setRawMode(this.wasRaw);
    } catch {
      // best-effort — terminal may already be torn down
    }
  }
}

/**
 * SIGWINCH forwarder — resize the PTY when the controlling terminal
 * changes size. Dispose removes the listener.
 */
class WinchForwarder {
  private constructor(private readonly handler: () => void) {}

  static start(pty: IPty): WinchForwarder {
    const handler = (): void => {
      const sz = getTerminalSize();
      try {
        pty.resize(sz.cols, sz.rows);
      } catch {
        // ignore — child may have already exited
      }
    };
    process.on('SIGWINCH', handler);
    return new WinchForwarder(handler);
  }

  [Symbol.dispose](): void {
    process.off('SIGWINCH', this.handler);
  }
}

/**
 * stdin → PTY-master pump. Only attaches when stdin is a real TTY —
 * draining a non-TTY pipe could close the PTY prematurely. Dispose detaches
 * the listener and pauses (so the parent doesn't keep consuming) without
 * destroying stdin.
 */
class StdinPump {
  private constructor(private readonly handler: (chunk: Buffer) => void) {}

  static start(pty: IPty): StdinPump | undefined {
    if (!isTTY(process.stdin)) return undefined;
    const handler = (chunk: Buffer): void => {
      try {
        pty.write(chunk);
      } catch {
        // child gone — ignore
      }
    };
    process.stdin.on('data', handler);
    if (typeof process.stdin.resume === 'function') process.stdin.resume();
    return new StdinPump(handler);
  }

  [Symbol.dispose](): void {
    process.stdin.off('data', this.handler);
    if (typeof process.stdin.pause === 'function') process.stdin.pause();
  }
}

/**
 * Arms a kill chain that fires when the SocketListener's `triggered`
 * promise resolves (i.e. a handoff action was dispatched): SIGTERM, then
 * SIGKILL after a 200 ms grace. Dispose clears the pending SIGKILL timer
 * if it hasn't fired yet.
 */
class HandoffKill {
  private timer: NodeJS.Timeout | undefined;

  private constructor() {}

  static arm(listener: SocketListener, pty: IPty): HandoffKill {
    const h = new HandoffKill();
    void listener.triggered().then(() => {
      try {
        pty.kill('SIGTERM');
      } catch {
        // ignore
      }
      h.timer = setTimeout(() => {
        try {
          pty.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 200);
    });
    return h;
  }

  [Symbol.dispose](): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

// ── runWithPTY ─────────────────────────────────────────────────────────────

export async function runWithPTY(opts: RunOptions): Promise<RunResult> {
  const { claudeArgv, launchCWD, cfg, handoff } = opts;

  // claudeArgv[0] is the conventional program name and is ignored — node-pty
  // takes file + args separately (mirrors exec.Command).
  if (claudeArgv.length === 0) {
    process.stderr.write('fnclaude: empty argv passed to runWithPTY\n');
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }

  // Build the env. Order matches Go: os env → exec.env → handoff env.
  // Last-wins on dupes, so handoff env beats user-supplied dupes.
  const envExtras: string[] = [...envFromConfig(cfg)];
  if (handoff !== undefined) {
    envExtras.push(...handoffEnv(handoff.mode, handoff.socketPath));
  }
  const childEnv = envArrayToObject(process.env, envExtras);

  // Start the AF_UNIX listener BEFORE the child so the socket is ready the
  // moment claude (and thus the `fnclaude mcp` subprocess) starts. On
  // listener-startup failure we abort the run — handoff is core behavior,
  // not optional.
  let listener: ListenerHandle | undefined;
  try {
    listener =
      handoff !== undefined
        ? await ListenerHandle.start({
            spec: handoff,
            cfg,
            launchCWD,
            origArgs: handoff.originalArgs,
          })
        : undefined;
  } catch (err) {
    process.stderr.write(
      `fnclaude: socket listener failed to start: ${errorMessage(err)}\n`,
    );
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }
  // Bind into `await using` scope. Declared first → disposed last, after
  // we've extracted the handoff argv below.
  await using _listener = listener;

  // Resuming a session whose stored cwd no longer exists used to surface as
  // a misleading ENOENT-against-claude-binary. Fabricate the tree before
  // spawn, then immediately unwind it once claude has chdir'd in.
  let cwd: CwdHandle;
  try {
    cwd = await CwdHandle.ensure(launchCWD);
  } catch (err) {
    process.stderr.write(`fnclaude: ${errorMessage(err)}\n`);
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }
  await using _cwd = cwd;

  // Spawn under the PTY.
  const { cols, rows } = getTerminalSize();
  let ptyRaw: IPty;
  try {
    ptyRaw = ptySpawn(claudeArgv[0] as string, claudeArgv.slice(1), {
      name: process.env.TERM ?? 'xterm-256color',
      cols,
      rows,
      cwd: launchCWD,
      env: childEnv,
      encoding: null, // emit raw Buffers so the ring tail is byte-accurate
    });
  } catch (err) {
    // cwd + listener will be cleaned up by their `using` disposers on the
    // way out of this scope.
    process.stderr.write(
      `fnclaude: failed to start claude with PTY: ${errorMessage(err)}\n`,
    );
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }
  using pty = new PtyHandle(ptyRaw);

  // Unwind any fabricated cwd tree now that the child has been spawned —
  // claude's kernel cwd is held by inode reference, so the path on disk
  // is no longer load-bearing. The CwdHandle's disposer becomes a no-op
  // after this.
  await cwd.unwindNow();

  // Put the controlling terminal into raw mode so the PTY behaves
  // transparently (key-by-key, no local echo, etc.).
  using _rawMode = RawModeHandle.enter();

  // Ring buffer for post-exit cross-cwd scanning.
  const ring = new RingBuffer(RING_BUFFER_SIZE);

  // Tee PTY output → stdout + ring buffer. node-pty with encoding:null
  // emits Buffer chunks; the type declaration still says string, but at
  // runtime it's Buffer when encoding is null (the lib's docstring is
  // explicit on this).
  pty.inner.onData((chunk: unknown) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    ring.write(buf);
    process.stdout.write(buf);
  });

  // Forward SIGWINCH (terminal resize) to the PTY.
  using _winch = WinchForwarder.start(pty.inner);

  // Pump stdin → PTY master. We only forward when stdin is a real TTY —
  // otherwise (test harness, piped invocation, headless run) we don't want
  // to drain a non-TTY stdin pipe which could close the PTY prematurely.
  using _stdinPump = StdinPump.start(pty.inner);

  // Handoff: when the listener fires triggered(), terminate claude.
  // SIGTERM + brief grace + SIGKILL mirrors the legacy SIGUSR1 path
  // — the listener marks "switch fired" and the parent gets out of
  // the PTY loop ASAP.
  using _handoffKill =
    listener !== undefined ? HandoffKill.arm(listener.inner, pty.inner) : undefined;

  // Wait for the child to exit. Use a one-shot guard so we capture only
  // the FIRST exit event — node-pty under Bun has been observed to emit
  // a follow-up `exit` for the previous pty when a new one is started in
  // the same process, which would pollute the next call's result.
  const exitResult = await new Promise<{ exitCode: number; signal?: number }>(
    (resolve) => {
      let fired = false;
      const disposable = pty.inner.onExit((e) => {
        if (fired) return;
        fired = true;
        disposable.dispose();
        resolve(e);
      });
    },
  );

  // node-pty's exit shape: { exitCode, signal? }.
  //
  // Under Node: exitCode is set when the child exited normally; signal is
  // set (with the signal number) when terminated by a signal. We could map
  // signal-death to POSIX's `128 + signal`.
  //
  // Under Bun (1.3.x), node-pty's `signal` field is unreliable — observed
  // value `1` on both normal exits AND deliberate SIGTERM kills, so we
  // can't trust it to distinguish "exited normally" from "killed". The
  // safest cross-runtime answer is to use `exitCode` as truth: it tracks
  // the real exit code on both runtimes, and on signal-death it reports
  // 0 (which is the correct "process didn't choose its exit code" answer).
  //
  // Callers that need to know "was this a handoff kill?" should inspect
  // `handoffArgv !== null` (the listener's stash), not the exit code.
  const exitCode = exitResult.exitCode;

  // Extract handoff argv BEFORE the listener's disposer fires (which will
  // close the socket). The listener disposer runs last because it was
  // declared first in this scope.
  const handoffArgv =
    listener !== undefined ? listener.inner.getHandoffArgv() : undefined;

  return { exitCode, tail: ring.bytes(), handoffArgv };
}
