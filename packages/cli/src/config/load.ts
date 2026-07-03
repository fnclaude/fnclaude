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
  type NoticeLadderSpec,
  type NoticeRepeatSpec,
  type NoticeTierSpec,
  type PctThreshold,
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
   * monitor. Each `at`/`every` is either a bare integer (absolute tokens) or a
   * quoted `"NN%"` percentage of the derived auto-compact point (#332).
   * Malformed tier/repeat entries are dropped BUT surface a warning (#331) —
   * silent discarding gave the writer no signal. Precedence between this and
   * `notice_threshold` lives in `resolveContextNoticeLadder`.
   */
  contextNoticeLadder: NoticeLadderSpec | undefined;
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
 * Parse one `at`/`every` threshold value: a bare positive finite number
 * (absolute tokens) OR a quoted `"NN%"` string → {@link PctThreshold}. `%`
 * values are NOT capped above 100% (auto-compact-disabled sessions climb past
 * the wall, #332). Returns `undefined` for anything invalid, with `reason`
 * describing why (for the caller's warning).
 */
function parseThresholdValue(v: unknown): { value: number | PctThreshold } | { reason: string } {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return { reason: `numeric threshold must be positive, got ${v}` };
    return { value: v };
  }
  if (typeof v === 'string') {
    const m = /^\s*([0-9]*\.?[0-9]+)\s*%\s*$/.exec(v);
    if (m === null) return { reason: `string threshold must be an "NN%" percentage, got ${JSON.stringify(v)}` };
    const pct = Number(m[1]);
    if (!Number.isFinite(pct) || pct <= 0) return { reason: `percentage must be positive, got ${JSON.stringify(v)}` };
    return { value: { pct } };
  }
  return { reason: `threshold must be a number or "NN%" string, got ${typeof v}` };
}

/** Sort/dedup key for a threshold value (absolute vs percent kept distinct). */
function thresholdKey(v: number | PctThreshold): string {
  return typeof v === 'number' ? `abs:${v}` : `pct:${v.pct}`;
}

/** Numeric sort key: absolute by tokens, percent by its number. */
function thresholdSortKey(v: number | PctThreshold): number {
  return typeof v === 'number' ? v : v.pct;
}

/**
 * Parse `[[context.notice_tiers]]` + `[context.notice_repeat]` into a
 * {@link NoticeLadderSpec}. Returns undefined when NO tier config is present
 * (neither key under `[context]`), so the resolver falls through to the
 * legacy `notice_threshold` / built-in default. An explicitly-empty
 * `notice_tiers = []` (with no repeat) yields `{ tiers: [] }` — a disabled
 * monitor. Each `at`/`every` may be a bare integer (absolute tokens) or a
 * quoted `"NN%"` percentage (#332). Malformed entries are dropped BUT emit a
 * warning via `warn` (#331) rather than vanishing silently; tiers are sorted
 * ascending and de-duplicated by threshold.
 */
function pickContextNoticeLadder(
  root: Record<string, unknown>,
  warn: (message: string) => void,
): NoticeLadderSpec | undefined {
  const context = root.context;
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return undefined;
  const ctx = context as Record<string, unknown>;

  const rawTiers = ctx.notice_tiers;
  const rawRepeat = ctx.notice_repeat;
  const hasTiers = rawTiers !== undefined;
  const hasRepeat = rawRepeat !== undefined;
  if (!hasTiers && !hasRepeat) return undefined;

  const tiers: NoticeTierSpec[] = [];
  if (hasTiers && !Array.isArray(rawTiers)) {
    warn(
      `[fnclaude] config: [[context.notice_tiers]] must be an array of { at, level } tables (got ${typeof rawTiers}) — ignoring.`,
    );
  } else if (Array.isArray(rawTiers)) {
    const seen = new Set<string>();
    rawTiers.forEach((entry, i) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        warn(`[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} is not a table — ignoring.`);
        return;
      }
      const e = entry as Record<string, unknown>;
      const parsed = parseThresholdValue(e.at);
      if ('reason' in parsed) {
        warn(`[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} has invalid \`at\` (${parsed.reason}) — ignoring.`);
        return;
      }
      if (!isNoticeLevel(e.level)) {
        warn(
          `[fnclaude] config: [[context.notice_tiers]] entry #${i + 1} has invalid \`level\` (${JSON.stringify(e.level)}); expected one of consider|plan|now|urgent — ignoring.`,
        );
        return;
      }
      const key = thresholdKey(parsed.value);
      if (seen.has(key)) return;
      seen.add(key);
      tiers.push({ at: parsed.value, level: e.level });
    });
    tiers.sort((a, b) => thresholdSortKey(a.at) - thresholdSortKey(b.at));
  }

  let repeat: NoticeRepeatSpec | undefined;
  if (hasRepeat) {
    if (rawRepeat === null || typeof rawRepeat !== 'object' || Array.isArray(rawRepeat)) {
      warn(
        `[fnclaude] config: [context.notice_repeat] must be a table { every, level } (got ${Array.isArray(rawRepeat) ? 'array' : typeof rawRepeat}) — ignoring. See the [context] section in the README.`,
      );
    } else {
      const r = rawRepeat as Record<string, unknown>;
      const parsed = parseThresholdValue(r.every);
      if ('reason' in parsed) {
        warn(`[fnclaude] config: [context.notice_repeat] has invalid \`every\` (${parsed.reason}) — ignoring.`);
      } else if (!isNoticeLevel(r.level)) {
        warn(
          `[fnclaude] config: [context.notice_repeat] has invalid \`level\` (${JSON.stringify(r.level)}); expected one of consider|plan|now|urgent — ignoring.`,
        );
      } else {
        repeat = { every: parsed.value, level: r.level };
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
