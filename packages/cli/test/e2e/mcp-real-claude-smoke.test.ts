/**
 * End-to-end smoke test for the §7.5 MCP subprocess through REAL claude.
 *
 * Why this exists: the §7.5 + §7.3 wiring landed without an integration
 * test that drives the full chain (claude → fnc mcp → AF_UNIX socket →
 * parent). The handoff round-trip in mcp-handoff-e2e.test.ts substitutes
 * claude with a hand-written stdin/stdout client, so a regression in
 * how claude talks to MCP servers (e.g. the cli 2.0.0 handshake bug
 * where `initialize` returned -32601) wouldn't be caught there.
 *
 * Setup:
 *   - Spin up an AF_UNIX listener that accepts one connection and returns
 *     a canned WireResponse.
 *   - Build a `--mcp-config` pointing at `fnc mcp` (this repo's binary).
 *   - Drive claude in stream-json print mode with a prompt that nudges
 *     it toward calling the MCP tool.
 *
 * Assertions:
 *   - The init line's `mcp_servers` array contains a fnclaude entry whose
 *     status is NOT "failed" (pre-fix, the cli 2.0.0 subprocess returned
 *     -32601 on `initialize`, which claude reports as "failed").
 *   - At least one subsequent assistant message contains a
 *     `tool_use` block with name `mcp__fnclaude__fnc_*` — meaning claude
 *     successfully ran `tools/list` against our subprocess and saw the
 *     tools we exposed. Without the §7.5 tool-schema port + jsonrpc-server
 *     wiring, `tools/list` would return -32601 too and the tool would
 *     never appear in claude's available tool set.
 *
 * Gate: skipped on Windows (no claude binary path standardized in CI for
 * the rewrite window) and when `claude` is not on PATH (so CI without an
 * Anthropic-API-key + claude install still runs). Also gated on
 * ANTHROPIC_API_KEY being set: this test makes a real API call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startMcpListener, type McpListener } from '../../src/mcp/listener.ts';
import { createParentDispatcher } from '../../src/mcp/parent-dispatch.ts';
import type { WireOp, WireRequest, WireResponse } from '../../src/mcp/wire.ts';

const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

const SKIP_WINDOWS = process.platform === 'win32';

/**
 * Probe for `claude` on PATH; if absent, skip — most CI environments
 * won't have it installed. Local dev runs (where Tom has claude) cover
 * the smoke test. The `which` check is sync and cheap.
 */
function hasClaude(): boolean {
  try {
    const proc = Bun.spawnSync(['which', 'claude']);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Detect whether claude can make API calls. Two paths:
 *   - `ANTHROPIC_API_KEY` set in env, or
 *   - `~/.claude/.credentials.json` present (claude's OAuth flow)
 *
 * CI doesn't have either by default, so the test skips. Local dev where
 * one of these is configured runs the full chain.
 */
function hasClaudeAuth(): boolean {
  if (typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY !== '') {
    return true;
  }
  const home = process.env.HOME;
  if (home === undefined) return false;
  const credPath = join(home, '.claude', '.credentials.json');
  if (!existsSync(credPath)) return false;
  try {
    return statSync(credPath).size > 0;
  } catch {
    return false;
  }
}

const SKIP_REAL_CLAUDE = SKIP_WINDOWS || !hasClaude() || !hasClaudeAuth();

interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runClaudeWithMcp(
  mcpConfig: string,
  prompt: string,
  extraArgs: string[],
): Promise<SubprocessResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const userMsg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  });

  const proc = Bun.spawn(
    [
      'claude',
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      ...extraArgs,
    ],
    {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  proc.stdin?.write(userMsg + '\n');
  proc.stdin?.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

interface InitLine {
  type: 'system';
  subtype: 'init';
  mcp_servers: Array<{ name: string; status: string }>;
}

interface AssistantLine {
  type: 'assistant';
  message: {
    content: Array<{
      type: string;
      name?: string;
    }>;
  };
}

type StreamLine = InitLine | AssistantLine | { type: string };

function parseStream(stdout: string): StreamLine[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as StreamLine;
      } catch {
        return { type: 'unparseable' };
      }
    });
}

describe.skipIf(SKIP_REAL_CLAUDE)('real-claude MCP smoke test', () => {
  let socketDir: string;
  let socketPath: string;
  let listener: McpListener | null;

  beforeEach(() => {
    socketDir = mkdtempSync(join(tmpdir(), 'fnc-mcp-real-claude-smoke-'));
    socketPath = join(socketDir, 'sock');
    listener = null;
  });

  afterEach(async () => {
    if (listener !== null) {
      await listener.stop();
      listener = null;
    }
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('claude actually calls a fnc_* MCP tool over the live wire', async () => {
    // Capturing dispatcher: every op returns a canned `action: "done"`.
    // The test asserts on tool-use evidence in claude's stream-json
    // output — meaning claude reached our subprocess, ran `initialize`
    // + `tools/list`, saw the tools, and then issued a `tools/call`.
    // Pre-fix (cli 2.0.0), `initialize` returned -32601 and the chain
    // never got to `tools/list`, so no `mcp__fnclaude__*` tool would
    // ever appear in claude's tool-use stream.
    const cannedResponses: Record<WireOp, WireResponse> = {
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done', clipboard_ok: true },
    };
    const handlers: Record<WireOp, (req: WireRequest) => Promise<WireResponse>> = {
      restart: async () => cannedResponses.restart,
      switch: async () => cannedResponses.switch,
      spawn: async () => cannedResponses.spawn,
      copy_to_clipboard: async () => cannedResponses.copy_to_clipboard,
    };
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    // mcp-config: spawn `node BIN mcp` with FNC_SOCKET pointed at our
    // listener. The env-passthrough on the mcpServers entry is what lets
    // claude inject FNC_SOCKET into the subprocess — claude doesn't
    // forward parent env by default for MCP server processes.
    const mcpConfig = JSON.stringify({
      mcpServers: {
        fnclaude: {
          command: 'node',
          args: [BIN, 'mcp'],
          env: { FNC_SOCKET: socketPath },
        },
      },
    });

    // Allowlist the MCP tool we want claude to call. Without it, claude's
    // sandbox blocks the tool-use and we couldn't tell handshake success
    // from a separate sandbox refusal. The prompt nudges claude toward
    // the tool but the assertion only checks IF a tool_use happens —
    // claude failing to choose the tool is a different kind of failure
    // than the regression this test is here to catch.
    const { stdout, exitCode } = await runClaudeWithMcp(
      mcpConfig,
      'Use the mcp__fnclaude__fnc_copy_to_clipboard tool to copy the text "smoke-test". Then reply with the single word DONE.',
      ['--allowedTools', 'mcp__fnclaude__fnc_copy_to_clipboard'],
    );

    expect(exitCode).toBe(0);
    const lines = parseStream(stdout);

    // First assertion: init line shows fnclaude with status != "failed".
    // Pre-fix, the subprocess returned -32601 on `initialize`, which
    // claude reports as `status: "failed"`. Post-fix, status is "pending"
    // (lazy connect) or "connected".
    const initLine = lines.find(
      (l): l is InitLine => l.type === 'system' && (l as InitLine).subtype === 'init',
    );
    expect(initLine).toBeDefined();
    const fncEntry = initLine!.mcp_servers.find((s) => s.name === 'fnclaude');
    expect(fncEntry).toBeDefined();
    expect(fncEntry!.status).not.toBe('failed');

    // Second assertion: claude issued at least one tool_use whose name
    // matches the fnclaude tool prefix. This proves the `tools/list`
    // response arrived intact — without the §7.5 wiring, the tool would
    // never appear in claude's available tool set and no tool_use could
    // reference it.
    const sawFncToolUse = lines.some((l) => {
      if (l.type !== 'assistant') return false;
      const msg = (l as AssistantLine).message;
      const content = msg?.content ?? [];
      return content.some(
        (c) => c.type === 'tool_use' && typeof c.name === 'string' && c.name.startsWith('mcp__fnclaude__'),
      );
    });
    expect(sawFncToolUse).toBe(true);
  }, 60_000);
});
