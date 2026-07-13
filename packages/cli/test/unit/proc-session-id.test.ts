/**
 * Unit tests for {@link resolveOwnSessionIdViaProc} + friends — resolving THIS
 * session's REAL claude session id from the fnc MCP child's `/proc` environ so
 * the context monitor pins by identity instead of guessing oldest-mtime (which
 * mis-pins a sibling session's JSONL in a shared cwd).
 *
 * Every `/proc` access is injected — these tests NEVER read real `/proc`. A
 * fake tree maps pid → {ppid, cmdline, environ}.
 */

import { describe, expect, test } from 'bun:test';

import {
  createProcSessionIdResolver,
  makeOwnSessionFileResolver,
  resolveOwnSessionIdViaProc,
  type ProcSessionIdDeps,
} from '../../src/usage/proc-session-id';

const CLAUDE_PID = 750983;
const OWN_ID = '13ee6add-16ee-4d94-85c7-b6cec0aff25b';
const SIBLING_ID = 'abcdef01-2345-4678-9abc-def012345678';
const FNC_MCP_CMDLINE = 'bun /home/tom/src/fnclaude/packages/cli/bin/fnc.js mcp';

interface FakeProc {
  ppid: number;
  cmdline: string;
  environ: string;
}

/** Build injected `/proc` seams over a pid → FakeProc map. */
function fakeDeps(tree: Record<number, FakeProc>): ProcSessionIdDeps {
  return {
    listPids: () => Object.keys(tree).map(Number),
    readPpid: (pid) => tree[pid]?.ppid ?? null,
    readCmdline: (pid) => tree[pid]?.cmdline ?? '',
    readEnviron: (pid) => tree[pid]?.environ ?? '',
  };
}

/** NUL-separated `KEY=VALUE` environ blob, as `/proc/<pid>/environ` yields. */
function environWith(...pairs: string[]): string {
  return `${pairs.join('\0')}\0`;
}

describe('resolveOwnSessionIdViaProc — read the id from the fnc MCP child', () => {
  test('reads the id from claude’s fnc MCP child, scoped by ppid', () => {
    const deps = fakeDeps({
      // claude itself — its OWN environ has no session id (set post-exec).
      [CLAUDE_PID]: {
        ppid: 1,
        cmdline: 'claude --resume',
        environ: environWith('HOME=/home/tom'),
      },
      // the fnc MCP child of THIS claude — carries the real id.
      900001: {
        ppid: CLAUDE_PID,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith('PATH=/usr/bin', `CLAUDE_CODE_SESSION_ID=${OWN_ID}`, 'TERM=xterm'),
      },
      // DECOY: a SIBLING session's MCP child (different claude parent). It also
      // matches fnc+mcp but must be excluded by the ppid scoping — proving no
      // cross-session leakage.
      900002: {
        ppid: 111111,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith(`CLAUDE_CODE_SESSION_ID=${SIBLING_ID}`),
      },
    });

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBe(OWN_ID);
  });

  test('returns null when no child matches (wrong ppid / cmdline lacks mcp)', () => {
    const deps = fakeDeps({
      // right ppid + fnc, but not the mcp subcommand.
      900003: {
        ppid: CLAUDE_PID,
        cmdline: 'bun /home/tom/src/fnclaude/packages/cli/bin/fnc.js server',
        environ: environWith(`CLAUDE_CODE_SESSION_ID=${OWN_ID}`),
      },
      // fnc+mcp but the WRONG parent.
      900004: {
        ppid: 999,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith(`CLAUDE_CODE_SESSION_ID=${SIBLING_ID}`),
      },
    });

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBeNull();
  });

  test('returns null when the matching child has no session-id env var', () => {
    const deps = fakeDeps({
      900005: {
        ppid: CLAUDE_PID,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith('HOME=/home/tom', 'TERM=xterm'),
      },
    });

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBeNull();
  });

  test('ignores a malformed (non-UUID) session-id value', () => {
    const deps = fakeDeps({
      900006: {
        ppid: CLAUDE_PID,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith('CLAUDE_CODE_SESSION_ID=not-a-uuid'),
      },
    });

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBeNull();
  });

  test('swallows per-pid read errors (process vanished mid-scan)', () => {
    const deps: ProcSessionIdDeps = {
      listPids: () => [900007, 900008],
      readPpid: (pid) => {
        if (pid === 900007) {
          throw new Error('ENOENT'); // vanished between listing and reading
        }
        return CLAUDE_PID;
      },
      readCmdline: () => FNC_MCP_CMDLINE,
      readEnviron: () => environWith(`CLAUDE_CODE_SESSION_ID=${OWN_ID}`),
    };

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBe(OWN_ID);
  });

  test('returns null when /proc is unavailable (listPids throws)', () => {
    const deps: Partial<ProcSessionIdDeps> = {
      listPids: () => {
        throw new Error('no /proc on this platform');
      },
    };

    expect(resolveOwnSessionIdViaProc(CLAUDE_PID, deps)).toBeNull();
  });
});

describe('createProcSessionIdResolver — lazy + cached', () => {
  test('stays null until resolvable, then caches (no further rescans)', () => {
    let mcpChildPresent = false;
    let scans = 0;
    const deps: ProcSessionIdDeps = {
      listPids: () => {
        scans += 1;
        return mcpChildPresent ? [900009] : [];
      },
      readPpid: () => CLAUDE_PID,
      readCmdline: () => FNC_MCP_CMDLINE,
      readEnviron: () => environWith(`CLAUDE_CODE_SESSION_ID=${OWN_ID}`),
    };

    const resolve = createProcSessionIdResolver(CLAUDE_PID, deps);
    expect(resolve()).toBeNull(); // MCP child not spawned yet — rescan yields nothing
    mcpChildPresent = true;
    expect(resolve()).toBe(OWN_ID); // now resolves

    const scansAtResolve = scans;
    expect(resolve()).toBe(OWN_ID); // cached
    expect(scans).toBe(scansAtResolve); // no rescan after a hit
  });
});

describe('makeOwnSessionFileResolver — identity wins over the mtime guess', () => {
  test('prefers the up-front id when present, never scanning /proc', () => {
    const deps: ProcSessionIdDeps = {
      listPids: () => {
        throw new Error('should not scan /proc when the id is known up front');
      },
      readPpid: () => null,
      readCmdline: () => '',
      readEnviron: () => '',
    };

    const resolver = makeOwnSessionFileResolver({
      upfrontId: OWN_ID,
      claudePid: CLAUDE_PID,
      deps,
    });

    expect(resolver?.()).toBe(`${OWN_ID}.jsonl`);
  });

  test('null up-front id + known pid → resolves <realId>.jsonl (identity path)', () => {
    const deps = fakeDeps({
      900010: {
        ppid: CLAUDE_PID,
        cmdline: FNC_MCP_CMDLINE,
        environ: environWith(`CLAUDE_CODE_SESSION_ID=${OWN_ID}`),
      },
    });

    const resolver = makeOwnSessionFileResolver({ upfrontId: null, claudePid: CLAUDE_PID, deps });

    // Non-null → the reader takes the identity path instead of guessing.
    expect(resolver?.()).toBe(`${OWN_ID}.jsonl`);
  });

  test('null up-front id + pid but no MCP child yet → resolver stays null (silent)', () => {
    const resolver = makeOwnSessionFileResolver({
      upfrontId: null,
      claudePid: CLAUDE_PID,
      deps: fakeDeps({}),
    });

    expect(resolver?.()).toBeNull();
  });

  test('null up-front id + no pid (renderer) → undefined (reader falls back to legacy)', () => {
    expect(makeOwnSessionFileResolver({ upfrontId: null, claudePid: null })).toBeUndefined();
  });
});
