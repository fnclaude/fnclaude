/**
 * §8.3 — `fnc_spawn_session` handler.
 *
 * Spec (design.mcp.md §4.3 + spawn.go + socket_listener.go.handleSpawn):
 *
 *   - Required args: `destination`, `name`, `summary`. **No `session_id`** —
 *     spawn starts fresh, with no preservation of flags or session state.
 *   - Optional args: override fields (model / effort / permission_mode /
 *     allowed_tools / agent / brief / chrome / ide / verbose).
 *
 * Algorithm:
 *
 *   1. Validate required args. Missing/empty → ActionError.
 *   2. Write `summary` to a unique 0600 file under XDG_RUNTIME_DIR.
 *   3. Build override args from `applyOverrides([], req)`. No preservation
 *      → only override-derived flag tokens appear. Result feeds the spawn
 *      template's surrounding context AND the paste-flow command string.
 *   4. Build the cleaned env (`cleanEnvForSpawn` strips FNC_SOCKET,
 *      FNCLAUDE_HANDOFF, CLAUDE_CODE_SESSION_ID).
 *   5. Decide launcher: `auto.spawnCommand` → `$TMUX` → paste-flow.
 *   6. On launcher success → ActionDone. On no-launcher → ActionPasteFlow
 *      + clipboard write of the rendered relaunch command.
 *
 * Unlike §8.1 (restart) and §8.2 (switch), spawn NEVER stashes argv or
 * fires the handoff trigger — the current session keeps running. The
 * spawned sibling is its own independent fnclaude (own socket, own MCP
 * env, own claude). design.mcp.md §4.3.
 *
 * Wire-protocol contract: returns a `WireResponse`. The handler never
 * throws — internal failures (launcher errors, file-write errors,
 * missing args) flow back as `{ action: 'error', error }`.
 *
 * Dependencies are injected via `createSpawnHandler` so tests can
 * exercise the algorithm without touching real launchers, real
 * clipboards, or real summary files. Production wiring in main.ts
 * spreads the deps from the parent's runtime context.
 */

import {
  applyOverrides,
  type OverrideRequest,
} from '../../argv/preserve-args';
import { cleanEnvForSpawn } from '../../handoff/clean-env';
import {
  chooseAndSpawn,
  defaultSpawn,
  renderSpawnCommand,
  type SpawnFn,
} from '../../handoff/spawn-launcher';
import { writeSummaryFile } from '../../handoff/summary-file';
import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';

export interface SpawnHandlerConfig {
  /** `cfg.auto.spawnCommand` — undefined or empty = "not configured". */
  autoSpawnCommand?: string | undefined;
}

export interface SpawnHandlerDeps {
  config: SpawnHandlerConfig;
  /** Env source (test seam). Production passes `process.env`. */
  processEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Absolute fnclaude bin path for `{bin}` substitution. */
  fncBinPath: string;
  /**
   * Override the launcher spawner (test seam). Production omits this and
   * gets `defaultSpawn` (a thin `Bun.spawn` adapter).
   */
  spawnLauncher?: SpawnFn;
  /**
   * Handler used for paste-flow fallback to put the rendered relaunch
   * command on the clipboard. Same signature as §8.4's `handleCopyToClipboard`.
   * Production wires §8.4's handler here; tests inject a stub.
   */
  handleCopyToClipboard?: (req: WireRequest) => Promise<WireResponse>;
  /**
   * Override the summary-file writer (test seam). Production omits this
   * and gets the real `writeSummaryFile`.
   */
  writeSummaryFile?: (args: { content: string }) => Promise<string>;
}

/**
 * Build the spawn dispatch handler with injected deps. Returns a
 * `ParentDispatchHandler` (the shape `createParentDispatcher` expects).
 */
export function createSpawnHandler(deps: SpawnHandlerDeps): ParentDispatchHandler {
  const spawnFn = deps.spawnLauncher ?? defaultSpawn;
  const copyHandler = deps.handleCopyToClipboard;
  const writeSummary =
    deps.writeSummaryFile ?? ((args: { content: string }) => writeSummaryFile({ content: args.content }));

  return async (req: WireRequest): Promise<WireResponse> => {
    // 1. Validate required args.
    const dest = typeof req.destination === 'string' ? req.destination : '';
    const name = typeof req.name === 'string' ? req.name : '';
    const summary = typeof req.summary === 'string' ? req.summary : '';

    if (dest === '') {
      return errorResponse('spawn requires a destination');
    }
    if (name === '') {
      return errorResponse('spawn requires a name');
    }
    if (summary === '') {
      return errorResponse('spawn requires a summary');
    }

    // 2. Persist the summary to disk.
    let summaryPath: string;
    try {
      summaryPath = await writeSummary({ content: summary });
    } catch (err) {
      return errorResponse(`write summary: ${(err as Error).message}`);
    }

    // 3. Build the override flag tokens. No preservation — spawn is a
    // fresh start, so the input slice is empty and `applyOverrides`
    // emits ONLY override-derived flags.
    const extraArgs = applyOverrides([], extractOverrides(req));

    // 4. Build the cleaned spawn env.
    const spawnEnv = cleanEnvForSpawn(deps.processEnv);

    // 5. Pick launcher and dispatch.
    let result: ReturnType<typeof chooseAndSpawn>;
    try {
      result = chooseAndSpawn({
        autoSpawnCommand: deps.config.autoSpawnCommand ?? '',
        env: deps.processEnv,
        spawnEnv,
        fncBin: deps.fncBinPath,
        dest,
        name,
        summary: summaryPath,
        extraArgs,
        spawn: spawnFn,
      });
    } catch (err) {
      return errorResponse(`spawn: ${(err as Error).message}`);
    }

    if (result.ok) {
      return {
        action: 'done',
        message: `Spawned sibling fnclaude for ${dest} in a new window.`,
      };
    }

    // 6. No launcher resolved — paste-flow fallback. Surface the
    // auto.spawnCommand config knob so users in unrecognized terminals
    // discover the customization point without reading source.
    const command = renderSpawnCommand({
      dest,
      name,
      summary: summaryPath,
      extraArgs,
    });
    const clipboardOk = await tryCopyToClipboard(copyHandler, command);
    const message = clipboardOk
      ? 'No spawn launcher configured for this terminal — the relaunch command is on your clipboard; paste it into a new terminal window. Set `auto.spawnCommand` in ~/.config/fnclaude/config.toml to enable auto-spawn (use {bin}, {dest}, {name}, {summary} placeholders).'
      : 'No spawn launcher configured for this terminal — copy this command and run it in a new terminal window. Set `auto.spawnCommand` in ~/.config/fnclaude/config.toml to enable auto-spawn (use {bin}, {dest}, {name}, {summary} placeholders):';

    return {
      action: 'paste_flow',
      message,
      command,
      clipboard_ok: clipboardOk,
    };
  };
}

function errorResponse(error: string): WireResponse {
  return { action: 'error', error };
}

/**
 * Pull the override fields off the request envelope and shape them as
 * an `OverrideRequest` for `applyOverrides`. Non-string / non-bool
 * values are ignored — the wire is loose by design (§7.6) and any
 * caller writing the wrong type per field gets the "preserve" branch.
 */
function extractOverrides(req: WireRequest): OverrideRequest {
  const out: OverrideRequest = {};
  if (typeof req.model === 'string' && req.model !== '') out.model = req.model;
  if (typeof req.effort === 'string' && req.effort !== '') out.effort = req.effort;
  if (typeof req.permission_mode === 'string' && req.permission_mode !== '') {
    out.permissionMode = req.permission_mode;
  }
  if (typeof req.allowed_tools === 'string' && req.allowed_tools !== '') {
    out.allowedTools = req.allowed_tools;
  }
  if (typeof req.agent === 'string' && req.agent !== '') out.agent = req.agent;
  if (typeof req.brief === 'boolean') out.brief = req.brief;
  if (typeof req.chrome === 'boolean') out.chrome = req.chrome;
  if (typeof req.ide === 'boolean') out.ide = req.ide;
  if (typeof req.verbose === 'boolean') out.verbose = req.verbose;
  return out;
}

/**
 * Best-effort clipboard write for paste-flow Responses. Routes the
 * command string through the injected §8.4 handler. Any failure
 * (no handler injected, handler returns non-`done`, handler throws)
 * collapses to `false` — the response still surfaces, claude just
 * tells the user to copy manually.
 */
async function tryCopyToClipboard(
  copyHandler: ((req: WireRequest) => Promise<WireResponse>) | undefined,
  text: string,
): Promise<boolean> {
  if (copyHandler === undefined) return false;
  try {
    const r = await copyHandler({ op: 'copy_to_clipboard', text });
    return r.clipboard_ok === true;
  } catch {
    return false;
  }
}
