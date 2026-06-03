/**
 * Real-spawn regression for #205 — in-session `fnc_restart` stacks fnc
 * processes and duplicates `--resume` per generation.
 *
 * Observed live (ioc@fnioc, 2026-06-03): after multiple in-session
 * restarts there were three live fnc processes chained parent→child→child,
 * all on the same claude session, with `--resume <sid>` appended once more
 * per generation. Only the leaf was doing work; the ancestors sat idle but
 * alive.
 *
 * Two distinct symptoms, asserted independently here:
 *
 *   Symptom 1 — process stacking. `reexecSelf` (src/handoff/awaiter.ts)
 *   replaces the running fnc via `Bun.spawn(child) + await child.exited +
 *   process.exit`. For a long-running interactive child that never returns,
 *   the parent waits forever — so each restart leaves the old generation
 *   alive as an ancestor. The fix is a true process-image replacement
 *   (execve) so the relaunch leaves exactly ONE fnc per session.
 *
 *   Symptom 2 — `--resume` accumulation. Covered at unit level in
 *   test/unit/restart-handler.test.ts; this e2e also asserts the leaf
 *   invocation's argv carries exactly one `--resume` after two restarts, so
 *   the whole real chain is pinned.
 *
 * Harness: fnc runs under a real PTY (so the §9.0 useTerminal branch + the
 * MCP socket engage). The fake-claude fixture, driven by
 * FAKE_CLAUDE_RESTART, dials $FNC_SOCKET and fires `fnc_restart` on the
 * first two generations, then exits cleanly on the third so the chain
 * terminates and the surviving process tree is probeable.
 *
 * Skipped on Windows (POSIX launcher only) and when `script` is missing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';

function hasScript(): boolean {
  try {
    return Bun.spawnSync(['which', 'script']).exitCode === 0;
  } catch {
    return false;
  }
}

const SKIP = SKIP_WINDOWS || !hasScript();

const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');
const FAKE_CLAUDE = join(FIXTURES_DIR, 'fake-claude');
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = join(CLI_ROOT, 'bin', 'fnc.js');

const SID = '11111111-2222-3333-4444-555555555555';

interface Invocation {
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string;
}

/**
 * Count live processes whose /proc/<pid>/cmdline mentions the fnc bin AND
 * (still on a `--resume`-bearing relaunch) the session id. This is the
 * direct analog of the issue's `ps` listing: how many fnc generations are
 * alive at once.
 */
function countLiveFncForSession(sessionId: string): number {
  let count = 0;
  for (const ent of readdirSync('/proc')) {
    if (!/^\d+$/.test(ent)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${ent}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const parts = cmdline.split('\0');
    const joined = parts.join(' ');
    if (joined.includes(BIN) && joined.includes(sessionId)) {
      count++;
    }
  }
  return count;
}

describe.skipIf(SKIP)('#205 — restart stacking + --resume duplication (real-spawn)', () => {
  let workRoot: string;
  let child: ReturnType<typeof nodeSpawn> | null;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'fnc-205-'));
    child = null;
  });

  afterEach(() => {
    if (child !== null && child.pid !== undefined) {
      try {
        // Kill the whole process group to reap any stacked ancestors the
        // bug left alive (otherwise they'd leak across test runs).
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ignore
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    rmSync(workRoot, { recursive: true, force: true });
  });

  test('two in-session restarts leave exactly one fnc; leaf argv has one --resume', async () => {
    const binDir = join(workRoot, 'bin');
    const cwd = join(workRoot, 'cwd');
    const logPath = join(workRoot, 'invocations.jsonl');
    const countFile = join(workRoot, 'restart-count');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const claudeLink = join(binDir, 'claude');
    symlinkSync(FAKE_CLAUDE, claudeLink);
    chmodSync(FAKE_CLAUDE, 0o755);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'FNC_SOCKET') env[k] = v;
    }
    env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    env.FAKE_CLAUDE_LOG = logPath;
    env.FNC_ARGS_JSON = JSON.stringify([cwd]);
    env.FNC_INTERNAL_DISABLE_AUTONAME = '1';
    // Two restarts, then the third generation exits cleanly.
    env.FAKE_CLAUDE_RESTART = `${countFile}:${SID}`;
    env.FAKE_CLAUDE_RESTART_MAX = '2';

    const cmd = `${process.execPath} ${BIN}`;
    child = nodeSpawn('script', ['-q', '/dev/null', '-c', cmd], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so afterEach can reap the chain
    });

    // Wait until the fake has been invoked three times (gen0 + 2 relaunches)
    // OR a timeout. We don't wait on child exit — the leaf session stays
    // alive (it's an interactive claude that never exits on its own), so we
    // probe the tree while it's live, then reap in afterEach.
    const deadline = Date.now() + 25_000;
    let invocations: Invocation[] = [];
    while (Date.now() < deadline) {
      invocations = parseLog(logPath);
      if (invocations.length >= 3) break;
      await sleep(200);
    }

    expect(invocations.length).toBeGreaterThanOrEqual(3);

    // Let the relaunch settle (the parent has to finish kill-and-exec /
    // process-image replacement after the 3rd fake logs).
    await sleep(1500);

    // Symptom 1: exactly ONE live fnc carrying this session id. Under the
    // bug there are 2+ (stacked ancestors all on --resume <SID>).
    const live = countLiveFncForSession(SID);
    expect(live).toBe(1);

    // Symptom 2: the leaf (3rd) invocation's argv carries exactly one
    // --resume. Under the bug it climbs one per generation.
    const leaf = invocations[2]!;
    const resumeCount = leaf.argv.filter((t) => t === '--resume').length;
    expect(resumeCount).toBe(1);
    expect(leaf.argv[leaf.argv.indexOf('--resume') + 1]).toBe(SID);
  }, 40_000);
});

function parseLog(logPath: string): Invocation[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Invocation);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
