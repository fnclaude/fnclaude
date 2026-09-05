/**
 * Load fnc's config from `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.*`.
 *
 * The file (specs/rhombus-rocks-config.md § "fnc config shape") looks like:
 *
 *   {
 *     "$schema": "https://json.schemastore.org/rhombus-rocks-fnclaude-config.json",
 *     "noOobe": true,
 *     "noopDir": "~/.config/rhombus.rocks/fnclaude/noop",
 *     "auto": { "tmux": "never", "handoff": "3", "spawnCommand": "…" },
 *     "claude": { "defaultArgs": ["--chrome"] },
 *     "exec": { "env": { "NAME": "value" } },
 *     "context": { "noticeThreshold": 0, "noticeTiers": [], "noticeRepeat": {…} }
 *   }
 *
 * Any of `config.{json,jsonc,toml,yaml}` is accepted — whichever exists first
 * in that order — and all four are parsed with `confbox` (unjs, zero deps).
 * Writers always emit JSON, because JSON's `$schema` key is the one form every
 * editor understands without extra setup.
 *
 * **No runtime schema validation** (owner's call, 2026-09-04). The schema
 * exists for editor completion and SchemaStore, not for gatekeeping. This
 * loader degrades PER FIELD: a wrong-shaped `auto` contributes nothing and
 * `context` still loads. The one exception is the notice ladder, which warns
 * about malformed entries (#331) because silently dropping them left the
 * writer no signal.
 *
 * Migration: when no file exists at the new location, the pre-restructure
 * `$XDG_CONFIG_HOME/fnclaude/config.toml` is read once and rewritten to
 * `<new dir>/config.json` (snake_case keys become camelCase). Failure to write
 * is not fatal — the values are still returned, and the next run tries again.
 */

import { extname, join } from 'node:path';

import type { IFileSystem } from '../ports/contracts';
import { NodeFileSystem } from '../ports/node-fs';
import {
  type NoticeLadderSpec,
  type NoticeRepeatSpec,
  type NoticeTierSpec,
  type PctThreshold,
  isNoticeLevel,
} from '../usage/context-monitor';
import {
  CONFIG_BASENAMES,
  type XdgEnv,
  fncConfigDir,
  fncConfigWritePath,
  legacyFncConfigPath,
} from './paths';
import { writeFncConfig } from './write';

export interface FnConfig {
  /**
   * `noOobe`. When falsy or absent — including the whole file being absent —
   * an interactive launch runs the first-run interview (`fnc install`).
   */
  noOobe: boolean;
  /**
   * `noopDir`. fnc's starting directory. `undefined` means "use the default"
   * (`$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop`); the caller expands `~`.
   */
  noopDir: string | undefined;
  /** `auto.tmux`: `never` | `always` | `worktree`. */
  autoTmux: string | undefined;
  /** `auto.handoff`: `never` | `ask` | seconds as a string. */
  autoHandoff: string | undefined;
  /**
   * `auto.spawnCommand`. Whitespace-tokenized launcher template consumed by
   * §8.3 (fnc_spawn_session). Placeholders: `{bin}`, `{dest}`, `{name}`,
   * `{summary}`. Empty/undefined means "fall back to $TMUX auto-detect, then
   * paste-flow".
   */
  autoSpawnCommand: string | undefined;
  /**
   * `claude.defaultArgs`. Appended to every claude launch. Claude Code has no
   * persistent setting for these, so fnc supplies the default.
   */
  claudeDefaultArgs: string[] | undefined;
  /**
   * `context.noticeThreshold`. Context size (in tokens) at which the launcher
   * injects a one-shot compaction notice (#170 part 2). `undefined` means "use
   * the built-in default". Non-positive or non-numeric degrades to undefined.
   */
  contextNoticeThreshold: number | undefined;
  /**
   * `context.noticeTiers` + `context.noticeRepeat`. The tiered escalation
   * ladder (#170 part 2). `undefined` means "no tier config present" (fall
   * through to `noticeThreshold` / the built-in default). An explicitly-empty
   * `noticeTiers: []` with no repeat yields `{ tiers: [] }` — a disabled
   * monitor. Each `at`/`every` is a positive number (absolute tokens) or an
   * `"NN%"` string (percentage of the derived auto-compact point, #332).
   */
  contextNoticeLadder: NoticeLadderSpec | undefined;
  /** `exec.env`. Extra environment for the claude child. */
  execEnv: Record<string, string> | undefined;
}

export interface LoadConfigArgs {
  env: XdgEnv;
  /**
   * Sink for config-validation warnings (#331) — malformed notice tier/repeat
   * entries emit here instead of being silently dropped. Defaults to
   * `console.warn` (stderr). Tests inject a capturing sink.
   */
  warn?: (message: string) => void;
  /**
   * Migration write seam. Defaults to the real {@link writeFncConfig}. A
   * failure here is swallowed: the migrated values are still returned.
   */
  write?: (path: string, patch: Record<string, unknown>) => void;
  /**
   * Read seam. Defaults to {@link NodeFileSystem}; a hermetic test injects an
   * in-memory filesystem. A read failure degrades to defaults, never throws.
   */
  fs?: IFileSystem;
}

const EMPTY: FnConfig = {
  noOobe: false,
  noopDir: undefined,
  autoTmux: undefined,
  autoHandoff: undefined,
  autoSpawnCommand: undefined,
  claudeDefaultArgs: undefined,
  contextNoticeThreshold: undefined,
  contextNoticeLadder: undefined,
  execEnv: undefined,
};

/**
 * First existing `config.{json,jsonc,toml,yaml}` in `dir`, or null. Mirrors
 * {@link findConfigFile} but reads through the injectable {@link IFileSystem}.
 */
function findConfigFileVia(fs: IFileSystem, dir: string): string | null {
  for (const base of CONFIG_BASENAMES) {
    const candidate = join(dir, base);
    if (fs.isFile(candidate)) return candidate;
  }
  return null;
}

/** Parse one config file by extension. Returns null on any read/parse failure. */
async function parseConfigFile(fs: IFileSystem, path: string): Promise<unknown> {
  let text: string;
  try {
    if (!fs.isFile(path)) return null;
    text = await fs.readText(path);
  } catch {
    return null;
  }
  const confbox = await import('confbox');
  try {
    switch (extname(path)) {
      case '.json':
        return confbox.parseJSON(text);
      case '.jsonc':
        return confbox.parseJSONC(text);
      case '.toml':
        return confbox.parseTOML(text);
      case '.yaml':
      case '.yml':
        return confbox.parseYAML(text);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export async function loadConfig(args: LoadConfigArgs): Promise<FnConfig> {
  const warn = args.warn ?? ((m: string): void => console.warn(m));
  const fs = args.fs ?? new NodeFileSystem();

  const found = findConfigFileVia(fs, fncConfigDir(args.env));
  if (found !== null) {
    const parsed = await parseConfigFile(fs, found);
    const root = asRecord(parsed);
    return root === null ? EMPTY : project(root, warn);
  }

  // Nothing at the new location — try the pre-restructure TOML once.
  const legacyPath = legacyFncConfigPath(args.env);
  const legacyParsed = await parseConfigFile(fs, legacyPath);
  const legacyRoot = asRecord(legacyParsed);
  if (legacyRoot === null) return EMPTY;

  const migrated = migrateLegacyShape(legacyRoot);
  const write = args.write ?? writeFncConfig;
  try {
    write(fncConfigWritePath(args.env), migrated);
  } catch {
    // Best-effort: a config we couldn't write is still a config we can use.
    // The next run finds the legacy file again and retries the migration.
  }
  return project(migrated, warn);
}

/** Narrow a parsed document into {@link FnConfig}, field by field. */
function project(root: Record<string, unknown>, warn: (m: string) => void): FnConfig {
  const auto = asRecord(root.auto) ?? {};
  const claude = asRecord(root.claude) ?? {};
  return {
    noOobe: root.noOobe === true,
    noopDir: pickString(root.noopDir),
    autoTmux: pickString(auto.tmux),
    autoHandoff: pickStringOrNumber(auto.handoff),
    autoSpawnCommand: pickString(auto.spawnCommand),
    claudeDefaultArgs: pickStringArray(claude.defaultArgs),
    contextNoticeThreshold: pickContextNoticeThreshold(root),
    contextNoticeLadder: pickContextNoticeLadder(root, warn),
    execEnv: pickExecEnv(root),
  };
}

/**
 * Translate the pre-restructure TOML shape into the new JSON shape.
 *
 * Only the keys fnc actually reads are translated; anything else in the old
 * file is carried across verbatim so a hand-added key isn't lost. The old
 * `[auto] spawn_command` and `[context] notice_*` snake_case names become
 * camelCase, matching the schema.
 */
export function migrateLegacyShape(legacy: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...legacy };

  const auto = asRecord(legacy.auto);
  if (auto !== null) {
    const nextAuto: Record<string, unknown> = { ...auto };
    delete nextAuto.spawn_command;
    if (auto.spawn_command !== undefined) nextAuto.spawnCommand = auto.spawn_command;
    out.auto = nextAuto;
  }

  const context = asRecord(legacy.context);
  if (context !== null) {
    const nextContext: Record<string, unknown> = { ...context };
    delete nextContext.notice_threshold;
    delete nextContext.notice_tiers;
    delete nextContext.notice_repeat;
    if (context.notice_threshold !== undefined) nextContext.noticeThreshold = context.notice_threshold;
    if (context.notice_tiers !== undefined) nextContext.noticeTiers = context.notice_tiers;
    if (context.notice_repeat !== undefined) nextContext.noticeRepeat = context.notice_repeat;
    out.context = nextContext;
  }

  // `[name]` (auto-name model/timeout) was never read by the launcher and has
  // no schema entry; it rides along under additionalProperties rather than
  // being dropped, so a user who set it doesn't silently lose it.
  return out;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function pickStringOrNumber(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function pickStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out;
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
 * Parse `context.noticeTiers` + `context.noticeRepeat` into a
 * {@link NoticeLadderSpec}. Returns undefined when NEITHER key is present, so
 * the resolver falls through to `noticeThreshold` / the built-in default. An
 * explicitly-empty `noticeTiers: []` (with no repeat) yields `{ tiers: [] }` —
 * a disabled monitor. Each `at`/`every` may be a positive number (absolute
 * tokens) or an `"NN%"` percentage (#332). Malformed entries are dropped BUT
 * emit a warning (#331) rather than vanishing silently; tiers are sorted
 * ascending and de-duplicated by threshold.
 */
function pickContextNoticeLadder(
  root: Record<string, unknown>,
  warn: (message: string) => void,
): NoticeLadderSpec | undefined {
  const ctx = asRecord(root.context);
  if (ctx === null) return undefined;

  const rawTiers = ctx.noticeTiers;
  const rawRepeat = ctx.noticeRepeat;
  const hasTiers = rawTiers !== undefined;
  const hasRepeat = rawRepeat !== undefined;
  if (!hasTiers && !hasRepeat) return undefined;

  const tiers: NoticeTierSpec[] = [];
  if (hasTiers && !Array.isArray(rawTiers)) {
    warn(
      `[fnclaude] config: context.noticeTiers must be an array of { at, level } objects (got ${typeof rawTiers}) — ignoring.`,
    );
  } else if (Array.isArray(rawTiers)) {
    const seen = new Set<string>();
    rawTiers.forEach((entry, i) => {
      const e = asRecord(entry);
      if (e === null) {
        warn(`[fnclaude] config: context.noticeTiers entry #${i + 1} is not an object — ignoring.`);
        return;
      }
      const parsed = parseThresholdValue(e.at);
      if ('reason' in parsed) {
        warn(`[fnclaude] config: context.noticeTiers entry #${i + 1} has invalid \`at\` (${parsed.reason}) — ignoring.`);
        return;
      }
      if (!isNoticeLevel(e.level)) {
        warn(
          `[fnclaude] config: context.noticeTiers entry #${i + 1} has invalid \`level\` (${JSON.stringify(e.level)}); expected one of consider|plan|now|urgent — ignoring.`,
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
    const r = asRecord(rawRepeat);
    if (r === null) {
      warn(
        `[fnclaude] config: context.noticeRepeat must be an object { every, level } (got ${Array.isArray(rawRepeat) ? 'array' : typeof rawRepeat}) — ignoring.`,
      );
    } else {
      const parsed = parseThresholdValue(r.every);
      if ('reason' in parsed) {
        warn(`[fnclaude] config: context.noticeRepeat has invalid \`every\` (${parsed.reason}) — ignoring.`);
      } else if (!isNoticeLevel(r.level)) {
        warn(
          `[fnclaude] config: context.noticeRepeat has invalid \`level\` (${JSON.stringify(r.level)}); expected one of consider|plan|now|urgent — ignoring.`,
        );
      } else {
        repeat = { every: parsed.value, level: r.level };
      }
    }
  }

  return repeat === undefined ? { tiers } : { tiers, repeat };
}

function pickContextNoticeThreshold(root: Record<string, unknown>): number | undefined {
  const ctx = asRecord(root.context);
  if (ctx === null) return undefined;
  const v = ctx.noticeThreshold;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

function pickExecEnv(root: Record<string, unknown>): Record<string, string> | undefined {
  const exec = asRecord(root.exec);
  if (exec === null) return undefined;
  const env = asRecord(exec.env);
  if (env === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
