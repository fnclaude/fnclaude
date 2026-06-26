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

import {
  type NoticeLadder,
  type NoticeRepeat,
  type NoticeTier,
  isNoticeLevel,
} from '../usage/context-monitor';

export interface FnConfig {
  autoTmux: string | undefined;
  autoHandoff: string | undefined;
  /**
   * `[auto] spawn_command`. Whitespace-tokenized launcher template
   * consumed by §8.3 (fnc_spawn_session). Supported placeholders:
   * `{bin}`, `{dest}`, `{name}`, `{summary}`. Empty/undefined means
   * "fall back to $TMUX auto-detect, then paste-flow".
   */
  autoSpawnCommand: string | undefined;
  /**
   * `[context] notice_threshold`. Context-size (in tokens) at which the
   * launcher injects a one-shot compaction notice into the live session
   * (#170 part 2). `undefined` means "use the built-in default"; the
   * monitor resolves the effective value. A non-positive or non-numeric
   * value degrades to undefined (defensive).
   */
  contextNoticeThreshold: number | undefined;
  /**
   * `[[context.notice_tiers]]` + `[context.notice_repeat]`. The tiered
   * escalation ladder for compaction notices (#170 part 2). `undefined`
   * means "no tier config present" (fall through to legacy
   * `notice_threshold` / built-in default). An explicitly-empty
   * `notice_tiers = []` with no repeat yields `{ tiers: [] }` — a disabled
   * monitor. Invalid tier/repeat entries are dropped defensively; tiers
   * are sorted ascending by `at` and de-duplicated. Precedence between
   * this and `notice_threshold` lives in `resolveContextNoticeLadder`.
   */
  contextNoticeLadder: NoticeLadder | undefined;
  execEnv: Record<string, string> | undefined;
}

export interface LoadConfigArgs {
  path: string;
}

const EMPTY: FnConfig = {
  autoTmux: undefined,
  autoHandoff: undefined,
  autoSpawnCommand: undefined,
  contextNoticeThreshold: undefined,
  contextNoticeLadder: undefined,
  execEnv: undefined,
};

export async function loadConfig(args: LoadConfigArgs): Promise<FnConfig> {
  let isFile = false;
  try {
    isFile = statSync(args.path).isFile();
  } catch {
    return EMPTY;
  }
  if (!isFile) return EMPTY;

  let parsed: unknown;
  try {
    const mod = await import(args.path, { with: { type: 'toml' } });
    parsed = (mod as { default?: unknown }).default;
  } catch {
    return EMPTY;
  }

  if (parsed === null || typeof parsed !== 'object') return EMPTY;
  const root = parsed as Record<string, unknown>;

  return {
    autoTmux: pickAutoTmux(root),
    autoHandoff: pickAutoHandoff(root),
    autoSpawnCommand: pickAutoSpawnCommand(root),
    contextNoticeThreshold: pickContextNoticeThreshold(root),
    contextNoticeLadder: pickContextNoticeLadder(root),
    execEnv: pickExecEnv(root),
  };
}

/**
 * Parse `[[context.notice_tiers]]` + `[context.notice_repeat]` into a
 * {@link NoticeLadder}. Returns undefined when NO tier config is present
 * (neither key under `[context]`), so the resolver falls through to the
 * legacy `notice_threshold` / built-in default. An explicitly-empty
 * `notice_tiers = []` (with no repeat) yields `{ tiers: [] }` — a disabled
 * monitor. Invalid tier/repeat entries are dropped; tiers are sorted
 * ascending by `at` and de-duplicated.
 */
function pickContextNoticeLadder(root: Record<string, unknown>): NoticeLadder | undefined {
  const context = root.context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const ctx = context as Record<string, unknown>;

  const rawTiers = ctx.notice_tiers;
  const rawRepeat = ctx.notice_repeat;
  const hasTiers = rawTiers !== undefined;
  const hasRepeat = rawRepeat !== undefined;
  if (!hasTiers && !hasRepeat) return undefined;

  const tiers: NoticeTier[] = [];
  if (Array.isArray(rawTiers)) {
    const seen = new Set<number>();
    for (const entry of rawTiers) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const at = e.at;
      const level = e.level;
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
      if (!isNoticeLevel(level)) continue;
      if (seen.has(at)) continue;
      seen.add(at);
      tiers.push({ at, level });
    }
    tiers.sort((a, b) => a.at - b.at);
  }

  let repeat: NoticeRepeat | undefined;
  if (rawRepeat !== null && typeof rawRepeat === 'object' && !Array.isArray(rawRepeat)) {
    const r = rawRepeat as Record<string, unknown>;
    const every = r.every;
    const level = r.level;
    if (typeof every === 'number' && Number.isFinite(every) && every > 0 && isNoticeLevel(level)) {
      repeat = { every, level };
    }
  }

  return repeat === undefined ? { tiers } : { tiers, repeat };
}

function pickContextNoticeThreshold(root: Record<string, unknown>): number | undefined {
  const context = root.context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const v = (context as Record<string, unknown>).notice_threshold;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

function pickAutoTmux(root: Record<string, unknown>): string | undefined {
  const auto = root.auto;
  if (auto === null || typeof auto !== 'object' || Array.isArray(auto)) return undefined;
  const v = (auto as Record<string, unknown>).tmux;
  return typeof v === 'string' ? v : undefined;
}

function pickAutoHandoff(root: Record<string, unknown>): string | undefined {
  const auto = root.auto;
  if (auto === null || typeof auto !== 'object' || Array.isArray(auto)) return undefined;
  const v = (auto as Record<string, unknown>).handoff;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function pickAutoSpawnCommand(root: Record<string, unknown>): string | undefined {
  const auto = root.auto;
  if (auto === null || typeof auto !== 'object' || Array.isArray(auto)) return undefined;
  const v = (auto as Record<string, unknown>).spawn_command;
  return typeof v === 'string' ? v : undefined;
}

function pickExecEnv(root: Record<string, unknown>): Record<string, string> | undefined {
  const exec = root.exec;
  if (exec === null || typeof exec !== 'object' || Array.isArray(exec)) return undefined;
  const env = (exec as Record<string, unknown>).env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
