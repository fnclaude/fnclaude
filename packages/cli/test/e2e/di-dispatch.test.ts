/**
 * End-to-end coverage for the pre-DI dispatcher + plan root (design.di-architecture
 * §9 PR-3).
 *
 * Two guarantees the DI migration must not break:
 *   1. The FNC_INTERNAL_DUMP_PLAN output stays byte-identical to the pre-DI tree, for a
 *      fixed argv+config, asserted against a fixture captured from the pre-change tree
 *      (machine-specific paths — the bun runtime, the fnc bin, the socket — normalized).
 *   2. `--help` and `--version` short-circuit in the dispatcher and never build a plan
 *      container: even with FNC_INTERNAL_DUMP_PLAN=1 set, they emit their own text, not a
 *      plan dump.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cleanEnvForSpawn } from '../../src/handoff/clean-env';
import { getVersion, helpText } from '../../src/help-version';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');
const FIXTURE = resolve(CLI_ROOT, 'test', 'fixtures', 'di-plan-golden.json');

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: readonly string[], extraEnv: Record<string, string>): Promise<SpawnResult> {
  const proc = Bun.spawn(['node', BIN, ...args], {
    cwd: tmpdir(),
    env: { ...cleanEnvForSpawn(process.env), ...extraEnv },
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
}

describe.skipIf(SKIP_WINDOWS)('DI dispatcher — FNC_INTERNAL_DUMP_PLAN byte-parity', () => {
  test('the plan dump matches the pre-DI fixture for a fixed argv + config', async () => {
    const emptyPrompts = mkdtempSync(join(tmpdir(), 'fnc-di-prompts-'));
    const emptyXdg = mkdtempSync(join(tmpdir(), 'fnc-di-xdg-'));
    const runtime = mkdtempSync(join(tmpdir(), 'fnc-di-runtime-'));
    try {
      const { stdout, exitCode } = await run(
        ['/tmp/fnc-di-golden-cwd', '-w', 'my-feat', '--', 'do a thing'],
        {
          FNC_INTERNAL_DUMP_PLAN: '1',
          FNC_PROMPTS_DIR: emptyPrompts,
          FNC_INTERNAL_DISABLE_AUTONAME: '1',
          FNC_INTERNAL_DISABLE_SESSION_ID: '1',
          XDG_CONFIG_HOME: emptyXdg,
          XDG_RUNTIME_DIR: runtime,
        },
      );
      expect(exitCode).toBe(0);

      const live = JSON.parse(stdout.trim());
      const mcpIdx = live.claudeArgs.indexOf('--mcp-config');
      const cfg = JSON.parse(live.claudeArgs[mcpIdx + 1]);
      const bun = cfg.mcpServers.fnclaude.command;
      const bin = cfg.mcpServers.fnclaude.args[0];
      // Normalize the machine-specific paths the fixture stores as placeholders.
      const normalized = JSON.stringify(live)
        .split(bun)
        .join('<BUN>')
        .split(bin)
        .join('<BIN>')
        .split(live.env.FNC_SOCKET)
        .join('<SOCKET>');

      expect(JSON.parse(normalized)).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    } finally {
      rmSync(emptyPrompts, { recursive: true, force: true });
      rmSync(emptyXdg, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe.skipIf(SKIP_WINDOWS)('DI dispatcher — help/version never build a plan container', () => {
  // FNC_INTERNAL_DUMP_PLAN=1 makes plan-building observable: if help/version fell through
  // to the plan root, stdout would be plan JSON. That they emit their own text instead
  // proves the dispatcher short-circuits before any container is built.
  test('--help emits help text, not a plan dump', async () => {
    const { stdout, exitCode } = await run(['--help'], { FNC_INTERNAL_DUMP_PLAN: '1' });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(helpText);
    expect(stdout.trimStart().startsWith('{')).toBe(false);
  });

  test('--version emits the version line, not a plan dump', async () => {
    const { stdout, exitCode } = await run(['--version'], { FNC_INTERNAL_DUMP_PLAN: '1' });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`fnc ${await getVersion()}\n`);
    expect(stdout.trimStart().startsWith('{')).toBe(false);
  });
});
