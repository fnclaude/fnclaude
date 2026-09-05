import { describe, expect, test } from 'bun:test';

import { injectMcpConfig } from '../../src/mcp/inject-config';

describe('injectMcpConfig', () => {
  test('non-noop interactive → appends --mcp-config with mcp args', () => {
    const out = injectMcpConfig({
      claudeArgs: ['--model', 'opus'],
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: false,
      interactive: true,
    });
    expect(out.slice(0, 2)).toEqual(['--model', 'opus']);
    expect(out[2]).toBe('--mcp-config');
    const cfg = JSON.parse(out[3]!) as {
      mcpServers: { fnclaude: { command: string; args: string[] } };
    };
    expect(cfg.mcpServers.fnclaude.command).toBe('/usr/bin/bun');
    expect(cfg.mcpServers.fnclaude.args).toEqual(['/abs/path/to/fnc.js', 'mcp']);
  });

  test('noop fallback → args include --noop after mcp', () => {
    const out = injectMcpConfig({
      claudeArgs: [],
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: true,
      interactive: true,
    });
    expect(out[0]).toBe('--mcp-config');
    const cfg = JSON.parse(out[1]!) as {
      mcpServers: { fnclaude: { command: string; args: string[] } };
    };
    expect(cfg.mcpServers.fnclaude.args).toEqual(['/abs/path/to/fnc.js', 'mcp', '--noop']);
  });

  test('print mode (non-interactive) → no injection (passes claudeArgs through unchanged)', () => {
    const out = injectMcpConfig({
      claudeArgs: ['-p', '--', 'hi'],
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: false,
      interactive: false,
    });
    expect(out).toEqual(['-p', '--', 'hi']);
    expect(out).not.toContain('--mcp-config');
  });

  test('empty fncBin → no injection (caller couldnt resolve self path)', () => {
    const out = injectMcpConfig({
      claudeArgs: ['--model', 'opus'],
      bunExec: '/usr/bin/bun',
      fncBin: '',
      noop: false,
      interactive: true,
    });
    expect(out).toEqual(['--model', 'opus']);
  });

  test('returned array is a fresh copy (no mutation of input)', () => {
    const input = ['--model', 'opus'];
    const out = injectMcpConfig({
      claudeArgs: input,
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: false,
      interactive: true,
    });
    expect(input).toEqual(['--model', 'opus']);
    expect(out).not.toBe(input);
  });

  test('JSON config has the exact shape from design.md §29', () => {
    const out = injectMcpConfig({
      claudeArgs: [],
      bunExec: '/bun',
      fncBin: '/fnc',
      noop: false,
      interactive: true,
    });
    expect(out[1]).toBe('{"mcpServers":{"fnclaude":{"command":"/bun","args":["/fnc","mcp"]}}}');
  });

  test('noop variant has the exact shape from design.md §29', () => {
    const out = injectMcpConfig({
      claudeArgs: [],
      bunExec: '/bun',
      fncBin: '/fnc',
      noop: true,
      interactive: true,
    });
    expect(out[1]).toBe(
      '{"mcpServers":{"fnclaude":{"command":"/bun","args":["/fnc","mcp","--noop"]}}}',
    );
  });

  // Regression: cli 2.0.0 appended the `--mcp-config <json>` pair past the
  // prompt-body sentinel, so claude read the JSON as positional prompt
  // content and never registered the MCP server. The injection now lands
  // BEFORE the first `--` via insertFlagsBeforeSentinel.
  test('claudeArgs has prompt-body sentinel → --mcp-config lands BEFORE --', () => {
    const out = injectMcpConfig({
      claudeArgs: ['--model', 'opus', '--', 'say hi'],
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: false,
      interactive: true,
    });
    const flagIdx = out.indexOf('--mcp-config');
    const sentinelIdx = out.indexOf('--');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeLessThan(sentinelIdx);
    // Original prompt body still rides through after the sentinel.
    expect(out[sentinelIdx + 1]).toBe('say hi');
  });

  test('sentinel at position 0 → --mcp-config still lands before it', () => {
    const out = injectMcpConfig({
      claudeArgs: ['--', 'say hi'],
      bunExec: '/usr/bin/bun',
      fncBin: '/abs/path/to/fnc.js',
      noop: false,
      interactive: true,
    });
    expect(out[0]).toBe('--mcp-config');
    expect(out.indexOf('--')).toBe(2);
    expect(out[3]).toBe('say hi');
  });
});
