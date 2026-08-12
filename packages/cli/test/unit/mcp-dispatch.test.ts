import { describe, expect, test } from 'bun:test';

import { isMcpSubcommand, parseMcpFlags, pumpJsonRpcLines } from '../../src/mcp/dispatch';

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

describe('pumpJsonRpcLines — a parked handler must not head-of-line-block the pump', () => {
  // fnc_await legitimately parks for up to 540s (560s wire deadline). If the
  // stdin pump awaits each line serially, a parked await freezes EVERY other
  // JSON-RPC line on that stdin — sibling fnc tool calls and
  // notifications/cancelled included — until the poll lapses. JSON-RPC
  // responses carry the request id, so out-of-order replies are legal; the
  // pump must float each line's handling instead of awaiting it inline.
  function encodeLines(lines: string[]): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    return (async function* (): AsyncGenerator<Uint8Array> {
      for (const line of lines) {
        yield encoder.encode(line + '\n');
      }
    })();
  }

  test('later line answers while an earlier line is still parked', async () => {
    const written: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const server = {
      handle(line: string): Promise<string | null> {
        if (line === 'slow') {
          return new Promise<string | null>((resolve) => {
            // Fallback so a serial pump FAILS the assertion instead of
            // deadlocking the test: if nothing releases us, self-resolve
            // with a marker after 250ms.
            const timer = setTimeout(() => {
              resolve('"slow:timed-out"');
            }, 250);
            releaseSlow = (): void => {
              clearTimeout(timer);
              resolve('"slow:after-fast"');
            };
          });
        }
        return Promise.resolve('"fast"');
      },
    };

    await pumpJsonRpcLines(server, {
      input: encodeLines(['slow', 'fast']),
      write(line: string): void {
        written.push(line.trim());
        // The slow handler only completes once fast's response is out —
        // proving the pump didn't serialize on the parked line.
        if (line.includes('fast')) {
          releaseSlow?.();
        }
      },
    });

    expect(written).toEqual(['"fast"', '"slow:after-fast"']);
  });

  test('null (notification) responses are dropped, others still written', async () => {
    const written: string[] = [];
    const server = {
      handle(line: string): Promise<string | null> {
        if (line === 'note') {
          return Promise.resolve(null);
        }
        return Promise.resolve(`"${line}"`);
      },
    };

    await pumpJsonRpcLines(server, {
      input: encodeLines(['note', 'call']),
      write(line: string): void {
        written.push(line.trim());
      },
    });

    expect(written).toEqual(['"call"']);
  });
});
