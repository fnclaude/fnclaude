/**
 * Self-MCP `--mcp-config` injection (§7.4).
 *
 * Builds an inline JSON config that points claude at the fnclaude binary
 * as an MCP server, then appends `--mcp-config <json>` to the claude argv
 * the launcher is about to spawn. The subprocess claude spawns from this
 * config dials the parent over $FNC_SOCKET — see design.mcp.md §2.1.
 *
 * Wire shape (design.md §29, design.mcp.md §2.1):
 *
 *   {"mcpServers":{"fnclaude":{"command":"<bunExec>","args":["<fncBin>","mcp"]}}}
 *
 * Noop sessions add `"--noop"` to args. The Go canonical resolves the exe
 * path via `filepath.EvalSymlinks(os.Executable())`; the TS equivalent is
 * `realpathSync(process.argv[1] ?? '')` paired with `process.execPath` for
 * the runtime that will actually `exec` it. The two-element shape (bun +
 * script path, vs. a single bundled binary in Go) is necessary because
 * fnc.js is a script — claude spawning bare `<fncBin>` would invoke node,
 * not bun, and node can't run the bun-only main.ts.
 *
 * Gate: print mode (-p / --print) doesn't get the config — claude is being
 * driven non-interactively, no MCP tools would be useful. The launcher
 * also skips the call entirely on win32 where there's no listener.
 *
 * `--mcp-config` lands BEFORE the prompt-body `--` sentinel via
 * `insertFlagsBeforeSentinel`. Appending the pair at the tail when a `--`
 * is present would push the JSON into claude's prompt body — claude
 * would never see it as a flag and the MCP server would never register.
 * That regression shipped in cli 2.0.0; the helper centralises the fix.
 */

import { insertFlagsBeforeSentinel } from '../argv/sentinel';

export interface InjectMcpConfigArgs {
  claudeArgs: readonly string[];
  /** Path to the bun executable that will run the MCP subprocess (typically process.execPath). */
  bunExec: string;
  /** Absolute path to the fnc bin script (typically realpathSync(process.argv[1])). */
  fncBin: string;
  /** True when the launcher used the noop fallback; appends "--noop" to args. */
  noop: boolean;
  /** False for -p / --print sessions; skips injection per design.md §29 gate. */
  interactive: boolean;
  /**
   * Override the interactive gate. Renderer mode runs claude in `--print`
   * stream-json (so `interactive` is false), yet still needs the self-MCP
   * config so claude can dial fnc back over $FNC_SOCKET (spawn-args.md §2).
   * When true, inject regardless of `interactive`.
   */
  forceInject?: boolean;
}

export function injectMcpConfig(args: InjectMcpConfigArgs): string[] {
  // Gate per design.md §29: only interactive sessions get the config. The
  // renderer-mode `forceInject` override bypasses the gate (spawn-args.md §2).
  if (!args.interactive && args.forceInject !== true) return [...args.claudeArgs];
  // Bail out if the launcher couldn't resolve its own path. Without an
  // absolute fnc bin the spawned subprocess wouldn't be able to find
  // itself; better to skip than to inject a broken config.
  if (args.fncBin === '') return [...args.claudeArgs];

  const subprocessArgs: string[] = [args.fncBin, 'mcp'];
  if (args.noop) subprocessArgs.push('--noop');

  const config = {
    mcpServers: {
      fnclaude: {
        command: args.bunExec,
        args: subprocessArgs,
      },
    },
  };

  return insertFlagsBeforeSentinel(
    args.claudeArgs,
    '--mcp-config',
    JSON.stringify(config),
  );
}
