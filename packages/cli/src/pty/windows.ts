/**
 * Windows PTY runner — Windows stub. No PTY allocation, no ring-buffer
 * scanning. claude is spawned with inherited stdio and the result tail is
 * null so detectCrossCwd never matches — cross-cwd-resume is a no-op on
 * Windows for now.
 *
 * Auto-handoff parity is implemented here in the same shape as Unix: when
 * `handoff` is set, fnclaude starts the AF_UNIX socket listener before
 * spawning claude and injects FNCLAUDE_HANDOFF / FNC_SOCKET into the child
 * env. Node's `net.createServer` over an AF_UNIX path works on Windows 10
 * build 17063+. When the listener fires triggered, the parent kills claude.
 *
 * Ported from src/pty_run_windows.go in the Go reference (fnclaude@fnrhombus).
 */

import { spawn as childSpawn } from 'node:child_process';
import { envFromConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { handoffEnv } from '../handoff.js';
import { SocketListener } from '../mcp/socketListener.js';
import { ensureCWD, type RunOptions, type RunResult } from '../pty.js';

export async function runWithPTY(opts: RunOptions): Promise<RunResult> {
  const { claudeArgv, launchCWD, cfg, handoff } = opts;
  if (claudeArgv.length === 0) {
    process.stderr.write('fnclaude: empty argv passed to runWithPTY\n');
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }

  // Build env. Order matches Unix: os env → exec.env → handoff env;
  // last-wins on dupes.
  const envExtras: string[] = [...envFromConfig(cfg)];
  if (handoff !== undefined) {
    envExtras.push(...handoffEnv(handoff.mode, handoff.socketPath));
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const kv of envExtras) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    childEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  // Start the AF_UNIX listener before the child.
  let listener: SocketListener | undefined;
  if (handoff !== undefined) {
    try {
      listener = await SocketListener.start({
        spec: handoff,
        cfg,
        launchCWD,
        origArgs: handoff.originalArgs,
      });
    } catch (err) {
      process.stderr.write(
        `fnclaude: socket listener failed to start: ${errorMessage(err)}\n`,
      );
      return { exitCode: 1, tail: undefined, handoffArgv: undefined };
    }
  }

  // Fabricate the cwd tree if missing. Windows can't safely tear the cwd
  // out from under a running child the way Unix can; defer the cleanup
  // until the child exits.
  let cleanupCWD: (() => Promise<void>) | undefined;
  try {
    const h = await ensureCWD(launchCWD);
    cleanupCWD = h.cleanup;
  } catch (err) {
    process.stderr.write(`fnclaude: ${errorMessage(err)}\n`);
    if (listener !== undefined) await listener.close();
    return { exitCode: 1, tail: undefined, handoffArgv: undefined };
  }

  let exitCode = 0;
  try {
    const child = childSpawn(claudeArgv[0] as string, claudeArgv.slice(1), {
      cwd: launchCWD,
      env: childEnv,
      stdio: 'inherit',
      // On Windows, this matches Go's exec.Command default — no shell.
      shell: false,
    });

    // Handoff: when the listener fires, kill the child. Windows doesn't
    // honor SIGTERM/SIGKILL through Node's signal API; child.kill() maps
    // to TerminateProcess which is the closest equivalent.
    if (listener !== undefined) {
      void listener.triggered().then(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      });
    }

    exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code, signal) => {
        if (code !== null) resolve(code);
        else if (signal !== null) resolve(1);
        else resolve(0);
      });
      child.on('error', (err) => {
        process.stderr.write(`fnclaude: failed to start claude: ${err.message}\n`);
        resolve(1);
      });
    });
  } finally {
    if (cleanupCWD !== undefined) {
      try {
        await cleanupCWD();
      } catch (err) {
        process.stderr.write(`fnclaude: ${errorMessage(err)}\n`);
      }
    }
  }

  let handoffArgv: string[] | undefined;
  if (listener !== undefined) {
    handoffArgv = listener.getHandoffArgv() ?? undefined;
    await listener.close();
  }

  return { exitCode, tail: undefined, handoffArgv };
}
