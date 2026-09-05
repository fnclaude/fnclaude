import type { ObjectType } from '@rhombus-std/primitives';

/**
 * `T` expanded into the `Type` tree describing its structure.
 *
 * @remarks
 * Where `typefor` NAMES a type, `schemaof` OPENS one up: the result is a
 * `Type.object` carrying one entry per public, writable member of `T`.
 *
 * Expansion stops at a name. A member whose type has one of its own keeps it,
 * spelled exactly as `typefor` would have, so what `schemaof` adds is the members
 * of the type it was handed — and a self-referential type terminates rather than
 * expanding forever. Only what has no name — an inline structure, a tuple — is
 * opened up in place.
 *
 * An OPTIONAL member is its own type unioned with `undefined`
 * (`Type.union(inner, Type.typeLiteral(undefined))`), the one spelling the union
 * grammar keeps intact: nothing subsumes a nullish member.
 *
 * Two types that expand to the same structure yield the SAME node, since a
 * structural description is not an address.
 *
 * @example
 * ```ts
 * interface ServerConfig {
 *   host: string;
 *   port: number;
 *   ssl?: boolean;
 * }
 *
 * schemaof<ServerConfig>();
 * // Type.object({
 * //   host: Type.global('string'),
 * //   port: Type.global('number'),
 * //   ssl: Type.union(Type.global('boolean'), Type.typeLiteral(undefined)),
 * // })
 * ```
 */
export function schemaof<T>(): ObjectType {
  void (null as T | null);
  throw new Error(
    "schemaof<T>() requires @rhombus-std/primitives.extras's authoring transform to run. "
      + 'It has not been applied. Depend on @rhombus-std/primitives.extras so ttsc spawns the '
      + '@rhombus-std transform host, or write the Type tree with the Type factories directly.',
  );
}

/** The exported identifier name recognized as `schemaof`. */
export const SCHEMAOF_NAME = 'schemaof';
