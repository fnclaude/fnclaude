/**
 * End-to-end tests for the published bin entry point.
 *
 * These spawn `bun packages/cli/bin/fnc.js …` as a real subprocess to
 * exercise the same code path users hit after `npm install @fnclaude/cli`.
 * Where the unit tests for help/version/mcp invoke run() in-process with
 * mocked seams, these go through the bin shim, the Bun startup, the src→
 * dist fallback in fnc.js, and the runtime entry — catching the kind of
 * regressions that only show up in real spawn (broken shebang, wrong
 * exit code on EOF, stdout/stderr split, etc.).
 *
 * Skipped on Windows: the bin shim is a Unix shebang script; Windows has
 * its own .cmd shim wiring via npm's bin packaging.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');
const BUN = process.execPath; // real Bun, no mise shim required.

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runBin(args: readonly string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10_000;
  const proc = Bun.spawn([BUN, BIN, ...args], {
    cwd: CLI_ROOT,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
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

describe.skipIf(SKIP_WINDOWS)('bin/fnc.js spawn', () => {
  test('--help prints help text to stdout and exits 0', async () => {
    const r = await runBin(['--help']);
    expect(r.exitCode).toBe(0);
    // Help text from src/help.ts.
    expect(r.stdout).toContain('fnclaude — claude CLI launcher');
    expect(r.stdout).toContain('Usage:');
    // Nothing on stderr in the happy path.
    expect(r.stderr).toBe('');
  });

  test('-h short form prints help', async () => {
    const r = await runBin(['-h']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fnclaude — claude CLI launcher');
  });

  test('--version prints version line and exits 0', async () => {
    const r = await runBin(['--version']);
    expect(r.exitCode).toBe(0);
    // version line shape: "fnclaude <version>\n"
    expect(r.stdout).toMatch(/^fnclaude \S+\n$/);
  });

  test('-v short form prints version', async () => {
    const r = await runBin(['-v']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^fnclaude \S+\n$/);
  });

  test('mcp --noop responds to initialize then exits cleanly on stdin EOF', async () => {
    // The MCP server reads newline-delimited JSON-RPC from stdin. Send one
    // initialize request, close stdin, and verify:
    //   - response is well-formed JSON-RPC for the initialize result
    //   - process exits with code 0 (clean EOF)
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const r = await runBin(['mcp', '--noop'], {
      stdin: `${JSON.stringify(init)}\n`,
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(0);

    // Parse the single JSON-RPC response line.
    const lines = r.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const resp = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    const result = resp.result as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.protocolVersion).toBe('2024-11-05');
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe('fnclaude');
  });

  test('mcp --noop tools/list returns the noop tool set', async () => {
    // noop=true → fnc_switch_project + fnc_spawn_session + fnc_copy_to_clipboard.
    // (fnc_restart is omitted in noop flavour per tools-fn split in client.ts.)
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const listReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };
    const stdin = `${JSON.stringify(init)}\n${JSON.stringify(listReq)}\n`;
    const r = await runBin(['mcp', '--noop'], { stdin, timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);

    const lines = r.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const listResp = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(listResp.id).toBe(2);
    const result = listResp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'fnc_copy_to_clipboard',
      'fnc_spawn_session',
      'fnc_switch_project',
    ]);
  });

  test('mcp (non-noop) tools/list returns the full tool set', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const listReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };
    const stdin = `${JSON.stringify(init)}\n${JSON.stringify(listReq)}\n`;
    const r = await runBin(['mcp'], { stdin, timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);

    const lines = r.stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const listResp = JSON.parse(lines[1]!) as Record<string, unknown>;
    const result = listResp.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'fnc_restart',
      'fnc_spawn_session',
      'fnc_switch_project',
    ]);
  });
});
