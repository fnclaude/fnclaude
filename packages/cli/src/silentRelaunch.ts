// Port of silentRelaunch / silentRelaunchHandoff from src/pty_run_unix.go +
// src/pty_run_windows.go in the Go reference.
//
// silentRelaunch is what fnclaude calls when claude has exited with a
// cross-cwd-resume marker in its tail output (user selected a session from
// another directory via the Ctrl+A picker). It replaces the current process
// with a fresh fnclaude pointed at the new cwd + session UUID.
//
// silentRelaunchHandoff is the auto-handoff sibling: invoked when the
// AF_UNIX socket listener received an OpRestart or OpSwitch confirmation
// during the run, killed claude, and stashed the argv for the next launch.
//
// On POSIX both use `process.execve` (Bun 1.3.14+) to replace the process
// image — semantically identical to Go's `syscall.Exec`. On Windows execve
// throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, so we fall back to spawn-
// and-propagate-exit-code (mirrors the Go Windows stub).

import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearScreen, reconstructArgv } from './pty.js';
import { selfPath } from './spawn.js';

// `process.execve` is a Bun-native POSIX-only API (1.3.14+). @types/bun
// hasn't typed it yet — declare the shape inline so TS strict mode is happy.
// The signature mirrors Bun's native binding: argv[0] is conventionally the
// program name; env is the full environment (KEY=VALUE strings).
interface ExecveProcess {
  execve?: (path: string, argv: string[], env: Record<string, string | undefined>) => never;
}

/**
 * Replace the current process image with a fresh fnclaude invocation, using
 * `dest` as the new cwd and `uuid` as the session to resume.
 *
 * On POSIX this NEVER returns on success — execve replaces the running
 * process. On failure it writes to stderr and returns, letting the caller
 * propagate claude's exit code.
 *
 * On Windows execve is unavailable; we approximate by spawning a fresh
 * fnclaude as a child, waiting for it to exit, and calling `process.exit`
 * with its code (NEVER returns on success on Windows either, but for a
 * different reason — the exit() in the child-completion handler).
 *
 * `origArgs` is the original `process.argv.slice(2)` from the launching
 * fnclaude invocation; reconstructArgv preserves leading magic words and
 * post-positional flags while swapping in the new cwd + --resume <uuid>.
 */
export function silentRelaunch(
  origArgs: readonly string[],
  dest: string,
  uuid: string,
  out: NodeJS.WriteStream = process.stdout,
): void {
  let self: string;
  try {
    self = selfPath();
  } catch (err) {
    process.stderr.write(
      `fnclaude: cannot determine executable, cannot relaunch: ${(err as Error).message}\n`,
    );
    return;
  }

  const newArgs = reconstructArgv(origArgs, dest, uuid);

  clearScreen(out);

  // execve argv[0] is conventionally the program name (matches Go's
  // syscall.Exec contract).
  const argv = [self, ...newArgs];
  execOrSpawn(self, argv);
}

/**
 * Replace the current process with a fresh fnclaude using `argv` as the new
 * arg list. The socket listener has already constructed argv with the
 * leading "fnclaude" token stripped; we prepend the self path as argv[0].
 *
 * Same POSIX vs Windows behavior as `silentRelaunch`.
 */
export function silentRelaunchHandoff(
  argv: readonly string[],
  out: NodeJS.WriteStream = process.stdout,
): void {
  let self: string;
  try {
    self = selfPath();
  } catch (err) {
    process.stderr.write(
      `fnclaude: cannot determine executable, cannot relaunch: ${(err as Error).message}\n`,
    );
    return;
  }

  clearScreen(out);

  const full = [self, ...argv];
  execOrSpawn(self, full, /* handoff */ true);
}

/**
 * Shared dispatcher: POSIX uses execve (process replacement); Windows
 * spawns a fresh child and exits with its code.
 *
 * `handoff` distinguishes the error message text so logs disambiguate the
 * two callsites.
 */
function execOrSpawn(self: string, argv: string[], handoff = false): void {
  const label = handoff ? 'handoff exec' : 'exec relaunch';

  if (process.platform === 'win32') {
    // No execve on Windows. Approximate process replacement: spawn a child
    // with inherited stdio and exit with its code once it finishes.
    spawnAndExit(self, argv);
    return; // unreachable in practice — spawnAndExit calls process.exit
  }

  // POSIX path — call Bun's native execve. NEVER returns on success.
  //
  // NOTE: `process.env` here is deliberate (mirrors Go's `os.Environ()`).
  // The exec replaces the current process with a fresh fnclaude, NOT
  // claude. The relaunched fnclaude will reload its own config and
  // re-apply [exec.env] before starting its claude child — merging config
  // env in here would double-inject those vars into the relaunched
  // fnclaude's own environment.
  //
  // Behavioral note: Bun's `process.execve` is uncatchable on failure —
  // when the kernel rejects the exec (ENOENT / EACCES / ENOEXEC / etc.)
  // Bun's runtime prints a SystemError to stderr and aborts the process
  // with SIGABRT (exit code 134). That differs from Go's `syscall.Exec`
  // which returns the error. The Go code's "if exec fails, fall through"
  // path is therefore unreachable on Bun — we get an abort instead.
  //
  // Implication for callers: don't rely on a returnable execve failure as
  // a recoverable path; any silentRelaunch* invocation that doesn't replace
  // the process is fatal. In practice that's the right semantics — if the
  // self path is unusable, we can't continue, and a noisy abort is more
  // informative than silently propagating a stale exit code.
  const execve = (process as ExecveProcess).execve;
  if (typeof execve !== 'function') {
    process.stderr.write(
      `fnclaude: process.execve unavailable on this runtime (Bun 1.3.14+ required); cannot ${label}\n`,
    );
    return;
  }

  // argv[0] is conventionally the program name; pass the full argv slice
  // with self at the front. Never returns on success; SIGABRTs on failure.
  execve(self, argv, process.env);
}

/**
 * Windows fallback for silentRelaunch* — spawn a child fnclaude with
 * inherited stdio, wait for it to exit, and call process.exit with its
 * code. Mirrors src/pty_run_windows.go's silentRelaunchHandoff.
 *
 * Exported for testability; production callers go through execOrSpawn.
 */
export function spawnAndExit(self: string, argv: string[]): void {
  // argv[0] is the program name slot (matches POSIX execve convention).
  // For child_process.spawn we pass the remaining args.
  const child = spawn(self, argv.slice(1), { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (typeof code === 'number') {
      process.exit(code);
    } else if (signal !== null) {
      // Signaled: emit non-zero exit. Match POSIX shell convention of
      // 128 + signal number where we can map it; default to 1.
      process.exit(1);
    } else {
      process.exit(1);
    }
  });
  child.on('error', (err) => {
    process.stderr.write(`fnclaude: handoff exec failed: ${err.message}\n`);
    process.exit(1);
  });
}
