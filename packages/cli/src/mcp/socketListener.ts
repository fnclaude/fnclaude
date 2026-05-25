/**
 * Parent-side AF_UNIX socket listener — accepts one MCP Request per
 * connection, dispatches by Op, returns one Response, then closes. Ported
 * from src/socket_listener.go in the Go reference (fnclaude@fnrhombus).
 *
 * The triggered/handoff-argv channel pattern is preserved: when a handoff
 * action fires (OpRestart, OpSwitch), the listener stashes the new argv
 * and resolves a `triggered` promise so the PTY-runner can unblock and
 * kill claude. First-wins on the argv; subsequent calls don't replace it.
 *
 * Cross-cutting helpers (clipboard write, sibling spawn) are dependency-
 * injected so tests can stub them without exec'ing real binaries. This
 * mirrors Go's `clipboardExec` / `spawnSibling` indirection vars.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { writeFile, unlink, chmod } from 'node:fs/promises';
import type { Config } from '../config.js';
import { handoffContentPath, type HandoffSpec } from '../handoff.js';
import { readLivePermissionMode } from '../sessionState.js';
import {
  encodeResponse,
  type CopyRequest,
  type Request,
  type Response,
  type RestartRequest,
  type SpawnRequest,
  type SwitchRequest,
  readRequest,
} from './protocol.js';
import {
  applyOverrides,
  flagPresent,
  preserveArgs,
  splitLeadingMagic,
  transferDenyBareOK,
  transferDenyFlags,
} from '../args/preserve.js';

// ── Session ID validation (matches Go sessionIDPattern) ───────────────────

const SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Injected dependencies ─────────────────────────────────────────────────

/** Result of a clipboard write — mirrors Go's (bool, error). */
export interface ClipboardResult {
  ok: boolean;
  error?: Error;
}

/** Result of a sibling spawn — mirrors Go's (bool, error). */
export interface SpawnResult {
  spawned: boolean;
  error?: Error;
}

export interface SocketListenerDeps {
  /**
   * Write text to the user's clipboard. Production default is a stub that
   * always reports failure — wire the real implementation in via the
   * constructor (or accept the no-op behavior in tests that don't care).
   */
  copyToClipboard: (text: string) => Promise<ClipboardResult>;

  /**
   * Spawn a sibling fnclaude session at `dest`, passing `summaryPath` as
   * the @-arg and `extraArgs` as the tail flag list. Return `spawned:true`
   * when a launcher was found and started; `spawned:false` (with no
   * error) when no launcher resolved — caller falls back to paste-flow.
   */
  spawnSibling: (
    cfg: Config,
    dest: string,
    name: string,
    summaryPath: string,
    extraArgs: readonly string[],
  ) => Promise<SpawnResult>;
}

/**
 * Default deps used when the caller doesn't supply their own. Both are
 * intentionally no-op fallbacks: real implementations live in higher
 * layers (clipboard.ts / spawn.ts in future phases). The listener
 * remains usable end-to-end with the defaults — clipboard writes report
 * failure, spawn always reports "no launcher".
 */
export function defaultDeps(): SocketListenerDeps {
  return {
    copyToClipboard: async () => ({
      ok: false,
      error: new Error('no clipboard backend wired'),
    }),
    spawnSibling: async () => ({ spawned: false }),
  };
}

// ── SocketListener ────────────────────────────────────────────────────────

export interface StartOptions {
  spec: HandoffSpec;
  cfg: Config;
  launchCWD: string;
  /** os.Args[1:] equivalent captured at startup; used to preserve flags. */
  origArgs?: readonly string[];
  /** Override for clipboard + spawn — tests pass stubs here. */
  deps?: Partial<SocketListenerDeps>;
}

export class SocketListener {
  private readonly socketPath: string;
  private readonly server: Server;
  private readonly cfg: Config;
  private readonly launchCWD: string;
  private readonly origArgs: readonly string[];
  private readonly deps: SocketListenerDeps;

  private handoffArgv: string[] | null = null;
  private triggeredResolve!: () => void;
  private readonly triggeredPromise: Promise<void>;
  private triggeredFired = false;

  private constructor(opts: StartOptions, server: Server) {
    this.socketPath = opts.spec.socketPath;
    this.server = server;
    this.cfg = opts.cfg;
    this.launchCWD = opts.launchCWD;
    this.origArgs = (opts.origArgs ?? []).slice();
    const fallback = defaultDeps();
    this.deps = {
      copyToClipboard: opts.deps?.copyToClipboard ?? fallback.copyToClipboard,
      spawnSibling: opts.deps?.spawnSibling ?? fallback.spawnSibling,
    };
    this.triggeredPromise = new Promise<void>((resolve) => {
      this.triggeredResolve = resolve;
    });
  }

  /**
   * Open the AF_UNIX listener at spec.socketPath and start the accept
   * loop. Best-effort removes any stale socket file from a prior crashed
   * invocation at this path (net listen errors with EADDRINUSE otherwise).
   *
   * The socket file is chmod'd to 0600 immediately after bind so other
   * UIDs on the host cannot dial it. Node's createServer() does NOT honor
   * a mode option for AF_UNIX paths — it inherits the process umask, which
   * defaults to 022 (world-readable) or worse depending on caller. We
   * tighten unconditionally rather than rely on umask discipline at every
   * launch site. The race window between bind and chmod is small (single
   * tick) but real; we accept it as the trade vs. a per-process umask
   * dance that would still leak any *other* file created in the same tick.
   */
  static async start(opts: StartOptions): Promise<SocketListener> {
    try {
      await unlink(opts.spec.socketPath);
    } catch {
      // best-effort — fine if it didn't exist
    }
    const server = createServer();
    const listener = new SocketListener(opts, server);
    server.on('connection', (sock) => {
      void listener.handleConn(sock);
    });
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => {
        server.off('listening', onOk);
        reject(e);
      };
      const onOk = () => {
        server.off('error', onErr);
        resolve();
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(opts.spec.socketPath);
    });
    // Tighten the socket to owner-only rw — see method-level note above.
    // Windows AF_UNIX implementations don't honor POSIX modes; the chmod
    // call is a no-op there but harmless.
    try {
      await chmod(opts.spec.socketPath, 0o600);
    } catch (err) {
      // Don't leave a world-readable socket up if we can't tighten it.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(opts.spec.socketPath);
      } catch {
        // already gone
      }
      throw new Error(
        `failed to chmod socket to 0600 at ${opts.spec.socketPath}: ${(err as Error).message}`,
      );
    }
    return listener;
  }

  /** Shut down and remove the socket file. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    try {
      await unlink(this.socketPath);
    } catch {
      // already removed (some platforms do this on close)
    }
  }

  /**
   * Promise that resolves when a handoff action (restart or switch) has
   * stashed an argv to relaunch with. The PTY runner awaits this to know
   * when to kill claude.
   */
  triggered(): Promise<void> {
    return this.triggeredPromise;
  }

  /** Parsed argv (leading "fnclaude" token already dropped) to re-exec. */
  getHandoffArgv(): string[] | null {
    return this.handoffArgv === null ? null : this.handoffArgv.slice();
  }

  /** First-wins. Subsequent calls don't overwrite. */
  private stashArgv(argv: string[]): void {
    if (this.handoffArgv === null) {
      this.handoffArgv = argv;
    }
    if (!this.triggeredFired) {
      this.triggeredFired = true;
      this.triggeredResolve();
    }
  }

  // ── per-connection handler ──────────────────────────────────────────────

  private async handleConn(sock: Socket): Promise<void> {
    try {
      // Read one Request from the socket's data stream.
      let req: Request | null;
      try {
        req = await readRequest(sock);
      } catch (err) {
        sock.write(
          encodeResponse({
            action: 'error',
            error: `malformed request: ${(err as Error).message}`,
          }),
        );
        sock.end();
        return;
      }
      if (req === null) {
        // EOF without a line — client disconnected silently. Nothing to respond.
        sock.end();
        return;
      }
      const resp = await this.dispatch(req);
      sock.write(encodeResponse(resp));
      sock.end();
    } catch (err) {
      // Best-effort error response then close.
      try {
        sock.write(
          encodeResponse({
            action: 'error',
            error: `handler failure: ${(err as Error).message}`,
          }),
        );
      } catch {
        // ignore — socket may already be torn down
      }
      sock.end();
    }
  }

  private async dispatch(req: Request): Promise<Response> {
    switch (req.op) {
      case 'restart':
        return this.handleRestart(req);
      case 'switch':
        return this.handleSwitch(req);
      case 'spawn':
        return this.handleSpawn(req);
      case 'copy_to_clipboard':
        return this.handleCopy(req);
      default: {
        // Exhaustiveness: adding a new Op variant to Request without
        // handling it here becomes a compile error on this line. The
        // runtime branch defends against malformed wire input that
        // squeezes through with an unknown op.
        const _exhaustive: never = req;
        void _exhaustive;
        return {
          action: 'error',
          error: `unsupported op ${JSON.stringify((req as { op: unknown }).op)}`,
        };
      }
    }
  }

  // ── handleRestart ───────────────────────────────────────────────────────

  private async handleRestart(req: RestartRequest): Promise<Response> {
    const sid = req.session_id ?? '';
    if (sid === '') {
      return {
        action: 'error',
        error:
          'restart requires a session id; pass it as the fnc_restart session_id argument (read $CLAUDE_CODE_SESSION_ID via Bash).',
      };
    }
    if (!SESSION_ID_PATTERN.test(sid)) {
      return {
        action: 'error',
        error: `session_id ${JSON.stringify(sid)} is not a valid UUID; expected the 8-4-4-4-12 hex form.`,
      };
    }

    // Preserve user flags (no denylist for restart — everything carries).
    const preserved = preserveArgs(this.origArgs, null, null);
    // Apply MCP-supplied overrides.
    let withOverrides = applyOverrides(preserved, req);
    // Auto-capture live permission-mode from the session JSONL when the
    // caller didn't override AND none was preserved.
    if (
      (req.permission_mode === undefined || req.permission_mode === '') &&
      !flagPresent(withOverrides, '--permission-mode')
    ) {
      const live = readLivePermissionMode(this.launchCWD, sid);
      if (live !== '') {
        withOverrides = [...withOverrides, '--permission-mode', live];
      }
    }
    const { magic, rest } = splitLeadingMagic(withOverrides);

    const argv = [...magic, this.launchCWD, '--resume', sid, ...rest];
    this.stashArgv(argv);
    return { action: 'done' };
  }

  // ── handleSwitch ────────────────────────────────────────────────────────

  private async handleSwitch(req: SwitchRequest): Promise<Response> {
    if (this.cfg.auto.handoff === 'never') {
      return this.handleSwitchNeverMode(req);
    }
    const summaryPath = handoffContentPath();
    try {
      await writeFile(summaryPath, req.summary ?? '', { mode: 0o600 });
    } catch (err) {
      return { action: 'error', error: `write summary: ${(err as Error).message}` };
    }

    // Preserve user flags minus the transfer denylist, then apply overrides.
    const preserved = preserveArgs(this.origArgs, transferDenyFlags, transferDenyBareOK);
    let withOverrides = applyOverrides(preserved, req);
    // Auto-capture live permission-mode (same pattern as restart).
    const sid = req.session_id ?? '';
    if (
      (req.permission_mode === undefined || req.permission_mode === '') &&
      !flagPresent(withOverrides, '--permission-mode') &&
      sid !== ''
    ) {
      const live = readLivePermissionMode(this.launchCWD, sid);
      if (live !== '') {
        withOverrides = [...withOverrides, '--permission-mode', live];
      }
    }
    const { magic, rest } = splitLeadingMagic(withOverrides);

    const argv = [
      ...magic,
      req.destination ?? '',
      ...rest,
      '--name',
      req.name ?? '',
      `@${summaryPath}`,
    ];
    this.stashArgv(argv);
    return { action: 'done' };
  }

  // ── handleSpawn ─────────────────────────────────────────────────────────

  private async handleSpawn(req: SpawnRequest): Promise<Response> {
    if (this.cfg.auto.handoff === 'never') {
      return this.handleSpawnNeverMode(req);
    }
    const summaryPath = handoffContentPath();
    try {
      await writeFile(summaryPath, req.summary ?? '', { mode: 0o600 });
    } catch (err) {
      return { action: 'error', error: `write summary: ${(err as Error).message}` };
    }

    // Spawn doesn't preserve startup flags — fresh-start sibling.
    const extraArgs = applyOverrides([], req);

    const dest = req.destination ?? '';
    const name = req.name ?? '';
    const { spawned, error } = await this.deps.spawnSibling(
      this.cfg,
      dest,
      name,
      summaryPath,
      extraArgs,
    );
    if (error) {
      return { action: 'error', error: `spawn: ${error.message}` };
    }
    if (!spawned) {
      // No launcher resolved — fall back to paste-flow.
      const cmdStr = renderSpawnCommand(dest, name, summaryPath, extraArgs);
      const { ok } = await this.deps.copyToClipboard(cmdStr);
      const msg = ok
        ? 'No spawn launcher configured for this terminal — the relaunch command is on your clipboard; paste it into a new terminal window. Set `auto.spawnCommand` in ~/.config/fnclaude/config.toml to enable auto-spawn (use {bin}, {dest}, {name}, {summary} placeholders).'
        : 'No spawn launcher configured for this terminal — copy this command and run it in a new terminal window. Set `auto.spawnCommand` in ~/.config/fnclaude/config.toml to enable auto-spawn (use {bin}, {dest}, {name}, {summary} placeholders):';
      return {
        action: 'paste_flow',
        message: msg,
        command: cmdStr,
        clipboard_ok: ok,
      };
    }
    return {
      action: 'done',
      message: `Spawned sibling fnclaude for ${dest} in a new window.`,
    };
  }

  // ── never-mode handlers ─────────────────────────────────────────────────

  private async handleSwitchNeverMode(req: SwitchRequest): Promise<Response> {
    const summaryPath = handoffContentPath();
    try {
      await writeFile(summaryPath, req.summary ?? '', { mode: 0o600 });
    } catch (err) {
      return { action: 'error', error: `write summary: ${(err as Error).message}` };
    }
    const preserved = preserveArgs(this.origArgs, transferDenyFlags, transferDenyBareOK);
    const withOverrides = applyOverrides(preserved, req);
    const { magic, rest } = splitLeadingMagic(withOverrides);
    const cmdStr = renderSwitchCommand(
      magic,
      req.destination ?? '',
      rest,
      req.name ?? '',
      summaryPath,
    );
    const { ok } = await this.deps.copyToClipboard(cmdStr);
    const msg = ok
      ? "I've prepared the handoff command (already on your clipboard)."
      : 'Copy this command and run it:';
    return {
      action: 'paste_flow',
      message: msg,
      command: cmdStr,
      clipboard_ok: ok,
    };
  }

  private async handleSpawnNeverMode(req: SpawnRequest): Promise<Response> {
    const summaryPath = handoffContentPath();
    try {
      await writeFile(summaryPath, req.summary ?? '', { mode: 0o600 });
    } catch (err) {
      return { action: 'error', error: `write summary: ${(err as Error).message}` };
    }
    const extraArgs = applyOverrides([], req);
    const dest = req.destination ?? '';
    const name = req.name ?? '';
    const cmdStr = renderSpawnCommand(dest, name, summaryPath, extraArgs);
    const { ok } = await this.deps.copyToClipboard(cmdStr);
    const msg = ok
      ? 'Auto-handoff is disabled — the relaunch command is on your clipboard; paste it into a new terminal window.'
      : 'Auto-handoff is disabled — copy this command and run it in a new terminal window:';
    return {
      action: 'paste_flow',
      message: msg,
      command: cmdStr,
      clipboard_ok: ok,
    };
  }

  // ── handleCopy ──────────────────────────────────────────────────────────

  private async handleCopy(req: CopyRequest): Promise<Response> {
    const { ok } = await this.deps.copyToClipboard(req.text ?? '');
    return { action: 'done', clipboard_ok: ok };
  }
}

// ── command-string rendering ──────────────────────────────────────────────

/**
 * Build the user-visible relaunch command for paste-flow Responses (spawn).
 */
export function renderSpawnCommand(
  destination: string,
  name: string,
  summaryPath: string,
  extraArgs: readonly string[],
): string {
  let cmd = `fnclaude ${destination} --name ${name} @${summaryPath}`;
  if (extraArgs.length > 0) {
    cmd += ` ${extraArgs.join(' ')}`;
  }
  return cmd;
}

/**
 * Build the user-visible relaunch command for paste-flow Responses
 * (never-mode switch). Magic words come first, then destination, then
 * preserved/override flags, then --name name @summary at the end.
 */
export function renderSwitchCommand(
  magic: readonly string[],
  destination: string,
  rest: readonly string[],
  name: string,
  summaryPath: string,
): string {
  const parts: string[] = ['fnclaude', ...magic, destination, ...rest, '--name', name, `@${summaryPath}`];
  return parts.join(' ');
}
