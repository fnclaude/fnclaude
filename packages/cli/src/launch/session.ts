/**
 * The session root's one consumer (design.di-architecture §4): a plain,
 * constructor-injected class that owns the live claude session. It starts the MCP
 * listener before spawn, spawns claude (PTY or stdio-inherit per the plan), wires the
 * terminal seams, starts the context monitor after spawn, then races claude's exit
 * against the handoff detector and captures the ring snapshot + drained warnings into
 * the outcome BEFORE the container disposes it — so both survive teardown (doctrine 2).
 *
 * Start is explicit; stop is disposal — the listener/monitor wrappers carry the
 * `Symbol` dispose protocol, so the container's LIFO teardown replaces the pre-DI
 * `finally` block. This class touches no DI engine and takes only injected seams, so
 * its unit tests construct it with fakes and no container.
 */

import { decidePostExitTeardown } from '../handoff/post-exit-teardown';
import { bootFields } from '../log/boot';
import { createPtyControlSeam } from '../mcp/handlers/send-control';
import { makeSessionJsonlReady, seedUltracodePrompt } from './seed-prompt';

import type { IProcessSpawner } from '../ports/contracts';
import type {
  IContextMonitor,
  IControlSeamHolder,
  IHandoffDetector,
  ILogger,
  IMcpListener,
  IPtyWriterHolder,
  IRingBuffer,
  ISession,
  ITerminalHost,
  IWarningBuffer,
  LaunchPlan,
  SessionOutcome,
} from './contracts';

const EMPTY_SNAPSHOT = new Uint8Array(0);

export class Session implements ISession {
  readonly #plan: LaunchPlan;
  readonly #spawner: IProcessSpawner;
  readonly #detector: IHandoffDetector;
  readonly #terminalHost: ITerminalHost;
  readonly #log: ILogger;
  readonly #warnings: IWarningBuffer;
  readonly #listener: IMcpListener | undefined;
  readonly #monitor: IContextMonitor | undefined;
  readonly #ring: IRingBuffer | undefined;
  readonly #ptyWriter: IPtyWriterHolder | undefined;
  readonly #controlSeam: IControlSeamHolder | undefined;

  constructor(
    plan: LaunchPlan,
    spawner: IProcessSpawner,
    detector: IHandoffDetector,
    terminalHost: ITerminalHost,
    log: ILogger,
    warnings: IWarningBuffer,
    listener: IMcpListener | undefined,
    monitor: IContextMonitor | undefined,
    ring: IRingBuffer | undefined,
    ptyWriter: IPtyWriterHolder | undefined,
    controlSeam: IControlSeamHolder | undefined,
  ) {
    this.#plan = plan;
    this.#spawner = spawner;
    this.#detector = detector;
    this.#terminalHost = terminalHost;
    this.#log = log;
    this.#warnings = warnings;
    this.#listener = listener;
    this.#monitor = monitor;
    this.#ring = ring;
    this.#ptyWriter = ptyWriter;
    this.#controlSeam = controlSeam;
  }

  async run(): Promise<SessionOutcome> {
    const plan = this.#plan;
    const cwd = plan.launchCWD;
    const childEnv = { ...plan.env };
    const command = [plan.claudeBin.ok ? plan.claudeBin.path : '', ...plan.claudeArgv];

    // Bind the MCP socket BEFORE spawn so the subprocess can dial back on the first
    // tool call; a bind failure throws McpBindError, which run.ts maps to exit 2.
    await this.#listener?.start();

    this.#log.info('boot', bootFields(plan.origArgs, cwd, process.ppid));

    const proc = plan.useTerminal
      ? this.#spawnUnderTerminal(command, cwd, childEnv)
      : this.#spawnInheriting(command, cwd, childEnv);

    this.#monitor?.start(proc);

    const handoff = await this.#detector.race(proc);
    const exitCode = await proc.exited;
    this.#log.info('claude.exit', { code: exitCode, signal: proc.signalCode ?? null });

    // Capture the ring snapshot + warnings HERE, before the container disposes us.
    const ringSnapshot = this.#ring?.snapshot() ?? EMPTY_SNAPSHOT;
    const warnings = this.#warnings.drain();

    // Post-exit tty handover: on a handoff the re-exec'd child owns termios, so only
    // release stdin; on a plain exit restore cooked mode and pause. Mirrors the pre-DI
    // teardown (specs/design.mcp.md §6), applied here because this class owns the tty.
    const teardown = decidePostExitTeardown({
      handoffStashed: handoff !== undefined,
      useTerminal: plan.useTerminal,
    });
    if (teardown.restoreRawMode) this.#terminalHost.setRawMode(false);
    if (teardown.releaseStdin) this.#terminalHost.pauseStdin();

    return {
      exitCode,
      ...(handoff !== undefined ? { handoff } : {}),
      ringSnapshot,
      warnings,
    };
  }

  #spawnUnderTerminal(
    command: string[],
    cwd: string,
    env: Record<string, string | undefined>,
  ): Bun.Subprocess {
    const term = this.#terminalHost.createTerminal(
      this.#terminalHost.columns(),
      this.#terminalHost.rows(),
      (chunk) => this.#ring?.push(chunk),
    );
    const proc = this.#spawner.spawnPty(command, { cwd, env, terminal: term });
    this.#log.info('claude.spawn', { claudePid: proc.pid, cwd });

    this.#ptyWriter?.bind((payload) => term.write(payload));
    const ptyControl = createPtyControlSeam({ write: (payload) => term.write(payload) });
    this.#controlSeam?.bind(ptyControl.sendControl);

    if (this.#plan.isUltracode && this.#plan.ultracodeSeedPrompt !== '') {
      void seedUltracodePrompt({
        seedPrompt: this.#plan.ultracodeSeedPrompt,
        write: (payload) => term.write(payload),
        waitForReady: makeSessionJsonlReady({ launchCWD: cwd }),
      });
    }

    this.#terminalHost.setRawMode(true);
    this.#terminalHost.onStdinData((chunk) => {
      ptyControl.noteUserInput(chunk.toString());
      term.write(chunk);
    });
    this.#terminalHost.onStdoutResize(() =>
      term.resize(this.#terminalHost.columns(), this.#terminalHost.rows()),
    );
    return proc;
  }

  #spawnInheriting(
    command: string[],
    cwd: string,
    env: Record<string, string | undefined>,
  ): Bun.Subprocess {
    const proc = this.#spawner.spawnInherit(command, { cwd, env });
    this.#log.info('claude.spawn', { claudePid: proc.pid, cwd });
    return proc;
  }
}
