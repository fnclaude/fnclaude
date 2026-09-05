/**
 * MCP subprocess root (design.di-architecture §2b, §9 PR-5): a plain Builder
 * container that resolves the stdio pump and returns its exit code.
 */

import { homedir } from 'node:os';

import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';

import { parseMcpFlags } from '../mcp/dispatch';
import { registerMcpServices, type McpInputs } from '../mcp/register';
import type { IMcpPump } from '../mcp/IMcpPump';

/** Build the MCP root, serve stdio JSON-RPC until stdin closes, and return the exit code. */
export async function runMcpServer(tail: readonly string[]): Promise<number> {
  const inputs: McpInputs = {
    flags: parseMcpFlags(tail),
    env: process.env,
    platform: process.platform,
    xdg: {
      home: homedir(),
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
    },
  };
  await using provider = Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices((m) => registerMcpServices(m, inputs))
    .build();
  return await provider.resolve<IMcpPump>().run();
}
