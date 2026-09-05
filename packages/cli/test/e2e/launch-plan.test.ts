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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { cleanEnvForSpawn } from '../../src/handoff/clean-env';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

// Point FNC_PROMPTS_DIR at an empty dir so prompt-fragment injection
// no-ops in tests that don't care about the system-prompt block. Tests
// that DO want fragment injection can override extraEnv.FNC_PROMPTS_DIR.
const EMPTY_PROMPTS_DIR = mkdtempSync(join(tmpdir(), 'fnc-e2e-no-prompts-'));

// A PATH carrying only what the launcher itself needs — `node` to start it
// and `bun` for bin/fnc.js's Node→Bun re-exec — and deliberately no `fngit`.
// Used by the "fngit not installed" case, which must hold on a developer's
// machine (where fngit IS installed) as well as in CI.
const MINIMAL_PATH = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-e2e-minimal-path-'));
  for (const tool of ['node', 'bun']) {
    const real = Bun.which(tool);
    // A missing tool leaves the dir short of it; the test that uses this PATH
    // then fails to spawn, which is a louder signal than silently passing.
    if (real !== null) symlinkSync(real, join(dir, tool));
  }
  return dir;
})();

interface PlanResult {
  cwd: string;
  claudeArgs: string[];
  usedNoopFallback: boolean;
  env: Record<string, string>;
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

/**
 * Strip the §7.4 self-MCP `--mcp-config <json>` pair from a claudeArgs
 * snapshot for tests asserting on the non-MCP-injection portion. The
 * injection is unconditional in interactive mode and shouldn't force
 * every magic-alias / short-flag assertion to repeat the pair.
 */
function stripMcpConfig(claudeArgs: readonly string[]): string[] {
  const idx = claudeArgs.indexOf('--mcp-config');
  if (idx < 0) return [...claudeArgs];
  return [...claudeArgs.slice(0, idx), ...claudeArgs.slice(idx + 2)];
}

async function runPlan(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    // Scrub fnclaude session-scoped vars (FNCLAUDE_HANDOFF, FNC_SOCKET,
    // CLAUDE_CODE_SESSION_ID) from the inherited env. When the suite runs
    // *inside* a live fnc session those are already exported, and the
    // env-composition assertions below would otherwise see the developer's
    // FNCLAUDE_HANDOFF leak through `...process.env` (#214). config.toml is
    // isolated via XDG_CONFIG_HOME; the inherited process env is the second
    // leak vector this closes. The launcher recomputes its own FNC_SOCKET.
    env: {
      ...cleanEnvForSpawn(process.env),
      FNC_INTERNAL_DUMP_PLAN: '1',
      FNC_PROMPTS_DIR: EMPTY_PROMPTS_DIR,
      FNC_INTERNAL_DISABLE_AUTONAME: '1',
      FNC_INTERNAL_DISABLE_SESSION_ID: '1',
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
    expect(plan!.cwd).toContain('rhombus.rocks/fnclaude/noop');
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

  // Was "ambiguous" before the fngit adoption: fnc used to compute the clone
  // destination itself, so it could see that a local directory and a clone
  // both existed and refuse. It no longer computes clone destinations — fngit
  // does — so it cannot see that collision, and a bare word naming a real
  // directory right here resolves to that directory. `./name` still forces
  // the path reading; a repo of the same name needs `name@owner`.
  test('bare name + local dir match → launches the local directory', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-localdir-'));
    try {
      mkdirSync(join(shell, 'some-dir'));
      const { plan, exitCode } = await runPlan(['some-dir'], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(plan!.cwd).toBe(join(shell, 'some-dir'));
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  // A bare name that is not a local directory is a repo reference, and repo
  // references are fngit's. What fnc guarantees on its own is the degraded
  // mode: with no fngit on PATH, the error names `fnc install` rather than
  // failing somewhere obscure. PATH is emptied so the assertion holds on a
  // machine that has fngit installed as well as one that doesn't.
  test('repo reference with no fngit on PATH → error naming `fnc install`', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-bare-'));
    try {
      const { stderr, exitCode } = await runPlan(['totally-unique-name-xyz-fnclaude-test'], {
        cwd: shell,
        extraEnv: { PATH: MINIMAL_PATH },
      });
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(/fngit is not installed/i);
      expect(stderr).toContain('fnc install');
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
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--model', 'opus']);
    expect(plan!.usedNoopFallback).toBe(true);
  });

  test('opus + high → --model opus --effort high', async () => {
    const { plan, exitCode } = await runPlan(['opus', 'high']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  test('bare high (effort-without-model) → opus injected per §4.3', async () => {
    const { plan, exitCode } = await runPlan(['high']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--model', 'opus', '--effort', 'high']);
  });

  test('resume → --resume', async () => {
    const { plan, exitCode } = await runPlan(['resume']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--resume']);
  });

  test('ultracode (no prompt) → tail is `--` `/effort ultracode`, no --effort', async () => {
    const { plan, exitCode } = await runPlan(['ultracode']);
    expect(exitCode).toBe(0);
    const args = stripMcpConfig(plan!.claudeArgs);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).not.toContain('--effort');
    // The initial-prompt slot is exactly `/effort ultracode` after a `--`.
    expect(args.slice(-2)).toEqual(['--', '/effort ultracode']);
  });

  test('ultracode -- say hi → /effort ultracode after --; user prompt dropped from slot', async () => {
    const { plan, exitCode } = await runPlan(['ultracode', '--', 'say hi']);
    expect(exitCode).toBe(0);
    const args = stripMcpConfig(plan!.claudeArgs);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).not.toContain('--effort');
    // `/effort ultracode` is the single element immediately after a `--`.
    const sentIdx = args.indexOf('--');
    expect(sentIdx).toBeGreaterThanOrEqual(0);
    expect(args[sentIdx + 1]).toBe('/effort ultracode');
    // The user's prompt body never competes for the single prompt slot.
    expect(args).not.toContain('say hi');
    expect(args).not.toContain('say');
    expect(args).not.toContain('hi');
  });

  test('fork → --resume --fork-session', async () => {
    const { plan, exitCode } = await runPlan(['fork']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--resume', '--fork-session']);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — short-flag expansion', () => {
  test('-BV → --brief --verbose', async () => {
    const { plan, exitCode } = await runPlan(['-BV']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--brief', '--verbose']);
  });

  test('-M plan → --permission-mode plan', async () => {
    const { plan, exitCode } = await runPlan(['-M', 'plan']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--permission-mode', 'plan']);
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
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--', 'hello']);
  });

  test('opus -- fix the bug → magic + sentinel + body all preserved', async () => {
    const { plan, exitCode } = await runPlan(['opus', '--', 'fix the bug']);
    expect(exitCode).toBe(0);
    expect(stripMcpConfig(plan!.claudeArgs)).toEqual(['--model', 'opus', '--', 'fix the bug']);
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

  test('one-shot print mode (-p) → --append-system-prompt contains one-shot content', async () => {
    const { plan, exitCode } = await runPlan(['-p', '--', 'hello'], {
      extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS },
    });
    expect(exitCode).toBe(0);
    const flagIdx = plan!.claudeArgs.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const value = plan!.claudeArgs[flagIdx + 1]!;
    expect(value.toLowerCase()).toContain('one-shot');
    // Interactive-only fragments stay out of the one-shot run.
    expect(value.toLowerCase()).not.toContain('noop-router');
  });

  test('print + stream-json (program-driven) → no --append-system-prompt', async () => {
    const { plan, exitCode } = await runPlan(
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'],
      { extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS } },
    );
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--append-system-prompt');
  });

  test('missing FNC_PROMPTS_DIR (set to empty dir): warning deferred, claudeArgs clean', async () => {
    // Warnings are deferred to post-claude-exit (§27). DUMP_PLAN exits
    // before claude spawns, so the warning never flushes here — that's
    // the point of the deferral.
    const { plan, stderr, exitCode } = await runPlan([]);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--append-system-prompt');
    expect(stderr).not.toMatch(/missing|prompt/i);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — worktree intercept (-w)', () => {
  test('-w <name> in a non-repo dir → no-match path → --worktree + --name pushed', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-w-'));
    try {
      const { plan, exitCode } = await runPlan([shell, '-w', 'my-feat'], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).toContain('--worktree');
      expect(plan!.claudeArgs).toContain('--name');
      expect(plan!.claudeArgs).toContain('my-feat');
      // cwd stays at shell (no match swapped it)
      expect(plan!.cwd).toBe(shell);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('-w with bad chars sanitized → sanitized name forwarded (warning deferred §27)', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-wsan-'));
    try {
      const { plan, stderr, exitCode } = await runPlan([shell, '-w', 'has spaces!'], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).toContain('has-spaces');
      expect(plan!.claudeArgs).not.toContain('has spaces!');
      // Sanitization warning is queued, but flushed after claude exits.
      // DUMP_PLAN exits pre-spawn → warning never reaches stderr here.
      expect(stderr).not.toMatch(/sanitized|illegal/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — auto-tmux gating (§5.4)', () => {
  function makeConfigDir(autoTmux: string | null): string {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-'));
    if (autoTmux !== null) {
      const dir = join(xdg, 'fnclaude');
      mkdirSync(dir);
      writeFileSync(join(dir, 'config.toml'), `[auto]\ntmux = "${autoTmux}"\n`);
    }
    return xdg;
  }

  test('config auto.tmux="worktree" + -w name (no match) → --tmux injected', async () => {
    const xdg = makeConfigDir('worktree');
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-at-'));
    try {
      const { plan, exitCode } = await runPlan([shell, '-w', 'new-feat'], {
        cwd: shell,
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).toContain('--tmux');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('no config → no --tmux even with -w', async () => {
    const xdg = makeConfigDir(null); // no config.toml
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-nt-'));
    try {
      const { plan, exitCode } = await runPlan([shell, '-w', 'new-feat'], {
        cwd: shell,
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).not.toContain('--tmux');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('config "worktree" + --no-tmux → no --tmux', async () => {
    const xdg = makeConfigDir('worktree');
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-nt2-'));
    try {
      const { plan, exitCode } = await runPlan([shell, '-w', 'new-feat', '--no-tmux'], {
        cwd: shell,
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).not.toContain('--tmux');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('§10.5: --no-tmux is consumed by the launcher and never reaches claude', async () => {
    // Regression guard: --no-tmux is an fnclaude-owned flag, must not be
    // forwarded to claude's argv. Run with no config (so no auto-tmux to
    // suppress) and assert the flag is simply eaten.
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-notmux-eat-'));
    try {
      const { plan, exitCode } = await runPlan(['/tmp', '--no-tmux', '--', 'hi'], {
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).not.toContain('--no-tmux');
      // The prompt body still rides through verbatim.
      expect(plan!.claudeArgs).toContain('--');
      expect(plan!.claudeArgs).toContain('hi');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test('config "worktree" but no -w → no --tmux (only new-worktree triggers)', async () => {
    const xdg = makeConfigDir('worktree');
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-nt3-'));
    try {
      const { plan, exitCode } = await runPlan([shell], {
        cwd: shell,
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.claudeArgs).not.toContain('--tmux');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(shell, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — auto-name (§5.2)', () => {
  // ANTHROPIC_API_KEY set with a fake value → SDK fast-path is selected,
  // SDK call throws on the bogus key, autoName catches the error and falls
  // through to the heuristic. End result: deterministic heuristic output,
  // no need to invoke real claude -p or hit the real API.

  test('-- "fix the login bug" → heuristic injects --name fix-login-bug', async () => {
    const { plan, exitCode } = await runPlan(['--', 'fix the login bug'], {
      extraEnv: {
        ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
        FNC_INTERNAL_DISABLE_AUTONAME: '', // override runPlan's default disable
      },
    });
    expect(exitCode).toBe(0);
    const nameIdx = plan!.claudeArgs.indexOf('--name');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(plan!.claudeArgs[nameIdx + 1]).toBe('fix-login-bug');
  });

  test('--name already given → no auto-name', async () => {
    const { plan, exitCode } = await runPlan(['--name', 'mine', '--', 'do stuff'], {
      extraEnv: {
        ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
        FNC_INTERNAL_DISABLE_AUTONAME: '',
      },
    });
    expect(exitCode).toBe(0);
    // Only one --name in the output (the user's), no second auto-name appended.
    const names = plan!.claudeArgs.filter((t) => t === '--name');
    expect(names.length).toBe(1);
    const nameIdx = plan!.claudeArgs.indexOf('--name');
    expect(plan!.claudeArgs[nameIdx + 1]).toBe('mine');
  });

  test('-p (print mode) → no auto-name', async () => {
    const { plan, exitCode } = await runPlan(['-p', '--', 'whatever'], {
      extraEnv: {
        ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
        FNC_INTERNAL_DISABLE_AUTONAME: '',
      },
    });
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--name');
  });

  test('no prompt body → no auto-name', async () => {
    const { plan, exitCode } = await runPlan([], {
      extraEnv: {
        ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
        FNC_INTERNAL_DISABLE_AUTONAME: '',
      },
    });
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--name');
  });

  // Dispatch-shape coverage for the SDK fast-path. The key signal we want to
  // verify is "with ANTHROPIC_API_KEY set, we do NOT shell out to `claude -p`."
  // To prove that, we prepend a shim dir to PATH containing a `claude` script
  // that records every invocation to a sentinel file. If the SDK fast-path
  // is wired correctly, the shim is never executed and the file stays empty.
  test('ANTHROPIC_API_KEY set → does NOT spawn `claude -p` (SDK fast-path)', async () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'fnc-e2e-sdk-shim-'));
    try {
      const sentinel = join(shimDir, 'claude-was-invoked');
      const shim = join(shimDir, 'claude');
      writeFileSync(
        shim,
        `#!/bin/sh\necho "$@" >> "${sentinel}"\nexit 0\n`,
        { mode: 0o755 },
      );
      const { plan, exitCode } = await runPlan(['--', 'fix the login bug'], {
        extraEnv: {
          ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
          FNC_INTERNAL_DISABLE_AUTONAME: '',
          // Prepend shim dir to PATH. The claude-p code path runs
          // `Bun.spawn(['claude', '-p', ...])` which resolves the bare name
          // against PATH and would hit our shim. The SDK path doesn't
          // resolve `claude` at all.
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        },
      });
      expect(exitCode).toBe(0);
      // Heuristic name still lands (SDK errors on fake key → fallback).
      const nameIdx = plan!.claudeArgs.indexOf('--name');
      expect(plan!.claudeArgs[nameIdx + 1]).toBe('fix-login-bug');
      // The sentinel file should NOT exist — `claude -p` was never spawned.
      const { existsSync } = await import('node:fs');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe('launch plan — own-session id injection (cross-session pin)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test('fresh interactive session → --session-id <uuid> injected', async () => {
    const { plan, exitCode } = await runPlan([], {
      extraEnv: { FNC_INTERNAL_DISABLE_SESSION_ID: '' }, // re-enable real behavior
    });
    expect(exitCode).toBe(0);
    const idx = plan!.claudeArgs.indexOf('--session-id');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(plan!.claudeArgs[idx + 1]).toMatch(UUID_RE);
  });

  test('--resume <uuid> → no minted --session-id injected', async () => {
    const resumeUuid = 'abcdef01-2345-4678-9abc-def012345678';
    const { plan, exitCode } = await runPlan(['--resume', resumeUuid], {
      extraEnv: { FNC_INTERNAL_DISABLE_SESSION_ID: '' },
    });
    expect(exitCode).toBe(0);
    // claude reuses the resume id and its file — fnc must not add a session-id.
    expect(plan!.claudeArgs).not.toContain('--session-id');
  });

  test('--print session → no --session-id injected', async () => {
    const { plan, exitCode } = await runPlan(['--print', '--', 'q'], {
      extraEnv: { FNC_INTERNAL_DISABLE_SESSION_ID: '' },
    });
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--session-id');
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — env composition (§6.1)', () => {
  test('no [exec.env] and no auto.handoff → only FNC_SOCKET present', async () => {
    // Use an empty XDG_CONFIG_HOME so no config.toml is found. FNC_SOCKET
    // is the only key fnclaude injects unconditionally on Unix (§7.2);
    // FNCLAUDE_HANDOFF + exec.env stay absent when their inputs are.
    const emptyXdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-empty-xdg-'));
    try {
      const { plan, exitCode } = await runPlan([], {
        extraEnv: { XDG_CONFIG_HOME: emptyXdg },
      });
      expect(exitCode).toBe(0);
      expect(Object.keys(plan!.env).sort()).toEqual(['FNC_SOCKET']);
      // Sanity: path looks like the §7.1 formula (base/fnclaude-mcp-<pid>.sock).
      expect(plan!.env.FNC_SOCKET).toMatch(/\/fnclaude-mcp-\d+\.sock$/);
    } finally {
      rmSync(emptyXdg, { recursive: true, force: true });
    }
  });

  // Regression for #214: when the suite runs *inside* a live fnc session,
  // the parent has already exported FNCLAUDE_HANDOFF into the environment.
  // runPlan inherits process.env, so without scrubbing that value leaks
  // into the composed child env and contaminates the assertion above —
  // green on clean CI, red on the maintainer's machine. Simulate the
  // in-session run by exporting FNCLAUDE_HANDOFF before the launch; the
  // scrub must keep it out of the plan regardless of XDG-isolated config.
  test('inherited FNCLAUDE_HANDOFF (in-session run) does not leak into the plan', async () => {
    const emptyXdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-inherit-xdg-'));
    const prev = process.env.FNCLAUDE_HANDOFF;
    process.env.FNCLAUDE_HANDOFF = '3';
    try {
      const { plan, exitCode } = await runPlan([], {
        extraEnv: { XDG_CONFIG_HOME: emptyXdg },
      });
      expect(exitCode).toBe(0);
      expect(Object.keys(plan!.env).sort()).toEqual(['FNC_SOCKET']);
    } finally {
      if (prev === undefined) {
        delete process.env.FNCLAUDE_HANDOFF;
      } else {
        process.env.FNCLAUDE_HANDOFF = prev;
      }
      rmSync(emptyXdg, { recursive: true, force: true });
    }
  });

  test('FNC_SOCKET path honors XDG_RUNTIME_DIR', async () => {
    // When XDG_RUNTIME_DIR is set, the socket path uses it as base. The
    // formula is verified in unit tests; this just confirms the e2e
    // pipeline plumbs the runtime env through to computeSocketPath.
    const xdgRuntime = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-runtime-'));
    const emptyXdgCfg = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-cfg-'));
    try {
      const { plan, exitCode } = await runPlan([], {
        extraEnv: {
          XDG_CONFIG_HOME: emptyXdgCfg,
          XDG_RUNTIME_DIR: xdgRuntime,
        },
      });
      expect(exitCode).toBe(0);
      expect(plan!.env.FNC_SOCKET).toMatch(
        new RegExp(`^${xdgRuntime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/fnclaude-mcp-\\d+\\.sock$`),
      );
    } finally {
      rmSync(xdgRuntime, { recursive: true, force: true });
      rmSync(emptyXdgCfg, { recursive: true, force: true });
    }
  });

  test('[exec.env] from config.toml lands in child env', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-execenv-'));
    try {
      const cfgDir = join(xdg, 'fnclaude');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'config.toml'),
        '[exec.env]\nMY_VAR = "hello"\nOTHER = "world"\n',
      );
      const { plan, exitCode } = await runPlan([], {
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.env.MY_VAR).toBe('hello');
      expect(plan!.env.OTHER).toBe('world');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test('auto.handoff = "ask" → FNCLAUDE_HANDOFF=ask injected', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-handoff-'));
    try {
      const cfgDir = join(xdg, 'fnclaude');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, 'config.toml'), '[auto]\nhandoff = "ask"\n');
      const { plan, exitCode } = await runPlan([], {
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.env.FNCLAUDE_HANDOFF).toBe('ask');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test('handoff wins over [exec.env] FNCLAUDE_HANDOFF', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-e2e-xdg-handoff-win-'));
    try {
      const cfgDir = join(xdg, 'fnclaude');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'config.toml'),
        '[auto]\nhandoff = "never"\n\n[exec.env]\nFNCLAUDE_HANDOFF = "ignored"\n',
      );
      const { plan, exitCode } = await runPlan([], {
        extraEnv: { XDG_CONFIG_HOME: xdg },
      });
      expect(exitCode).toBe(0);
      expect(plan!.env.FNCLAUDE_HANDOFF).toBe('never');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — self-MCP --mcp-config injection (§7.4)', () => {
  test('interactive session → --mcp-config injected with fnclaude server entry', async () => {
    const { plan, exitCode } = await runPlan([]);
    expect(exitCode).toBe(0);
    const flagIdx = plan!.claudeArgs.indexOf('--mcp-config');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const cfg = JSON.parse(plan!.claudeArgs[flagIdx + 1]!) as {
      mcpServers: { fnclaude: { command: string; args: string[] } };
    };
    // command points at the bun runtime (process.execPath in the launcher).
    expect(cfg.mcpServers.fnclaude.command).toContain('bun');
    // args[0] is the absolute fnc bin script; args[1] is "mcp".
    expect(cfg.mcpServers.fnclaude.args[0]).toContain('fnc.js');
    expect(cfg.mcpServers.fnclaude.args[1]).toBe('mcp');
  });

  test('noop fallback → args include "--noop"', async () => {
    const { plan, exitCode } = await runPlan([]);
    expect(exitCode).toBe(0);
    expect(plan!.usedNoopFallback).toBe(true);
    const flagIdx = plan!.claudeArgs.indexOf('--mcp-config');
    const cfg = JSON.parse(plan!.claudeArgs[flagIdx + 1]!) as {
      mcpServers: { fnclaude: { args: string[] } };
    };
    expect(cfg.mcpServers.fnclaude.args).toContain('--noop');
  });

  test('non-noop launch → args do NOT include "--noop"', async () => {
    const { plan, exitCode } = await runPlan(['/tmp']);
    expect(exitCode).toBe(0);
    expect(plan!.usedNoopFallback).toBe(false);
    const flagIdx = plan!.claudeArgs.indexOf('--mcp-config');
    const cfg = JSON.parse(plan!.claudeArgs[flagIdx + 1]!) as {
      mcpServers: { fnclaude: { args: string[] } };
    };
    expect(cfg.mcpServers.fnclaude.args).not.toContain('--noop');
  });

  test('print mode (-p) → no --mcp-config injected (gate per design.md §29)', async () => {
    const { plan, exitCode } = await runPlan(['-p', '--', 'hello']);
    expect(exitCode).toBe(0);
    expect(plan!.claudeArgs).not.toContain('--mcp-config');
  });

  // Regression for cli 2.0.0: `fnc -- "say hi"` produced a plan whose
  // `--mcp-config` pair landed AFTER the `--` sentinel. Claude treats
  // post-sentinel tokens as positional prompt content, so the MCP server
  // never registered. The fix is sentinel-aware insertion.
  test('prompt body via `--` → --mcp-config lands BEFORE --', async () => {
    const { plan, exitCode } = await runPlan(['--', 'say hi']);
    expect(exitCode).toBe(0);
    const flagIdx = plan!.claudeArgs.indexOf('--mcp-config');
    const sentinelIdx = plan!.claudeArgs.indexOf('--');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeLessThan(sentinelIdx);
  });
});

describe.skipIf(SKIP_WINDOWS)('launch plan — auto-name sentinel ordering (regression)', () => {
  // Regression for cli 2.0.0: the auto-name `--name <slug>` pair was
  // appended past the `--` sentinel, so claude read it as prompt body
  // and the session name never registered. Auto-name now lands BEFORE
  // the sentinel via insertFlagsBeforeSentinel.
  test('-- "fix the login bug" → --name lands BEFORE --', async () => {
    const { plan, exitCode } = await runPlan(['--', 'fix the login bug'], {
      extraEnv: {
        ANTHROPIC_API_KEY: 'placeholder-skip-sdk',
        FNC_INTERNAL_DISABLE_AUTONAME: '', // re-enable autoname for this test
      },
    });
    expect(exitCode).toBe(0);
    const nameIdx = plan!.claudeArgs.indexOf('--name');
    const sentinelIdx = plan!.claudeArgs.indexOf('--');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeLessThan(sentinelIdx);
    // Sanity: the prompt body still rides after the sentinel.
    expect(plan!.claudeArgs[sentinelIdx + 1]).toBe('fix the login bug');
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

describe.skipIf(SKIP_WINDOWS)('launch plan — warnings deferred-flush (§27)', () => {
  /**
   * Run fnc WITHOUT FNC_INTERNAL_DUMP_PLAN — i.e. through the real spawn
   * path — but with a fake `claude` binary on PATH that exits 0 instantly.
   * This lets us observe what fnc writes to stderr AROUND the (no-op)
   * claude lifecycle, which is exactly the surface §27 governs.
   */
  async function runWithFakeClaude(
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const shimDir = mkdtempSync(join(tmpdir(), 'fnc-fake-claude-'));
    try {
      const claudeShim = join(shimDir, 'claude');
      writeFileSync(claudeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const childPATH = `${shimDir}:${process.env.PATH ?? ''}`;
      const proc = Bun.spawn(['node', BIN, ...args], {
        cwd: opts.cwd ?? tmpdir(),
        env: {
          ...process.env,
          PATH: childPATH,
          FNC_PROMPTS_DIR: EMPTY_PROMPTS_DIR,
          FNC_INTERNAL_DISABLE_AUTONAME: '1',
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
      return { stdout, stderr, exitCode };
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  }

  test('warning NOT in stderr under DUMP_PLAN (deferred until claude exit)', async () => {
    // -w with bad chars produces a sanitization warning. With deferral,
    // DUMP_PLAN exits before claude spawns → warning never flushes.
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-warn-defer-'));
    try {
      const { stderr, exitCode } = await runPlan([shell, '-w', 'has spaces!'], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/sanitized|illegal/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('warning IS in stderr after fake-claude exits (real launch path)', async () => {
    // Same trigger as above, but going through the actual spawn → exit
    // sequence. The fake claude exits immediately; fnc then flushes the
    // queued sanitization warning to stderr.
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-warn-flush-'));
    try {
      const { stderr, exitCode } = await runWithFakeClaude([shell, '-w', 'has spaces!'], {
        cwd: shell,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toMatch(/sanitized|illegal/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('no warnings → no extra stderr noise on real launch path', async () => {
    // A clean launch (absolute path arg, no sanitization trigger, real
    // prompts dir so no fragment-missing warnings) shouldn't produce any
    // fnc-prefixed stderr after the fake claude exits.
    const REAL_PROMPTS = resolve(CLI_ROOT, 'prompts');
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-warn-clean-'));
    try {
      const { stderr, exitCode } = await runWithFakeClaude([shell], {
        cwd: shell,
        extraEnv: { FNC_PROMPTS_DIR: REAL_PROMPTS },
      });
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/sanitized|illegal|missing/i);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('§9.1: ring buffer wiring compiles and launcher still runs', async () => {
    // Smoke check that the §9.1 RingBuffer import + tee wiring in main.ts
    // hasn't broken the real spawn path. Buffer contents aren't asserted
    // here — §9.3 lands the consumer (and its own dedicated test). What
    // we care about: fake claude launches, exits 0, fnc returns 0 with
    // no diagnostic noise.
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-ring-smoke-'));
    try {
      const { stderr, exitCode } = await runWithFakeClaude([shell], { cwd: shell });
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/RingBuffer|ring-buffer|TypeError|ReferenceError/);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('§9.3: no cross-cwd relaunch when ring is empty (inherit-branch real path)', async () => {
    // The real-spawn test path runs under stdio inherit (no TTY), which
    // means the ring buffer stays empty. The §9.3 post-exit gate should
    // therefore return false uniformly — fnc exits with the fake-claude
    // exit code (0), the warnings flush still runs, and there is NO
    // observable relaunch spawn. The negative-path smoke is the part we
    // can assert in CI; a positive cross-cwd test requires a real TTY +
    // a claude stand-in that emits the resume hint, both of which are
    // out-of-scope for these e2e tests.
    const shell = mkdtempSync(join(tmpdir(), 'fnc-e2e-crosscwd-noop-'));
    try {
      const start = Date.now();
      const { stderr, exitCode } = await runWithFakeClaude([shell], { cwd: shell });
      const dt = Date.now() - start;
      expect(exitCode).toBe(0);
      // No "second fnclaude" stderr — the relaunch path would either
      // spawn a fresh fnc (and we'd see double-process output) or, in
      // the wrong-decode case, throw a TypeError on `argv` shape.
      expect(stderr).not.toMatch(/TypeError|ReferenceError|RangeError/);
      // Sanity check that we're not silently hanging on a stuck
      // relaunch loop; a misbehaving §9.3 that recurses would blow
      // through the default 2-minute test timeout instead.
      expect(dt).toBeLessThan(60_000);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });
});
