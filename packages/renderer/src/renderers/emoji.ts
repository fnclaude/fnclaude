import { nameToEmoji } from "gemoji";

/**
 * GitHub-custom shortcodes that render as bespoke raster images on github.com
 * (`:shipit:` is a squirrel on a skateboard, `:octocat:` the mascot, etc.) and
 * therefore have NO entry in gemoji's Unicode dataset. A terminal can't show
 * those images, so each maps to the closest standard Unicode glyph — rendering
 * *something* recognizable beats leaking the literal `:shipit:` text.
 */
const GITHUB_CUSTOM: Record<string, string> = {
  shipit: "🐿️",
  octocat: "🐙",
  trollface: "👹",
  bowtie: "🤵",
  feelsgood: "😎",
  finnadie: "😈",
  goberserk: "😡",
  godmode: "😇",
  hurtrealbad: "😖",
  neckbeard: "🧔",
  rage1: "😠",
  rage2: "😡",
  rage3: "🤬",
  rage4: "👿",
  suspect: "🕵️",
};

// GitHub's emoji shortcode grammar: a run of letters, digits, `_`, `+`, `-`
// between two colons. Matching is case-sensitive (github.com renders `:rocket:`
// but not `:Rocket:`) — we look the captured name up literally.
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/**
 * Replace GitHub-style emoji shortcodes (`:rocket:` → 🚀) in a plain-text run.
 *
 * Pure string transform: unknown shortcodes (`:notareal:`) are left exactly as
 * written, matching github.com. Callers must apply this only to non-code,
 * non-link plain text — codespans and code blocks must never reach here.
 */
export function emojify(text: string): string {
  // Fast path: no colon means no possible shortcode.
  if (!text.includes(":")) return text;
  return text.replace(SHORTCODE_RE, (match, name: string) => {
    return nameToEmoji[name] ?? GITHUB_CUSTOM[name] ?? match;
  });
}
