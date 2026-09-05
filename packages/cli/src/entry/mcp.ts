/**
 * MCP subprocess role (design.di-architecture §2b, §9 PR-3).
 *
 * PR-3 stub: dispatches to today's MCP code path unchanged. PR-5 replaces this body
 * with a `registerMcpServices` container root; the dispatcher's call site stays put.
 */

import { parseMcpFlags, runMcpServer as runMcpServerLeaf } from '../mcp/dispatch';

/** Run the stdio JSON-RPC MCP server for the `fnc mcp` subcommand tail. */
export async function runMcpServer(tail: readonly string[]): Promise<number> {
  return runMcpServerLeaf(parseMcpFlags(tail));
}
