import { Text } from "ink";

/**
 * A glow-runner function: takes raw markdown, returns rendered output
 * (typically containing ANSI escapes from `glow -s dark`).
 *
 * Injectable so tests can avoid depending on glow being on PATH in CI.
 *   - `undefined` (omitted) → use the module default (detect + run glow if
 *      present; else pass markdown through unchanged).
 *   - `null`               → explicitly disable glow; render raw markdown.
 *   - `(md) => rendered`    → use the provided runner.
 */
export type GlowRunner = (markdown: string) => string;

export interface TextRendererProps {
  text: string;
  glow?: GlowRunner | null;
}

let cachedGlowPath: string | null | undefined;

/**
 * Detect glow on PATH via `which glow`. Memoized. Returns null if not
 * found. Synchronous (single subprocess at module load); never throws —
 * an unreachable binary just yields null.
 */
export function detectGlowPath(): string | null {
  if (cachedGlowPath !== undefined) return cachedGlowPath;
  try {
    const proc = Bun.spawnSync({ cmd: ["which", "glow"], stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode === 0) {
      const out = proc.stdout.toString().trim();
      cachedGlowPath = out.length > 0 ? out : null;
    } else {
      cachedGlowPath = null;
    }
  } catch {
    cachedGlowPath = null;
  }
  return cachedGlowPath;
}

/**
 * Run `glow -s dark` against the markdown. Returns the rendered output
 * (ANSI-styled); falls back to the raw input if glow exits non-zero.
 */
export function runGlow(markdown: string, glowPath: string): string {
  try {
    const proc = Bun.spawnSync({
      cmd: [glowPath, "-s", "dark"],
      stdin: new TextEncoder().encode(markdown),
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) return proc.stdout.toString();
  } catch {
    // fall through
  }
  return markdown;
}

/** The default runner used when the prop is omitted. */
const defaultGlowRunner: GlowRunner | null = (() => {
  const path = detectGlowPath();
  if (path === null) return null;
  return (md: string) => runGlow(md, path);
})();

/**
 * Renders an AssistantEvent.message.content[] TextBlock.
 *
 * Glow integration: if glow is on PATH at module init, pipes markdown
 * through `glow -s dark`; otherwise renders raw markdown. Ink's <Text>
 * passes ANSI escapes through unchanged, so glow's coloring survives.
 */
export function TextRenderer({ text, glow }: TextRendererProps): JSX.Element {
  const runner = glow === undefined ? defaultGlowRunner : glow;
  const rendered = runner ? runner(text) : text;
  return <Text>{rendered}</Text>;
}
