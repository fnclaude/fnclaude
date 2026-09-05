/**
 * The run root's {@link IMcpListener} — a sync-constructed wrapper over the
 * {@link startMcpListener} leaf whose explicit async {@link McpListenerService.start}
 * performs the pre-spawn bind and whose disposal stops the accept loop and unlinks
 * the socket (design.di-architecture §4).
 *
 * A bind failure is mapped to {@link McpBindError} so the run root can surface it as
 * `fnclaude: <message>` + exit 2 with claude never spawned, byte-identical to the
 * pre-DI path (specs/design.mcp.md §2.1).
 */

import type { IDispatcher, ILogger, IMcpListener } from '../launch/contracts';
import { type McpListener, startMcpListener } from './listener';

/** A fatal MCP socket bind failure; its message is the leaf's, so stderr stays byte-identical. */
export class McpBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpBindError';
  }
}

export class McpListenerService implements IMcpListener {
  readonly #socketPath: string;
  readonly #dispatcher: IDispatcher;
  readonly #log: ILogger;
  #listener: McpListener | null = null;

  constructor(socketPath: string, dispatcher: IDispatcher, log: ILogger) {
    this.#socketPath = socketPath;
    this.#dispatcher = dispatcher;
    this.#log = log;
  }

  async start(): Promise<void> {
    try {
      this.#listener = await startMcpListener({
        socketPath: this.#socketPath,
        onConnection: (accepted) => this.#dispatcher.onConnection(accepted),
      });
    } catch (err) {
      throw new McpBindError((err as Error).message);
    }
    this.#log.info('mcp.listen', { socket: this.#socketPath });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#listener !== null) {
      await this.#listener.stop();
      this.#listener = null;
    }
  }
}
