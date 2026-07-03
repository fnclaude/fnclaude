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
   * monitor. Malformed tier/repeat entries are dropped BUT surface a warning
   * (#331) — silent discarding gave the writer no signal that a bare-number
   * `notice_repeat` never fires. Tiers are sorted ascending by `at` and
   * de-duplicated. Precedence between this and `notice_threshold` lives in
   * `resolveContextNoticeLadder`.
   */
  contextNoticeLadder: NoticeLadder | undefined;
  execEnv: Record<string, string> | undefined;
}

export interface LoadConfigArgs {
  path: string;
  /**
   * Sink for config-validation warnings (#331) — malformed notice tier/repeat
   * entries emit here instead of being silently dropped. Defaults to
   * `console.warn` (stderr). Tests inject a capturing sink.
   */
  warn?: (message: string) => void;
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
  const warn = args.warn ?? ((m: string): void => console.warn(m));
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
    contextNoticeLadder: pickContextNoticeLadder(root, warn),
    execEnv: pickExecEnv(root),
  };
}

/**
 * Parse `[[context.notice_tiers]]` + `[context.notice_repeat]` into a
 * {@link NoticeLadder}. Returns undefined when NO tier config is present
 * (neither key under `[context]`), so the resolver falls through to the
 * legacy `notice_threshold` / built-in default. An explicitly-empty
 * `notice_tiers = []` (with no repeat) yields `{ tiers: [] }` — a disabled
 * monitor. Malformed entries are dropped BUT emit a warning via `warn` (#331)
 * rather than vanishing silently (a bare-number `notice_repeat` that isn't a
 * `{ every, level }` table used to just never fire, with zero signal); tiers
 * are sorted ascending by `at` and de-duplicated.
 */
function pickContextNoticeLadder(
  root: Record<string, unknown>,
  warn: (message: string) => void,
): NoticeLadder | undefined {
  const context = root.context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const ctx = context as Record<string, unknown>;

  const rawTiers = ctx.notice_tiers;
  const rawRepeat = ctx.notice_repeat;
  const hasTiers = rawTiers !== undefined;
  const hasRepeat = rawRepeat !== undefined;
  if (!hasTiers && !hasRepeat) return undefined;

  const tiers: NoticeTier[] = [];
  if (hasTiers && !Array.isArray(rawTiers)) {
    warn(
      `[fnclaude] config: [[context.notice_tiers]] must be an array of { at, level } tables (got ${typeof rawTiers}) — ignoring.`,
    );
  } else if (Array.isArray(rawTiers)) {
    const seen = new Set<number>();
    rawTiers.forEach((entry, i) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        warn(`[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} is not a table — ignoring.`);
        return;
      }
      const e = entry as Record<string, unknown>;
      const at = e.at;
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
        warn(
          `[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} has invalid \`at\` (expected a positive token count, got ${JSON.stringify(at)}) — ignoring.`,
        );
        return;
      }
      if (!isNoticeLevel(e.level)) {
        warn(
          `[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} has invalid \`level\` (${JSON.stringify(e.level)}); expected one of consider|plan|now|urgent — ignoring.`,
        );
        return;
      }
      if (seen.has(at)) return;
      seen.add(at);
      tiers.push({ at, level: e.level });
    });
    tiers.sort((a, b) => a.at - b.at);
  }

  let repeat: NoticeRepeat | undefined;
  if (hasRepeat) {
    if (rawRepeat === null || typeof rawRepeat !== 'object' || Array.isArray(rawRepeat)) {
      warn(
        `[fnclaude] config: [context.notice_repeat] must be a table { every, level } (got ${Array.isArray(rawRepeat) ? 'array' : typeof rawRepeat}) — ignoring. See the [context] section in the README.`,
      );
    } else {
      const r = rawRepeat as Record<string, unknown>;
      const every = r.every;
      if (typeof every !== 'number' || !Number.isFinite(every) || every <= 0) {
        warn(
          `[fnclaude] config: [context.notice_repeat] has invalid \`every\` (expected a positive token count, got ${JSON.stringify(every)}) — ignoring.`,
        );
      } else if (!isNoticeLevel(r.level)) {
        warn(
          `[fnclaude] config: [context.notice_repeat] has invalid \`level\` (${JSON.stringify(r.level)}); expected one of consider|plan|now|urgent — ignoring.`,
        );
      } else {
        repeat = { every, level: r.level };
      }
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
