/**
 * Build the env passed to claude's child process.
 *
 * Order (each step wins over earlier ones):
 *   1. processEnv — the launcher's inherited env, filtered to defined values.
 *   2. execEnv    — `[exec.env]` from fnclaude's config.toml.
 *   3. handoff    — sets FNCLAUDE_HANDOFF if defined; per design.md §5
 *                   this is the resolved auto.handoff value.
 *   4. socket     — sets FNC_SOCKET if defined; the AF_UNIX path the
 *                   MCP subprocess dials for tool calls.
 *
 * Per design.md §5: "These are appended AFTER os.Environ() + envFromConfig,
 * so they win against any same-name entries from user config."
 */

export interface ComposeEnvArgs {
  processEnv: Record<string, string | undefined>;
  execEnv: Record<string, string> | undefined;
  handoff: string | undefined;
  socket: string | undefined;
}

export function composeEnv(args: ComposeEnvArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.processEnv)) {
    if (v !== undefined) out[k] = v;
  }
  if (args.execEnv !== undefined) {
    for (const [k, v] of Object.entries(args.execEnv)) out[k] = v;
  }
  if (args.handoff !== undefined) out.FNCLAUDE_HANDOFF = args.handoff;
  if (args.socket !== undefined) out.FNC_SOCKET = args.socket;
  // Strip FNC_ARGS_JSON: it's the Node-shim → main.ts argv handoff and must
  // not propagate into claude's env. Claude forwards env to MCP subprocesses
  // verbatim; the `fnc mcp` subprocess prefers FNC_ARGS_JSON over process.argv,
  // would see the parent's argv (no "mcp"), fall through past isMcpSubcommand,
  // run main.ts as a launcher, and ENOEXEC trying to spawn the claude binary.
  delete out.FNC_ARGS_JSON;
  return out;
}
