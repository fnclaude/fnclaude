// Mirrors src/socket_listener_test.go + src/socket_listener_overrides_test.go.
// Uses real AF_UNIX sockets per the project conventions — no mocking of the
// socket layer. Clipboard + spawn are dependency-injected stubs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type Config } from '../../src/config.js';
import type { HandoffSpec } from '../../src/handoff.js';
import {
  encodeRequest,
  readResponse,
  type Request,
  type Response,
} from '../../src/mcp/protocol.js';
import {
  SocketListener,
  type ClipboardResult,
  type SocketListenerDeps,
  type SpawnResult,
} from '../../src/mcp/socketListener.js';
import { encodeCWDForProjects } from '../../src/sessionState.js';

// ── fixture helpers ───────────────────────────────────────────────────────

let SAVED_XDG: string | undefined;
let SAVED_HOME: string | undefined;

beforeEach(() => {
  SAVED_XDG = process.env.XDG_RUNTIME_DIR;
  SAVED_HOME = process.env.HOME;
});
afterEach(() => {
  if (SAVED_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = SAVED_XDG;
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
});

interface Fixture {
  spec: HandoffSpec;
  cfg: Config;
  launchCWD: string;
  dir: string;
}

function mkFixture(mode: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'fnclaude-sl-'));
  // Pin XDG_RUNTIME_DIR so handoffContentPath writes summary content here.
  process.env.XDG_RUNTIME_DIR = dir;
  const sockName = `fnclaude-mcp-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
  const sock = join(dir, sockName);
  const cfg = defaultConfig();
  cfg.auto.handoff = mode;
  return {
    spec: { mode, socketPath: sock, originalArgs: [] },
    cfg,
    launchCWD: '/launch/cwd',
    dir,
  };
}

function trackingClipboard(out: { calls: string[]; ok: boolean }): SocketListenerDeps['copyToClipboard'] {
  return async (text: string): Promise<ClipboardResult> => {
    out.calls.push(text);
    return { ok: out.ok };
  };
}

function trackingSpawn(
  out: { calls: Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>; spawned: boolean; error?: Error },
): SocketListenerDeps['spawnSibling'] {
  return async (_cfg, dest, name, summaryPath, extra): Promise<SpawnResult> => {
    out.calls.push({ dest, name, summaryPath, extra: [...extra] });
    if (out.error) return { spawned: false, error: out.error };
    return { spawned: out.spawned };
  };
}

/** Dial the socket, send one Request, read one Response, close. */
async function dialAndRoundtrip(socketPath: string, req: Request): Promise<Response> {
  const sock: Socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  sock.write(encodeRequest(req));
  const resp = await readResponse(sock);
  sock.destroy();
  if (resp === null) throw new Error('no response from listener');
  return resp;
}

function expectResolvedWithin(p: Promise<unknown>, ms: number): Promise<true | false> {
  return Promise.race([
    p.then(() => true as const),
    new Promise<false>((r) => setTimeout(() => r(false), ms)),
  ]);
}

// ── lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  test('start opens socket file; close removes it', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    // socket file exists
    expect(statSync(fx.spec.socketPath).isSocket()).toBe(true);
    await l.close();
    let exists = false;
    try {
      statSync(fx.spec.socketPath);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test('handles stale socket file from prior crashed instance', async () => {
    const fx = mkFixture('ask');
    // Create a regular file at the socket path to simulate stale state.
    writeFileSync(fx.spec.socketPath, 'stale');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    expect(statSync(fx.spec.socketPath).isSocket()).toBe(true);
    await l.close();
  });
});

// ── OpRestart ──────────────────────────────────────────────────────────────

describe('OpRestart', () => {
  test('with sessionID: returns done, fires triggered, stashes argv', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const sid = '01234567-89ab-cdef-0123-456789abcdef';
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
      expect(l.getHandoffArgv()).toEqual([fx.launchCWD, '--resume', sid]);
    } finally {
      await l.close();
    }
  });

  test('without sessionID returns error, no trigger', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, { op: 'restart' });
      expect(resp.action).toBe('error');
      expect(resp.error).toBeTruthy();
      expect(await expectResolvedWithin(l.triggered(), 100)).toBe(false);
      expect(l.getHandoffArgv()).toBeNull();
    } finally {
      await l.close();
    }
  });

  test('non-UUID sessionID returns error, no trigger', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: 'not-a-uuid',
      });
      expect(resp.action).toBe('error');
      expect(resp.error?.toLowerCase()).toContain('uuid');
      expect(await expectResolvedWithin(l.triggered(), 100)).toBe(false);
    } finally {
      await l.close();
    }
  });

  test('first-wins: second restart does not overwrite stashed argv', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const sidFirst = '11111111-1111-1111-1111-111111111111';
      const sidSecond = '22222222-2222-2222-2222-222222222222';
      await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sidFirst,
      });
      expect(l.getHandoffArgv()).toEqual([fx.launchCWD, '--resume', sidFirst]);
      await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sidSecond,
      });
      expect(l.getHandoffArgv()).toEqual([fx.launchCWD, '--resume', sidFirst]);
    } finally {
      await l.close();
    }
  });

  test('preserves origArgs: magic at front, flags at end', async () => {
    const fx = mkFixture('ask');
    const origArgs = ['opus', 'max', '/some/cwd', '--ide', '--brief', '-W', 'Bash'];
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      origArgs,
    });
    try {
      const sid = '01234567-89ab-cdef-0123-456789abcdef';
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
      });
      expect(resp.action).toBe('done');
      expect(l.getHandoffArgv()).toEqual([
        'opus',
        'max',
        fx.launchCWD,
        '--resume',
        sid,
        '--ide',
        '--brief',
        '-W',
        'Bash',
      ]);
    } finally {
      await l.close();
    }
  });

  test('model override strips bare magic and appends flag', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      origArgs: ['opus', 'max', '/some/cwd', '--ide'],
    });
    try {
      const sid = '01234567-89ab-cdef-0123-456789abcdef';
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
        model: 'sonnet',
      });
      expect(resp.action).toBe('done');
      expect(l.getHandoffArgv()).toEqual([
        'max',
        fx.launchCWD,
        '--resume',
        sid,
        '--ide',
        '--model',
        'sonnet',
      ]);
    } finally {
      await l.close();
    }
  });
});

// ── OpSwitch ──────────────────────────────────────────────────────────────

describe('OpSwitch', () => {
  test('ask mode (one-shot): returns done, fires triggered, writes summary', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const summary = 'this is the summary\nwith multiple lines\n';
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'arch-setup@fnrhombus',
        name: 'fix-thing',
        summary,
        confirmed: true, // tolerated
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
      const argv = l.getHandoffArgv();
      expect(argv).not.toBeNull();
      expect(argv!).toHaveLength(4);
      expect(argv![0]).toBe('arch-setup@fnrhombus');
      expect(argv![1]).toBe('--name');
      expect(argv![2]).toBe('fix-thing');
      expect(argv![3]!.startsWith('@')).toBe(true);
      const summaryPath = argv![3]!.slice(1);
      expect(readFileSync(summaryPath, 'utf8')).toBe(summary);
    } finally {
      await l.close();
    }
  });

  test('numeric mode (one-shot): server still completes the switch', async () => {
    const fx = mkFixture('5');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'dest@owner',
        name: 'x',
        summary: '...',
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
    } finally {
      await l.close();
    }
  });

  test('regression guard: never returns auto_countdown or needs_confirmation', async () => {
    for (const mode of ['ask', '3', '10', '0']) {
      const fx = mkFixture(mode);
      const l = await SocketListener.start({
        spec: fx.spec,
        cfg: fx.cfg,
        launchCWD: fx.launchCWD,
      });
      try {
        const resp = await dialAndRoundtrip(fx.spec.socketPath, {
          op: 'switch',
          destination: 'd',
          name: 'n',
          summary: '...',
        });
        expect(resp.action).not.toBe('auto_countdown');
        expect(resp.action).not.toBe('needs_confirmation');
      } finally {
        await l.close();
      }
    }
  });

  test('never mode: returns paste_flow with clipboard ok=true when clipboard succeeds', async () => {
    const fx = mkFixture('never');
    const clip = { calls: [] as string[], ok: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { copyToClipboard: trackingClipboard(clip) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'arch-setup@fnrhombus',
        name: 'fix-thing',
        summary: 'summary content here',
      });
      expect(resp.action).toBe('paste_flow');
      expect(resp.clipboard_ok).toBe(true);
      expect(resp.command).toMatch(/^fnclaude arch-setup@fnrhombus --name fix-thing @/);
      expect(await expectResolvedWithin(l.triggered(), 100)).toBe(false);
    } finally {
      await l.close();
    }
  });

  test('never mode: clipboard failure still surfaces Command + Message', async () => {
    const fx = mkFixture('never');
    const clip = { calls: [] as string[], ok: false };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { copyToClipboard: trackingClipboard(clip) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'dest@owner',
        name: 'x',
        summary: '...',
      });
      expect(resp.action).toBe('paste_flow');
      expect(resp.clipboard_ok).toBe(false);
      expect(resp.command).toBeTruthy();
      expect(resp.message).toBeTruthy();
    } finally {
      await l.close();
    }
  });

  test('preserves flags and strips denylisted ones', async () => {
    const fx = mkFixture('ask');
    const origArgs = [
      'opus',
      '/old/cwd',
      '--ide',
      '--brief',
      '-A',
      '/old/extra',
      '--mcp-config',
      '/tmp/x.json',
      '--from-pr',
      '42',
      '--name',
      'old-name',
    ];
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      origArgs,
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'arch-setup@fnrhombus',
        name: 'new-name',
        summary: 'summary content',
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
      const argv = l.getHandoffArgv()!;
      expect(argv[0]).toBe('opus');
      expect(argv[1]).toBe('arch-setup@fnrhombus');
      const tail = argv.slice(2);
      expect(tail).toContain('--ide');
      expect(tail).toContain('--brief');
      for (const denied of ['-A', '--mcp-config', '--from-pr']) {
        expect(argv).not.toContain(denied);
      }
      // New --name with new value present, exactly once.
      const nameIdx = argv.indexOf('--name');
      expect(nameIdx).toBeGreaterThan(-1);
      expect(argv[nameIdx + 1]).toBe('new-name');
      expect(argv).not.toContain('old-name');
    } finally {
      await l.close();
    }
  });

  test('overrides appended after preservation', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      origArgs: ['opus', 'max', '/old/cwd', '--ide'],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'switch',
        destination: 'dest@owner',
        name: 'topic',
        summary: 's',
        model: 'sonnet',
        verbose: true,
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
      const argv = l.getHandoffArgv()!;
      // "opus" stripped (model override); "max" remains as leading magic.
      expect(argv[0]).toBe('max');
      expect(argv[1]).toBe('dest@owner');
      expect(argv).toContain('--ide');
      expect(argv).toContain('--verbose');
      const modelIdx = argv.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(argv[modelIdx + 1]).toBe('sonnet');
    } finally {
      await l.close();
    }
  });
});

// ── OpSpawn ────────────────────────────────────────────────────────────────

describe('OpSpawn', () => {
  test('ask mode: returns done, calls spawnSibling, does NOT trigger', async () => {
    const fx = mkFixture('ask');
    const spawn = { calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>, spawned: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { spawnSibling: trackingSpawn(spawn) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'arch-setup@fnrhombus',
        name: 'side-thing',
        summary: '...',
      });
      expect(resp.action).toBe('done');
      expect(spawn.calls).toHaveLength(1);
      expect(await expectResolvedWithin(l.triggered(), 100)).toBe(false);
      expect(l.getHandoffArgv()).toBeNull();
    } finally {
      await l.close();
    }
  });

  test('regression guard: never returns auto_countdown / needs_confirmation', async () => {
    const spawn = { calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>, spawned: true };
    for (const mode of ['ask', '3', '10', '0']) {
      const fx = mkFixture(mode);
      const l = await SocketListener.start({
        spec: fx.spec,
        cfg: fx.cfg,
        launchCWD: fx.launchCWD,
        deps: { spawnSibling: trackingSpawn(spawn) },
      });
      try {
        const resp = await dialAndRoundtrip(fx.spec.socketPath, {
          op: 'spawn',
          destination: 'd',
          name: 'n',
          summary: '...',
        });
        expect(resp.action).not.toBe('auto_countdown');
        expect(resp.action).not.toBe('needs_confirmation');
      } finally {
        await l.close();
      }
    }
  });

  test('no launcher → falls back to paste-flow with auto.spawnCommand hint', async () => {
    const fx = mkFixture('ask');
    const spawn = { calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>, spawned: false };
    const clip = { calls: [] as string[], ok: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: {
        spawnSibling: trackingSpawn(spawn),
        copyToClipboard: trackingClipboard(clip),
      },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'dest@owner',
        name: 'x',
        summary: '...',
      });
      expect(resp.action).toBe('paste_flow');
      expect(resp.command).toMatch(/^fnclaude dest@owner --name x @/);
      expect(resp.clipboard_ok).toBe(true);
      expect(resp.message ?? '').toContain('auto.spawnCommand');
    } finally {
      await l.close();
    }
  });

  test('no launcher + clipboard fails: still surfaces config hint', async () => {
    const fx = mkFixture('ask');
    const spawn = { calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>, spawned: false };
    const clip = { calls: [] as string[], ok: false };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: {
        spawnSibling: trackingSpawn(spawn),
        copyToClipboard: trackingClipboard(clip),
      },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'dest@owner',
        name: 'x',
        summary: '...',
      });
      expect(resp.action).toBe('paste_flow');
      expect(resp.clipboard_ok).toBe(false);
      expect(resp.message ?? '').toContain('auto.spawnCommand');
    } finally {
      await l.close();
    }
  });

  test('spawn error: returns Action error', async () => {
    const fx = mkFixture('ask');
    const spawn = {
      calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>,
      spawned: false,
      error: new Error('launcher unavailable'),
    };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { spawnSibling: trackingSpawn(spawn) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'x',
        name: 'y',
        summary: 'z',
      });
      expect(resp.action).toBe('error');
      expect(resp.error).toBeTruthy();
    } finally {
      await l.close();
    }
  });

  test('overrides flow through as extraArgs to spawnSibling', async () => {
    const fx = mkFixture('ask');
    const spawn = { calls: [] as Array<{ dest: string; name: string; summaryPath: string; extra: string[] }>, spawned: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { spawnSibling: trackingSpawn(spawn) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'dest',
        name: 'side',
        summary: 's',
        model: 'haiku',
        effort: 'low',
        ide: true,
      });
      expect(resp.action).toBe('done');
      const extra = spawn.calls[0]!.extra;
      const modelIdx = extra.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(extra[modelIdx + 1]).toBe('haiku');
      const effortIdx = extra.indexOf('--effort');
      expect(effortIdx).toBeGreaterThan(-1);
      expect(extra[effortIdx + 1]).toBe('low');
      expect(extra).toContain('--ide');
    } finally {
      await l.close();
    }
  });

  test('never mode: paste-flow command includes overrides', async () => {
    const fx = mkFixture('never');
    const clip = { calls: [] as string[], ok: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { copyToClipboard: trackingClipboard(clip) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'spawn',
        destination: 'dest@owner',
        name: 'x',
        summary: 's',
        model: 'sonnet',
        brief: true,
      });
      expect(resp.action).toBe('paste_flow');
      expect(resp.command ?? '').toContain('--model sonnet');
      expect(resp.command ?? '').toContain('--brief');
    } finally {
      await l.close();
    }
  });
});

// ── OpCopy ─────────────────────────────────────────────────────────────────

describe('OpCopy', () => {
  test('success: action=done, clipboard_ok=true, no trigger', async () => {
    const fx = mkFixture('ask');
    const clip = { calls: [] as string[], ok: true };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { copyToClipboard: trackingClipboard(clip) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'copy_to_clipboard',
        text: 'hello clipboard',
      });
      expect(resp.action).toBe('done');
      expect(resp.clipboard_ok).toBe(true);
      expect(clip.calls).toEqual(['hello clipboard']);
      expect(await expectResolvedWithin(l.triggered(), 100)).toBe(false);
    } finally {
      await l.close();
    }
  });

  test('failure: action=done but clipboard_ok=false', async () => {
    const fx = mkFixture('ask');
    const clip = { calls: [] as string[], ok: false };
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
      deps: { copyToClipboard: trackingClipboard(clip) },
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'copy_to_clipboard',
        text: 'x',
      });
      expect(resp.action).toBe('done');
      expect(resp.clipboard_ok).toBe(false);
    } finally {
      await l.close();
    }
  });
});

// ── error paths ────────────────────────────────────────────────────────────

describe('error paths', () => {
  test('malformed JSON returns error response', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const sock = connect(fx.spec.socketPath);
      await new Promise<void>((res, rej) => {
        sock.once('connect', () => res());
        sock.once('error', rej);
      });
      sock.write('not-json\n');
      const resp = await readResponse(sock);
      sock.destroy();
      expect(resp).not.toBeNull();
      expect(resp!.action).toBe('error');
      expect(resp!.error).toBeTruthy();
    } finally {
      await l.close();
    }
  });

  test('unknown op returns error response', async () => {
    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: fx.launchCWD,
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        // biome-ignore lint/suspicious/noExplicitAny: testing unknown op on wire
        op: 'bogus_op' as any,
      });
      expect(resp.action).toBe('error');
      expect(resp.error).toBeTruthy();
    } finally {
      await l.close();
    }
  });
});

// ── live permission-mode auto-capture ──────────────────────────────────────

function writeSessionJSONL(
  claudeHome: string,
  cwd: string,
  sessionID: string,
  body: string,
): string {
  const encoded = encodeCWDForProjects(cwd);
  const dir = join(claudeHome, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionID}.jsonl`);
  writeFileSync(path, body);
  return path;
}

describe('live permission-mode auto-capture', () => {
  test('handleRestart auto-captures live mode from session JSONL', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-jsonl-'));
    process.env.HOME = tmpHome;
    const sid = '77777777-7777-7777-7777-777777777777';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    writeSessionJSONL(
      tmpHome,
      cwd,
      sid,
      `${JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' })}\n`,
    );

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd, '--ide'],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
      });
      expect(resp.action).toBe('done');
      expect(await expectResolvedWithin(l.triggered(), 2000)).toBe(true);
      const argv = l.getHandoffArgv()!;
      const idx = argv.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe('plan');
    } finally {
      await l.close();
    }
  });

  test('explicit permission_mode override beats live value', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-jsonl-'));
    process.env.HOME = tmpHome;
    const sid = '88888888-8888-8888-8888-888888888888';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    writeSessionJSONL(
      tmpHome,
      cwd,
      sid,
      `${JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' })}\n`,
    );

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd, '--ide'],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
        permission_mode: 'bypassPermissions',
      });
      expect(resp.action).toBe('done');
      const argv = l.getHandoffArgv()!;
      const idx = argv.indexOf('--permission-mode');
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe('bypassPermissions');
      // Exactly one --permission-mode token.
      const count = argv.filter((t) => t === '--permission-mode').length;
      expect(count).toBe(1);
    } finally {
      await l.close();
    }
  });
});

// ── resume-continue system reminder (issue #77) ────────────────────────────
//
// On fnc_restart, append an isMeta:true user-message containing a
// <system-reminder> to the session JSONL before relaunching claude. When
// claude resumes the JSONL, the reminder appears as the final input —
// driving the model to continue the in-flight work rather than treat the
// restart as a hard reset and idle.

describe('resume-continue system reminder', () => {
  function readJSONL(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function lastUserMessageContent(entry: Record<string, unknown>): string {
    const msg = entry.message as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'user') return '';
    return typeof msg.content === 'string' ? msg.content : '';
  }

  test('handleRestart appends an isMeta system-reminder to the session JSONL', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-restart-reminder-'));
    process.env.HOME = tmpHome;
    const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    const jsonlPath = writeSessionJSONL(
      tmpHome,
      cwd,
      sid,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        uuid: 'parent-uuid-0001',
        sessionId: sid,
      })}\n`,
    );

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
      });
      expect(resp.action).toBe('done');
      const entries = readJSONL(jsonlPath);
      // Original entry preserved, new entry appended.
      expect(entries.length).toBe(2);
      const appended = entries[1]!;
      expect(appended.type).toBe('user');
      expect(appended.isMeta).toBe(true);
      const content = lastUserMessageContent(appended);
      expect(content).toContain('<system-reminder>');
      expect(content).toContain('</system-reminder>');
      expect(content.toLowerCase()).toContain('fnc_restart');
      // Directive to continue in-flight work (key phrase).
      expect(content.toLowerCase()).toMatch(/resume|continue|in[- ]flight/);
      // Parent linkage to the prior entry.
      expect(appended.parentUuid).toBe('parent-uuid-0001');
      expect(appended.sessionId).toBe(sid);
    } finally {
      await l.close();
    }
  });

  test('reminder mentions model override when supplied', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-restart-reminder-'));
    process.env.HOME = tmpHome;
    const sid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    const jsonlPath = writeSessionJSONL(
      tmpHome,
      cwd,
      sid,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        uuid: 'parent-uuid-0002',
        sessionId: sid,
      })}\n`,
    );

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
        model: 'sonnet',
      });
      expect(resp.action).toBe('done');
      const entries = readJSONL(jsonlPath);
      const content = lastUserMessageContent(entries[entries.length - 1]!);
      expect(content).toContain('sonnet');
    } finally {
      await l.close();
    }
  });

  test('reminder mentions --ide when ide override is true', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-restart-reminder-'));
    process.env.HOME = tmpHome;
    const sid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    const jsonlPath = writeSessionJSONL(
      tmpHome,
      cwd,
      sid,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        uuid: 'parent-uuid-0003',
        sessionId: sid,
      })}\n`,
    );

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
        ide: true,
      });
      expect(resp.action).toBe('done');
      const entries = readJSONL(jsonlPath);
      const content = lastUserMessageContent(entries[entries.length - 1]!);
      expect(content).toContain('--ide');
    } finally {
      await l.close();
    }
  });

  test('missing JSONL: handleRestart still succeeds (no-op append)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'fnclaude-restart-reminder-'));
    process.env.HOME = tmpHome;
    const sid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const cwd = join(tmpHome, 'proj');
    mkdirSync(cwd, { recursive: true });
    // Deliberately do NOT write a JSONL.

    const fx = mkFixture('ask');
    const l = await SocketListener.start({
      spec: fx.spec,
      cfg: fx.cfg,
      launchCWD: cwd,
      origArgs: [cwd],
    });
    try {
      const resp = await dialAndRoundtrip(fx.spec.socketPath, {
        op: 'restart',
        session_id: sid,
      });
      // Restart still completes — missing JSONL is best-effort, not fatal.
      expect(resp.action).toBe('done');
      expect(l.getHandoffArgv()).not.toBeNull();
    } finally {
      await l.close();
    }
  });
});
