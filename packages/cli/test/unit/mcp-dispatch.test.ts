import { describe, expect, test } from 'bun:test';

import { isMcpSubcommand, parseMcpFlags } from '../../src/mcp/dispatch';

describe('isMcpSubcommand', () => {
  test('detects "mcp" at position 0', () => {
    expect(isMcpSubcommand(['mcp'])).toBe(true);
    expect(isMcpSubcommand(['mcp', '--noop'])).toBe(true);
  });

  test('false when "mcp" is not at position 0', () => {
    // The subcommand is positional only; later tokens that happen to be "mcp"
    // are not the subcommand. Per Go canonical, only argv[1] (== our argv[0])
    // triggers the dispatch.
    expect(isMcpSubcommand(['~/src/proj', 'mcp'])).toBe(false);
    expect(isMcpSubcommand(['--mcp'])).toBe(false);
  });

  test('false on empty argv', () => {
    expect(isMcpSubcommand([])).toBe(false);
  });

  test('false on similar tokens', () => {
    expect(isMcpSubcommand(['mcps'])).toBe(false);
    expect(isMcpSubcommand(['MCP'])).toBe(false);
  });
});

describe('parseMcpFlags', () => {
  test('default: noop=false', () => {
    expect(parseMcpFlags([])).toEqual({ noop: false });
    expect(parseMcpFlags(['--verbose'])).toEqual({ noop: false });
  });

  test('--noop sets noop=true', () => {
    expect(parseMcpFlags(['--noop'])).toEqual({ noop: true });
  });

  test('--noop anywhere in tail args', () => {
    expect(parseMcpFlags(['--verbose', '--noop'])).toEqual({ noop: true });
    expect(parseMcpFlags(['--noop', '--verbose'])).toEqual({ noop: true });
  });

  test('multiple --noop is fine (still true)', () => {
    expect(parseMcpFlags(['--noop', '--noop'])).toEqual({ noop: true });
  });
});
