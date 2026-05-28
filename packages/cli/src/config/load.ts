/**
 * Load fnclaude's config.toml.
 *
 * The full config (per prd.launcher.md "Config file") looks like:
 *
 *   [name]
 *   model = "claude-haiku-4-5"
 *   timeout = "3s"
 *
 *   [auto]
 *   tmux = "never"      # or "worktree"
 *   handoff = "ask"
 *   spawn_command = ""
 *
 *   [exec.env]
 *   MY_VAR = "value"
 *
 * Only fields fnclaude actively uses are surfaced on FnConfig today.
 * Others land as they're wired into the launch pipeline.
 *
 * Robustness: missing file / non-file at path / malformed TOML all
 * degrade silently to defaults (all-undefined). Caller checks each
 * field for undefined.
 *
 * Bun supports `import(path, { with: { type: 'toml' } })` natively, so
 * no third-party TOML parser dependency.
 */

import { statSync } from 'node:fs';

export interface FnConfig {
  autoTmux: string | undefined;
}

export interface LoadConfigArgs {
  path: string;
}

export async function loadConfig(args: LoadConfigArgs): Promise<FnConfig> {
  let isFile = false;
  try {
    isFile = statSync(args.path).isFile();
  } catch {
    return { autoTmux: undefined };
  }
  if (!isFile) return { autoTmux: undefined };

  let parsed: unknown;
  try {
    const mod = await import(args.path, { with: { type: 'toml' } });
    parsed = (mod as { default?: unknown }).default;
  } catch {
    return { autoTmux: undefined };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { autoTmux: undefined };
  }

  const auto = (parsed as Record<string, unknown>).auto;
  let autoTmux: string | undefined;
  if (auto !== null && typeof auto === 'object' && !Array.isArray(auto)) {
    const v = (auto as Record<string, unknown>).tmux;
    if (typeof v === 'string') autoTmux = v;
  }

  return { autoTmux };
}
