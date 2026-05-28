/**
 * Unit coverage for the §7.5 dispatch wiring of §7.3's JSON-RPC scaffold.
 *
 * Drives the runMcpServer's per-line handler in-process by importing the
 * line-handling export. The MCP subprocess speaks newline-delimited
 * JSON-RPC 2.0 over stdio; the e2e harness covers the spawn-and-stdio
 * shape (`mcp-handoff-e2e.test.ts`). What this file is for: the
 * handshake messages (`initialize`, `tools/list`, `notifications/*`)
 * that cli 2.0.0 returned -32601 for, which broke claude's connect
 * handshake. Each test feeds one line and asserts the response shape.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { handleMcpLine } from '../../src/mcp/dispatch.ts';

const PKG_VERSION = (() => {
  const pkgPath = resolve(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
})();

function parseLine(out: string | null): Record<string, unknown> {
  if (out === null) throw new Error('expected JSON response, got null');
  return JSON.parse(out) as Record<string, unknown>;
}

describe('dispatch — initialize handshake', () => {
  test('initialize returns protocolVersion + serverInfo with package.json version', async () => {
    const out = await handleMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    );
    const env = parseLine(out);
    expect(env.id).toBe(1);
    const result = env.result as {
      protocolVersion: string;
      capabilities: { tools: object };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities.tools).toEqual({});
    expect(result.serverInfo.name).toBe('fnclaude');
    expect(result.serverInfo.version).toBe(PKG_VERSION);
  });

  test('notifications/initialized → no response written (null returned)', async () => {
    // The MCP handshake sends this notification right after initialize; if
    // the dispatcher responded with a -32601 error on notifications,
    // claude would treat the server as broken. createJsonRpcServer
    // suppresses responses on missing-id requests; we re-verify here.
    const out = await handleMcpLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    );
    expect(out).toBeNull();
  });
});

describe('dispatch — tools/list', () => {
  test('returns the four registered tools with descriptions + JSON-Schema input', async () => {
    const out = await handleMcpLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const env = parseLine(out);
    expect(env.id).toBe(2);
    const tools = (env.result as { tools: unknown[] }).tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties: object; required?: string[] };
    }>;
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'fnc_copy_to_clipboard',
      'fnc_restart',
      'fnc_spawn_session',
      'fnc_switch_project',
    ]);
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
    }
  });
});
