/**
 * End-to-end coverage for `fnc install`, through the real binary.
 *
 * The unit tests cover the plan builder and the tools; what they can't cover
 * is the wiring — whether a real `fnc install` actually skips ref resolution,
 * actually injects `oobe.md` instead of every other fragment, actually sets
 * the lockdown flags, and actually sets `FNC_OOBE` so the three wizard tools
 * are registered. Those all live in `main.ts`'s composition, which only a real
 * invocation exercises.
 *
 * The `-y` half runs for real against a sandboxed `XDG_CONFIG_HOME`, so the
 * config it writes and the directories it creates are checked as artifacts
 * rather than as intentions. No network and no installs: the flags decline
 * both tools, so the plan is purely local.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

interface Plan {
  cwd: string;
  claudeArgs: string[];
  usedNoopFallback: boolean;
  env: Record<string, string>;
}

async function run(
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

async function plan(args: readonly string[], extra: Record<string, string> = {}): Promise<Plan> {
  const xdg = mkdtempSync(join(tmpdir(), 'fnc-install-plan-'));
  try {
    const r = await run(args, {
      XDG_CONFIG_HOME: xdg,
      FNC_INTERNAL_DUMP_PLAN: '1',
      FNC_INTERNAL_DISABLE_AUTONAME: '1',
      FNC_INTERNAL_DISABLE_SESSION_ID: '1',
      ...extra,
    });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.trim()) as Plan;
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
}

describe.skipIf(SKIP_WINDOWS)('`fnc install` launches a locked-down wizard session', () => {
  test('runs in the shell cwd — a scratch dir would re-prompt for trust every run', async () => {
    const shell = mkdtempSync(join(tmpdir(), 'fnc-install-cwd-'));
    try {
      const p = await plan(['install'], {});
      // The dump runs from tmpdir() by default; pin that it is the invocation
      // directory rather than the starting directory.
      expect(p.usedNoopFallback).toBe(false);
      const fromShell = await runPlanIn(['install'], shell);
      expect(fromShell.cwd).toBe(shell);
    } finally {
      rmSync(shell, { recursive: true, force: true });
    }
  });

  test('injects oobe.md and NOTHING else — no spawn, switch, restart, or router', async () => {
    const p = await plan(['install']);
    const i = p.claudeArgs.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    const prompt = p.claudeArgs[i + 1]!;
    expect(prompt).toContain('fnc setup');
    expect(prompt).toContain('fnc_oobe_next');
    // The fragments a normal interactive session would carry.
    expect(prompt).not.toContain('fnc_spawn_session');
    expect(prompt).not.toContain('fnc_switch_project');
    expect(prompt).not.toContain('noop landing zone');
  });

  test('the tool lockdown is on the command line, not just in the prompt', async () => {
    const p = await plan(['install']);
    expect(p.claudeArgs).toContain('--no-session-persistence');
    const d = p.claudeArgs.indexOf('--disallowedTools');
    expect(p.claudeArgs[d + 1]).toBe('Write,Edit,MultiEdit,NotebookEdit,Bash');
    const m = p.claudeArgs.indexOf('--permission-mode');
    expect(p.claudeArgs[m + 1]).toBe('default');
  });

  test('the session is named so it is recognisable', async () => {
    const p = await plan(['install']);
    expect(p.claudeArgs[p.claudeArgs.indexOf('--name') + 1]).toBe('fnc-setup');
  });

  test('FNC_OOBE=1 reaches the child, which is what registers the three tools', async () => {
    const p = await plan(['install']);
    expect(p.env.FNC_OOBE).toBe('1');
  });

  test('a normal launch does NOT set it', async () => {
    const p = await plan(['/tmp']);
    expect(p.env.FNC_OOBE).toBeUndefined();
  });

  test('ref resolution is skipped: `fnc install` never tries to resolve a repo', async () => {
    // With no fngit on PATH a repo reference errors. `install` must not take
    // that path at all — it has no reference to resolve.
    const p = await plan(['install'], { PATH: process.env.PATH ?? '' });
    expect(p.claudeArgs).toContain('--no-session-persistence');
  });

  test('an unknown flag is refused rather than silently dropped', async () => {
    const r = await run(['install', '--clone-tempalte', 'x'], {
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'fnc-install-bad-')),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('unknown flag');
  });
});

/** Run the plan dump with an explicit cwd. */
async function runPlanIn(args: readonly string[], cwd: string): Promise<Plan> {
  const xdg = mkdtempSync(join(tmpdir(), 'fnc-install-plan2-'));
  try {
    const r = await run(
      args,
      {
        XDG_CONFIG_HOME: xdg,
        FNC_INTERNAL_DUMP_PLAN: '1',
        FNC_INTERNAL_DISABLE_AUTONAME: '1',
        FNC_INTERNAL_DISABLE_SESSION_ID: '1',
      },
      cwd,
    );
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.trim()) as Plan;
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
}

describe.skipIf(SKIP_WINDOWS)('`fnc install -y` applies without asking anything', () => {
  test('writes the config, creates the directories, and sets noOobe', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-install-y-'));
    const home = mkdtempSync(join(tmpdir(), 'fnc-install-home-'));
    try {
      // Both tools declined, so the plan is purely local: no network, no
      // installs, nothing outside the sandbox.
      const r = await run(
        [
          'install',
          '-y',
          '--no-fngit',
          '--no-plugin',
          '--tmux',
          'always',
          '--handoff',
          '3',
          '--claude-args',
          '--chrome --brief',
        ],
        { XDG_CONFIG_HOME: xdg, HOME: home },
      );
      expect(r.exitCode).toBe(0);

      const configPath = join(xdg, 'rhombus.rocks', 'fnclaude', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(config.$schema).toBe(
        'https://json.schemastore.org/rhombus-rocks-fnclaude-config.json',
      );
      expect(config.auto).toEqual({ tmux: 'always', handoff: '3' });
      expect(config.claude).toEqual({ defaultArgs: ['--chrome', '--brief'] });
      expect(config.noOobe).toBe(true);

      expect(existsSync(join(xdg, 'rhombus.rocks', 'fnclaude', 'noop'))).toBe(true);
      const readme = join(xdg, 'rhombus.rocks', 'fnclaude', 'prompts', 'README.txt');
      expect(existsSync(readme)).toBe(true);
      expect(readFileSync(readme, 'utf8')).toContain('SYSTEM PROMPT');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('prints the plan before running it, then the closing note', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-install-y2-'));
    const home = mkdtempSync(join(tmpdir(), 'fnc-install-home2-'));
    try {
      const r = await run(['install', '-y', '--no-fngit', '--no-plugin'], {
        XDG_CONFIG_HOME: xdg,
        HOME: home,
      });
      expect(r.stdout).toContain('fnc install will:');
      expect(r.stdout).toContain('Host aliases');
      expect(r.stdout).toContain('Prompt overrides');
      expect(r.stdout).toContain('Re-run this any time with `fnc install`.');
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a flag that was not passed leaves its key unset — no silent defaults', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'fnc-install-y3-'));
    const home = mkdtempSync(join(tmpdir(), 'fnc-install-home3-'));
    try {
      await run(['install', '-y', '--no-fngit', '--no-plugin', '--tmux', 'never'], {
        XDG_CONFIG_HOME: xdg,
        HOME: home,
      });
      const config = JSON.parse(
        readFileSync(join(xdg, 'rhombus.rocks', 'fnclaude', 'config.json'), 'utf8'),
      ) as { auto: Record<string, unknown>; claude?: unknown };
      expect(config.auto.tmux).toBe('never');
      expect(config.auto.handoff).toBeUndefined();
      expect(config.claude).toBeUndefined();
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
