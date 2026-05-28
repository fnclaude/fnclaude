/**
 * End-to-end coverage for the launch plan: bin → preflight → parseArgs
 * → expandAliases → expandShortFlags → final {cwd, claudeArgs} that
 * would be handed to Bun.spawn.
 *
 * Uses FNC_INTERNAL_DUMP_PLAN=1 to short-circuit before the actual
 * spawn — verifies that the full pipeline produces the right plan
 * without needing claude on PATH or a fake-claude shim.
 *
 * Skipped on Windows pending the Windows launcher path (separate phase).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

// Point FNC_PROMPTS_DIR at an empty dir so prompt-fragment injection
// no-ops in tests that don't care about the system-prompt block. Tests
// that DO want fragment injection can override extraEnv.FNC_PROMPTS_DIR.
const EMPTY_PROMPTS_DIR = mkdtempSync(join(tmpdir(), 'fnc-e2e-no-prompts-'));

interface PlanResult {
  cwd: string;
  claudeArgs: string[];
  usedNoopFallback: boolean;
}

interface RunResult {
  plan: PlanResult | null;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOptions {
  cwd?: string;
  extraEnv?: Record<string, string>;
}

async function runPlan(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    env: {
      ...process.env,
      FNC_INTERNAL_DUMP_PLAN: '1',
      FNC_PROMPTS_DIR: EMPTY_PROMPTS_DIR,
      ...(opts.extraEnv ?? {}),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  let plan: PlanResult | null = null;
  if (exitCode === 0 && stdout.trim() !== '') {
    plan = JSON.parse(stdout.trim());
  }
  return { plan, stdout, stderr, exitCode };
}

describe.skipIf(SKIP_WINDOWS)('launch plan — cwd resolution', () => {
  test('no args → noop fallback dir', async () => {
    const { plan, exitCode } = await runPlan([]);
    expect(exitCode).toBe(0);
    expect(plan!.usedNoopFallback).toBe(true);
    expect(plan!.cwd).toContain('fnclaude/noop');
  });

  test('absolute path arg → that path as cwd', async () => {
    const { plan, exitCode } = await runPlan(['/tmp']);
    expect(exitCode).toBe(0);
    expect(plan!.cwd).toBe('/tmp');
    expect(plan!.usedNoopFallback).toBe(false);
  });

  test('absolute path with existing dir → launches there', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-abs-'));
    try {
      const sub = join(shell, 'some-dir');
      mkdirSync(sub);
      const { plan, exitCode } = await runPlan([sub], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(plan!.cwd).toBe(sub);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('bare name + local dir match → ambiguous (spec §18.1 disambiguation)', async () => {
    // bare name 'foo' could mean local <shellCwd>/foo OR a gh repo 'foo'.
    // Per spec, that ambiguity surfaces as a clean error — user has to be
    // explicit (e.g. absolute path or owner-qualified).
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-ambig-'));
    try {
      mkdirSync(join(shell, 'some-dir'));
      const { stderr, exitCode } = await runPlan(['some-dir'], { cwd: shell });
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(/ambiguous/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('bare name with no local dir → needs-owner-lookup error (gh CLI not yet wired)', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-bare-'));
    try {
      const { stderr, exitCode } = await runPlan(['totally-unique-name-xyz'], { cwd: shell });
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(/gh CLI|owner|implemented/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('~ → home dir', async () => {
    const { plan, exitCode } = await runPlan(['~']);
    expect(exitCode).toBe(0);
    expect(plan!.cwd).toBe(homedir());
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — magic alias expansion', () => {
  test('opus → --model opus prepended', async () => {
    const { plan, exitCode } = await runPlan(['opus']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--model', 'opus']);
    expect(plan!.usedNoopFallback).toBe(true);
  });

  test('opus + high → --model opus --effort high', async () => {
    const { plan, exitCode } = await runPlan(['opus', 'high']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  test('bare high (effort-without-model) → opus injected per §4.3', async () => {
    const { plan, exitCode } = await runPlan(['high']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  test('resume → --resume', async () => {
    const { plan, exitCode } = await runPlan(['resume']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--resume']);
  });

  test('fork → --resume --fork-session', async () => {
    const { plan, exitCode } = await runPlan(['fork']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--resume', '--fork-session']);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — short-flag expansion', () => {
  test('-BV → --brief --verbose', async () => {
    const { plan, exitCode } = await runPlan(['-BV']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--brief', '--verbose']);
  });

  test('-M plan → --permission-mode plan', async () => {
    const { plan, exitCode } = await runPlan(['-M', 'plan']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--permission-mode', 'plan']);
  });

  test('mid-cluster shortRequired → error exit 2', async () => {
    const { stderr, exitCode } = await runPlan(['-MV']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/middle/);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — prompt body preservation', () => {
  test('-- hello → passthrough has -- hello', async () => {
    const { plan, exitCode } = await runPlan(['--', 'hello']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--', 'hello']);
  });

  test('opus -- fix the bug → magic + sentinel + body all preserved', async () => {
    const { plan, exitCode } = await runPlan(['opus', '--', 'fix the bug']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).toEqual(['--model', 'opus', '--', 'fix the bug']);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — prompt fragment injection', () => {
  const REAL_PROMPTS = resolve(CLI_ROOT, 'prompts');

  test('noop session → --append-system-prompt contains noop-router content', async () => {
    const { plan, exitCode } = await runPlan([], {
      extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS },
    });
    expect(exitCode).toBe(0);
    const flagIdx = plan!.claudeArgs.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const value = plan!.claudeArgs[flagIdx + 1]!;
    // noop-router fragment is selected only for noop sessions.
    expect(value.toLowerCase()).toContain('noop');
  });

  test('non-noop interactive → fragments injected without noop-router', async () => {
    const { plan, exitCode } = await runPlan(['/tmp'], {
      extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS },
    });
    expect(exitCode).toBe(0);
    const flagIdx = plan!.claudeArgs.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const value = plan!.claudeArgs[flagIdx + 1]!;
    // Should NOT contain noop-router content (which mentions the noop bucket).
    expect(value.toLowerCase()).not.toContain('noop-router');
  });

  test('print mode (-p) → no --append-system-prompt', async () => {
    const { plan, exitCode } = await runPlan(['-p', '--', 'hello'], {
      extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS },
    });
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--append-system-prompt');
  });

  test('missing FNC_PROMPTS_DIR (set to empty dir): warnings to stderr, claudeArgs clean', async () => {
    const { plan, stderr, exitCode } = await runPlan([]);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--append-system-prompt');
    expect(stderr).toMatch(/missing|prompt/i);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — parser errors', () => {
  test('two-positional + third → error', async () => {
    const { stderr, exitCode } = await runPlan(['/a', '/b', '/c']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/too many|positional/i);
  });

  test('duplicate subcommand → error', async () => {
    const { stderr, exitCode } = await runPlan(['resume', 'continue']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/only one of|resume|continue/i);
  });
});
