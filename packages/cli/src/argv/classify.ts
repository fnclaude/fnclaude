/**
 * Token classification. Pure functions over a single argv token.
 *
 * The Go canonical does this inline inside its argv loop; here it's
 * lifted out as a pure function so the magic-positional state machine
 * (§2.3) and short-flag expander (§4.5) can share the same classifier
 * without restating the alphabets.
 *
 * Case-sensitive on the magic words — `Opus`, `OPUS`, etc. are positionals.
 * Matches Go canonical, which does exact string comparison against
 * lowercase literals.
 */

export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode'] as const;

export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  opus5: 'claude-opus-5',
  opus46: 'claude-opus-4-6',
  sonnet5: 'claude-sonnet-5',
  fable5: 'claude-fable-5',
  haiku45: 'claude-haiku-4-5-20251001',
});

export type BareModel = (typeof MODELS)[number];
export type ModelAlias = keyof typeof MODEL_ALIASES;
export type Model = BareModel | ModelAlias;
export type Effort = (typeof EFFORTS)[number];
export type CanonicalSubcommand = 'resume' | 'continue' | 'fork';

export const SUBCOMMAND_ALIASES: Readonly<Record<string, CanonicalSubcommand>> = Object.freeze({
  resume: 'resume',
  res: 'resume',
  continue: 'continue',
  con: 'continue',
  fork: 'fork',
  fk: 'fork',
});

const MODEL_SET = new Set<string>([...MODELS, ...Object.keys(MODEL_ALIASES)]);
const EFFORT_SET = new Set<string>(EFFORTS);

/** Bare names pass through; aliases resolve to the full model ID. */
export function resolveModel(tok: string): string {
  return MODEL_ALIASES[tok] ?? tok;
}

export type TokenKind = 'flag' | 'model' | 'effort' | 'subcommand' | 'positional';

export function classifyToken(tok: string): TokenKind {
  // Flag-shape check is first because tokens starting with `-` shouldn't
  // ever match a magic word alphabet (none start with `-`), and a leading
  // `-` is the cheapest possible discriminator.
  if (tok.startsWith('-')) return 'flag';
  if (MODEL_SET.has(tok)) return 'model';
  if (EFFORT_SET.has(tok)) return 'effort';
  if (tok in SUBCOMMAND_ALIASES) return 'subcommand';
  return 'positional';
}

export function canonicalSubcommand(tok: string): CanonicalSubcommand | null {
  return SUBCOMMAND_ALIASES[tok] ?? null;
}
