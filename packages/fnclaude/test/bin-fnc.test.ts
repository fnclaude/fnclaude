/**
 * Preflight integration tests for the umbrella `fnc` shim.
 *
 * The shim's job: detect when it's been launched under Node (typically
 * because `npm i -g fnclaude` installed it and the user invoked `fnc`),
 * and either re-exec under Bun or fail with a directive error. The
 * underlying CLI uses Bun-only globals (`Bun.spawn`, `Bun.TOML.parse`,
 * `Bun.which`, `process.execve`) — running it under Node silently
 * degrades (config parse errors, missing claude lookup, etc.) rather
 * than failing loudly.
 *
 * These tests spawn the shim as a subprocess so we exercise the same
 * code path that `fnc` on a user's PATH does. The `decide()` function
 * itself is tested directly in preflight.test.ts.
 *
 * Skipped on Windows: shim is a Unix shebang script; Windows uses
 * npm's .cmd wrapper instead.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const HERE = import.meta.dir;
const BIN = resolve(HERE, '..', 'bin', 'fnc.js');

const umbrellaPkg = JSON.parse(
  readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'),
) as { name: string; version: string };
const cliPkg = JSON.parse(
  readFileSync(resolve(HERE, '..', '..', 'cli', 'package.json'), 'utf8'),
) as { name: string; version: string };

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

describe.skipIf(SKIP_WINDOWS)('fnclaude umbrella shim — preflight', () => {
  test('under Bun, --version succeeds (happy path)', async () => {
    const r = await spawnShim('bun', ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^fnclaude \S+/);
  });

  test('--version reports the umbrella version, not cli version', async () => {
    // Regression: previously the umbrella's bin delegated straight to
    // cli's bin, so `fnc --version` would print `fnclaude <cli-version>`
    // — confusing for users who installed `fnclaude@<umbrella-version>`
    // and expect that version to surface. The umbrella owns its own
    // --version handler.
    const r = await spawnShim('bun', ['--version']);
    expect(r.exitCode).toBe(0);
    // Leading token: `fnclaude <umbrella-version>`.
    expect(r.stdout.startsWith(`fnclaude ${umbrellaPkg.version}`)).toBe(true);
    // Sanity: when umbrella and cli versions differ (the case that
    // motivated the bug), the umbrella's version is the one out front —
    // not cli's.
    if (umbrellaPkg.version !== cliPkg.version) {
      expect(r.stdout.startsWith(`fnclaude ${cliPkg.version}`)).toBe(false);
    }
  });

  test('under Node with bun on PATH, re-execs and succeeds', async () => {
    // Node binary launches the shim; the shim should notice `typeof Bun
    // === 'undefined'`, find `bun` on PATH, and re-exec itself. The
    // observable result is identical to the direct Bun invocation: same
    // exit code, same stdout shape, no Bun-degraded warnings on stderr.
    const r = await spawnShim('node', ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^fnclaude \S+/);
    // The signature warning from the silent-degradation failure mode
    // ("Bun is not defined" thrown by Bun.TOML.parse). It would only fire
    // if the CLI ran under Node — which is exactly what the re-exec is
    // supposed to prevent. Note: --version short-circuits before config
    // loading, so absence here is necessary-but-not-sufficient; the
    // preflight.test.ts unit tests carry the load-bearing assertion.
    expect(r.stderr).not.toContain('Bun is not defined');
  });

  test('Node re-exec serializes argv via FNC_ARGS_JSON to dodge Bun -- stripping', async () => {
    // Bun strips the first `--` from script argv (confirmed empirically:
    // `bun script.js -- foo` invokes script.js with argv=['foo']). The
    // umbrella shim's re-exec from Node into Bun would lose the `--`
    // separator unless we serialise the user's args into an env var
    // instead of passing them as Bun-script argv.
    //
    // Setup: a fake `bun` on a tmpdir PATH-prefix that echoes
    // FNC_ARGS_JSON and exits 0. The shim under Node finds our fake,
    // spawns it, fake prints the env var we care about. Asserts the
    // shim populated FNC_ARGS_JSON with the full argv (including `--`).
    const fs = await import('node:fs');
    const fakeDir = `/tmp/fnclaude-fakebun-${process.pid}-${Math.random().toString(36).slice(2)}`;
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
      const r = await spawnShim('node', ['--', 'some-positional', '--help'], {
        env,
        timeoutMs: 10_000,
      });
      expect(r.exitCode).toBe(0);
      const match = r.stdout.match(/^FNC_ARGS_JSON=(.*)$/m);
      expect(match).not.toBeNull();
      const value = match![1] ?? '';
      expect(value).not.toBe('');
      const parsed = JSON.parse(value);
      expect(parsed).toEqual(['--', 'some-positional', '--help']);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  test('under Node with bun NOT on PATH, emits directive error and exits non-zero', async () => {
    // Use --help rather than --version as the trigger arg: --version now
    // short-circuits BEFORE the Bun preflight (since it only needs file
    // reads and shouldn't fail just because Bun is missing), so it can't
    // exercise the directive-error path. --help still falls through to
    // the preflight and hits cli's bin under Bun.
    //
    // Strip every bun-providing dir from PATH so the shim's preflight
    // can't find it. CI runners commonly stack multiple bun installations
    // on PATH simultaneously (mise's installs dir, proto's shim dir,
    // setup-bun's `~/.bun/bin`, system package manager dirs, …) — earlier
    // single-shot strategies (name-based heuristics, `Bun.which('bun')` →
    // dirname) only removed one of them and left the rest resolving bun.
    // Iterate: probe → find currently-resolving dir → drop → repeat until
    // bun is no longer reachable (or we hit the safety cap).
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
      // `which` runs under the filtered PATH, so it reports whichever
      // dir is currently first to resolve bun — exactly the one the
      // probe above just succeeded against.
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

    // Final sanity check: bun must genuinely be unreachable now. If a
    // future env stacks more than MAX_ITER bun dirs on PATH (or shims bun
    // via something `which` can't trace), fail loudly here rather than
    // silently flunking the assertions below with a confusing
    // exitCode-0.
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
    // Directive error names Bun explicitly and points at the install URL
    // so a confused user knows what to do next.
    expect(r.stderr).toContain('Bun');
    expect(r.stderr).toMatch(/bun\.sh/);
    // Must NOT degrade into a broken CLI run.
    expect(r.stderr).not.toContain('Bun is not defined');
  });
});
