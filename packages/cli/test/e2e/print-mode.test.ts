/**
 * End-to-end coverage for the `-p` / `--print` (non-interactive) argv shape.
 *
 * Unit tests in `argv.test.ts`, `prompts.test.ts`, and `autoname.test.ts`
 * pin the predicates in isolation, but nothing was watching whether the
 * REAL bin's spawn shape actually collapses to the minimal print-mode form
 * end-to-end: no autoname call, no `--append-system-prompt` even with a
 * populated prompts dir, and no self-MCP `--mcp-config` injection. This
 * file plugs that gap by running the published bin against a fake `claude`
 * on PATH and asserting on the captured argv — mirroring the harness from
 * PR #119 (`argv-passthrough.test.ts`).
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
 * Root temp dir for this test file. Same shape as `argv-passthrough.test.ts`:
 *   - bin/claude   — pure-bash fake that captures its argv.
 *   - logs/        — per-invocation argv captures (one JSON per call).
 *   - prompts/     — fragments dir pointed at via FNC_PROMPTS_DIR. Populated
 *                    deliberately so the test proves -p/--print SUPPRESSES
 *                    --append-system-prompt even when fragments exist.
 *   - home/        — clean HOME so config / repo-settings / host-aliases
 *                    loaders don't touch the real user.
 *   - xdg/         — clean XDG_CONFIG_HOME so seedNoop writes here.
 */
let ROOT: string;
let FAKE_BIN_DIR: string;
let LOG_DIR: string;
let PROMPTS_DIR: string;
let FAKE_HOME: string;
let FAKE_XDG: string;

/**
 * Pure-bash fake `claude`. Captures its argv into a sequenced JSON file
 * under FNC_TEST_LOG_DIR and exits 0. No `-p` branching needed here —
 * in `-p`/`--print` mode the cli does NOT spawn the autoname call, so
 * there's exactly one invocation per test (the main session). The trap
 * and pure-bash IO discipline match `argv-passthrough.test.ts`; see that
 * file for the rationale on `trap '' HUP` and the no-fork JSON build.
 */
const FAKE_CLAUDE_SCRIPT = [
  '#!/usr/bin/env bash',
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
  'exit 0',
  '',
].join('\n');

beforeAll(() => {
  if (SKIP_WINDOWS) return;
  ROOT = mkdtempSync(join(tmpdir(), 'fnc-print-e2e-'));
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

  // Populated fragments dir — deliberately. The whole point of these tests
  // is that -p/--print SUPPRESSES fragment injection even when fragments
  // exist; an empty dir would prove the suppression vacuously.
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
 * Same shape as `argv-passthrough.test.ts`'s `runBinCapturingArgv`; see
 * that file for the rationale on FNC_ARGS_JSON, `stdin: 'ignore'`, and
 * the unset ANTHROPIC_API_KEY (kept out of `env` here for the same
 * reason — even though -p mode doesn't autoname, we want a fully
 * deterministic env across the file).
 */
async function runBin(
  argvJson: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; captures: Capture[]; stdout: string; stderr: string }> {
  // Wipe LOG_DIR so the per-test capture sequence starts at 1.
  for (const f of readdirSync(LOG_DIR)) rmSync(join(LOG_DIR, f), { force: true });

  const path = `${FAKE_BIN_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`;

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

describe.skipIf(SKIP_WINDOWS)('claude argv passthrough — `-p` / `--print` non-interactive shape', () => {
  test.each([['-p'], ['--print']])(
    'fnc %s -- "say hi": exactly one claude spawn (no autoname)',
    async (flag) => {
      // Interactive `fnc -- "say hi"` produces TWO claude calls (autoname +
      // main); -p / --print sessions skip autoname entirely. If a regression
      // ever reintroduces the autoname call here, captures.length will jump
      // and this assertion fires.
      const { captures } = await runBin([flag, '--', 'say hi']);

      expect(captures.length).toBe(1);

      const argv = captures[0]!.argv;
      expect(argv).toContain(flag);

      // The prompt body survives past the sentinel.
      const sentinelIdx = argv.indexOf('--');
      expect(sentinelIdx).toBeGreaterThanOrEqual(0);
      expect(argv.slice(sentinelIdx + 1)).toContain('say hi');
    },
  );

  test.each([['-p'], ['--print']])(
    'fnc %s -- "say hi": no --append-system-prompt even with populated FNC_PROMPTS_DIR',
    async (flag) => {
      // `selectFragments` returns [] for non-interactive sessions
      // (prompts.ts:230), so withAppendedSystemPrompts should be a no-op.
      // Cover both standalone-token and `--append-system-prompt=value`
      // shapes — neither should appear in the final argv.
      const { captures } = await runBin([flag, '--', 'say hi']);

      expect(captures.length).toBe(1);
      const argv = captures[0]!.argv;

      expect(argv).not.toContain('--append-system-prompt');
      expect(argv.some((t) => t.startsWith('--append-system-prompt='))).toBe(false);
    },
  );

  test.each([['-p'], ['--print']])(
    'fnc %s -- "say hi": no self-MCP --mcp-config injection',
    async (flag) => {
      // The fnclaude self-MCP block is gated by isInteractiveSession in
      // argv.ts:179, so a minimal -p/--print invocation with no -d flags
      // should carry no --mcp-config tokens at all. (Extra-dir injection
      // is the only other source and isn't exercised here.)
      const { captures } = await runBin([flag, '--', 'say hi']);

      expect(captures.length).toBe(1);
      const argv = captures[0]!.argv;

      expect(argv).not.toContain('--mcp-config');
    },
  );
});
