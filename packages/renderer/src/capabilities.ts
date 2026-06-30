/**
 * Env-only terminal capability detection.
 *
 * A single source of truth for "what can this terminal do" so that every
 * renderer feature — OSC 8 hyperlinks (#285), inline images (#293), OSC 52
 * clipboard, and live theme notify (#294) — gates against one consistent
 * capability object instead of each sniffing its own subset of env vars.
 *
 * Detection is purely environment-variable based: no subprocess calls, no
 * write-and-read round-trips to the terminal (those — DA1 / XTGETTCAP /
 * OSC 11 probes — belong to #294 and are strictly additive; the surface
 * here stays the same when they land). That makes this module a pure
 * function of its env argument and fully unit-testable.
 *
 * Conservative throughout: an unrecognized terminal degrades rather than
 * assuming support (all booleans false, images `none`, color `16`).
 *
 * Capability matrix sourced from
 * docs/reverse-engineering/claude-code-terminal-tricks.md.
 */

/** A read-only view of the process environment. */
export type Env = Record<string, string | undefined>;

/** Inline-image protocol, best-first per the degradation cascade. */
export type ImageProtocol = "kitty" | "iterm2" | "half-block" | "none";

/** Detected color depth. */
export type ColorLevel = "truecolor" | "256" | "16" | "none";

export interface TerminalCapabilities {
  /** OSC 8 hyperlinks are safe to emit. */
  hyperlinks: boolean;
  /** Best available inline-image protocol. */
  images: ImageProtocol;
  /** OSC 52 clipboard writes are safe. */
  clipboard: boolean;
  /** DEC private mode 2031 live theme-change reports are supported. */
  themeNotify: boolean;
  /** Color depth, after NO_COLOR / FORCE_COLOR overrides. */
  color: ColorLevel;
}

/** `TERM_PROGRAM` values we recognize. */
const TERM_PROGRAM = {
  appleTerminal: "Apple_Terminal",
  ghostty: "ghostty",
  iterm: "iTerm.app",
  vscode: "vscode",
  wezterm: "WezTerm",
} as const;

/**
 * An env var is "present" when set to a non-empty string. Per the
 * no-color.org spec an empty value does not count, and most presence
 * probes (KITTY_WINDOW_ID, WT_SESSION, …) are only meaningful non-empty.
 */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** True when any `GHOSTTY*` var is set (resources dir, bin dir, …). */
function hasGhosttyVar(env: Env): boolean {
  for (const key in env) {
    if (key.startsWith("GHOSTTY") && present(env[key])) return true;
  }
  return false;
}

/** Major version from a `TERM_PROGRAM_VERSION` string, or 0 if unparseable. */
function majorVersion(value: string | undefined): number {
  const match = /^(\d+)/.exec(value ?? "");
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Map a `FORCE_COLOR` value to a level, or `null` when unrecognized (caller
 * falls through to normal detection). Mirrors the de-facto chalk semantics:
 * `0`/`false` disables, `''`/`1`/`true` is basic, `2` is 256, `3` is
 * truecolor. Use it to force color on when ordinary detection would
 * otherwise disable it (the "override upward" case).
 */
function forceColorLevel(value: string): ColorLevel | null {
  switch (value) {
    case "0":
    case "false":
      return "none";
    case "":
    case "1":
    case "true":
      return "16";
    case "2":
      return "256";
    case "3":
    case "truecolor":
      return "truecolor";
    default:
      return null;
  }
}

function detectColor(env: Env): ColorLevel {
  if (env.FORCE_COLOR !== undefined) {
    const forced = forceColorLevel(env.FORCE_COLOR);
    if (forced !== null) return forced;
  }

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";

  switch (env.TERM_PROGRAM) {
    case TERM_PROGRAM.iterm:
    case TERM_PROGRAM.ghostty:
    case TERM_PROGRAM.wezterm:
    case TERM_PROGRAM.vscode:
      return "truecolor";
  }

  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  if (term.includes("256")) return "256";
  // Unknown-but-present (or unset) terminal: assume basic 16-color.
  return "16";
}

function detectImages(env: Env, color: ColorLevel): ImageProtocol {
  // No color at all (NO_COLOR / FORCE_COLOR=0 / dumb) means no image
  // rendering — graphics protocols and half-block alike need a color plane.
  if (color === "none") return "none";

  // Kitty graphics protocol: native kitty, ghostty, and WezTerm.
  if (
    present(env.KITTY_WINDOW_ID) ||
    env.TERM_PROGRAM === TERM_PROGRAM.ghostty ||
    env.TERM_PROGRAM === TERM_PROGRAM.wezterm ||
    hasGhosttyVar(env)
  ) {
    return "kitty";
  }

  // iTerm2 inline images, version-gated: < 3 has no inline-image support.
  if (
    env.TERM_PROGRAM === TERM_PROGRAM.iterm &&
    majorVersion(env.TERM_PROGRAM_VERSION) >= 3
  ) {
    return "iterm2";
  }

  // No graphics protocol: half-block needs color cells to work at all.
  if (color === "truecolor" || color === "256") return "half-block";
  return "none";
}

function detectHyperlinks(env: Env): boolean {
  if (present(env.FORCE_HYPERLINK) && env.FORCE_HYPERLINK !== "0") return true;

  switch (env.TERM_PROGRAM) {
    case TERM_PROGRAM.iterm:
    case TERM_PROGRAM.ghostty:
    case TERM_PROGRAM.wezterm:
    case TERM_PROGRAM.vscode:
      return true;
    // Apple_Terminal notably does NOT support OSC 8.
  }

  if (present(env.KITTY_WINDOW_ID) || hasGhosttyVar(env)) return true;
  if (present(env.WT_SESSION)) return true;
  if (present(env.KONSOLE_VERSION)) return true;
  // VTE gained OSC 8 support in 0.50.0 (VTE_VERSION 5000).
  if (majorVersion(env.VTE_VERSION) >= 5000) return true;

  return false;
}

function detectClipboard(env: Env): boolean {
  switch (env.TERM_PROGRAM) {
    case TERM_PROGRAM.iterm:
    case TERM_PROGRAM.ghostty:
    case TERM_PROGRAM.wezterm:
    case TERM_PROGRAM.vscode:
      return true;
  }

  if (present(env.KITTY_WINDOW_ID) || hasGhosttyVar(env)) return true;
  if (present(env.WT_SESSION)) return true;
  if (present(env.TMUX)) return true;

  return false;
}

function detectThemeNotify(env: Env): boolean {
  // DEC mode 2031: kitty, ghostty, WezTerm, and recent iTerm2.
  switch (env.TERM_PROGRAM) {
    case TERM_PROGRAM.iterm:
    case TERM_PROGRAM.ghostty:
    case TERM_PROGRAM.wezterm:
      return true;
  }

  if (present(env.KITTY_WINDOW_ID) || hasGhosttyVar(env)) return true;

  return false;
}

/**
 * Derive the full capability set from an env object. Pure: same input
 * always yields the same (frozen) output. Pass an explicit `env` in tests;
 * defaults to `process.env`.
 */
export function detectCapabilities(env: Env = process.env): TerminalCapabilities {
  // NO_COLOR (present, non-empty) suppresses all color output and, with it,
  // image rendering. It does not affect hyperlinks / clipboard / themeNotify.
  const noColor = present(env.NO_COLOR);
  const color = noColor ? "none" : detectColor(env);
  const images = noColor ? "none" : detectImages(env, color);

  return Object.freeze({
    hyperlinks: detectHyperlinks(env),
    images,
    clipboard: detectClipboard(env),
    themeNotify: detectThemeNotify(env),
    color,
  });
}

let cached: TerminalCapabilities | null = null;

/**
 * The process-wide capability set, computed once from `process.env` on
 * first call and memoized (the result is already frozen). Consumers that
 * need to detect against a specific env should call `detectCapabilities`
 * directly instead.
 */
export function terminalCapabilities(): TerminalCapabilities {
  if (cached === null) cached = detectCapabilities();
  return cached;
}
