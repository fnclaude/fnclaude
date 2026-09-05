/**
 * MCP stdio pump (design.di-architecture §4, MCP root): builds the JSON-RPC
 * server from the injected wire client + version reader and pumps stdin lines
 * through it, logging one serve line so the subprocess is no longer unlogged.
 */

import { createJsonRpcServer } from './jsonrpc-server';
import { buildInitializeResponse, buildTools, type McpFlags, runStdinLoop } from './dispatch';

import type { IVersionReader } from '../composition/version-reader';
import type { Logger } from '../log/logger';
import type { IWireClient } from './wire';

/** Serves the stdio JSON-RPC MCP protocol for the `fnc mcp` subprocess. */
export interface IMcpPump {
  /** Serve until stdin closes; returns the process exit code (2 when no socket is set). */
  run(): Promise<number>;
}

export interface McpPumpDeps {
  wire: IWireClient;
  version: IVersionReader;
  logger: Logger;
  flags: McpFlags;
  env: Record<string, string | undefined>;
  /** The newline-delimited request source; defaults to `process.stdin`. */
  input?: AsyncIterable<unknown>;
}

export class McpPump implements IMcpPump {
  readonly #wire: IWireClient;
  readonly #version: IVersionReader;
  readonly #logger: Logger;
  readonly #flags: McpFlags;
  readonly #env: Record<string, string | undefined>;
  readonly #input: AsyncIterable<unknown>;

  constructor(deps: McpPumpDeps) {
    this.#wire = deps.wire;
    this.#version = deps.version;
    this.#logger = deps.logger;
    this.#flags = deps.flags;
    this.#env = deps.env;
    this.#input = deps.input ?? process.stdin;
  }

  async run(): Promise<number> {
    const socketPath = this.#env.FNC_SOCKET;
    if (socketPath === undefined || socketPath === '') {
      process.stderr.write(
        'fnc mcp: FNC_SOCKET not set; subprocess must be invoked by fnclaude launcher.\n',
      );
      return 2;
    }

    const server = createJsonRpcServer({
      tools: buildTools({ socketPath, dialAndCall: this.#wire, env: this.#env }),
      initializeResponse: buildInitializeResponse(this.#version.read()),
    });
    this.#logger.info('mcp_serve', { socketPath, noop: this.#flags.noop });

    await runStdinLoop(server, this.#input);
    return 0;
  }
}
