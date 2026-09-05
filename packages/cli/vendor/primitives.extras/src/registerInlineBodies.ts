// registerInlineBodies is a runtime no-op that documents, in code, that an
// inline sugar body set is published in the declaring package's
// `package.json` "rhombus-std" marker's "inline" list. Nothing in TypeScript imports such a
// set, so without this call it reads as dead code and a reader has no way to
// tell why it exists; calling it beside the declaration fixes both problems.

/**
 * One inline sugar body: a single-return-expression function substituted at a
 * matching call site during the build.
 *
 * @remarks
 * A call signature rather than a `Func<...>` alias, because a body's shape is
 * receiver-first through a `this` parameter (e.g. `addClass<T>(this:
 * IInlineRegistrationTarget, ctor: Ctor)`), which `Func` has no slot for. The
 * receiver is deliberately left unconstrained — each package's bodies carry
 * their own receiver view, and this interface doesn't constrain which.
 */
export interface InlineBody {
  (...args: never[]): unknown;
}

/**
 * An object literal of {@link InlineBody} members, named by the matching
 * entry's `impl` in the declaring package's `package.json` "rhombus-std" marker "inline"
 * list. Every member must be function-like — a member with no body has
 * nothing to substitute.
 */
export interface InlineBodySet {
  readonly [member: string]: InlineBody;
}

/**
 * Declares, in code, that `bodies` is an inline sugar body set published in
 * the declaring package's `package.json` "rhombus-std" marker "inline" list.
 *
 * @remarks
 * A runtime no-op — the file these sets live in is never bundled or executed.
 * Call it at module level, immediately beside the set's declaration, never
 * wrapping it: tooling locates a set by its top-level `const` declaration, so
 * wrapping it in a call would hide the set behind a call expression.
 *
 * @example
 * ```ts
 * export const ConfigBuilderInline = {
 *   withType<T>(this: IWithSchemaTarget): unknown {
 *     return this.withSchema(schemaof<T>());
 *   },
 * };
 * registerInlineBodies(ConfigBuilderInline);
 * ```
 */
export function registerInlineBodies<Receiver>(_bodies: InlineBodySet): void {
  // Intentionally empty -- see the file header.
}
