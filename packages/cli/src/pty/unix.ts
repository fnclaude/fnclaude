/**
 * Unix PTY runner — spawn claude under a node-pty pseudo-terminal, tee its
 * output to stdout + a ring buffer, forward stdin / SIGWINCH, integrate the
 * AF_UNIX socket listener for handoff, and return the exit code + tail +
 * (optional) handoff argv.
 *
 * Ported from src/pty_run_unix.go in the Go reference (fnclaude@fnrhombus).
 *
 * Library choice: `node-pty` (Microsoft, MIT, currently v1.1.0). Verified
 * to load under Bun 1.3.x via the N-API compat layer — both spawn() and the
 * onData/onExit/kill surface work as documented. There's no native Bun PTY
 * primitive yet; if/when Bun ships one, this file is the natural place to
 * swap implementations behind the shared RunOptions API.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty';
import { envFromConfig } from '../config.js';
import { handoffEnv } from '../handoff.js';
import { SocketListener } from '../mcp/socketListener.js';
import {
  ensureCWD,
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

// ── runWithPTY ─────────────────────────────────────────────────────────────

export async function runWithPTY(opts: RunOptions): Promise<RunResult> {
  const { claudeArgv, launchCWD, cfg, handoff } = opts;

  // claudeArgv[0] is the conventional program name and is ignored — node-pty
  // takes file + args separately (mirrors exec.Command).
  if (claudeArgv.length === 0) {
    process.stderr.write('fnclaude: empty argv passed to runWithPTY\n');
    return { exitCode: 1, tail: null, handoffArgv: null };
  }

  // Build the env. Order matches Go: os env → exec.env → handoff env.
  // Last-wins on dupes, so handoff env beats user-supplied dupes.
  const envExtras: string[] = [...envFromConfig(cfg)];
  if (handoff !== null) {
    envExtras.push(...handoffEnv(handoff.mode, handoff.socketPath));
  }
  const childEnv = envArrayToObject(process.env, envExtras);

  // Start the AF_UNIX listener BEFORE the child so the socket is ready the
  // moment claude (and thus the `fnclaude mcp` subprocess) starts. On
  // listener-startup failure we abort the run — handoff is core behavior,
  // not optional.
  let listener: SocketListener | null = null;
  if (handoff !== null) {
    try {
      listener = await SocketListener.start({
        spec: handoff,
        cfg,
        launchCWD,
        origArgs: handoff.originalArgs,
      });
    } catch (err) {
      process.stderr.write(
        `fnclaude: socket listener failed to start: ${(err as Error).message}\n`,
      );
      return { exitCode: 1, tail: null, handoffArgv: null };
    }
  }

  // Resuming a session whose stored cwd no longer exists used to surface as
  // a misleading ENOENT-against-claude-binary. Fabricate the tree before
  // spawn, then immediately unwind it once claude has chdir'd in.
  let cleanupCWD: (() => Promise<void>) | null = null;
  try {
    const h = await ensureCWD(launchCWD);
    cleanupCWD = h.cleanup;
  } catch (err) {
    process.stderr.write(`fnclaude: ${(err as Error).message}\n`);
    if (listener !== null) await listener.close();
    return { exitCode: 1, tail: null, handoffArgv: null };
  }

  // Spawn under the PTY.
  const { cols, rows } = getTerminalSize();
  let pty: IPty;
  try {
    pty = ptySpawn(claudeArgv[0] as string, claudeArgv.slice(1), {
      name: process.env.TERM ?? 'xterm-256color',
      cols,
      rows,
      cwd: launchCWD,
      env: childEnv,
      encoding: null, // emit raw Buffers so the ring tail is byte-accurate
    });
  } catch (err) {
    if (cleanupCWD !== null) await cleanupCWD().catch(() => undefined);
    if (listener !== null) await listener.close();
    process.stderr.write(
      `fnclaude: failed to start claude with PTY: ${(err as Error).message}\n`,
    );
    return { exitCode: 1, tail: null, handoffArgv: null };
  }

  // Unwind any fabricated cwd tree now that the child has been spawned —
  // claude's kernel cwd is held by inode reference, so the path on disk
  // is no longer load-bearing.
  if (cleanupCWD !== null) {
    try {
      await cleanupCWD();
    } catch (err) {
      process.stderr.write(`fnclaude: ${(err as Error).message}\n`);
    }
  }

  // Put the controlling terminal into raw mode so the PTY behaves
  // transparently (key-by-key, no local echo, etc.).
  let restoreRaw: (() => void) | null = null;
  if (isTTY(process.stdin)) {
    const stdinRaw = process.stdin;
    const wasRaw = stdinRaw.isRaw;
    try {
      stdinRaw.setRawMode(true);
      restoreRaw = () => {
        try {
          stdinRaw.setRawMode(wasRaw);
        } catch {
          // best-effort — terminal may already be torn down
        }
      };
    } catch {
      // not a real TTY in some test harnesses — skip raw mode silently
    }
  }

  // Ring buffer for post-exit cross-cwd scanning.
  const ring = new RingBuffer(RING_BUFFER_SIZE);

  // Tee PTY output → stdout + ring buffer. node-pty with encoding:null
  // emits Buffer chunks; the type declaration still says string, but at
  // runtime it's Buffer when encoding is null (the lib's docstring is
  // explicit on this).
  pty.onData((chunk: unknown) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    ring.write(buf);
    process.stdout.write(buf);
  });

  // Forward SIGWINCH (terminal resize) to the PTY. Listener is detached in
  // the finally block.
  const onWinch = (): void => {
    const sz = getTerminalSize();
    try {
      pty.resize(sz.cols, sz.rows);
    } catch {
      // ignore — child may have already exited
    }
  };
  process.on('SIGWINCH', onWinch);

  // Pump stdin → PTY master. We only forward when stdin is a real TTY —
  // otherwise (test harness, piped invocation, headless run) we don't want
  // to drain a non-TTY stdin pipe which could close the PTY prematurely.
  // We attach a 'data' handler rather than pipe() so we can detach cleanly
  // on exit without destroying stdin (which would leak into the parent's
  // post-PTY state).
  let onStdinData: ((chunk: Buffer) => void) | null = null;
  if (isTTY(process.stdin)) {
    onStdinData = (chunk: Buffer): void => {
      try {
        pty.write(chunk);
      } catch {
        // child gone — ignore
      }
    };
    process.stdin.on('data', onStdinData);
    if (typeof process.stdin.resume === 'function') process.stdin.resume();
  }

  // Handoff: when the listener fires triggered(), terminate claude.
  // SIGTERM + brief grace + SIGKILL mirrors the legacy SIGUSR1 path
  // — the listener marks "switch fired" and the parent gets out of
  // the PTY loop ASAP.
  let handoffKillTimer: NodeJS.Timeout | null = null;
  if (listener !== null) {
    void listener.triggered().then(() => {
      try {
        pty.kill('SIGTERM');
      } catch {
        // ignore
      }
      handoffKillTimer = setTimeout(() => {
        try {
          pty.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 200);
    });
  }

  // Wait for the child to exit. Use a one-shot guard so we capture only
  // the FIRST exit event — node-pty under Bun has been observed to emit
  // a follow-up `exit` for the previous pty when a new one is started in
  // the same process, which would pollute the next call's result.
  const exitResult = await new Promise<{ exitCode: number; signal?: number }>(
    (resolve) => {
      let fired = false;
      const disposable = pty.onExit((e) => {
        if (fired) return;
        fired = true;
        disposable.dispose();
        resolve(e);
      });
    },
  );

  // Tear down listeners / restore terminal state.
  process.off('SIGWINCH', onWinch);
  if (onStdinData !== null) {
    process.stdin.off('data', onStdinData);
    if (typeof process.stdin.pause === 'function') process.stdin.pause();
  }
  if (restoreRaw !== null) restoreRaw();
  if (handoffKillTimer !== null) clearTimeout(handoffKillTimer);

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

  let handoffArgv: string[] | null = null;
  if (listener !== null) {
    handoffArgv = listener.getHandoffArgv();
    await listener.close();
  }

  return { exitCode, tail: ring.bytes(), handoffArgv };
}
