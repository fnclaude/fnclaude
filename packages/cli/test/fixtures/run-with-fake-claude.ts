/**
 * `runWithFakeClaude` — drive the real fnc launcher end-to-end with the
 * scriptable `fake-claude` fixture standing in for the real binary.
 *
 * fnc resolves `claude` by walking $PATH for a file named exactly
 * `claude` (see src/launch/find-claude.ts). The seam this helper drives
 * is therefore PATH: it builds a throwaway dir holding a `claude` symlink
 * to the fixture, prepends that dir to PATH, and spawns the bin. No env
 * override like CLAUDE_BIN exists — PATH *is* the override.
 *
 * Two spawn modes:
 *
 *   - default (`pty: false`): spawn `bun bin/fnc.js` with piped stdio.
 *     stdin/stdout are NOT TTYs, so main.ts takes the stdio-inherit
 *     branch — the ring buffer stays empty and no cross-cwd relaunch
 *     fires. Good for asserting on a single invocation's argv/cwd/env.
 *
 *   - `pty: true`: wrap the spawn in `script -q /dev/null -c '<cmd>'` so
 *     fnc runs under a real PTY (stdin + stdout both isTTY). This is the
 *     ONLY way the §9.0 useTerminal branch — and therefore the §9.1 ring
 *     buffer + §9.3 cross-cwd relaunch — engages. The A2 #55 regression
 *     needs this so fnc actually scans fake-claude's emitted hint and
 *     relaunches.
 *
 * Returns the subprocess result plus the parsed invocation log: one entry
 * per fake-claude invocation, in order. A clean single-launch run yields
 * one entry; a #55-style resume loop would yield two-plus.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURES_DIR = resolve(import.meta.dir);
const FAKE_CLAUDE = join(FIXTURES_DIR, 'fake-claude');
const CLI_ROOT = resolve(FIXTURES_DIR, '..', '..');
const BIN = join(CLI_ROOT, 'bin', 'fnc.js');

export interface FakeClaudeInvocation {
  /** process.argv.slice(2) the fake saw — the args fnc handed claude. */
  argv: string[];
  /** process.cwd() — the launch cwd fnc spawned the fake in. */
  cwd: string;
  /** Allow-listed env subset (FNC_ARGS_JSON + the FAKE_CLAUDE_* knobs). */
  env: Record<string, string | undefined>;
}

export interface RunWithFakeClaudeArgs {
  /** Args handed to fnc via FNC_ARGS_JSON (matches the node→bun preflight). */
  args: readonly string[];
  /** Launch cwd for the fnc process. Defaults to a fresh temp dir. */
  cwd?: string;
  /**
   * Extra env handed to BOTH fnc and (inherited by) the fake. Use this for
   * the FAKE_CLAUDE_* knobs (EMIT_HINT / EXIT) and any fnc internals.
   */
  env?: Record<string, string>;
  /**
   * Run fnc under a real PTY via `script` so the §9.0 useTerminal branch
   * (ring buffer + cross-cwd relaunch) engages. Default false.
   */
  pty?: boolean;
  /** Hard timeout (ms) before the child is killed. Default 15_000. */
  timeoutMs?: number;
}

export interface RunWithFakeClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Parsed fake-claude invocation log, in invocation order. */
  invocations: FakeClaudeInvocation[];
}

function parseLog(logPath: string): FakeClaudeInvocation[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    // No invocations recorded (fake never ran, or never reached the log
    // write) — an empty list is the faithful answer.
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FakeClaudeInvocation);
}

export async function runWithFakeClaude(
  args: RunWithFakeClaudeArgs,
): Promise<RunWithFakeClaudeResult> {
  const workRoot = mkdtempSync(join(tmpdir(), 'fnc-fake-claude-'));
  const binDir = join(workRoot, 'bin');
  const logPath = join(workRoot, 'invocations.jsonl');
  const cwd = args.cwd ?? join(workRoot, 'cwd');

  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // Symlink the fixture in as `claude` so findClaude resolves it. A
    // symlink (rather than a copy) keeps the fixture single-sourced.
    const claudeLink = join(binDir, 'claude');
    symlinkSync(FAKE_CLAUDE, claudeLink);
    chmodSync(FAKE_CLAUDE, 0o755);

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    // Prepend our bin dir so the fake `claude` wins over any real install.
    childEnv.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    childEnv.FAKE_CLAUDE_LOG = logPath;
    // Args land in main.ts's readArgv() via this env var (the preflight
    // shape). Setting it directly skips the node→bun re-exec while keeping
    // the same argv-intake path the real preflight produces.
    childEnv.FNC_ARGS_JSON = JSON.stringify([...args.args]);
    // Keep auto-name off by default so a `-- <prompt>` invocation doesn't
    // shell out to `claude -p` and pollute the invocation log. Callers can
    // override by setting it in `args.env`.
    childEnv.FNC_INTERNAL_DISABLE_AUTONAME = '1';
    for (const [k, v] of Object.entries(args.env ?? {})) {
      childEnv[k] = v;
    }

    const result = args.pty
      ? await spawnUnderPty(childEnv, cwd, args.timeoutMs ?? 15_000)
      : await spawnDirect(childEnv, cwd, args.timeoutMs ?? 15_000);

    return {
      ...result,
      invocations: parseLog(logPath),
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function spawnDirect(
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  // process.execPath is the running bun — spawn the bin under it directly,
  // skipping the node→bun preflight (args already in FNC_ARGS_JSON).
  return collect(process.execPath, [BIN], env, cwd, timeoutMs);
}

function spawnUnderPty(
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  // `script -q /dev/null -c '<cmd>'` runs <cmd> with a PTY attached to
  // both stdin and stdout, so main.ts's `process.stdin.isTTY &&
  // process.stdout.isTTY` gate passes and the useTerminal branch engages.
  // util-linux script is the portable spelling on Linux. The command
  // string is built from absolute paths with no user-controlled bytes, so
  // the single-quote wrapping is safe here.
  const cmd = `${process.execPath} ${BIN}`;
  return collect('script', ['-q', '/dev/null', '-c', cmd], env, cwd, timeoutMs);
}

function collect(
  command: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(command, argv, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `runWithFakeClaude: timed out after ${timeoutMs}ms (likely a resume loop). ` +
            `stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code });
    });
  });
}
