/**
 * Real-spawn regression for the #55 / #52 `fnc resume` picker loop.
 *
 * The bug: when claude prints a cross-cwd resume hint, fnc relaunches
 * itself with a reconstructed `[<dir>, '--resume', <uuid>]` argv. The
 * relaunch child was spawned inheriting `process.env`, which still held
 * the node→bun preflight's `FNC_ARGS_JSON=["resume"]` from the ORIGINAL
 * invocation. main.ts's readArgv() reads FNC_ARGS_JSON *before*
 * process.argv, so the stale `["resume"]` shadowed the reconstructed argv
 * — the relaunched fnc re-ran `resume`, hit the picker again, and looped
 * forever.
 *
 * The fix (cli 2.0.5, commit 2a36523, src/handoff/awaiter.ts::reexecSelf):
 * stamp the child's FNC_ARGS_JSON with the relaunch argv so readArgv and
 * the spawn argv agree.
 *
 * This is the HIGH-FIDELITY guard: it drives the REAL Bun.spawn re-exec
 * path through the launcher under a PTY (the only branch where the ring
 * buffer fills and §9.3 cross-cwd relaunch fires), with the scriptable
 * fake-claude emitting the hint. The unit-level seam test lives in
 * test/unit/reexec-self.test.ts; this one exercises the whole chain.
 *
 * What it asserts:
 *   - claude is invoked EXACTLY TWICE: once for the original picker
 *     launch (emits the hint), once for the relaunch resuming the hinted
 *     session. Under the bug it would loop and the helper's timeout would
 *     fire (or the count would blow past 2).
 *   - the SECOND invocation carries `--resume <uuid>` for the hinted cwd,
 *     NOT a bare `resume` re-run of the original argv (the loop signature).
 *   - the second invocation's cwd is the hinted destination.
 *
 * Pre-fix this fails because the relaunch re-runs `["resume"]` → the
 * second fake invocation gets the original `resume` argv (no
 * `--resume <uuid>`), re-emits the hint, and the chain loops until the
 * timeout kills it.
 *
 * Skipped on Windows (POSIX launcher only) and when `script` is missing
 * (PTY mode needs it).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeCWDForProjects } from '../../src/launch/live-permission-reader.ts';
import { runWithFakeClaude } from '../fixtures/run-with-fake-claude.ts';

const SKIP_WINDOWS = process.platform === 'win32';

function hasScript(): boolean {
  try {
    return Bun.spawnSync(['which', 'script']).exitCode === 0;
  } catch {
    return false;
  }
}

const SKIP = SKIP_WINDOWS || !hasScript();

const UUID = '11111111-2222-3333-4444-555555555555';

describe.skipIf(SKIP)('#55 — fnc resume picker loop (real-spawn regression)', () => {
  test('cross-cwd hint relaunches once with --resume <uuid>, no loop', async () => {
    // A throwaway HOME so the loop-guard probe (sessionExists →
    // $HOME/.claude/projects/<encoded-cwd>/<uuid>.jsonl) resolves against
    // a session file WE plant, not the real machine's claude state.
    const home = mkdtempSync(join(tmpdir(), 'fnc-55-home-'));
    // The cross-cwd destination claude's hint points at. It must exist
    // (fnc spawns the relaunch claude there) AND host the session jsonl
    // (so the §9.3 loop-guard lets the relaunch proceed).
    const dest = mkdtempSync(join(tmpdir(), 'fnc-55-dest-'));
    try {
      const projectsDir = join(home, '.claude', 'projects', encodeCWDForProjects(dest));
      mkdirSync(projectsDir, { recursive: true });
      writeFileSync(join(projectsDir, `${UUID}.jsonl`), '{"type":"summary"}\n');

      const r = await runWithFakeClaude({
        // Original invocation: a bare `resume`. The node→bun preflight
        // would stuff FNC_ARGS_JSON=["resume"] here — runWithFakeClaude
        // sets it identically. This is the exact stale value that, pre-fix,
        // leaked into the relaunch child and re-ran the picker.
        args: ['resume'],
        pty: true,
        env: {
          HOME: home,
          // First launch emits the hint; the fixture suppresses re-emission
          // on the `--resume` relaunch (real-claude behaviour), so the
          // chain terminates after exactly one relaunch under the fix.
          FAKE_CLAUDE_EMIT_HINT: `${dest}:${UUID}`,
        },
        timeoutMs: 20_000,
      });

      // Exactly two invocations: original picker launch + one relaunch.
      // A loop would either blow past 2 or hit the helper's timeout (which
      // rejects, failing the test before we get here).
      expect(r.invocations).toHaveLength(2);

      const first = r.invocations[0]!;
      const second = r.invocations[1]!;

      // First launch is the original `fnc resume` → claude gets a BARE
      // `--resume` (the picker), with no session id following it.
      const firstResumeIdx = first.argv.indexOf('--resume');
      expect(firstResumeIdx).toBeGreaterThanOrEqual(0);
      expect(first.argv[firstResumeIdx + 1]).not.toBe(UUID);

      // Second launch is the reconstructed resume: `--resume <uuid>` in the
      // hinted cwd. THIS is what the fix guarantees — pre-fix the relaunch
      // re-ran `["resume"]`, so the second invocation would carry a BARE
      // `--resume` (picker again), not the resolved uuid → infinite loop.
      const secondResumeIdx = second.argv.indexOf('--resume');
      expect(secondResumeIdx).toBeGreaterThanOrEqual(0);
      expect(second.argv[secondResumeIdx + 1]).toBe(UUID);
      expect(second.cwd).toBe(dest);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  }, 30_000);
});
