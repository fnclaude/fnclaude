#!/usr/bin/env node
//
// Node→Bun preflight. Bun 1.3.14 still strips the literal `--` sentinel from
// `process.argv` (see docs/decisions.md), which would corrupt `fnc -- <prompt>`
// invocations. Running this shim under Node first preserves the unstripped
// argv long enough to stuff it into FNC_ARGS_JSON, then re-execs under Bun
// where main.ts reads back from the env var instead of process.argv.
//
// When this file is invoked directly under Bun (e.g. `bun bin/fnc.js`, or
// via the `#!/usr/bin/env bun` future state), `typeof Bun !== 'undefined'`
// short-circuits the preflight and we jump straight to main.

import { fileURLToPath } from 'node:url';

if (typeof Bun === 'undefined') {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const argvJson = JSON.stringify(process.argv.slice(2));
  const result = spawnSync('bun', [self], {
    stdio: 'inherit',
    env: { ...process.env, FNC_ARGS_JSON: argvJson },
  });
  if (result.error) {
    const err = result.error;
    const isMissingBun = /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT';
    if (isMissingBun) {
      process.stderr.write(
        'fnc: Bun runtime not found on PATH.\n' +
          '  fnclaude requires Bun (Node alone is not supported).\n' +
          '  Install: https://bun.sh — `curl -fsSL https://bun.sh/install | bash`\n',
      );
    } else {
      process.stderr.write(`fnc: failed to re-exec under bun (${err.message})\n`);
    }
    process.exit(127);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    // Unreachable on Unix; defensive return for Windows where kill-self doesn't terminate.
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

await import('../src/main.ts');
