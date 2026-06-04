/**
 * Boot-event field builder.
 *
 * The `boot` log line is forensic: it records the argv the launcher is about
 * to act on, so a failing invocation can be reconstructed from the per-launch
 * log alone. It MUST receive the rehydrated argv (readArgv()'s result), not a
 * fresh `process.argv` read.
 *
 * After the Node→Bun preflight in bin/fnc.js, the real argv lives in
 * `FNC_ARGS_JSON` and `process.argv` has been stripped of the user's args —
 * so logging `process.argv.slice(2)` records `[]`. Taking the argv as a
 * parameter keeps the logged forensic data identical to what the launcher
 * classifies and acts on, with no second, drift-prone read. See issue #211.
 */

export interface BootFields {
  argv: readonly string[];
  cwd: string;
  ppid: number;
}

export function bootFields(argv: readonly string[], cwd: string, ppid: number): BootFields {
  return { argv, cwd, ppid };
}
