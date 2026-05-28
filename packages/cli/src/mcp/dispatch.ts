/**
 * MCP subcommand dispatch. fnc's first arg of "mcp" routes to the embedded
 * JSON-RPC server (the subprocess claude invokes via the injected
 * --mcp-config; see docs/design.mcp.md §2).
 *
 * §2.7 ships only the dispatch wiring. The server itself lands in §7
 * (scaffolding) and §8 (tools). For now, runMcpServer prints a stub
 * message and exits non-zero so silent silence can't masquerade as
 * success.
 *
 * Matches Go canonical's dispatch shape (src/main.go:879-887): mcp
 * subcommand recognized ONLY at argv[0], '--noop' is the sole flag that
 * affects server behavior, anything else is ignored.
 */

const SUBCOMMAND = 'mcp';
const NOOP_FLAG = '--noop';

export function isMcpSubcommand(args: readonly string[]): boolean {
  return args.length > 0 && args[0] === SUBCOMMAND;
}

export interface McpFlags {
  noop: boolean;
}

export function parseMcpFlags(tail: readonly string[]): McpFlags {
  return { noop: tail.includes(NOOP_FLAG) };
}

export async function runMcpServer(flags: McpFlags): Promise<number> {
  const mode = flags.noop ? 'noop' : 'project';
  process.stderr.write(
    `fnc: MCP server not yet implemented (${mode} mode). See docs/design.mcp.md and docs/build-plan.md §7.\n`,
  );
  return 2;
}
