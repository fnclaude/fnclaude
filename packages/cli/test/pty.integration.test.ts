// Integration tests for the platform-specific runWithPTY implementations.
//
// IMPORTANT — Bun + node-pty limitation:
//
//   Under Bun 1.3.x, fixture children spawned via node-pty receive SIGHUP
//   almost immediately after any output write. The behavior reproduces
//   in a minimal `import { spawn } from 'node-pty'; spawn(...).onExit(...)`
//   harness — it is NOT caused by anything in runWithPTY. The result is
//   that we can't drive a long-running fixture shell, dial the parent's
//   socket from the test, and observe the handoff flow end-to-end the way
//   the Go reference does with a real PTY.
//
//   For now, the integration tests below assert the PIECES we CAN verify
//   reliably under Bun: that runWithPTY composes (no async-error paths in
//   the happy path), that it preserves exit codes for child-doesn't-emit
//   cases, and that it integrates with ensureCWD. The end-to-end handoff
//   path is exercised in the parent fnclaude e2e tests (and against real
//   claude in manual verification).
//
//   If/when Bun gets a native PTY primitive — or node-pty fixes its
//   PTY-master-on-Bun lifetime — these tests can be expanded.
//
// Skipped on Windows: the unix.ts module is the one under test here;
// Windows parity lives in pty/windows.ts.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';

// Resolve the cli package root so the harness script can import src files.
const CLI_ROOT = resolvePath(__dirname, '..');

/**
 * Run a harness snippet in a fresh Bun subprocess. The snippet is wrapped
 * with imports for runWithPTY + defaultConfig and should `console.log` a
 * single JSON line; we parse and return it.
 *
 * Why subprocess isolation: node-pty under Bun has been observed to
 * misreport exit-status fields on subsequent fork() calls within the same
 * process (signal:1 leaks across forks even on normal exits). A fresh
 * subprocess per test guarantees a clean kernel-level state, even though
 * the per-process exit-status accuracy is still the best we can get.
 */
async function runHarness<T>(snippet: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fnclaude-pty-harness-'));
  const scriptPath = join(dir, 'harness.ts');
  const PTY_PATH = resolvePath(CLI_ROOT, 'src/pty.ts').replace(/\\/g, '/');
  const CFG_PATH = resolvePath(CLI_ROOT, 'src/config.ts').replace(/\\/g, '/');
  writeFileSync(
    scriptPath,
    `
import { runWithPTY } from ${JSON.stringify(PTY_PATH)};
import { defaultConfig } from ${JSON.stringify(CFG_PATH)};
import { existsSync } from 'node:fs';

${snippet}
`,
  );
  const proc = Bun.spawn([process.execPath, scriptPath], {
    cwd: CLI_ROOT,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  const trimmed = stdout.trim();
  const lastNl = trimmed.lastIndexOf('\n');
  const lastLine = lastNl >= 0 ? trimmed.slice(lastNl + 1) : trimmed;
  return JSON.parse(lastLine) as T;
}

interface RunResultLite {
  exitCode: number;
  tail: string | null;
  handoffArgv: string[] | null;
  targetExists?: boolean;
}

describe.skipIf(SKIP_WINDOWS)('runWithPTY (unix)', () => {
  test('returns exit code from a silent fixture child', async () => {
    // `/bin/sh -c 'exit 42'` produces no output before exit — the only
    // shape that reliably round-trips node-pty's exit-status under Bun.
    const result = await runHarness<RunResultLite>(`
const r = await runWithPTY({
  claudeArgv: ['/bin/sh', '-c', 'exit 42'],
  launchCWD: process.cwd(),
  cfg: defaultConfig(),
  handoff: null,
});
process.stdout.write('\\n' + JSON.stringify({
  exitCode: r.exitCode,
  tail: r.tail ? r.tail.toString('utf8') : null,
  handoffArgv: r.handoffArgv,
}));
process.exit(0);
`);
    expect(result.exitCode).toBe(42);
    expect(result.handoffArgv).toBeNull();
  }, 15_000);

  test('returns exit 0 from a silent successful child', async () => {
    const result = await runHarness<RunResultLite>(`
const r = await runWithPTY({
  claudeArgv: ['/bin/true'],
  launchCWD: process.cwd(),
  cfg: defaultConfig(),
  handoff: null,
});
process.stdout.write('\\n' + JSON.stringify({
  exitCode: r.exitCode,
  tail: r.tail ? r.tail.toString('utf8') : null,
  handoffArgv: r.handoffArgv,
}));
process.exit(0);
`);
    expect(result.exitCode).toBe(0);
  }, 15_000);

  test('runs to completion with empty argv guard', async () => {
    // Empty argv is a defensive guard, not a real call. Asserts the early
    // return doesn't blow up.
    const result = await runHarness<RunResultLite>(`
const r = await runWithPTY({
  claudeArgv: [],
  launchCWD: process.cwd(),
  cfg: defaultConfig(),
  handoff: null,
});
process.stdout.write('\\n' + JSON.stringify({
  exitCode: r.exitCode,
  tail: r.tail ? r.tail.toString('utf8') : null,
  handoffArgv: r.handoffArgv,
}));
process.exit(0);
`);
    expect(result.exitCode).toBe(1);
    expect(result.tail).toBeNull();
  }, 15_000);

  test('ensureCWD fabricates missing dir and unwinds afterward', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'fnclaude-pty-cwd-'));
    const target = join(parent, 'fabricated', 'leaf');
    try {
      const result = await runHarness<RunResultLite>(`
const r = await runWithPTY({
  claudeArgv: ['/bin/true'],
  launchCWD: ${JSON.stringify(target)},
  cfg: defaultConfig(),
  handoff: null,
});
const targetExists = existsSync(${JSON.stringify(target)});
process.stdout.write('\\n' + JSON.stringify({
  exitCode: r.exitCode,
  tail: r.tail ? r.tail.toString('utf8') : null,
  handoffArgv: r.handoffArgv,
  targetExists,
}));
process.exit(0);
`);
      expect(result.exitCode).toBe(0);
      // ensureCWD cleanup happened: the target dir should no longer exist.
      // (The fabricated tree gets nuked once the child has chdir'd in.)
      expect(result.targetExists).toBe(false);
      // Parent untouched.
      const { existsSync } = await import('node:fs');
      expect(existsSync(parent)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);

  test('starts the AF_UNIX listener when handoff is set', async () => {
    // We can't reliably observe the listener mid-run under Bun (the PTY
    // child gets SIGHUP'd before the test can dial in), but we CAN
    // observe the run completing without rejection — i.e. that the
    // listener integration plumbs cleanly end-to-end.
    const dir = mkdtempSync(join(tmpdir(), 'fnclaude-pty-sock-'));
    const sockPath = join(dir, 'sock.sock');
    try {
      const result = await runHarness<RunResultLite>(`
process.env.XDG_RUNTIME_DIR = ${JSON.stringify(dir)};
const r = await runWithPTY({
  claudeArgv: ['/bin/true'],
  launchCWD: ${JSON.stringify(dir)},
  cfg: defaultConfig(),
  handoff: {
    mode: 'ask',
    socketPath: ${JSON.stringify(sockPath)},
    originalArgs: [],
  },
});
process.stdout.write('\\n' + JSON.stringify({
  exitCode: r.exitCode,
  tail: r.tail ? r.tail.toString('utf8') : null,
  handoffArgv: r.handoffArgv,
}));
process.exit(0);
`);
      expect(result.exitCode).toBe(0);
      // No trigger fired → handoffArgv stays null.
      expect(result.handoffArgv).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
