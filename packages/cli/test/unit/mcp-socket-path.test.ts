import { describe, expect, test } from 'bun:test';

import { computeSocketPath } from '../../src/mcp/socket-path';

describe('computeSocketPath', () => {
  test('XDG_RUNTIME_DIR set → wins over everything', () => {
    const result = computeSocketPath({
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/run/user/1000/fnclaude-mcp-12345.sock');
  });

  test('only TMPDIR set → TMPDIR base', () => {
    const result = computeSocketPath({
      env: { TMPDIR: '/var/tmp' },
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/var/tmp/fnclaude-mcp-12345.sock');
  });

  test('neither set → /tmp fallback', () => {
    const result = computeSocketPath({
      env: {},
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/tmp/fnclaude-mcp-12345.sock');
  });

  test('all three set (XDG + TMPDIR + nothing) → XDG wins', () => {
    const result = computeSocketPath({
      env: { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/var/tmp' },
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/run/user/1000/fnclaude-mcp-12345.sock');
  });

  test('pid stringified into filename', () => {
    const result = computeSocketPath({
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      pid: 7,
      platform: 'linux',
    });
    expect(result).toBe('/run/user/1000/fnclaude-mcp-7.sock');
  });

  test('large pid renders correctly', () => {
    const result = computeSocketPath({
      env: {},
      pid: 4194303,
      platform: 'linux',
    });
    expect(result).toBe('/tmp/fnclaude-mcp-4194303.sock');
  });

  test('empty XDG_RUNTIME_DIR is treated as unset', () => {
    const result = computeSocketPath({
      env: { XDG_RUNTIME_DIR: '', TMPDIR: '/var/tmp' },
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/var/tmp/fnclaude-mcp-12345.sock');
  });

  test('empty TMPDIR is treated as unset', () => {
    const result = computeSocketPath({
      env: { TMPDIR: '' },
      pid: 12345,
      platform: 'linux',
    });
    expect(result).toBe('/tmp/fnclaude-mcp-12345.sock');
  });

  test('darwin uses Unix precedence too', () => {
    const result = computeSocketPath({
      env: { TMPDIR: '/var/folders/xy/T' },
      pid: 999,
      platform: 'darwin',
    });
    expect(result).toBe('/var/folders/xy/T/fnclaude-mcp-999.sock');
  });

  test('win32 throws — Windows MCP not yet supported', () => {
    expect(() =>
      computeSocketPath({
        env: { TMP: 'C:\\Users\\tom\\AppData\\Local\\Temp' },
        pid: 12345,
        platform: 'win32',
      }),
    ).toThrow(/win32|windows/i);
  });
});
