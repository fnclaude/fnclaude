/**
 * §7.5 — MCP subprocess entry point: tool-handler shape.
 *
 * The four tools (`fnc_restart`, `fnc_switch_project`, `fnc_spawn_session`,
 * `fnc_copy_to_clipboard`) each wrap a single `dialAndCall` to the parent
 * over the AF_UNIX socket. This file covers the handler-construction seam:
 * given a socketPath and a callable `dialAndCall`, each tool builds a
 * WireRequest with the correct `op` and forwards the args, then returns
 * whatever the parent says.
 *
 * Real socket I/O is covered by mcp-wire.test.ts. Here we inject a stub
 * `dialAndCall` so the handler-shape contract is exercised without OS
 * sockets.
 */

import { describe, expect, test } from 'bun:test';

import { buildTools, MCP_TOOL_NAMES } from '../../src/mcp/dispatch.ts';
import type { WireRequest, WireResponse } from '../../src/mcp/wire.ts';

describe('MCP_TOOL_NAMES', () => {
  test('exposes the original four plus the Batch-2 slash tools', () => {
    expect(MCP_TOOL_NAMES).toEqual([
      'fnc_restart',
      'fnc_switch_project',
      'fnc_spawn_session',
      'fnc_copy_to_clipboard',
      'request_compact',
      'fnc_set_effort',
      'fnc_set_model',
      'fnc_run_slash_command',
    ]);
  });
});

describe('buildTools — per-tool handler shape', () => {
  function makeFakeDialer(canned: WireResponse) {
    const calls: Array<{ socketPath: string; request: WireRequest }> = [];
    const dial = async (args: {
      socketPath: string;
      request: WireRequest;
    }): Promise<WireResponse> => {
      calls.push({ socketPath: args.socketPath, request: args.request });
      return canned;
    };
    return { dial, calls };
  }

  test('fnc_restart → op "restart", forwards args, returns response', async () => {
    const fake = makeFakeDialer({ ok: true, action: 'done' });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
    });
    const restart = tools['fnc_restart'];
    expect(restart).toBeDefined();
    const result = await restart!.handler({ session_id: 'abc', model: 'opus' });
    expect(result).toEqual({ ok: true, action: 'done' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      socketPath: '/run/fake.sock',
      request: { op: 'restart', session_id: 'abc', model: 'opus' },
    });
  });

  test('fnc_switch_project → op "switch", forwards args', async () => {
    const fake = makeFakeDialer({ ok: true, action: 'done' });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
    });
    const switchTool = tools['fnc_switch_project'];
    await switchTool!.handler({
      destination: '/tmp/foo',
      name: 'bar',
      summary: 'body',
    });
    expect(fake.calls[0]?.request).toEqual({
      op: 'switch',
      destination: '/tmp/foo',
      name: 'bar',
      summary: 'body',
    });
  });

  test('fnc_spawn_session → op "spawn", forwards args', async () => {
    const fake = makeFakeDialer({ ok: true, action: 'done' });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
    });
    const spawnTool = tools['fnc_spawn_session'];
    await spawnTool!.handler({
      destination: '/tmp/foo',
      name: 'bar',
      summary: 'body',
    });
    expect(fake.calls[0]?.request).toEqual({
      op: 'spawn',
      destination: '/tmp/foo',
      name: 'bar',
      summary: 'body',
    });
  });

  test('fnc_copy_to_clipboard → op "copy_to_clipboard", forwards args', async () => {
    const fake = makeFakeDialer({ ok: true, action: 'done', clipboard_ok: true });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
    });
    const clip = tools['fnc_copy_to_clipboard'];
    const result = await clip!.handler({ text: 'hello' });
    expect(fake.calls[0]?.request).toEqual({
      op: 'copy_to_clipboard',
      text: 'hello',
    });
    expect(result).toEqual({ ok: true, action: 'done', clipboard_ok: true });
  });

  test('handler propagates dial rejections', async () => {
    const dial = async (): Promise<WireResponse> => {
      throw new Error('boom');
    };
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: dial,
    });
    const restart = tools['fnc_restart'];
    await expect(restart!.handler({ session_id: 'abc' })).rejects.toThrow(/boom/);
  });

  test('null / undefined arg payload is treated as empty', async () => {
    const fake = makeFakeDialer({ ok: true });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
    });
    const restart = tools['fnc_restart'];
    await restart!.handler(undefined);
    expect(fake.calls[0]?.request).toEqual({ op: 'restart' });
    await restart!.handler(null);
    expect(fake.calls[1]?.request).toEqual({ op: 'restart' });
  });

  test('returned record exposes each tool by name with description + schema', async () => {
    const fake = makeFakeDialer({ ok: true });
    const tools = buildTools({
      socketPath: '/run/fake.sock',
      dialAndCall: fake.dial,
      // Opt in to the generic slash tool so every name in MCP_TOOL_NAMES
      // is present for this completeness check.
      env: { FNC_ENABLE_SLASH_TOOL: '1' },
    });
    // Schema port from §7.5 wiring: each entry carries description +
    // inputSchema so the jsonrpc-server's tools/list response is complete.
    for (const name of MCP_TOOL_NAMES) {
      const tool = tools[name];
      expect(tool).toBeDefined();
      expect(typeof tool!.description).toBe('string');
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(typeof tool!.inputSchema).toBe('object');
    }
  });
});
