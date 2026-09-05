import{AugmentationSet,MergeStrategies,ObjectType,Type,ConstructorType,AbstractConstructorType,FunctionType,ArrayType,TupleType,NamedType,TypeLiteralType,UnionType,IterableType}from'@rhombus-std/primitives';import{Ctor,Func}from'@rhombus-toolkit/types';declare const HOLE:unique symbol;/**
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
 */type Generic<L extends string,C=unknown>=C&{readonly[HOLE]?:L;};/**
 * The conventional hole for a pattern with one of them; written twice in one pattern it binds the
 * same type at both occurrences, as any repeated label does.
 */type T=Generic<'T'>;declare const KEY:unique symbol;/**
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
 */type Keyed<T,K extends string>=T&{readonly[KEY]?:K;};/**
 * Register `set`'s members against the receiver type `R` —
 * `registerAugmentations<IConfigBuilder>(ConfigBuilderJsonAugmentations)`.
 *
 * @remarks
 * The receiver arrives as a type argument, so no call site has to spell its `Type`.
 * Resolved at compile time; calling this without that resolution throws.
 *
 * A receiver reachable only as a VALUE — a composed `Type`, or one held in a variable —
 * has no type to name here. Register it through `@rhombus-std/primitives`' form, which
 * takes the receiver as its first argument.
 *
 * @example
 * ```ts
 * registerAugmentations<IConfigBuilder>(ConfigBuilderJsonAugmentations);
 * // → registerAugmentations(Type.imported('IConfigBuilder', '@rhombus-std/config.core'), ConfigBuilderJsonAugmentations)
 * ```
 */declare function registerAugmentations<R>(set:AugmentationSet<R>,merge?:MergeStrategies<R>):void;declare const REGISTER_AUGMENTATIONS_NAME="registerAugmentations";/**
 * One inline sugar body: a single-return-expression function substituted at a
 * matching call site during the build.
 *
 * @remarks
 * A call signature rather than a `Func<...>` alias, because a body's shape is
 * receiver-first through a `this` parameter (e.g. `addClass<T>(this:
 * IInlineRegistrationTarget, ctor: Ctor)`), which `Func` has no slot for. The
 * receiver is deliberately left unconstrained — each package's bodies carry
 * their own receiver view, and this interface doesn't constrain which.
 */interface InlineBody{(...args:never[]):unknown;}/**
 * An object literal of {@link InlineBody} members, named by the matching
 * entry's `impl` in the declaring package's `package.json` "rhombus-std" marker "inline"
 * list. Every member must be function-like — a member with no body has
 * nothing to substitute.
 */interface InlineBodySet{readonly[member:string]:InlineBody;}/**
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
 */declare function registerInlineBodies<Receiver>(_bodies:InlineBodySet):void;/**
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
 */declare function schemaof<T>():ObjectType;/** The exported identifier name recognized as `schemaof`. */declare const SCHEMAOF_NAME="schemaof";/** Does `T` inhabit `Shape` in both directions — the shape itself, not a subtype of it? */type Exactly<T,Shape>=[T]extends[Shape]?[Shape]extends[T]?true:false:false;/** Distributes `T` and asks whether any member fails to cover the whole — true only for a union. */type IsUnion<T,Each=T>=T extends unknown?[Each]extends[T]?false:true:never;/**
 * The structural reading of `T`, with `Alias` carrying the address every branch an alias spelling
 * can hide answers with instead.
 */type DerivedType<T,Alias>=[T]extends[never]?Type:[T]extends[Ctor<never[],unknown>]?ConstructorType|Alias:[T]extends[abstract new(...args:never[])=>unknown]?AbstractConstructorType|Alias:[T]extends[Func<never[],unknown>]?FunctionType|Alias:[T]extends[unknown[]]?number extends T['length']?ArrayType|Alias:TupleType|Alias:[T]extends[boolean]?Exactly<T,boolean>extends true?NamedType:TypeLiteralType<T&boolean>|Alias:IsUnion<T>extends true?UnionType|Alias:[T]extends[string]?[string]extends[T]?NamedType:TypeLiteralType<T&string>|Alias:[T]extends[number]?[number]extends[T]?NamedType:TypeLiteralType<T&number>|Alias:[T]extends[bigint]?[bigint]extends[T]?NamedType:TypeLiteralType<T&bigint>|Alias:[T]extends[undefined]?TypeLiteralType<undefined>|Alias:[T]extends[null]?TypeLiteralType<null>|Alias:[T]extends[Iterable<infer E>]?[Iterable<E>]extends[T]?IterableType|Alias:Type:ObjectType|Alias;/**
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
 */type TypeFor<T>=DerivedType<T,NamedType>;/**
 * The {@link Type} `typefor(value)` yields — the structural kind alone, since observing a value
 * reads the construct or call signatures it carries rather than a spelling an alias could hide.
 */type TypeForValue<V>=DerivedType<V,never>;/**
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
 */declare function typefor<T>():TypeFor<T>;/**
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
 */declare function typefor<V>(value:V):TypeForValue<V>;declare const TYPEFOR_NAME="typefor";export{REGISTER_AUGMENTATIONS_NAME,SCHEMAOF_NAME,TYPEFOR_NAME,registerAugmentations,registerInlineBodies,schemaof,typefor};export type{Generic,InlineBody,InlineBodySet,Keyed,T,TypeFor,TypeForValue};