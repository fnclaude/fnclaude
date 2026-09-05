/**
 * Unit coverage for the MCP-root pump (design.di-architecture §9 PR-5).
 *
 * McpPump is the sugar-free composition class the mcp root resolves: it builds
 * the JSON-RPC server from the injected wire client + version reader, aggregates
 * the enabled tools, logs one serve line (the previously-unlogged subprocess
 * gap), and pumps stdin. These tests drive it with an injected line source and
 * fakes — no container, no socket, no subprocess.
 */

import { describe, expect, test } from 'bun:test';

import { McpPump } from '../../src/mcp/IMcpPump';
import type { Logger } from '../../src/log/logger';

function recordingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const record = (ev: string) => {
    events.push(ev);
  };
  return {
    logger: { debug: record, info: record, warn: record, error: record },
    events,
  };
}

async function* lines(...requests: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const request of requests) {
    yield encoder.encode(request + '\n');
  }
}

describe('McpPump.run', () => {
  test('without FNC_SOCKET returns 2 and points at the launcher', async () => {
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stderr.write;

    let code: number;
    try {
      const pump = new McpPump({
        wire: async () => ({}),
        version: { read: () => '9.9.9' },
        logger: recordingLogger().logger,
        flags: { noop: false },
        env: {},
        input: lines(),
      });
      code = await pump.run();
    } finally {
      process.stderr.write = original;
    }

    expect(code).toBe(2);
    expect(written.join('')).toContain('FNC_SOCKET not set');
    expect(written.join('')).toContain('fnclaude launcher');
  });

  test('serves the aggregated tools, carries the injected version, and logs a serve line', async () => {
    const { logger, events } = recordingLogger();
    const out: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      const pump = new McpPump({
        wire: async () => ({ ok: true }),
        version: { read: () => '9.9.9' },
        logger,
        flags: { noop: false },
        env: { FNC_SOCKET: '/run/fake.sock' },
        input: lines(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05' },
          }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        ),
      });
      code = await pump.run();
    } finally {
      process.stdout.write = original;
    }

    expect(code).toBe(0);
    expect(events).toContain('mcp_serve');

    const init = JSON.parse(out[0]) as { result: { serverInfo: { version: string } } };
    expect(init.result.serverInfo.version).toBe('9.9.9');

    const list = JSON.parse(out[1]) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'fnc_copy_to_clipboard',
      'fnc_restart',
      'fnc_set_effort',
      'fnc_set_model',
      'fnc_spawn_session',
      'fnc_switch_project',
      'get_usage',
      'request_compact',
    ]);
  });
});
