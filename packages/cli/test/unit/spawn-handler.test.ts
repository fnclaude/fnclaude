/**
 * §8.3 — unit tests for `createSpawnHandler`.
 *
 * Covers the algorithm end-to-end with injected deps:
 *
 *   1. Required-arg validation (destination / name / summary).
 *   2. Summary file written before the launcher runs.
 *   3. `applyOverrides([], req)` emits override-derived flags only —
 *      nothing is preserved (matches Go canonical's spawn semantics).
 *   4. Launcher decision: `auto.spawnCommand` → `$TMUX` → paste-flow.
 *   5. Paste-flow surfaces `auto.spawnCommand` config hint, routes
 *      command through the injected clipboard handler, and reports
 *      `clipboard_ok` based on that handler's response.
 *   6. Handler NEVER stashes argv or fires the handoff trigger — the
 *      current session keeps running (the spawned sibling is its own
 *      independent fnclaude).
 *
 * Ports Go canonical's socket_listener_test.go OpSpawn block from
 * `fnclaude@fnrhombus/src/`.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpawnHandler } from '../../src/mcp/handlers/spawn';
import type { SpawnFn } from '../../src/handoff/spawn-launcher';
import type { WireRequest, WireResponse } from '../../src/mcp/wire';

const noopSpawn: SpawnFn = () => ({ unref() {} });

function recordingSpawn(): {
  spawn: SpawnFn;
  calls: { argv: readonly string[]; env: Record<string, string> }[];
} {
  const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
  const spawn: SpawnFn = (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return { unref() {} };
  };
  return { spawn, calls };
}

function recordingWriter(): {
  writeSummaryFile: (args: { content: string }) => Promise<string>;
  writes: { content: string }[];
} {
  const writes: { content: string }[] = [];
  const writer = async (args: { content: string }): Promise<string> => {
    writes.push(args);
    return `/tmp/handoff-${writes.length}.md`;
  };
  return { writeSummaryFile: writer, writes };
}

const fakeCopyOk = async (_req: WireRequest): Promise<WireResponse> => ({
  action: 'done',
  clipboard_ok: true,
});
const fakeCopyFail = async (_req: WireRequest): Promise<WireResponse> => ({
  action: 'done',
  clipboard_ok: false,
});

// ── 1. validation ──────────────────────────────────────────────────────

describe('createSpawnHandler — required-arg validation', () => {
  test('missing destination → error response', async () => {
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
    });
    const r = await handler({ op: 'spawn', name: 'n', summary: 's' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('destination');
  });

  test('empty destination → error response', async () => {
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
    });
    const r = await handler({ op: 'spawn', destination: '', name: 'n', summary: 's' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('destination');
  });

  test('missing name → error response', async () => {
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
    });
    const r = await handler({ op: 'spawn', destination: 'd', summary: 's' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('name');
  });

  test('missing summary → error response', async () => {
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
    });
    const r = await handler({ op: 'spawn', destination: 'd', name: 'n' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('summary');
  });

  test('non-string destination → error response', async () => {
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
    });
    const r = await handler({
      op: 'spawn',
      destination: 42 as unknown as string,
      name: 'n',
      summary: 's',
    });
    expect(r.action).toBe('error');
  });
});

// ── 2. launcher decision ──────────────────────────────────────────────

describe('createSpawnHandler — launcher decision', () => {
  test('config.autoSpawnCommand set → tokenizes, substitutes, dispatches', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile, writes } = recordingWriter();
    const handler = createSpawnHandler({
      config: {
        autoSpawnCommand:
          'kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}',
      },
      processEnv: { PATH: '/bin' },
      fncBinPath: '/usr/bin/fnclaude',
      spawnLauncher: spawn,
      writeSummaryFile,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'arch-setup@fnrhombus',
      name: 'side-thing',
      summary: 'the summary\nlines and lines\n',
    });

    expect(r.action).toBe('done');
    expect(r.message).toContain('arch-setup@fnrhombus');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe('the summary\nlines and lines\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      'kitty',
      '@',
      'launch',
      '--type=os-window',
      '/usr/bin/fnclaude',
      'arch-setup@fnrhombus',
      '--name',
      'side-thing',
      '@/tmp/handoff-1.md',
    ]);
  });

  test('$TMUX set, no config → uses tmux template', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: {},
      processEnv: { TMUX: '/tmp/tmux-1000/default,1,0', PATH: '/bin' },
      fncBinPath: '/usr/bin/fnclaude',
      spawnLauncher: spawn,
      writeSummaryFile,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'dest@owner',
      name: 'x',
      summary: '...',
    });

    expect(r.action).toBe('done');
    expect(calls[0]?.argv).toEqual([
      'tmux',
      'new-window',
      '-d',
      '/usr/bin/fnclaude',
      'dest@owner',
      '--name',
      'x',
      '@/tmp/handoff-1.md',
    ]);
  });

  test('neither config nor $TMUX → paste-flow fallback', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: {},
      processEnv: { PATH: '/bin' },
      fncBinPath: '/usr/bin/fnclaude',
      spawnLauncher: spawn,
      writeSummaryFile,
      handleCopyToClipboard: fakeCopyOk,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'dest@owner',
      name: 'x',
      summary: '...',
    });

    expect(r.action).toBe('paste_flow');
    expect(r.command).toBe('fnclaude dest@owner --name x @/tmp/handoff-1.md');
    expect(r.clipboard_ok).toBe(true);
    expect(r.message).toContain('auto.spawnCommand');
    expect(calls).toHaveLength(0);
  });

  test('paste-flow clipboard failure → message changes, clipboard_ok=false', async () => {
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
      writeSummaryFile,
      handleCopyToClipboard: fakeCopyFail,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: '...',
    });

    expect(r.action).toBe('paste_flow');
    expect(r.clipboard_ok).toBe(false);
    expect(r.message).toContain('auto.spawnCommand');
    // Failure path must still surface the actionable hint.
    expect(r.message).toContain('copy this command');
  });

  test('paste-flow without injected copy handler → clipboard_ok=false', async () => {
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
      writeSummaryFile,
      // handleCopyToClipboard omitted on purpose.
    });

    const r = await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: '...',
    });

    expect(r.action).toBe('paste_flow');
    expect(r.clipboard_ok).toBe(false);
  });

  test('launcher throws → error response', async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error('exec: no such file or directory');
    };
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: { autoSpawnCommand: '/nonexistent/launcher {bin}' },
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: throwingSpawn,
      writeSummaryFile,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: 's',
    });

    expect(r.action).toBe('error');
    expect(r.error).toContain('exec');
  });
});

// ── 3. override flag plumbing ─────────────────────────────────────────

describe('createSpawnHandler — applyOverrides(nil, req)', () => {
  test('overrides emit flag form only, appended to templated argv', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: { autoSpawnCommand: 'tmux new-window -d {bin} {dest}' },
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: spawn,
      writeSummaryFile,
    });

    await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: 's',
      model: 'sonnet',
      effort: 'high',
      ide: true,
      brief: false,
    });

    expect(calls[0]?.argv).toEqual([
      'tmux',
      'new-window',
      '-d',
      '/fnc',
      'd',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--ide',
    ]);
  });

  test('paste-flow command includes override flags', async () => {
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: {},
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: noopSpawn,
      writeSummaryFile,
      handleCopyToClipboard: fakeCopyOk,
    });

    const r = await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: 's',
      model: 'sonnet',
    });

    expect(r.command).toBe('fnclaude d --name n @/tmp/handoff-1.md --model sonnet');
  });

  test('boolean override = undefined → not emitted', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: { autoSpawnCommand: 'tmux new-window -d {bin} {dest}' },
      processEnv: {},
      fncBinPath: '/fnc',
      spawnLauncher: spawn,
      writeSummaryFile,
    });

    await handler({
      op: 'spawn',
      destination: 'd',
      name: 'n',
      summary: 's',
      // No overrides — bare templated argv only.
    });

    expect(calls[0]?.argv).toEqual(['tmux', 'new-window', '-d', '/fnc', 'd']);
  });
});

// ── 3b. production summary writer (no injected seam) ──────────────────

describe('createSpawnHandler — production summary writer (real writeSummaryFile)', () => {
  test('no injected writeSummaryFile → summary persisted, string path threaded, done', async () => {
    // Exercises the PRODUCTION adapter that wraps the real
    // writeSummaryFile. Every other test injects `writeSummaryFile`,
    // which bypasses that adapter — this is the wiring #237 breaks:
    // the adapter must forward `{ summary }` (not `{ content }`) and
    // unwrap the returned `{ path }` to a plain string.
    const dir = mkdtempSync(join(tmpdir(), 'fnc-spawn-prod-'));
    const prevXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = dir;
    try {
      const { spawn, calls } = recordingSpawn();
      const handler = createSpawnHandler({
        config: {
          autoSpawnCommand: 'tmux new-window -d {bin} {dest} --name {name} @{summary}',
        },
        processEnv: {},
        fncBinPath: '/fnc',
        spawnLauncher: spawn,
        // writeSummaryFile intentionally NOT injected.
      });

      const summary = 'production summary content\nline two\n';
      const r = await handler({ op: 'spawn', destination: 'd', name: 'n', summary });

      expect(r.action).toBe('done');
      expect(calls).toHaveLength(1);

      // The threaded summary token must be `@<string path>` pointing at a
      // real file containing the summary — not `@[object Object]` (unwrap
      // bug) and not an errored-out no-write.
      const argv = calls[0]?.argv ?? [];
      const summaryToken = argv[argv.length - 1] ?? '';
      expect(summaryToken.startsWith('@')).toBe(true);
      const summaryPath = summaryToken.slice(1);
      expect(existsSync(summaryPath)).toBe(true);
      expect(readFileSync(summaryPath, 'utf8')).toBe(summary);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = prevXdg;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 4. env scrubbing ──────────────────────────────────────────────────

describe('createSpawnHandler — env passed to launcher is cleaned', () => {
  test('FNC_SOCKET / FNCLAUDE_HANDOFF / CLAUDE_CODE_SESSION_ID stripped', async () => {
    const { spawn, calls } = recordingSpawn();
    const { writeSummaryFile } = recordingWriter();
    const handler = createSpawnHandler({
      config: { autoSpawnCommand: 'tmux new-window -d {bin} {dest}' },
      processEnv: {
        PATH: '/bin',
        FNC_SOCKET: '/tmp/x.sock',
        FNCLAUDE_HANDOFF: '5',
        CLAUDE_CODE_SESSION_ID: '01ABC',
        OTHER: 'keep',
      },
      fncBinPath: '/fnc',
      spawnLauncher: spawn,
      writeSummaryFile,
    });

    await handler({ op: 'spawn', destination: 'd', name: 'n', summary: 's' });

    const env = calls[0]?.env ?? {};
    expect(env.FNC_SOCKET).toBeUndefined();
    expect(env.FNCLAUDE_HANDOFF).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.OTHER).toBe('keep');
  });
});
