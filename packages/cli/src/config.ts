// Port of src/config.go (fnclaude/fnclaude Go reference).
//
// Holds all fnclaude configuration, merged from defaults, the config file,
// and environment variables (env overrides config, config overrides built-in
// defaults).
//
// TOML parsing uses Bun's built-in `Bun.TOML.parse` — no external dependency.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from './errors.js';

/**
 * Resolve the user's home directory. Honors `$HOME` first (matches Go's
 * `os.UserHomeDir()` precedence on Unix), then falls back to `os.homedir()`.
 * Tests rely on being able to override HOME at runtime.
 */
function home(): string {
  return process.env.HOME ?? homedir();
}

// ── public types ───────────────────────────────────────────────────────────

export type TmuxMode = 'never' | 'worktree';
/**
 * `'never'`, `'ask'`, or a non-negative integer-as-string (e.g. `'5'`).
 *
 * The template-literal `${number}` variant narrows correctly: a bare
 * `string` would collapse the union, so runtime validation gates env-var
 * and config-file inputs into this type via `normalizeHandoffMode`.
 */
export type HandoffMode = 'never' | 'ask' | `${number}`;

export interface NameConfig {
  /** Model used for the noop name session. */
  model: string;
  /** Timeout for the noop name session, expressed in milliseconds. */
  timeout: number;
  /** When true, suppresses the missing-API-key startup warning. */
  quietMissingAPIKey: boolean;
}

export interface AutoConfig {
  /**
   * Auto-injection of --tmux. "never" or "worktree".
   * Anything else (including the deprecated "always") is normalized to
   * "never" with a stderr warning during config load.
   */
  tmux: TmuxMode;

  /**
   * Auto-handoff prompt mode. One of:
   *   "never" — never auto-switch; user pastes the rendered command.
   *   "ask"   — noop session asks; on yes, fnclaude relaunches.
   *   "<N>"   — non-negative integer; auto-switch after N seconds.
   * Invalid values normalize to "ask" with a stderr warning during load.
   */
  handoff: HandoffMode;

  /**
   * Launcher template used by fnc_spawn_session to open a sibling
   * fnclaude in a new window. Whitespace-tokenized into argv; tokens
   * are then placeholder-substituted before exec. Supported
   * placeholders: {bin}, {dest}, {name}, {summary}. Empty means
   * "auto-detect from environment, fall back to paste-flow".
   */
  spawnCommand: string;
}

export interface ExecConfig {
  /**
   * Additional environment variables to inject into the claude child's
   * environment, sourced from [exec.env] in the config file. Appended
   * AFTER os env when spawning claude — by exec last-wins semantics a
   * configured key beats any inherited value with the same name.
   */
  env: Record<string, string>;
}

export interface Config {
  name: NameConfig;
  auto: AutoConfig;
  exec: ExecConfig;
}

// ── defaults ───────────────────────────────────────────────────────────────

export function defaultConfig(): Config {
  return {
    name: {
      model: 'claude-haiku-4-5',
      timeout: 3_000, // 3s
      quietMissingAPIKey: false,
    },
    auto: {
      tmux: 'never',
      handoff: 'ask',
      spawnCommand: '',
    },
    exec: {
      env: {},
    },
  };
}

// ── config file path ───────────────────────────────────────────────────────

export function configFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home(), '.config');
  return join(base, 'fnclaude', 'config.toml');
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * parseBoolEnv returns true for "1", "true", "yes" (case-insensitive),
 * false for anything else.
 */
export function parseBoolEnv(v: string): boolean {
  switch (v.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true;
    default:
      return false;
  }
}

/**
 * Result of a normalize-mode call: the validated value plus an optional
 * warning describing any fallback that was applied. Callers thread the
 * warning into their own returned warnings list rather than mutating a
 * module-global sink.
 */
export interface NormalizeResult<T> {
  value: T;
  warning: string | undefined;
}

/**
 * normalizeTmuxMode validates against the supported set and falls back to
 * "never" for anything else, returning the fallback value and an optional
 * warning describing what was rejected (the empty-string case is the
 * absent-value default path and produces no warning).
 */
export function normalizeTmuxMode(v: string): NormalizeResult<TmuxMode> {
  if (v === 'never' || v === 'worktree') return { value: v, warning: undefined };
  if (v === '') return { value: 'never', warning: undefined };
  return {
    value: 'never',
    warning: `fnclaude: auto.tmux=${JSON.stringify(v)} is not a valid mode (use "never" or "worktree"), falling back to "never"`,
  };
}

/**
 * normalizeHandoffMode validates against the supported set and falls back
 * to "ask" for anything else (with an optional warning, except empty
 * string). Valid: "never", "ask", or a non-negative integer (as a string).
 */
export function normalizeHandoffMode(v: string): NormalizeResult<HandoffMode> {
  if (v === 'never' || v === 'ask') return { value: v, warning: undefined };
  if (v === '') return { value: 'ask', warning: undefined };
  // Non-negative integer (no decimal, no unit). The regex guarantees the
  // template-literal shape, which TS's type narrowing can't infer from a
  // .test() call alone — so assert it explicitly once.
  if (/^\d+$/.test(v)) return { value: v as `${number}`, warning: undefined };
  return {
    value: 'ask',
    warning: `fnclaude: auto.handoff=${JSON.stringify(v)} is not a valid mode (use "never", "ask", or a non-negative integer), falling back to "ask"`,
  };
}

/**
 * parseDuration accepts a Go-style duration string (e.g., "3s", "150ms",
 * "1m30s") and returns the equivalent in milliseconds. Returns undefined
 * on parse failure. This is the same surface as Go's time.ParseDuration
 * for the config use-case (we don't need ns/us precision).
 */
export function parseDuration(s: string): number | undefined {
  if (!s) return undefined;
  // Whole number with unit suffix(es).
  // Units: ns, us, µs, ms, s, m, h. (We support all common units.)
  const unitToMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    'µs': 1e-3,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const re = /([0-9]*\.?[0-9]+)(ns|us|µs|ms|s|m|h)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  // RegExp.exec returns null for "no match" — third-party API shape, kept
  // as null rather than coerced.
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return undefined; // gap between matches
    const num = parseFloat(m[1] as string);
    const unit = m[2] as string;
    if (!Number.isFinite(num) || num < 0) return undefined;
    total += num * (unitToMs[unit] as number);
    consumed = m.index + m[0].length;
    matched++;
  }
  if (matched === 0 || consumed !== s.length) return undefined;
  return total;
}

// ── raw TOML shape (mirrors the Go rawConfig) ──────────────────────────────

interface RawConfig {
  name?: {
    model?: string;
    timeout?: string;
    quiet_missing_api_key?: boolean;
  };
  auto?: {
    tmux?: string;
    handoff?: string;
    spawn_command?: string;
    // legacy keys (silently ignored): dangerously_skip_permissions, ide
    [k: string]: unknown;
  };
  exec?: {
    env?: Record<string, string>;
  };
  [k: string]: unknown;
}

// ── loadConfig ─────────────────────────────────────────────────────────────

/**
 * Result of `loadConfig` — the merged Config plus any non-fatal warnings
 * raised during the load (malformed file, invalid mode value, bogus
 * duration, etc.). The caller threads warnings into the deferred-flush
 * mechanism in `main.ts`; this module owns no global mutable state.
 */
export interface LoadConfigResult {
  config: Config;
  warnings: readonly string[];
}

/**
 * loadConfig loads the configuration from the config file and environment
 * variables, merging over built-in defaults. Order of precedence:
 *
 *   env var > config file > built-in default
 *
 * A missing config file is not an error. A malformed config file produces
 * a warning and falls back to defaults.
 */
export function loadConfig(): LoadConfigResult {
  const cfg = defaultConfig();
  const warnings: string[] = [];
  const path = configFilePath();

  const recordNormalize = <T>(
    r: NormalizeResult<T>,
    set: (v: T) => void,
  ): void => {
    set(r.value);
    if (r.warning !== undefined) warnings.push(r.warning);
  };

  if (existsSync(path)) {
    let raw: RawConfig | undefined;
    try {
      const body = readFileSync(path, 'utf8');
      raw = Bun.TOML.parse(body) as RawConfig;
    } catch (err) {
      warnings.push(
        `fnclaude: config file ${path} is malformed, using defaults: ${errorMessage(err)}`,
      );
      raw = undefined;
    }
    if (raw) {
      if (raw.name?.model) cfg.name.model = raw.name.model;
      if (raw.name?.timeout) {
        const d = parseDuration(raw.name.timeout);
        if (d !== undefined) {
          cfg.name.timeout = d;
        } else {
          warnings.push(
            `fnclaude: invalid timeout ${JSON.stringify(raw.name.timeout)} in config, using default`,
          );
        }
      }
      if (typeof raw.name?.quiet_missing_api_key === 'boolean') {
        cfg.name.quietMissingAPIKey = raw.name.quiet_missing_api_key;
      }
      if (typeof raw.auto?.tmux === 'string' && raw.auto.tmux !== '') {
        recordNormalize(normalizeTmuxMode(raw.auto.tmux), (v) => {
          cfg.auto.tmux = v;
        });
      }
      if (typeof raw.auto?.handoff === 'string' && raw.auto.handoff !== '') {
        recordNormalize(normalizeHandoffMode(raw.auto.handoff), (v) => {
          cfg.auto.handoff = v;
        });
      }
      if (
        typeof raw.auto?.spawn_command === 'string' &&
        raw.auto.spawn_command !== ''
      ) {
        cfg.auto.spawnCommand = raw.auto.spawn_command;
      }
      if (raw.exec?.env && Object.keys(raw.exec.env).length > 0) {
        cfg.exec.env = { ...raw.exec.env };
      }
    }
  }

  // Env-var overrides.
  const e = process.env;
  if (e.FNCLAUDE_NAME_MODEL) cfg.name.model = e.FNCLAUDE_NAME_MODEL;
  if (e.FNCLAUDE_NAME_TIMEOUT) {
    const d = parseDuration(e.FNCLAUDE_NAME_TIMEOUT);
    if (d !== undefined) {
      cfg.name.timeout = d;
    } else {
      warnings.push(
        `fnclaude: invalid FNCLAUDE_NAME_TIMEOUT ${JSON.stringify(e.FNCLAUDE_NAME_TIMEOUT)}, using current value`,
      );
    }
  }
  if (e.FNCLAUDE_QUIET_MISSING_API_KEY) {
    cfg.name.quietMissingAPIKey = parseBoolEnv(e.FNCLAUDE_QUIET_MISSING_API_KEY);
  }
  if (e.FNCLAUDE_TMUX) {
    recordNormalize(normalizeTmuxMode(e.FNCLAUDE_TMUX), (v) => {
      cfg.auto.tmux = v;
    });
  }
  if (e.FNCLAUDE_HANDOFF) {
    recordNormalize(normalizeHandoffMode(e.FNCLAUDE_HANDOFF), (v) => {
      cfg.auto.handoff = v;
    });
  }
  if (e.FNCLAUDE_SPAWN_COMMAND) cfg.auto.spawnCommand = e.FNCLAUDE_SPAWN_COMMAND;

  return { config: cfg, warnings };
}

// ── envFromConfig ─────────────────────────────────────────────────────────

/**
 * envFromConfig returns cfg.exec.env rendered as a sorted array of
 * "KEY=VALUE" strings, ready to append to the parent's env before
 * spawning claude. Sort order is deterministic so debug output is stable.
 *
 * Precedence rule: callers append this AFTER the inherited env; if the
 * spawning API resolves duplicate keys by last-wins (Node's
 * child_process.spawn does, since it accepts an object), a configured key
 * here overrides the inherited value of the same name when callers merge
 * appropriately.
 */
export function envFromConfig(cfg: Config): string[] {
  const env = cfg.exec?.env;
  if (!env) return [];
  const keys = Object.keys(env).sort();
  if (keys.length === 0) return [];
  return keys.map((k) => `${k}=${env[k]}`);
}
