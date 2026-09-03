/**
 * Argv intake. Reads the user's command-line arguments, working around
 * bun's argv-stripping behavior via the Node-shebang preflight indirection.
 *
 * When invoked under Node first, `bin/fnc.js`'s preflight stuffs the raw
 * argv into `FNC_ARGS_JSON` and re-execs under Bun. By the time main.ts
 * runs, `process.argv` may have lost its `--` sentinel (bun 1.3.14 still
 * strips it; see `specs/decisions.md`), so we prefer the env var.
 *
 * Direct `bun fnc.js` invocations (no preflight) still work — there's
 * just no way to recover `--` in that path.
 */

const ENV_KEY = 'FNC_ARGS_JSON';

function warnStderr(msg: string): void {
  try {
    Bun.write(Bun.stderr, `fnc: ${msg}\n`);
  } catch {
    // Stderr write failure is non-fatal — the fallback still applies.
  }
}

function tryParseArgsJson(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnStderr(`${ENV_KEY} is not valid JSON (${(err as Error).message}); falling back to process.argv`);
    return null;
  }
  if (!Array.isArray(parsed)) {
    warnStderr(`${ENV_KEY} did not parse to an array; falling back to process.argv`);
    return null;
  }
  for (const el of parsed) {
    if (typeof el !== 'string') {
      warnStderr(`${ENV_KEY} contains a non-string element; falling back to process.argv`);
      return null;
    }
  }
  return parsed as readonly string[];
}

export function readArgv(): readonly string[] {
  const raw = process.env[ENV_KEY];
  if (raw !== undefined) {
    const parsed = tryParseArgsJson(raw);
    if (parsed !== null) return parsed;
  }
  return process.argv.slice(2);
}
