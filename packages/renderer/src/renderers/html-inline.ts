// Parsing helpers for raw inline HTML tags. `marked` emits inline HTML as a
// SPLIT token stream — an `html` token for each open tag, a `text` token for
// the content, and an `html` token for each close tag (e.g. `<kbd>` / `Ctrl` /
// `</kbd>`). The renderer groups that stream back into styled spans; these
// pure helpers classify a single tag so the grouping pass can decide whether to
// interpret it (native terminal rendering) or surface it as colored raw markup.

/** Void HTML elements that the renderer interprets natively. */
const VOID_INTERPRETED = new Set(["br", "hr"]);

/**
 * Container tags the renderer interprets by wrapping their (recursively
 * rendered) children — each name maps to a terminal-native treatment in the
 * renderer's grouping pass.
 */
export const INTERPRETED_CONTAINERS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "s",
  "strike",
  "del",
  "ins",
  "code",
  "tt",
  "samp",
  "var",
  "q",
  "mark",
  "kbd",
  "sub",
  "sup",
  "a",
]);

export interface ParsedHtmlTag {
  /** open container tag, its close, or a self-closing/void tag. */
  kind: "open" | "close" | "void";
  /** lowercased tag name, for matching. */
  name: string;
  /** the literal tag text exactly as authored, for raw-markup fallback. */
  raw: string;
  /** href attribute value, when present (anchors). */
  href?: string;
}

/**
 * Parse a single raw HTML tag token's text into its classification, or `null`
 * when the text isn't a single well-formed tag.
 */
export function parseHtmlTag(text: string): ParsedHtmlTag | null {
  const m = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)\s*>$/.exec(text.trim());
  if (m === null) return null;
  const closing = m[1] === "/";
  const name = m[2].toLowerCase();
  const attrs = m[3] ?? "";
  const selfClose = m[4] === "/";

  let kind: ParsedHtmlTag["kind"];
  if (closing) kind = "close";
  else if (selfClose || VOID_INTERPRETED.has(name)) kind = "void";
  else kind = "open";

  const tag: ParsedHtmlTag = { kind, name, raw: text };
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  if (hrefMatch) tag.href = hrefMatch[1] ?? hrefMatch[2];
  return tag;
}

/** Whether the renderer interprets this void tag (`br`, `hr`) natively. */
export function isInterpretedVoid(name: string): boolean {
  return VOID_INTERPRETED.has(name);
}
