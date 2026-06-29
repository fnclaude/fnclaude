import supportsHyperlinks from "supports-hyperlinks";

// OSC 8 hyperlinks let a terminal attach a real URL to arbitrary display text,
// so a titled markdown link `[text](url)` becomes clickable even when the
// visible text isn't the URL (the terminal's URL auto-matcher can't help there).
//
// We MUST use the BEL (`\x07`) terminator form, NOT the ESC-backslash (ST) form:
// Ink's ansi-tokenize only recognizes the BEL form, and only a recognized OSC
// sequence is tokenized as zero-width — which is what keeps table column
// measurement (TableBlock) unaffected by an embedded link.

/** OSC 8 opener: `\x1b]8;;<url>\x07`. Begins a hyperlink targeting `url`. */
export function osc8Start(url: string): string {
  return `\x1b]8;;${url}\x07`;
}

/** OSC 8 closer: `\x1b]8;;\x07`. Ends the current hyperlink. */
export function osc8End(): string {
  return "\x1b]8;;\x07";
}

/**
 * Wrap plain `text` in an OSC 8 hyperlink pointing at `url`, BEL-terminator form.
 * For styled link text (where SGR codes interleave the display text), emit
 * `osc8Start`/`osc8End` around the rendered content instead.
 */
export function osc8(url: string, text: string): string {
  return osc8Start(url) + text + osc8End();
}

// Test seam mirroring App's `testInputBus`: ink-testing-library renders to a
// string buffer (no real TTY), so detection can't be exercised through the
// component tree. An override lets tests force support on and off; `undefined`
// restores real detection.
let supportOverride: boolean | undefined;

/** Force hyperlink support on/off for tests; pass `undefined` to restore detection. */
export function setHyperlinkSupportOverride(value: boolean | undefined): void {
  supportOverride = value;
}

/** Whether the active output stream supports OSC 8 hyperlinks. */
export function supportsHyperlinkOutput(): boolean {
  if (supportOverride !== undefined) return supportOverride;
  return supportsHyperlinks.stdout;
}
