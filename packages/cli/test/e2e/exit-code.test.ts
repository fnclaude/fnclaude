/**
 * End-to-end coverage for PTY exit-code propagation.
 *
 * The cli wraps the main claude session in a node-pty subprocess and is
 * supposed to surface the child's exit code as its own. Unit-level pty
 * tests cover the wiring in isolation, but nothing currently watches the
 * real bin to confirm the propagation survives end-to-end. This file
 * inherits the harness from `argv-passthrough.test.ts` (PR #119) — same
 * pure-bash fake claude with `trap '' HUP`, same hermetic env, same
 * FNC_ARGS_JSON dispatch — and diverges only in the fake: the main-session
 * branch now exits with `$FNC_TEST_EXIT_CODE`, while the autoname branch
 * (`-p` in argv) still exits 0 so the cli proceeds to the main spawn.
 *
 * Skipped on Windows for the same reason as `bin-fnc.test.ts` — the bin
 * shim is a Unix shebang script.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');
const BUN = process.execPath; // real Bun, no mise shim required.

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * Root temp dir for this test file. Holds:
 *   - bin/claude           — pure-bash fake whose main-session branch exits
 *                            with $FNC_TEST_EXIT_CODE (default 0).
 *   - prompts/             — fragments dir pointed at via FNC_PROMPTS_DIR so
 *                            selectFragments returns a non-empty set and
 *                            `--append-system-prompt` actually gets emitted
 *                            (matches autoname/main-session shape from #119).
 *   - home/                — clean HOME so config / repo-settings / host-
 *                            aliases loaders don't touch the real user.
 *   - xdg/                 — clean XDG_CONFIG_HOME so seedNoop writes here.
 */
let ROOT: string;
let FAKE_BIN_DIR: string;
let PROMPTS_DIR: string;
let FAKE_HOME: string;
let FAKE_XDG: string;

/**
 * Pure-bash fake `claude`. Two branches, distinguished by whether `-p` is
 * present in argv:
 *
 *   - `-p` present (autoname call): emit a slug to stdout and exit 0,
 *     UNCONDITIONALLY. We deliberately ignore $FNC_TEST_EXIT_CODE here so
 *     the cli proceeds to the main session — otherwise we'd be measuring
 *     the autoname call's exit, not the propagation guarantee the test is
 *     about.
 *   - `-p` absent (main session): exit with $FNC_TEST_EXIT_CODE (default 0).
 *     The fnc cli should surface this as its own exit code.
 *
 * Why pure bash (no jq, no `node -e`, no `$(...)`): inherited rationale from
 * PR #119 — node-pty spawns its child in a new session with the slave PTY
 * as the controlling tty, and under Bun.spawn with stdout:'pipe' parent
 * shape, the slave-side process gets SIGHUP very early. `trap '' HUP`
 * ignores the hangup so bash runs through; no external forks means no
 * extra scheduling points to die on.
 *
 * Written as plain string concatenation (no template literal) so the bash
 * `${VAR}` constructs aren't mistaken for JS interpolation.
 */
const FAKE_CLAUDE_SCRIPT = [
  '#!/usr/bin/env bash',
  // Same SIGHUP defence as PR #119's harness; see argv-passthrough.test.ts
  // for the full reasoning.
  "trap '' HUP",
  '',
  '# Autoname shape (claude -p …): emit a slug and exit cleanly, no matter',
  '# what FNC_TEST_EXIT_CODE is set to. The propagation under test is for the',
  '# MAIN session only — if autoname exits non-zero the cli aborts before it',
  '# ever spawns the main session, and the test measures the wrong thing.',
  'for a in "$@"; do',
  '  if [ "$a" = "-p" ]; then',
  "    printf 'fake-session\\n'",
  '    exit 0',
  '  fi',
  'done',
  '',
  '# Main-session shape: exit with the requested code. Default 0 so an',
  '# accidentally-unset env doesn\'t mask a regression as a green test.',
  'code="${FNC_TEST_EXIT_CODE:-0}"',
  'exit "$code"',
  '',
].join('\n');

beforeAll(() => {
  if (SKIP_WINDOWS) return;
  ROOT = mkdtempSync(join(tmpdir(), 'fnc-exit-code-e2e-'));
  FAKE_BIN_DIR = join(ROOT, 'bin');
  PROMPTS_DIR = join(ROOT, 'prompts');
  FAKE_HOME = join(ROOT, 'home');
  FAKE_XDG = join(ROOT, 'xdg');

  mkdirSync(FAKE_BIN_DIR, { recursive: true });
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(FAKE_XDG, { recursive: true });

  // Install the fake. mode 0o755 = rwxr-xr-x so PATH lookup + execve work.
  writeFileSync(join(FAKE_BIN_DIR, 'claude'), FAKE_CLAUDE_SCRIPT, { mode: 0o755 });

  // One fragment file is enough for selectFragments() to return non-empty;
  // matches the autoname/main-session shape exercised in #119's harness so
  // the cli takes the same code path and `--append-system-prompt` appears
  // in the spawn argv as it does in production.
  writeFileSync(join(PROMPTS_DIR, 'agent-pitfall.md'), 'test-fragment\n');
});

afterAll(() => {
  if (SKIP_WINDOWS) return;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn the bin with the given FNC_ARGS_JSON args under a hermetic env,
 * pointing the fake claude at $FNC_TEST_EXIT_CODE for the main-session
 * branch.
 *
 * Why FNC_ARGS_JSON instead of passing `--` directly on argv: inherited from
 * PR #119 — Bun strips the first `--` from a script's argv regardless of
 * position. Setting FNC_ARGS_JSON ourselves matches what
 * `main.ts:readArgvFromEnvOrProcess` is designed to consume.
 *
 * `stdin: 'ignore'` (NOT an empty Buffer + stdout: 'pipe') — the
 * combination `stdin=empty-Buffer + stdout=pipe` is uniquely broken for
 * the cli's child-spawn shape; 'ignore' / 'inherit' / null all work.
 */
async function runBinWithFakeExit(
  argvJson: readonly string[],
  fakeExitCode: number,
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Clean PATH with the fake bin in front. Keep system bins so bash inside
  // the fake resolves.
  const path = `${FAKE_BIN_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`;

  // ANTHROPIC_API_KEY must NOT be set, or the autoname code path skips the
  // claude CLI shell-out (defaultLlmClient takes over) and never hits the
  // fake. The main-session spawn still happens, but we want the same shape
  // as the argv-passthrough tests for parity.
  const env: Record<string, string> = {
    PATH: path,
    HOME: FAKE_HOME,
    XDG_CONFIG_HOME: FAKE_XDG,
    FNC_PROMPTS_DIR: PROMPTS_DIR,
    FNC_ARGS_JSON: JSON.stringify(argvJson),
    FNC_TEST_EXIT_CODE: String(fakeExitCode),
    TERM: 'xterm-256color',
  };

  const timeout = opts.timeoutMs ?? 15_000;
  const proc = Bun.spawn([BUN, BIN], {
    cwd: CLI_ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_WINDOWS)('claude exit-code propagation through fnc', () => {
  // Table covers:
  //   0   — happy path: clean exit shouldn't be mistranslated to non-zero.
  //   1   — generic failure.
  //   2   — bash misuse-of-shell / common cli error code.
  //   42  — arbitrary non-special value (catches accidental clamping/mask).
  //   137 — semantically "killed by SIGKILL" (128+9). Here it's just an
  //         explicit `exit 137` from the fake — bash exits propagate ≤255 —
  //         which is enough to assert the cli doesn't normalise non-zero
  //         codes to 1. Signal-induced exit is covered separately in
  //         packages/cli/test/pty.integration.test.ts; trying to simulate a
  //         real signal death here is brittle and not worth the surface.
  test.each([0, 1, 2, 42, 137])(
    'fnc -- "ignored-prompt" surfaces claude exit code %i',
    async (target) => {
      const { exitCode } = await runBinWithFakeExit(['--', 'ignored-prompt'], target);
      expect(exitCode).toBe(target);
    },
  );
});
