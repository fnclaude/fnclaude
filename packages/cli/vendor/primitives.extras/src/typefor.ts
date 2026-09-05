import type { AbstractConstructorType, ArrayType, ConstructorType, FunctionType, IterableType, NamedType, ObjectType, TupleType, Type, TypeLiteralType, UnionType } from '@rhombus-std/primitives';
import type { Ctor, Func } from '@rhombus-toolkit/types';

/** Does `T` inhabit `Shape` in both directions — the shape itself, not a subtype of it? */
type Exactly<T, Shape> = [T] extends [Shape] ? [Shape] extends [T] ? true : false : false;

/** Distributes `T` and asks whether any member fails to cover the whole — true only for a union. */
type IsUnion<T, Each = T> = T extends unknown ? [Each] extends [T] ? false : true : never;

/**
 * The structural reading of `T`, with `Alias` carrying the address every branch an alias spelling
 * can hide answers with instead.
 */
type DerivedType<T, Alias> = [T] extends [never] ? Type
  : [T] extends [Ctor<never[], unknown>] ? ConstructorType | Alias
  : [T] extends [abstract new(...args: never[]) => unknown] ? AbstractConstructorType | Alias
  : [T] extends [Func<never[], unknown>] ? FunctionType | Alias
  : [T] extends [unknown[]] ? number extends T['length'] ? ArrayType | Alias : TupleType | Alias
  : [T] extends [boolean] ? Exactly<T, boolean> extends true ? NamedType : TypeLiteralType<T & boolean> | Alias
  : IsUnion<T> extends true ? UnionType | Alias
  : [T] extends [string] ? [string] extends [T] ? NamedType : TypeLiteralType<T & string> | Alias
  : [T] extends [number] ? [number] extends [T] ? NamedType : TypeLiteralType<T & number> | Alias
  : [T] extends [bigint] ? [bigint] extends [T] ? NamedType : TypeLiteralType<T & bigint> | Alias
  : [T] extends [undefined] ? TypeLiteralType<undefined> | Alias
  : [T] extends [null] ? TypeLiteralType<null> | Alias
  : [T] extends [Iterable<infer E>] ? [Iterable<E>] extends [T] ? IterableType | Alias : Type
  : ObjectType | Alias;

/**
 * The {@link Type} `typefor<T>()` yields — the structural kind `T`'s spelling reads back as, or a
 * {@link NamedType} address wherever an alias could be spelling that same structure.
 *
 * @remarks
 * The structural reading takes callables first (a concrete class before the abstract test, since
 * every concrete constructor also answers the abstract shape), then arrays apart from tuples by
 * their literal length, unions, scalars — a wide scalar names a type, since `string` spells a
 * global and `type S = string` an import, while a scalar literal is its own value — and last an
 * exact `Iterable<E>`.
 *
 * An alias derives to the ALIAS's name, since the address must not shift with the aliased
 * structure, and nothing in the type says which of the two spellings the call site wrote. So every
 * branch an alias can stand in front of answers with its structural kind OR a named address, and
 * the caller checks `kind` before reading the members only one of them carries. An object-shaped
 * `T` — an interface or a class instance — derives to an {@link ObjectType} OR a named address,
 * since TypeScript cannot tell a named interface from an inline object type at the type level; the
 * `ObjectType`'s members are read structurally off `T`, with an optional property spelled as a
 * union with `undefined`.
 */
export type TypeFor<T> = DerivedType<T, NamedType>;

/**
 * The {@link Type} `typefor(value)` yields — the structural kind alone, since observing a value
 * reads the construct or call signatures it carries rather than a spelling an alias could hide.
 */
export type TypeForValue<V> = DerivedType<V, never>;

/**
 * Compile-time {@link Type} for a type — `typefor<IUserRepo>()`.
 *
 * @remarks
 * The type is derived exactly as spelled: no constructor or call unwrap, and a keyed type arrives
 * as its tag. What a callable builds, returns, or takes is a field on the derived node —
 * `.instance`, `.return`, `.signatures` — reachable once a `kind` check has picked the callable
 * reading out of the result.
 *
 * Resolved at compile time; calling this without that resolution throws.
 *
 * @example
 * ```ts
 * services.add(typefor<ICache>(), RedisCache, Type.ctor(typefor<ICache>()));
 * // → services.add(Type.imported('ICache', '@rhombus-std/caching.core'), RedisCache,
 * //     Type.ctor(Type.imported('ICache', '@rhombus-std/caching.core')))
 * ```
 */
export function typefor<T>(): TypeFor<T>;
/**
 * Compile-time {@link Type} for a value's own type — `typefor(SqlUserRepo)`.
 *
 * @remarks
 * A class arrives as the constructor it is, not as the instance it builds; read `.instance` for
 * that. Resolved at compile time; calling this without that resolution throws.
 *
 * @example
 * ```ts
 * const built = typefor(SqlUserRepo).instance; // → Type.imported('SqlUserRepo', 'pkg')
 * ```
 */
export function typefor<V>(value: V): TypeForValue<V>;
export function typefor(_value?: unknown): Type {
  throw new Error(
    "typefor() requires @rhombus-std/primitives.extras's authoring transform to run. "
      + 'It has not been applied. Depend on @rhombus-std/primitives.extras so ttsc spawns the '
      + '@rhombus-std transform host, or pass a type token string to a public API that accepts one.',
  );
}

export const TYPEFOR_NAME = 'typefor';
