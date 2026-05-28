import { describe, expect, test } from 'bun:test';

import { composeEnv } from '../../src/launch/compose-env.ts';

describe('composeEnv', () => {
  test('no execEnv, no handoff/socket → process env passes through', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin', HOME: '/home/user' },
      execEnv: undefined,
      handoff: undefined,
      socket: undefined,
    });
    expect(result).toEqual({ PATH: '/bin', HOME: '/home/user' });
  });

  test('execEnv keys merged on top of processEnv', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin', FOO: 'from-shell' },
      execEnv: { FOO: 'from-config', BAR: 'config-only' },
      handoff: undefined,
      socket: undefined,
    });
    expect(result).toEqual({
      PATH: '/bin',
      FOO: 'from-config',
      BAR: 'config-only',
    });
  });

  test('FNCLAUDE_HANDOFF set from handoff arg, wins over execEnv', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin' },
      execEnv: { FNCLAUDE_HANDOFF: 'config-tries' },
      handoff: 'ask',
      socket: undefined,
    });
    expect(result.FNCLAUDE_HANDOFF).toBe('ask');
  });

  test('FNC_SOCKET set from socket arg, wins over execEnv', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin' },
      execEnv: { FNC_SOCKET: '/old/sock' },
      handoff: undefined,
      socket: '/new/sock',
    });
    expect(result.FNC_SOCKET).toBe('/new/sock');
  });

  test('undefined handoff → key absent in result', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin' },
      execEnv: undefined,
      handoff: undefined,
      socket: undefined,
    });
    expect('FNCLAUDE_HANDOFF' in result).toBe(false);
  });

  test('undefined socket → key absent in result', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin' },
      execEnv: undefined,
      handoff: undefined,
      socket: undefined,
    });
    expect('FNC_SOCKET' in result).toBe(false);
  });

  test('processEnv values that are undefined are filtered out', () => {
    const result = composeEnv({
      processEnv: { PATH: '/bin', NOPE: undefined },
      execEnv: undefined,
      handoff: undefined,
      socket: undefined,
    });
    expect('NOPE' in result).toBe(false);
    expect(result.PATH).toBe('/bin');
  });

  test('full composition order: process → exec → handoff/socket wins', () => {
    const result = composeEnv({
      processEnv: { FOO: 'p', BAR: 'p', FNCLAUDE_HANDOFF: 'p' },
      execEnv: { FOO: 'c', BAZ: 'c', FNCLAUDE_HANDOFF: 'c' },
      handoff: 'never',
      socket: '/sock',
    });
    expect(result).toEqual({
      FOO: 'c',
      BAR: 'p',
      BAZ: 'c',
      FNCLAUDE_HANDOFF: 'never',
      FNC_SOCKET: '/sock',
    });
  });
});
