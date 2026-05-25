/**
 * Stage-typed argv pipeline.
 *
 * fnclaude's argv flows through five stages — parse, resolve, intercept,
 * auto-name, sanitize — before being handed to buildArgv. Earlier the
 * intermediate state was a single mutable `Args` bag passed through every
 * step, each free to rewrite any field. The pipeline's *ordering* was a
 * runtime invariant only: nothing stopped `buildArgv` from being called
 * before `applyWorktreeIntercept`, and `worktreeMatched` started life as a
 * placeholder boolean on the parsed shape, even though it has no meaningful
 * value until intercept has run.
 *
 * The new shape uses distinct types per stage. Each function takes its
 * predecessor's output type as input and returns the next stage's type.
 * The shapes are structurally readonly and brand-discriminated, so:
 *
 *   - `parseArgs` returns `ParsedArgs`, which has NO `worktreeMatched`
 *     field at all — the invariant "the intercept hasn't run yet" is
 *     encoded in the type, not a sentinel value.
 *   - `applyWorktreeIntercept` returns `InterceptedArgs`, which has
 *     `worktreeMatched` materialized. Passing a `ParsedArgs` to `buildArgv`
 *     is a compile error because `InterceptedArgs` is what `buildArgv`
 *     accepts.
 *   - Stages are immutable; each function returns a new value. The
 *     pipeline composes by value, not by aliased reference.
 *
 * The brand fields (`__stage`) only exist in the type system — they're
 * never assigned at runtime. The brand functions (`brandParsed` etc.) are
 * named casts that document the boundary at which the stage transition
 * happens.
 */

// ── Base shape ─────────────────────────────────────────────────────────────

/**
 * Fields every stage carries. All readonly: stage transitions produce new
 * objects, never mutate.
 */
export interface BaseArgs {
  /**
   * CWD is the directory claude will be launched in (first positional, or
   * the noop fallback when no positionals are given). The interpretation
   * narrows as stages progress — `ParsedArgs.cwd` is whatever the user
   * typed; later stages have it resolved to an absolute path and/or
   * swapped to a matched-worktree path.
   */
  readonly cwd: string;

  /**
   * ExtraDirs collects all -A / --also values in order. Positional 2 is the
   * worktree slot; -A is the only way to supply extra dirs.
   */
  readonly extraDirs: readonly string[];

  /**
   * Passthrough is everything else, preserved in order, to be forwarded to
   * claude verbatim. Short flags are already translated to their long
   * forms. Later stages may *extend* this slice (e.g. the intercept pushes
   * `--worktree <name>`, auto-name prepends `--name <name>`).
   */
  readonly passthrough: readonly string[];

  /**
   * NoTmux is true when the user passed --no-tmux (eaten by fnclaude; not
   * forwarded to claude).
   */
  readonly noTmux: boolean;

  /**
   * WorktreeSet is true when the user passed -w / --worktree, OR supplied
   * a 2nd positional after magic + subcommand consumption, OR the Resolve
   * step picked up a `+workspace` suffix from a repo reference.
   */
  readonly worktreeSet: boolean;

  /**
   * WorktreeArg is the name/value given with -w / --worktree (or the 2nd
   * positional / +workspace suffix), or "" if the flag was bare.
   */
  readonly worktreeArg: string;

  /**
   * UsedNoopFallback is true when CWD was filled by the noop fallback (no
   * positional path given). Caller uses this to gate seed-noop behavior —
   * explicit paths don't get auto-seeded.
   */
  readonly usedNoopFallback: boolean;
}

// ── Brand machinery ────────────────────────────────────────────────────────

/**
 * `Branded<T, K>` tags `T` with a phantom string literal `K` so two
 * otherwise-structurally-identical types become assignment-incompatible.
 * The `__stage` property exists only in the type — runtime values never
 * carry it.
 */
type Branded<T, K extends string> = T & { readonly __stage: K };

// ── Stage 1: parsed ────────────────────────────────────────────────────────

/**
 * Output of `parseArgs`. The argv has been split into structural fields,
 * but no I/O has run yet — `cwd` is still the user-typed string, the
 * worktree intercept hasn't queried git, and no autoname has been generated.
 *
 * Has NO `worktreeMatched` field. That value only becomes meaningful after
 * the intercept stage, and encoding its absence in the type means a stale
 * `worktreeMatched: false` can't accidentally be read by a downstream step.
 */
export type ParsedArgs = Branded<BaseArgs, 'parsed'>;

// ── Stage 2: resolved ──────────────────────────────────────────────────────

/**
 * Output of the Resolve / tilde-expand step. `cwd` is an absolute path
 * (when a path or repo ref was resolved) or the noop fallback. The Resolve
 * step may also have promoted a `+workspace` suffix into `worktreeSet` +
 * `worktreeArg`.
 *
 * Still no `worktreeMatched` — that's the next stage.
 */
export type ResolvedArgs = Branded<BaseArgs, 'resolved'>;

// ── Stage 3: intercepted ───────────────────────────────────────────────────

/**
 * Output of `applyWorktreeIntercept`. `worktreeMatched` is now meaningful:
 * true iff an existing worktree of the project repo matched
 * `worktreeArg` (and `cwd` was swapped to that worktree's path). Downstream
 * consumers (`buildArgv`'s auto-tmux gate, primarily) treat matched=true
 * as "no new worktree being created this run" and avoid injecting flags
 * that only make sense when claude is about to spin up a fresh worktree.
 *
 * `passthrough` may have been extended with `--worktree`, `--worktree <name>`,
 * or `--name <name>` depending on whether the intercept matched.
 */
export interface InterceptedFields {
  /**
   * True iff -w / --worktree was resolved against an existing worktree of
   * the project repo (and cwd was swapped to that worktree).
   */
  readonly worktreeMatched: boolean;
}

export type InterceptedArgs = Branded<BaseArgs & InterceptedFields, 'intercepted'>;

// ── Brand constructors ─────────────────────────────────────────────────────
//
// Each brand function is a named cast — it doesn't validate anything,
// it just documents *where* the stage transition happens in the pipeline.
// The asserted shape carries all the invariants the stage promises.

/**
 * Stamp a `BaseArgs`-shaped value as `ParsedArgs`. Only `parseArgs` should
 * call this.
 */
export function brandParsed(a: BaseArgs): ParsedArgs {
  return a as ParsedArgs;
}

/**
 * Stamp a `BaseArgs`-shaped value as `ResolvedArgs`. Called after the
 * Resolve / tilde-expand step (or to short-circuit when the input is
 * already absolute and doesn't need resolution).
 */
export function brandResolved(a: BaseArgs): ResolvedArgs {
  return a as ResolvedArgs;
}

/**
 * Stamp a `BaseArgs & InterceptedFields`-shaped value as `InterceptedArgs`.
 * Only `applyWorktreeIntercept` should call this.
 */
export function brandIntercepted(a: BaseArgs & InterceptedFields): InterceptedArgs {
  return a as InterceptedArgs;
}

// ── Stage transitions (replace one or more fields, restamp the brand) ──────

/**
 * Return a new `ResolvedArgs` with the given field overrides. Used by the
 * Resolve step to swap `cwd` (and possibly `worktreeSet` / `worktreeArg`)
 * without mutating the parsed value.
 */
export function withResolved(
  a: ParsedArgs | ResolvedArgs,
  overrides: Partial<BaseArgs>,
): ResolvedArgs {
  return brandResolved({ ...(a as BaseArgs), ...overrides });
}

/**
 * Return a new `InterceptedArgs` from a `ResolvedArgs` plus the
 * intercept's outputs. `InterceptedFields` (currently just `worktreeMatched`)
 * is mandatory in the overrides so the brand can't be applied without it.
 */
export function withIntercepted(
  a: ResolvedArgs,
  overrides: Partial<BaseArgs> & InterceptedFields,
): InterceptedArgs {
  return brandIntercepted({ ...(a as BaseArgs), ...overrides });
}

/**
 * Return a new `InterceptedArgs` with `passthrough` (or other fields)
 * replaced. Used by the auto-name and sanitize steps — both operate on the
 * passthrough slice and produce a new slice; the rest of the args carries
 * through unchanged.
 *
 * Returns `InterceptedArgs` (not a separate "named" / "sanitized" type)
 * because no new invariants are established at those steps — only the
 * passthrough slice changes shape, and that's already an in-stage edit
 * the intercept itself does.
 */
export function withPassthroughUpdate(
  a: InterceptedArgs,
  overrides: Partial<BaseArgs>,
): InterceptedArgs {
  // Carry worktreeMatched through; only overrides win.
  return brandIntercepted({
    ...(a as BaseArgs & InterceptedFields),
    ...overrides,
  });
}

// ── Back-compat re-export ──────────────────────────────────────────────────

/**
 * `Args` was the single mutable bag the pipeline threaded through before
 * the stage-typed refactor. Retained as an alias for `InterceptedArgs` so
 * external consumers (the published `index.ts` surface, test helpers in
 * downstream tooling) keep working while the refactor lands. New code
 * should use the stage-specific types directly.
 *
 * @deprecated Use `ParsedArgs` / `ResolvedArgs` / `InterceptedArgs` per
 *   the position in the pipeline.
 */
export type Args = InterceptedArgs;
