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
export type HandoffMode = 'never' | 'ask' | string; // or a non-negative integer-as-string

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
 * normalizeTmuxMode validates against the supported set and falls back to
 * "never" for anything else, emitting a stderr warning (except for the
 * empty-string case, which is the absent-value default path).
 */
export function normalizeTmuxMode(v: string): TmuxMode {
  if (v === 'never' || v === 'worktree') return v;
  if (v === '') return 'never';
  warn(
    `fnclaude: auto.tmux=${JSON.stringify(v)} is not a valid mode (use "never" or "worktree"), falling back to "never"`,
  );
  return 'never';
}

/**
 * normalizeHandoffMode validates against the supported set and falls back
 * to "ask" for anything else (with a stderr warning, except empty string).
 * Valid: "never", "ask", or a non-negative integer (as a string).
 */
export function normalizeHandoffMode(v: string): HandoffMode {
  if (v === 'never' || v === 'ask') return v;
  if (v === '') return 'ask';
  // Non-negative integer (no decimal, no unit).
  if (/^\d+$/.test(v)) return v;
  warn(
    `fnclaude: auto.handoff=${JSON.stringify(v)} is not a valid mode (use "never", "ask", or a non-negative integer), falling back to "ask"`,
  );
  return 'ask';
}

/**
 * parseDuration accepts a Go-style duration string (e.g., "3s", "150ms",
 * "1m30s") and returns the equivalent in milliseconds. Returns null on
 * parse failure. This is the same surface as Go's time.ParseDuration for
 * the config use-case (we don't need ns/us precision).
 */
export function parseDuration(s: string): number | null {
  if (!s) return null;
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
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return null; // gap between matches
    const num = parseFloat(m[1] as string);
    const unit = m[2] as string;
    if (!Number.isFinite(num) || num < 0) return null;
    total += num * (unitToMs[unit] as number);
    consumed = m.index + m[0].length;
    matched++;
  }
  if (matched === 0 || consumed !== s.length) return null;
  return total;
}

// Deferred stderr warnings — fnclaude collects these during config load
// and flushes them at a sensible time. Tests can clear/inspect this list.
export const deferredWarnings: string[] = [];

function warn(msg: string): void {
  deferredWarnings.push(msg);
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
 * loadConfig loads the configuration from the config file and environment
 * variables, merging over built-in defaults. Order of precedence:
 *
 *   env var > config file > built-in default
 *
 * A missing config file is not an error. A malformed config file queues a
 * warning and falls back to defaults.
 */
export function loadConfig(): Config {
  const cfg = defaultConfig();
  const path = configFilePath();

  if (existsSync(path)) {
    let raw: RawConfig | null = null;
    try {
      const body = readFileSync(path, 'utf8');
      raw = Bun.TOML.parse(body) as RawConfig;
    } catch (err) {
      warn(
        `fnclaude: config file ${path} is malformed, using defaults: ${(err as Error).message}`,
      );
      raw = null;
    }
    if (raw) {
      if (raw.name?.model) cfg.name.model = raw.name.model;
      if (raw.name?.timeout) {
        const d = parseDuration(raw.name.timeout);
        if (d !== null) {
          cfg.name.timeout = d;
        } else {
          warn(
            `fnclaude: invalid timeout ${JSON.stringify(raw.name.timeout)} in config, using default`,
          );
        }
      }
      if (typeof raw.name?.quiet_missing_api_key === 'boolean') {
        cfg.name.quietMissingAPIKey = raw.name.quiet_missing_api_key;
      }
      if (typeof raw.auto?.tmux === 'string' && raw.auto.tmux !== '') {
        cfg.auto.tmux = raw.auto.tmux as TmuxMode;
      }
      if (typeof raw.auto?.handoff === 'string' && raw.auto.handoff !== '') {
        cfg.auto.handoff = raw.auto.handoff;
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
    if (d !== null) {
      cfg.name.timeout = d;
    } else {
      warn(
        `fnclaude: invalid FNCLAUDE_NAME_TIMEOUT ${JSON.stringify(e.FNCLAUDE_NAME_TIMEOUT)}, using current value`,
      );
    }
  }
  if (e.FNCLAUDE_QUIET_MISSING_API_KEY) {
    cfg.name.quietMissingAPIKey = parseBoolEnv(e.FNCLAUDE_QUIET_MISSING_API_KEY);
  }
  if (e.FNCLAUDE_TMUX) cfg.auto.tmux = e.FNCLAUDE_TMUX as TmuxMode;
  if (e.FNCLAUDE_HANDOFF) cfg.auto.handoff = e.FNCLAUDE_HANDOFF;
  if (e.FNCLAUDE_SPAWN_COMMAND) cfg.auto.spawnCommand = e.FNCLAUDE_SPAWN_COMMAND;

  cfg.auto.tmux = normalizeTmuxMode(cfg.auto.tmux);
  cfg.auto.handoff = normalizeHandoffMode(cfg.auto.handoff);

  return cfg;
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
