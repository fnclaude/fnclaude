/**
 * Derive Claude Code's auto-compaction threshold for the active session (#332).
 *
 * Percentage context-notice tiers (`at = "94%"`) resolve against this derived
 * threshold: 100% = the exact token count at which Claude Code will
 * auto-compact, computed per active model / surface / env. Anchoring the
 * notice ladder to *proximity to auto-compact* (rather than raw window size)
 * is what lets one percentage config self-adjust across models and surfaces
 * with zero re-tuning — 94% is ~878k on a default 1M `cli` session and ~439k
 * on a 500k `local-agent` surface.
 *
 * ── Formula (reverse-engineered, Claude Code v2.1.200) ────────────────────
 * See specs/reverse-engineering/claude-code-autocompact-thresholds.md.
 *
 *   autoCompactThreshold = configuredWindow − offset
 *     offset = min(maxOutputTokens, 20000) + 13000   (= 33000 by default)
 *
 *   configuredWindow precedence (highest first):
 *     1. CLAUDE_CODE_AUTO_COMPACT_WINDOW  (env, tokens, clamp 100k–1M)
 *     2. settings.json autoCompactWindow  (int 1e5–1e6)
 *     3. CLAUDE_CODE_ENTRYPOINT = local-agent | remote_cowork  → 500,000
 *     4. per-model default: 1M-class model → 967,000; else → 200,000
 *     5. CLAUDE_CODE_DISABLE_1M_CONTEXT drops a 1M-class model to 200,000
 *
 * ── Versioned constants ───────────────────────────────────────────────────
 * The numeric constants (33000, 500000, 967000, 200000) are
 * Claude-Code-version-specific. The env knobs above ARE the manual override:
 * because fnclaude spawns claude with the same env, setting
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW moves BOTH claude's real behavior and
 * fnclaude's derived threshold in lockstep. (The settings.json
 * `autoCompactWindow` knob is honored by {@link deriveConfiguredWindow} when
 * supplied, but production currently wires only the env path — the env var is
 * the higher-precedence, self-consistent override.)
 */

/** 1M-class configured-window default (raw capability 1,000,000). */
const ONE_M_CONFIGURED_WINDOW = 967_000;
/** Non-extended / non-1M model window (the "200K boundary"). */
const NON_1M_CONFIGURED_WINDOW = 200_000;
/** `local-agent` / `remote_cowork` surface override. */
const SURFACE_CONFIGURED_WINDOW = 500_000;
/** Window when a 1M-class model runs with CLAUDE_CODE_DISABLE_1M_CONTEXT. */
const DISABLED_1M_WINDOW = 200_000;

/** Clamp bounds for the env / settings configured-window overrides. */
const WINDOW_CLAMP_MIN = 100_000;
const WINDOW_CLAMP_MAX = 1_000_000;

/** Output-reserve cap and the `compact` offset within the effective window. */
const OUTPUT_RESERVE_CAP = 20_000;
const COMPACT_OFFSET = 13_000;

/** Surfaces that force a 500,000 configured window regardless of model. */
const SURFACE_500K_ENTRYPOINTS: ReadonlySet<string> = new Set(['local-agent', 'remote_cowork']);

/**
 * Base model ids that are 1M-class by default (no `[1m]` suffix needed).
 * Kept intentionally small — only ids with direct evidence. Everything else
 * is treated as non-1M (fail-safe: notices fire a touch early rather than
 * never). Extend as new 1M-class generations are confirmed.
 */
const ONE_M_BASE_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-5']);

type Env = Record<string, string | undefined>;

function parsePositiveInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function clampWindow(n: number): number {
  return Math.min(Math.max(n, WINDOW_CLAMP_MIN), WINDOW_CLAMP_MAX);
}

/**
 * Strip a routing/variant `[...]` suffix and a trailing `-YYYYMMDD` snapshot
 * date from a model id, leaving the base id. `claude-sonnet-5-20260101` →
 * `claude-sonnet-5`; `claude-opus-4-8[1m]` → `claude-opus-4-8`.
 */
export function baseModelId(model: string): string {
  return model
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * True iff `model` is a 1M-context-class model: it carries the explicit
 * `[1m]` routing suffix, or its base id is a known 1M-class model.
 */
export function is1MClassModel(model: string): boolean {
  if (/\[1m\]$/i.test(model.trim())) return true;
  return ONE_M_BASE_MODELS.has(baseModelId(model));
}

export interface DeriveWindowArgs {
  /** Active model id (from the latest assistant turn). */
  model: string;
  /** Environment the claude child sees (childEnv), for the override knobs. */
  env: Env;
  /** settings.json `autoCompactWindow`, when known. Below the env var in precedence. */
  settingsAutoCompactWindow?: number;
}

/**
 * Resolve the configured context window for the active model/surface/env,
 * following Claude Code's own precedence. See the module header.
 */
export function deriveConfiguredWindow(args: DeriveWindowArgs): number {
  const { model, env } = args;

  const envWindow = parsePositiveInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (envWindow !== undefined) return clampWindow(envWindow);

  const settingsWindow = args.settingsAutoCompactWindow;
  if (settingsWindow !== undefined && Number.isFinite(settingsWindow) && settingsWindow > 0) {
    return clampWindow(Math.floor(settingsWindow));
  }

  const entrypoint = (env.CLAUDE_CODE_ENTRYPOINT ?? '').trim();
  if (SURFACE_500K_ENTRYPOINTS.has(entrypoint)) return SURFACE_CONFIGURED_WINDOW;

  if (is1MClassModel(model)) {
    const disable1m = env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    if (disable1m !== undefined && disable1m !== '' && disable1m !== '0' && disable1m !== 'false') {
      return DISABLED_1M_WINDOW;
    }
    return ONE_M_CONFIGURED_WINDOW;
  }

  return NON_1M_CONFIGURED_WINDOW;
}

/**
 * The auto-compact threshold (= 100% for percentage tiers): the token count
 * at which Claude Code auto-compacts, = configuredWindow − offset, where
 * offset = min(maxOutputTokens, 20000) + 13000.
 */
export function deriveAutoCompactThreshold(args: DeriveWindowArgs): number {
  const window = deriveConfiguredWindow(args);
  const maxOut = parsePositiveInt(args.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) ?? OUTPUT_RESERVE_CAP;
  const offset = Math.min(maxOut, OUTPUT_RESERVE_CAP) + COMPACT_OFFSET;
  return window - offset;
}

/**
 * Resolve a percentage (e.g. `94`, `2.5`) into an absolute token count against
 * a derived auto-compact `threshold`. NOT clamped above 100% — when
 * auto-compact is disabled, usage climbs past the compact point and tiers
 * above 100% stay meaningful.
 */
export function resolvePctToTokens(pct: number, threshold: number): number {
  return Math.round((pct / 100) * threshold);
}
