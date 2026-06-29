// Nerd Fonts MDI glyphs (nf-md-*) for rendering <kbd> keys.
// Codepoints from ryanoasis/nerd-fonts glyphnames.json, cross-verified vs
// Pictogrammers/MaterialDesign meta.json (2026-06-26).

export const KBD_MODIFIER = {
  control: "\u{f0634}",
  option: "\u{f0635}",
  shift: "\u{f0636}",
  command: "\u{f0633}",
} as const; // apple_keyboard_{control,option,shift,command} — ctrl/alt/shift/super

export const KBD_SYMBOL = {
  "-": "\u{f06f2}",
  "%": "\u{f1a03}",
  "+": "\u{f0704}",
  "#": "\u{f117f}",
  "*": "\u{f0a74}",
} as const; // {minus,percent,plus,pound,star}_box_outline

export const KBD_ALPHA = {
  a: "\u{f0beb}",
  b: "\u{f0bee}",
  c: "\u{f0bf1}",
  d: "\u{f0bf4}",
  e: "\u{f0bf7}",
  f: "\u{f0bfa}",
  g: "\u{f0bfd}",
  h: "\u{f0c00}",
  i: "\u{f0c03}",
  j: "\u{f0c06}",
  k: "\u{f0c09}",
  l: "\u{f0c0c}",
  m: "\u{f0c0f}",
  n: "\u{f0c12}",
  o: "\u{f0c15}",
  p: "\u{f0c18}",
  q: "\u{f0c1b}",
  r: "\u{f0c1e}",
  s: "\u{f0c21}",
  t: "\u{f0c24}",
  u: "\u{f0c27}",
  v: "\u{f0c2a}",
  w: "\u{f0c2d}",
  x: "\u{f0c30}",
  y: "\u{f0c33}",
  z: "\u{f0c36}",
} as const; // alpha_{a-z}_box_outline

export const KBD_NUMERIC = {
  "0": "\u{f03a3}",
  "1": "\u{f03a6}",
  "2": "\u{f03a9}",
  "3": "\u{f03ac}",
  "4": "\u{f03ae}",
  "5": "\u{f03b0}",
  "6": "\u{f03b5}",
  "7": "\u{f03b8}",
  "8": "\u{f03bb}",
  "9": "\u{f03be}",
} as const; // numeric_{0-9}_box_outline

export const KBD_ARROW = {
  up: "\u{f0739}",
  down: "\u{f0730}",
  left: "\u{f0733}",
  right: "\u{f0736}",
} as const; // arrow_{dir}_bold_box_outline

export const KBD_NAMED = {
  enter: "\u{f0311}",
  return: "\u{f0311}",
  tab: "\u{f0312}",
  esc: "\u{f12b7}",
  escape: "\u{f12b7}",
  space: "\u{f1050}",
  backspace: "\u{f030d}",
  caps: "\u{f030e}",
} as const; // keyboard_* named keys

export const KBD_FKEY = {
  f1: "\u{f12ab}",
  f2: "\u{f12ac}",
  f3: "\u{f12ad}",
  f4: "\u{f12ae}",
  f5: "\u{f12af}",
  f6: "\u{f12b0}",
  f7: "\u{f12b1}",
  f8: "\u{f12b2}",
  f9: "\u{f12b3}",
  f10: "\u{f12b4}",
  f11: "\u{f12b5}",
  f12: "\u{f12b6}",
} as const; // keyboard_f1..f12 (ceiling f12)

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: KBD_MODIFIER.control,
  control: KBD_MODIFIER.control,
  ctl: KBD_MODIFIER.control,
  alt: KBD_MODIFIER.option,
  opt: KBD_MODIFIER.option,
  option: KBD_MODIFIER.option,
  shift: KBD_MODIFIER.shift,
  super: KBD_MODIFIER.command,
  cmd: KBD_MODIFIER.command,
  command: KBD_MODIFIER.command,
  win: KBD_MODIFIER.command,
  meta: KBD_MODIFIER.command,
};

const NAMED_ALIASES: Record<string, string> = {
  enter: KBD_NAMED.enter,
  return: KBD_NAMED.return,
  tab: KBD_NAMED.tab,
  esc: KBD_NAMED.esc,
  escape: KBD_NAMED.escape,
  space: KBD_NAMED.space,
  spacebar: KBD_NAMED.space,
  backspace: KBD_NAMED.backspace,
  bksp: KBD_NAMED.backspace,
  caps: KBD_NAMED.caps,
  capslock: KBD_NAMED.caps,
};

const ARROW_ALIASES: Record<string, string> = {
  up: KBD_ARROW.up,
  down: KBD_ARROW.down,
  left: KBD_ARROW.left,
  right: KBD_ARROW.right,
  arrowup: KBD_ARROW.up,
  arrowdown: KBD_ARROW.down,
  arrowleft: KBD_ARROW.left,
  arrowright: KBD_ARROW.right,
};

/**
 * Map a single key token (e.g. "Ctrl", "C", "Enter", "F5", "+") to its NerdFont
 * glyph, or `undefined` when the token isn't a recognized key.
 */
export function mapKbdToken(token: string): string | undefined {
  if (token.length === 0) return undefined;
  const k = token.toLowerCase();
  if (k in MODIFIER_ALIASES) return MODIFIER_ALIASES[k];
  if (k in NAMED_ALIASES) return NAMED_ALIASES[k];
  if (k in ARROW_ALIASES) return ARROW_ALIASES[k];
  if (/^f([1-9]|1[0-2])$/.test(k)) return KBD_FKEY[k as keyof typeof KBD_FKEY];
  if (/^[a-z]$/.test(k)) return KBD_ALPHA[k as keyof typeof KBD_ALPHA];
  if (/^[0-9]$/.test(k)) return KBD_NUMERIC[k as keyof typeof KBD_NUMERIC];
  if (k in KBD_SYMBOL) return KBD_SYMBOL[k as keyof typeof KBD_SYMBOL];
  return undefined;
}

/**
 * Render the inner text of a `<kbd>` element as NerdFont glyph(s). Multi-key
 * chords joined with `+` (e.g. "Ctrl+C") map to one glyph per recognized
 * token; unrecognized tokens fall back to their literal text so nothing is
 * lost or crashes.
 */
export function kbdToGlyphs(text: string): string {
  const parts = text.split(/\s*\+\s*/);
  return parts.map((part) => mapKbdToken(part.trim()) ?? part).join("");
}
