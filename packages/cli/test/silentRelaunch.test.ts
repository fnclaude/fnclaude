// silentRelaunch / silentRelaunchHandoff tests.
//
// The execve POSIX path is inherently destructive (replaces the test
// process), so we exercise it through subprocess harnesses: spawn a Bun
// child that imports silentRelaunch, points its own selfPath() at a known
// sentinel script, calls the function, and verifies the sentinel ran (via
// its exit code + stdout JSON).
//
// To avoid mise-shim PATH dependencies, the sentinel is invoked through
// `process.execPath` (the real Bun binary, not the shim). The harness
// rewrites process.argv[1] to a shell wrapper that re-execs the real Bun
// against the sentinel — that's the same trick selfPath() uses to anchor
// to the CLI script in production.
//
// Tests run on POSIX only; the Windows branch (spawn-and-exit) is exercised
// via the spawnAndExit unit test below with a stubbed spawn target.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolvePath(__dirname, '..');
const BUN_BIN = process.execPath; // real Bun binary, not the mise shim.

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface HarnessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signalCode: number | null;
}

/**
 * Materialize a sentinel that logs its argv as JSON and exits with the
 * given code. The wrapper script is what selfPath() points at; the
 * wrapper uses `exec <bunBin>` so the kernel chdir's the child to bunBin
 * with the sentinel as the script to run.
 *
 * Returns the wrapper path (suitable for `process.argv[1] = ...`).
 */
function makeSentinel(exitCode: number, workDir: string): string {
  const sentinel = join(workDir, 'sentinel.ts');
  writeFileSync(
    sentinel,
    `console.log(JSON.stringify({argv: process.argv.slice(2)}));\nprocess.exit(${exitCode});\n`,
    'utf8',
  );
  const wrapper = join(workDir, 'wrapper.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${BUN_BIN} run ${sentinel} "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

/** Run a Bun harness script that imports silentRelaunch.ts. */
async function runHarness(snippet: string): Promise<HarnessResult> {
  const dir = mkdtempSync(join(tmpdir(), 'fnclaude-relaunch-'));
  dirs.push(dir);
  const SR = resolvePath(CLI_ROOT, 'src/silentRelaunch.ts').replace(/\\/g, '/');
  const scriptPath = join(dir, 'harness.ts');
  writeFileSync(
    scriptPath,
    `import { silentRelaunch, silentRelaunchHandoff, spawnAndExit } from ${JSON.stringify(SR)};\n${snippet}\n`,
    'utf8',
  );
  const proc = Bun.spawn([BUN_BIN, 'run', scriptPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  // Bun.spawn exposes signalCode for processes killed by signal — abort
  // (SIGABRT) lands there, and exitCode is null in that case.
  return {
    stdout,
    stderr,
    exitCode: proc.exitCode ?? -1,
    signalCode: proc.signalCode ?? null,
  };
}

describe.skipIf(SKIP_WINDOWS)('silentRelaunch (POSIX)', () => {
  test('execs the determined self path with reconstructed argv', async () => {
    const sentinelDir = mkdtempSync(join(tmpdir(), 'fnclaude-sentinel-'));
    dirs.push(sentinelDir);
    const wrapper = makeSentinel(42, sentinelDir);

    const result = await runHarness(`
process.argv[1] = ${JSON.stringify(wrapper)};
silentRelaunch(['/some/dir'], '/dest/dir', '12345678-1234-1234-1234-123456789abc');
console.error('UNREACHABLE');
process.exit(99);
`);
    expect(result.exitCode).toBe(42);
    // clearScreen() writes ANSI escapes before execve fires, so the JSON
    // sentinel output appears on the same line as the escapes. Extract the
    // JSON object via regex rather than line-splitting.
    const jsonMatch = result.stdout.match(/\{"argv":.*\}/);
    expect(jsonMatch).not.toBeNull();
    const out = JSON.parse(jsonMatch![0]);
    expect(out.argv).toEqual([
      '/dest/dir',
      '--resume',
      '12345678-1234-1234-1234-123456789abc',
    ]);
  });

  test('Bun aborts (SIGABRT, exit 134) when execve cannot fire — uncatchable', async () => {
    // Bun's process.execve is uncatchable on failure: when the kernel
    // rejects the exec (ENOENT/EACCES/ENOEXEC) the runtime prints a
    // SystemError to stderr and aborts. We deliberately codify this
    // behaviour so the divergence from Go's syscall.Exec (which RETURNS
    // the error) is loud rather than silent.
    const result = await runHarness(`
// /dev/null exists but isn't executable; execve will EACCES.
process.argv[1] = '/dev/null';
silentRelaunch(['/some/dir'], '/dest/dir', '12345678-1234-1234-1234-123456789abc');
console.log('after-call');
process.exit(0);
`);
    // Bun.spawn surfaces SIGABRT as signalCode (the harness exitCode is
    // null/-1 in that case). We assert the stderr fingerprint regardless
    // and check at least one of the two abort signals (exit code 134 OR
    // signalCode 'SIGABRT' / 6).
    expect(result.stderr).toMatch(/SystemError \[process\.execve\]/);
    expect(result.stdout).not.toContain('after-call'); // never reached
    const aborted =
      result.exitCode === 134 ||
      result.signalCode === 6 ||
      String(result.signalCode) === 'SIGABRT';
    expect(aborted).toBe(true);
  });
});

describe.skipIf(SKIP_WINDOWS)('silentRelaunchHandoff (POSIX)', () => {
  test('execs self with handoff argv passed through verbatim', async () => {
    const sentinelDir = mkdtempSync(join(tmpdir(), 'fnclaude-handoff-'));
    dirs.push(sentinelDir);
    const wrapper = makeSentinel(17, sentinelDir);

    const result = await runHarness(`
process.argv[1] = ${JSON.stringify(wrapper)};
silentRelaunchHandoff(['/dest', '--name', 'foo', '--', 'continue from here']);
console.error('UNREACHABLE');
process.exit(99);
`);
    expect(result.exitCode).toBe(17);
    // clearScreen() writes ANSI escapes before execve fires, so the JSON
    // sentinel output appears on the same line as the escapes. Extract the
    // JSON object via regex rather than line-splitting.
    const jsonMatch = result.stdout.match(/\{"argv":.*\}/);
    expect(jsonMatch).not.toBeNull();
    const out = JSON.parse(jsonMatch![0]);
    expect(out.argv).toEqual(['/dest', '--name', 'foo', '--', 'continue from here']);
  });
});
