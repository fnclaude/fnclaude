/**
 * Preflight tests for the cli `fnc` bin shim.
 *
 * The cli's bin owns the Node→Bun re-exec preflight (previously lived in
 * the umbrella package). When a user installs `@fnclaude/cli` standalone
 * (`npm i -g @fnclaude/cli`), npm exposes the bin under whichever runtime
 * is on PATH at link time — typically Node. The bin needs to detect that
 * it's running under Node, find `bun` on PATH, and re-exec itself,
 * serialising user argv into FNC_ARGS_JSON so that Bun's `--`-stripping
 * doesn't mangle prompts like `fnc -- "say hi"`.
 *
 * The bug this guards: under Bun, `bun script.js -- foo` invokes the
 * script with argv=['foo'] (the literal `--` is stripped). If the bin is
 * spawned by Node and re-execs under Bun with the user's argv as
 * Bun-script argv, the user's `--` separator disappears — the cli then
 * treats the prompt as a positional cwd, hits the resolver, and 404s
 * across 8 GitHub orgs in series. Sidestep: serialise argv into
 * FNC_ARGS_JSON; the cli's main() reads from there when present.
 *
 * Skipped on Windows: the bin is a Unix shebang script.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const HERE = import.meta.dir;
const CLI_ROOT = resolve(HERE, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawnShim(
  runner: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10_000;
  const proc = Bun.spawn([runner, BIN, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: opts.env ?? process.env,
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

describe.skipIf(SKIP_WINDOWS)('@fnclaude/cli bin — Node→Bun preflight', () => {
  test('under Bun directly, --help succeeds (happy path)', async () => {
    const r = await spawnShim('bun', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fnclaude — claude CLI launcher');
  });

  test('under Node with bun on PATH, re-execs and succeeds', async () => {
    // The cli bin has a Node-shebang entry that owns the preflight (so
    // standalone `npm i -g @fnclaude/cli` works regardless of which
    // runtime npm picked to launch the bin). Node fires the shebang,
    // detects `typeof Bun === 'undefined'`, finds `bun` on PATH, and
    // re-execs. Observable: same exit code, same help output.
    const r = await spawnShim('node', ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fnclaude — claude CLI launcher');
    // The signature warning from the silent-degradation failure mode.
    expect(r.stderr).not.toContain('Bun is not defined');
  });

  test('Node re-exec serialises argv via FNC_ARGS_JSON to dodge Bun -- stripping', async () => {
    // Bun strips the first `--` from script argv (confirmed empirically:
    // `bun script.js -- foo` invokes script.js with argv=['foo']). The
    // bin's re-exec from Node into Bun would lose the `--` separator
    // unless we serialise the user's args into an env var instead of
    // passing them as Bun-script argv.
    //
    // Setup: a fake `bun` on a tmpdir PATH-prefix that echoes
    // FNC_ARGS_JSON and exits 0. The bin under Node finds our fake,
    // spawns it, fake prints the env var we care about. Asserts the
    // bin populated FNC_ARGS_JSON with the full argv (including `--`).
    const fs = await import('node:fs');
    const fakeDir = `/tmp/fnclaude-cli-fakebun-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(
      `${fakeDir}/bun`,
      `#!/bin/sh
echo "FNC_ARGS_JSON=$FNC_ARGS_JSON"
exit 0
`,
      { mode: 0o755 },
    );
    try {
      const env = {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
      };
      const r = await spawnShim('node', ['--', 'say hi'], {
        env,
        timeoutMs: 10_000,
      });
      expect(r.exitCode).toBe(0);
      const match = r.stdout.match(/^FNC_ARGS_JSON=(.*)$/m);
      expect(match).not.toBeNull();
      const value = match![1] ?? '';
      expect(value).not.toBe('');
      const parsed = JSON.parse(value);
      // The literal `--` must survive the round-trip: if Bun's stripping
      // had won, parsed would be ['say hi'] and the resolver would fire
      // on launch.
      expect(parsed).toEqual(['--', 'say hi']);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  test('under Node with bun NOT on PATH, emits directive error and exits non-zero', async () => {
    // Strip every bun-providing dir from PATH so the bin's preflight
    // can't find it. CI runners commonly stack multiple bun installations
    // on PATH simultaneously; iterate until bun is genuinely unreachable.
    const origPath = process.env.PATH ?? '';
    let filteredPath = origPath;
    const stripped: string[] = [];
    const MAX_ITER = 16;
    for (let i = 0; i < MAX_ITER; i++) {
      const probe = spawnSync('bun', ['--version'], {
        env: { ...process.env, PATH: filteredPath },
        stdio: 'ignore',
      });
      if (probe.error || probe.status !== 0) break;
      const which = spawnSync('which', ['bun'], {
        env: { ...process.env, PATH: filteredPath },
        encoding: 'utf8',
      });
      if (which.error || which.status !== 0) break;
      const bunBin = which.stdout.trim();
      if (!bunBin) break;
      const bunDir = bunBin.substring(0, bunBin.lastIndexOf('/'));
      if (!bunDir || stripped.includes(bunDir)) break;
      stripped.push(bunDir);
      filteredPath = filteredPath
        .split(':')
        .filter((dir) => dir !== bunDir)
        .join(':');
    }

    const finalProbe = spawnSync('bun', ['--version'], {
      env: { ...process.env, PATH: filteredPath },
      stdio: 'ignore',
    });
    if (!finalProbe.error && finalProbe.status === 0) {
      throw new Error(
        `test setup broken: bun still reachable after stripping ${stripped.length} dir(s): ` +
          `${stripped.join(', ')}. Filtered PATH=${filteredPath}`,
      );
    }

    const r = await spawnShim('node', ['--help'], {
      env: { ...process.env, PATH: filteredPath },
      timeoutMs: 5_000,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Bun');
    expect(r.stderr).toMatch(/bun\.sh/);
    expect(r.stderr).not.toContain('Bun is not defined');
  });
});
