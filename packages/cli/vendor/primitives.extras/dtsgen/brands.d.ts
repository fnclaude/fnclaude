declare const HOLE: unique symbol;
/**
 * Stands for a type argument a pattern has not been closed against yet — the slot is filled by
 * whatever the type it is matched against closes it to.
 *
 * @remarks
 * `L` labels the hole so several can be told apart and a repeated one binds consistently; any
 * string serves, so a label may read as a name (`'TEntity'`) rather than a position. `C` constrains
 * what may close it, and defaults to anything.
 *
 * @example
 * ```ts
 * const [matched, generics] = Type.extractMatchedGenerics(typefor<Promise<Generic<'S'>>>(), type);
 * ```
 */
export type Generic<L extends string, C = unknown> = C & {
    readonly [HOLE]?: L;
};
/**
 * The conventional hole for a pattern with one of them; written twice in one pattern it binds the
 * same type at both occurrences, as any repeated label does.
 */
export type T = Generic<'T'>;
declare const KEY: unique symbol;
/**
 * Pins a key into a type, distinguishing one spelling of it from another.
 *
 * @remarks
 * A key is not a parallel lookup: it tags the type, so the key travels inside the type rather than
 * beside it and a reader has to spell the same tag to arrive at the same one. `Keyed<ICache,
 * 'redis'>` is therefore one type, not a type plus an argument.
 *
 * The value type stays `T` — a plain `T` remains assignable, because the brand property is optional
 * — and `K` is always a string literal. It stacks with any other optional-property intersection.
 *
 * @example
 * ```ts
 * class Handler {
 *   public constructor(redis: Keyed<ICache, 'redis'>) {}
 * }
 * ```
 */
export type Keyed<T, K extends string> = T & {
    readonly [KEY]?: K;
};
export {};
