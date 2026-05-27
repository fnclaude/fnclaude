/**
 * End-to-end regression coverage for the fnclaude self-MCP injection in the
 * assembled claude argv.
 *
 * Unit tests for `buildArgv` and `buildFnclaudeMCPConfigJSON` cover the
 * helpers in isolation, but nothing watches whether the real bin spawns
 * claude with `--mcp-config '<inline-json>'` carrying a valid fnclaude
 * server entry, or whether the gate flips off correctly for `-p` / `--print`
 * sessions. This file plugs that gap by running the published bin against a
 * fake `claude` on PATH and inspecting the argv it received.
 *
 * Harness is inherited from `argv-passthrough.test.ts` (PR #119): pure-bash
 * fake claude with `trap '' HUP`, FNC_ARGS_JSON to bypass Bun's `--`
 * stripping, hermetic env, `stdin: 'ignore'`. Skipped on Windows for the
 * same reason as `bin-fnc.test.ts` — the bin shim is a Unix shebang script.
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
 *                            selectFragments returns a non-empty set for
 *                            interactive runs.
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
 * Pure-bash fake `claude`. See argv-passthrough.test.ts for the rationale
 * behind every defensive measure (HUP trap, single-write JSON build, no
 * external forks). Duplicated rather than extracted to keep each e2e file
 * self-contained — the harness is small and the duplication isolates each
 * test from accidental coupling through a shared module.
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
  ROOT = mkdtempSync(join(tmpdir(), 'fnc-self-mcp-e2e-'));
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

  // One fragment file is enough for selectFragments() to return non-empty
  // for the interactive cases; not strictly required for the self-MCP gate
  // (which keys off isInteractiveSession alone) but mirrors the realistic
  // shape captured by argv-passthrough.test.ts and matches its env exactly.
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
 * See argv-passthrough.test.ts for the rationale behind FNC_ARGS_JSON,
 * `stdin: 'ignore'`, and the clean PATH/HOME/XDG setup.
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

/**
 * Shape of the inline --mcp-config JSON we care about: an object with
 * `mcpServers.fnclaude.command` (any non-empty string) and
 * `mcpServers.fnclaude.args` (string array).
 */
interface FnclaudeMcpConfig {
  mcpServers?: {
    fnclaude?: {
      command?: string;
      args?: string[];
    };
  };
}

/**
 * Scan `argv` for every `--mcp-config <json>` pair where <json> starts with
 * `{`. Parse each and return the [index, parsed] tuples. Index points at the
 * `--mcp-config` token itself (not its value). Non-JSON values (e.g.
 * `--mcp-config /some/path.json` from extra-dir injection) are skipped.
 */
function findInlineMcpConfigs(argv: readonly string[]): { idx: number; cfg: FnclaudeMcpConfig }[] {
  const out: { idx: number; cfg: FnclaudeMcpConfig }[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '--mcp-config') continue;
    const value = argv[i + 1] as string;
    if (!value.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(value) as FnclaudeMcpConfig;
      out.push({ idx: i, cfg: parsed });
    } catch {
      // Not JSON — skip.
    }
  }
  return out;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_WINDOWS)('claude argv — fnclaude self-MCP injection', () => {
  test('interactive session injects --mcp-config with the fnclaude server shape', async () => {
    // Regression coverage for the buildArgv self-MCP gate. Without this
    // injection the spawned claude has no way to call back into the running
    // fnclaude binary for fnc_restart, fnc_switch_project, fnc_copy_to_clipboard.
    const { captures } = await runBin(['--', 'say hi']);

    expect(captures.length).toBeGreaterThanOrEqual(2);
    const main = captures[captures.length - 1]!.argv;

    const inline = findInlineMcpConfigs(main);
    expect(inline.length).toBeGreaterThan(0);

    // At least one inline --mcp-config must carry the fnclaude server entry.
    const fnclaudeEntries = inline.filter((e) => e.cfg.mcpServers?.fnclaude !== undefined);
    expect(fnclaudeEntries.length).toBeGreaterThan(0);

    const fnc = fnclaudeEntries[0]!.cfg.mcpServers!.fnclaude!;
    // command is the resolved-self-path; under the harness it'll be either
    // bun (process.execPath) or the BIN path. Just assert non-empty.
    expect(typeof fnc.command).toBe('string');
    expect(fnc.command!.length).toBeGreaterThan(0);
    expect(Array.isArray(fnc.args)).toBe(true);
    expect(fnc.args![0]).toBe('mcp');
  });

  test('interactive session: self-MCP --mcp-config precedes the `--` sentinel', async () => {
    // Sentinel-aware injection is the bug class PR #117 closed; the
    // self-MCP injection site is separate from withAppendedSystemPrompts
    // so it gets its own ordering guard here. If the self-MCP block ever
    // moves below the sentinel, claude swallows the inline JSON as prompt
    // text and the MCP server never starts.
    const { captures } = await runBin(['--', 'say hi']);

    expect(captures.length).toBeGreaterThanOrEqual(2);
    const main = captures[captures.length - 1]!.argv;

    const inline = findInlineMcpConfigs(main);
    const fnclaudeEntry = inline.find((e) => e.cfg.mcpServers?.fnclaude !== undefined);
    expect(fnclaudeEntry).toBeDefined();

    const sentinelIdx = main.indexOf('--');
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(fnclaudeEntry!.idx).toBeLessThan(sentinelIdx);
  });

  test('non-interactive (-p) session does NOT inject the self-MCP', async () => {
    // -p / --print sessions are one-shot and have no use for fnc_restart /
    // fnc_switch_project / fnc_copy_to_clipboard. The buildArgv gate must
    // skip the injection entirely; otherwise we're spawning a useless MCP
    // server subprocess for every non-interactive run.
    //
    // -p mode also skips autoname (see autoname.ts:39-41), so there's only
    // ONE capture — the main session.
    const { captures } = await runBin(['-p', '--', 'say hi']);

    expect(captures.length).toBe(1);
    const main = captures[0]!.argv;

    // Without -d / --add-dir flags there's no extra-dir --mcp-config
    // either, so the cleanest assertion is: no --mcp-config tokens at all.
    expect(main).not.toContain('--mcp-config');
  });
});
