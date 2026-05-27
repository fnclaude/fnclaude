/**
 * End-to-end regression coverage for the `--` sentinel ordering invariant
 * in the assembled claude argv.
 *
 * Unit tests for `withAppendedSystemPrompts` cover the pure function in
 * isolation, but they CAN'T catch the regression class where the spawn
 * shape silently changes — e.g. PR #117 fixed a bug where claude received
 * `claude … -- "say hi" --append-system-prompt <frags>` and the sentinel
 * caused the flag-pair to be swallowed as additional prompt text. The fix
 * exists, but nothing was watching whether the REAL bin spawns claude with
 * the correct ordering. This file plugs that gap by running the published
 * bin against a fake `claude` on PATH and inspecting the argv it received.
 *
 * Skipped on Windows for the same reason as `bin-fnc.test.ts` — the bin
 * shim is a Unix shebang script.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');
const BUN = process.execPath; // real Bun, no mise shim required.

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * Root temp dir for this test file. Holds:
 *   - bin/claude           — pure-bash fake that captures its argv.
 *   - logs/                — per-invocation argv captures (one JSON per call).
 *   - prompts/             — fragments dir pointed at via FNC_PROMPTS_DIR so
 *                            selectFragments returns a non-empty set and
 *                            `--append-system-prompt` actually gets emitted.
 *   - home/                — clean HOME so config / repo-settings / host-
 *                            aliases loaders don't touch the real user.
 *   - xdg/                 — clean XDG_CONFIG_HOME so seedNoop writes here.
 */
let ROOT: string;
let FAKE_BIN_DIR: string;
let LOG_DIR: string;
let PROMPTS_DIR: string;
let FAKE_HOME: string;
let FAKE_XDG: string;

/**
 * Pure-bash fake `claude`. Captures its argv into a sequenced JSON file
 * (invocation-1.json, invocation-2.json, ...) under FNC_TEST_LOG_DIR so
 * the autoname call (capture 0) and the main-session call (capture N-1)
 * can be addressed separately by the test.
 *
 * Why pure bash (no jq, no `node -e`, no `$(...)`): node-pty spawns its
 * child in a new session with the slave PTY as the controlling tty, and
 * under bun's `Bun.spawn`-with-stdout:`pipe` parent shape (what the test
 * harness uses) the slave-side process gets SIGHUP very early — observed
 * to fire before bash reaches its second statement. Every external fork
 * is another scheduling point where the script could die mid-write.
 *
 * Defence-in-depth:
 *   - `trap '' HUP` ignores the slave-side hangup so bash runs through.
 *   - JSON is built in a bash variable with parameter-expansion escaping
 *     and written in a single `printf > out` to minimise IO surface.
 *
 * When invoked with `-p` (the autoname shape: `claude -p --model ... <prompt>`),
 * the fake emits a short slug to stdout and exits 0 — otherwise generateName
 * falls back to heuristicName and the test can't distinguish "fake fired"
 * from "fake never invoked". For the main-session spawn (no -p), the fake
 * stays silent.
 *
 * Written as plain string concatenation (no template literal) so the bash
 * `${VAR}` and `$(...)` constructs aren't mistaken for JS interpolation.
 */
const FAKE_CLAUDE_SCRIPT = [
  '#!/usr/bin/env bash',
  // The cli launches claude under node-pty in its own session, slave-side.
  // Under bun's `Bun.spawn`-with-stdout:`pipe` parent (the harness shape),
  // the slave-side process receives SIGHUP very early — observed to fire
  // before bash gets past its second statement. Bash exits on SIGHUP by
  // default, half-writing the capture file. Ignoring it lets the script
  // run to completion. Real fnclaude runs from a TTY parent and never
  // surfaces this; it's harness-specific.
  "trap '' HUP",
  '',
  'logDir="${FNC_TEST_LOG_DIR}"',
  'if [ -z "$logDir" ]; then',
  '  echo "fake-claude: FNC_TEST_LOG_DIR must be set" >&2',
  '  exit 2',
  'fi',
  'mkdir -p "$logDir"',
  '',
  '# Pick next sequence index via bash glob — no fork, no command sub.',
  'shopt -s nullglob',
  'files=("$logDir"/invocation-*.json)',
  'idx=$((${#files[@]} + 1))',
  'out="$logDir/invocation-$idx.json"',
  '',
  '# Build JSON in a bash variable, no jq / no $(…). Single write keeps the',
  '# slave-side IO to one burst, minimising race surface against any',
  '# follow-up SIGHUP (belt and braces with the trap above).',
  'json=\'{"argv":[\'',
  'first=1',
  'for a in "$@"; do',
  '  if [ $first -eq 1 ]; then',
  '    first=0',
  '  else',
  "    json+=','",
  '  fi',
  '  s="$a"',
  '  s="${s//\\\\/\\\\\\\\}"',
  '  s="${s//\\"/\\\\\\"}"',
  "  s=\"${s//$'\\n'/\\\\n}\"",
  "  s=\"${s//$'\\t'/\\\\t}\"",
  "  s=\"${s//$'\\r'/\\\\r}\"",
  '  json+=\'"\'"$s"\'"\'',
  'done',
  "json+=']}'",
  '',
  'printf \'%s\' "$json" > "$out"',
  '',
  '# Autoname shape (claude -p ...) → emit a slug and exit. Otherwise stay',
  '# silent so the cli sees no cross-cwd marker in the PTY tail.',
  'for a in "$@"; do',
  '  if [ "$a" = "-p" ]; then',
  "    printf 'fake-session\\n'",
  '    exit 0',
  '  fi',
  'done',
  '',
  'exit 0',
  '',
].join('\n');

beforeAll(() => {
  if (SKIP_WINDOWS) return;
  ROOT = mkdtempSync(join(tmpdir(), 'fnc-argv-e2e-'));
  FAKE_BIN_DIR = join(ROOT, 'bin');
  LOG_DIR = join(ROOT, 'logs');
  PROMPTS_DIR = join(ROOT, 'prompts');
  FAKE_HOME = join(ROOT, 'home');
  FAKE_XDG = join(ROOT, 'xdg');

  mkdirSync(FAKE_BIN_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(PROMPTS_DIR, { recursive: true });
  mkdirSync(FAKE_HOME, { recursive: true });
  mkdirSync(FAKE_XDG, { recursive: true });

  // Install the fake. mode 0o755 = rwxr-xr-x so PATH lookup + execve work.
  writeFileSync(join(FAKE_BIN_DIR, 'claude'), FAKE_CLAUDE_SCRIPT, { mode: 0o755 });

  // One fragment file is enough for selectFragments() to return non-empty;
  // see packages/cli/src/prompts.ts. With FNC_PROMPTS_DIR pointed here,
  // agent-pitfall is picked up for interactive sessions.
  writeFileSync(join(PROMPTS_DIR, 'agent-pitfall.md'), 'test-fragment\n');
});

afterAll(() => {
  if (SKIP_WINDOWS) return;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

interface Capture {
  argv: string[];
}

/**
 * Spawn the bin with the given FNC_ARGS_JSON args under a hermetic env.
 *
 * Why FNC_ARGS_JSON instead of passing `--` directly on argv: Bun strips
 * the first `--` from a script's argv regardless of position. The bin
 * shim normally papers over this by re-exec'ing under Bun with
 * FNC_ARGS_JSON set, but the re-exec is gated on running under Node first
 * — under direct `bun fnc.js -- …` from a test, the `--` is already lost
 * by the time the cli sees process.argv. Setting FNC_ARGS_JSON ourselves
 * sidesteps the issue and is exactly what `main.ts:readArgvFromEnvOrProcess`
 * is designed to consume.
 *
 * `stdin: 'ignore'` (NOT an empty Buffer + stdout: 'pipe') — the
 * combination `stdin=empty-Buffer + stdout=pipe` is uniquely broken for
 * the cli's child-spawn shape; 'ignore' / 'inherit' / null all work.
 */
async function runBinCapturingArgv(
  argvJson: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; captures: Capture[]; stdout: string; stderr: string }> {
  // Wipe LOG_DIR so the per-test capture sequence starts at 1.
  for (const f of readdirSync(LOG_DIR)) rmSync(join(LOG_DIR, f), { force: true });

  // Build a clean PATH with our fake bin in front. Keep system bins so
  // bash inside the fake resolves (and the cli's own subprocess machinery
  // can still find any shell-out helpers, though the fake itself never
  // forks).
  const path = `${FAKE_BIN_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`;

  // ANTHROPIC_API_KEY must NOT be set, or the autoname code path skips the
  // claude CLI shell-out (defaultLlmClient takes over) and we never capture
  // the autoname invocation — which would also defeat the
  // "two captures => two distinct calls" sanity test.
  const env: Record<string, string> = {
    PATH: path,
    HOME: FAKE_HOME,
    XDG_CONFIG_HOME: FAKE_XDG,
    FNC_PROMPTS_DIR: PROMPTS_DIR,
    FNC_TEST_LOG_DIR: LOG_DIR,
    FNC_ARGS_JSON: JSON.stringify(argvJson),
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

    // Read every captured invocation in order. Sort numerically by the
    // index in "invocation-N.json" so callers can address [0] = first call.
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('invocation-') && f.endsWith('.json'))
      .sort((a, b) => {
        const ia = Number(a.match(/^invocation-(\d+)\.json$/)?.[1] ?? '0');
        const ib = Number(b.match(/^invocation-(\d+)\.json$/)?.[1] ?? '0');
        return ia - ib;
      });
    const captures: Capture[] = files.map(
      (f) => JSON.parse(readFileSync(join(LOG_DIR, f), 'utf8')) as Capture,
    );

    return { exitCode, captures, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_WINDOWS)('claude argv passthrough — `--` sentinel ordering', () => {
  test('autoname spawn invokes claude with -p (pins the two-call invariant)', async () => {
    // Run a `-- "prompt"` invocation. The cli should make TWO claude calls:
    // first the autoname (`claude -p --model …`), then the main session
    // (`claude --mcp-config … --append-system-prompt … -- "say hi"`).
    // If this assertion ever fails (only one capture, or the first capture
    // doesn't carry -p), the spawn shape has changed and the main-session
    // capture index in the assertions below is no longer trustworthy.
    const { captures } = await runBinCapturingArgv(['--', 'say hi']);

    expect(captures.length).toBeGreaterThanOrEqual(2);
    // First capture is the autoname call.
    expect(captures[0]!.argv).toContain('-p');
  });

  test('fnc -- "say hi": --append-system-prompt precedes --, prompt follows --', async () => {
    // Regression coverage for PR #117. Without the sentinel-aware splice in
    // withAppendedSystemPrompts, claude would receive `claude … -- "say hi"
    // --append-system-prompt <frags>` and treat the trailing flag-pair as
    // additional prompt text, silently exiting on the malformed input.
    const { captures } = await runBinCapturingArgv(['--', 'say hi']);

    expect(captures.length).toBeGreaterThanOrEqual(2);
    const main = captures[captures.length - 1]!.argv;

    const aspIdx = main.indexOf('--append-system-prompt');
    const sentinelIdx = main.indexOf('--');
    expect(aspIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(aspIdx).toBeLessThan(sentinelIdx);

    // The prompt body lives among the post-sentinel tokens.
    const postSentinel = main.slice(sentinelIdx + 1);
    expect(postSentinel).toContain('say hi');
  });

  test('fnc opus -- "do something": both --model opus and --append-system-prompt precede --', async () => {
    // Magic-word `opus` should be translated to `--model opus` in passthrough
    // by the argParser, BEFORE the sentinel. The append-system-prompt splice
    // must also land before the sentinel. Both flag-pairs together must not
    // be pushed past `--` into prompt-text territory.
    const { captures } = await runBinCapturingArgv(['opus', '--', 'do something']);

    expect(captures.length).toBeGreaterThanOrEqual(2);
    const main = captures[captures.length - 1]!.argv;

    const modelIdx = main.indexOf('--model');
    const aspIdx = main.indexOf('--append-system-prompt');
    const sentinelIdx = main.indexOf('--');

    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(aspIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);

    expect(modelIdx).toBeLessThan(sentinelIdx);
    expect(aspIdx).toBeLessThan(sentinelIdx);

    // And the --model value is indeed "opus".
    expect(main[modelIdx + 1]).toBe('opus');

    // Prompt body still survives past the sentinel.
    expect(main.slice(sentinelIdx + 1)).toContain('do something');
  });
});
