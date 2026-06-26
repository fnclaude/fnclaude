import { afterEach, describe, expect, test } from 'bun:test';

import { readArgv } from '../../src/argv/intake';
import { bootFields } from '../../src/log/boot';

const ORIGINAL_ENV = process.env.FNC_ARGS_JSON;
const ORIGINAL_ARGV = process.argv;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.FNC_ARGS_JSON;
  else process.env.FNC_ARGS_JSON = ORIGINAL_ENV;
  process.argv = ORIGINAL_ARGV;
});

describe('bootFields', () => {
  test('logs the argv it is handed, not process.argv', () => {
    // Simulate the post-preflight state: bun stripped the user args off
    // process.argv, the real argv lives in FNC_ARGS_JSON and has been
    // rehydrated by readArgv(). The boot event must record the rehydrated
    // argv — issue #211.
    process.argv = ['bun', '/path/to/fnc.js'];
    const argv = ['resume', '--', 'pick up where I left off'];

    expect(bootFields(argv, '/some/cwd', 4321)).toEqual({
      argv,
      cwd: '/some/cwd',
      ppid: 4321,
    });
  });

  test('rehydration path: boot argv matches readArgv() output, not the empty process.argv', () => {
    // End-to-end of the bug: launch via the FNC_ARGS_JSON rehydration path
    // (the node-shim preflight). process.argv has no user args, yet the
    // boot event must carry the rehydrated argv.
    process.env.FNC_ARGS_JSON = JSON.stringify(['resume']);
    process.argv = ['bun', '/path/to/fnc.js']; // bun stripped the user args

    const argv = readArgv();
    const fields = bootFields(argv, '/cwd', 7);

    expect(argv).toEqual(['resume']);
    expect(fields.argv).toEqual(['resume']);
    // Regression guard: the old code logged process.argv.slice(2) === [].
    expect(fields.argv).not.toEqual([]);
  });
});
