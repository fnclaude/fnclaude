import{AbortSignal}from'@rhombus-toolkit/platform';export*from'@rhombus-toolkit/platform';import{Func,AbstractCtor,DistributiveOmit}from'@rhombus-toolkit/types';/**
 * A namespace of `this`-based augmentation functions all sharing receiver type R.
 */type AugmentationSet<in out R>={[K in keyof R]?:Func<any,unknown,R>;};/**
 * A collision resolver for a single augmented member whose name is already
 * taken on the receiver prototype -- the class's own primitive, or a member an
 * earlier registration mounted. It is handed:
 *
 *   - `original` -- the member currently occupying the slot.
 *   - `incoming` -- the augmentation method being installed.
 *
 * It returns
 * the DISPATCHER method that replaces the slot: a pure filter that routes a
 * call to `incoming` when the arguments match that method's own signature, and
 * to `original` otherwise. Routing the primitive-shaped call to `original` is
 * what keeps a wrapper (which typically re-enters the receiver method in
 * primitive shape) from recursing into itself.
 */type MergeStrategy<Receiver>=Func<[
original:Func<any,unknown,Receiver>,incoming:Func<any,unknown,Receiver>],Func<any,unknown,Receiver>>;/** Per-member collision resolvers, keyed by the augmentation member name. */type MergeStrategies<Receiver>=Record<string,MergeStrategy<Receiver>>;/**
 * Mounts each augmentation in `augmentations` onto `Ctor.prototype` verbatim.
 * A name already taken on the prototype is resolved by its `merge` strategy or,
 * with none, throws.
 */declare function applyAugmentations<Receiver extends object>(ctor:AbstractCtor<unknown[],Receiver>,augmentations:AugmentationSet<Receiver>,merge?:MergeStrategies<Receiver>):void;/**
 * The rules a type token is written and read by: which characters an identifier segment may carry
 * unescaped, how to spell one that cannot, and the unqualified names that carry a reading of their
 * own. The reserved set is derived from the tables below, so a name gains its reserved meaning and
 * its escaping in the same edit.
 *//**
 * Each aggregate spelling and the node kind it names. One type argument on a global name is that
 * aggregate wherever it is spelled — parsed, derived, or composed by hand — so the kind node is
 * the only identity the spelling ever has.
 */declare const LIST_KINDS:{readonly Array:"array";readonly Iterable:"iterable";};/** An aggregate's wire spelling. */type ListName=keyof typeof LIST_KINDS;/**
 * Dispatches a {@link Type} to the handler for its `kind`.
 *
 * `visit` is the entry point; subclasses supply the per-kind methods and call `this.visit(child)`
 * to recurse into a node's own children — a composite's members, a signature's arguments, an
 * list's element, a tag's inner type.
 *
 * @typeParam Return - what each handler produces.
 */declare abstract class TypeVisitor<out Return,in Context=never>{visit(type:Type):Return;visit(type:Type,context:Context):Return;protected abstract visitArray(type:ArrayType,context:Context):Return;protected abstract visitCtor(type:ConstructorType,context:Context):Return;protected abstract visitAbstractCtor(type:AbstractConstructorType,context:Context):Return;protected abstract visitFunc(type:FunctionType,context:Context):Return;protected abstract visitGeneric(type:GenericType,context:Context):Return;protected abstract visitGlobal(type:GlobalType,context:Context):Return;protected abstract visitImported(type:ImportedType,context:Context):Return;protected abstract visitIntersection(type:IntersectionType,context:Context):Return;protected abstract visitIterable(type:IterableType,context:Context):Return;protected abstract visitObject(type:ObjectType,context:Context):Return;protected abstract visitTag(type:TagType,context:Context):Return;protected abstract visitTuple(type:TupleType,context:Context):Return;protected abstract visitTypeLiteral(type:TypeLiteralType,context:Context):Return;protected abstract visitUnion(type:UnionType,context:Context):Return;}type ListType=ArrayType|IterableType;type NamedType=GlobalType|ImportedType;/** Types that are only useful as identifiers */type TypeIdentifier=GenericType|NamedType|TagType;declare const TYPE_BRAND:unique symbol;type TypeBrand=typeof TYPE_BRAND;interface TypeBase<Kind extends string>{readonly kind:Kind;readonly[TYPE_BRAND]:void;}interface ImportedType extends TypeBase<'imported'>{/** Literally the 'from' part in the import statement you would use to access this type (package and all). */readonly from:string;/** The exported name, or 'default' for default exports. */readonly name:string;readonly genericArgs:readonly Type[];}/** A type the ambient scope already carries — `string`, `Date`, `Promise<T>`; no import reaches it. */interface GlobalType extends TypeBase<'global'>{/** The exported name, or 'default' for default exports. */readonly name:string;readonly genericArgs:readonly Type[];}/** An open generic argument — a labeled hole standing for a type bound later. */interface GenericType extends TypeBase<'generic'>{readonly label:string;}interface ConstructorType extends TypeBase<'ctor'>{/**
 * @remarks
 * Built by {@link Type.signatures}: several overload rows collapse to a {@link UnionType}, one
 * row collapses to its bare {@link TupleType} or {@link ListType}. Construct it through that
 * factory rather than by hand.
 */readonly signatures:TupleType|ListType|UnionType;readonly instance:Type;}/**
 * An abstract constructor signature — `abstract new (...args) => instance` — its own kind, so a
 * slot that must be able to `new` its node spells {@link ConstructorType} and refuses this one
 * by assignability; a position accepting either spells the union.
 */interface AbstractConstructorType extends TypeBase<'abstract-ctor'>{/**
 * @remarks
 * Built by {@link Type.signatures}: several overload rows collapse to a {@link UnionType}, one
 * row collapses to its bare {@link TupleType} or {@link ListType}. Construct it through that
 * factory rather than by hand.
 */readonly signatures:TupleType|ListType|UnionType;readonly instance:Type;}interface FunctionType extends TypeBase<'func'>{/**
 * @remarks
 * Built by {@link Type.signatures}: several overload rows collapse to a {@link UnionType}, one
 * row collapses to its bare {@link TupleType} or {@link ListType}. Construct it through that
 * factory rather than by hand.
 */readonly signatures:TupleType|ListType|UnionType;readonly return:Type;}interface ArrayType extends TypeBase<'array'>{readonly element:Type;}interface IterableType extends TypeBase<'iterable'>{readonly element:Type;}interface IntersectionType extends TypeBase<'intersection'>{readonly members:readonly Type[];}type LiteralValue=string|number|bigint|boolean|null|undefined;interface ObjectType extends TypeBase<'object'>{readonly members:Readonly<Record<string,Type>>;}interface TagType extends TypeBase<'tag'>{readonly tag:string;readonly type:Exclude<Type,TagType>;}interface TupleType extends TypeBase<'tuple'>{/** Every fixed slot in order. A slot that may be absent admits `undefined`, like any other optional position. */readonly members:readonly Type[];/** A trailing rest slot's element type, or undefined for a fixed-length tuple. */readonly rest:Type|undefined;}/** Any type that `typeof` can resolve */interface TypeLiteralType<Value extends LiteralValue=LiteralValue>extends TypeBase<'literal'>{readonly value:Value;}interface UnionType extends TypeBase<'union'>{readonly members:readonly Type[];}/** All Types */type Type=ListType|ConstructorType|AbstractConstructorType|FunctionType|IntersectionType|ObjectType|TupleType|TypeIdentifier|TypeLiteralType|UnionType;declare namespace Type{/** An unadopted Type */export type RawType<T extends Type=Type>=DistributiveOmit<T,TypeBrand>;type Spec<T extends Type>=Omit<RawType<T>,'kind'>;/**
 * Brings a Type into the system, thus guaranteeing referential equality.
 *
 * @remarks
 * The one door meaning enters by: every kind is rebuilt through its own factory, so whatever a
 * factory canonicalizes, collapses or refuses applies to a node arriving as plain data — a tree
 * revived from JSON, one a cast produced, the tree {@link from} reads out of a token. A tuple
 * node that is nothing but a rest slot adopts as the list it collapses to, so a tuple-kind node
 * can answer a {@link ListType}.
 *
 * @throws TypeError - when the node names no kind, lacks a field its kind carries, or spells a
 * type its factory refuses.
 *
 * @example
 * ```ts
 * Type.adopt({ kind: 'imported', name: 'IClock', from: 'app', genericArgs: [] });
 * ```
 */export function adopt<const Node extends RawType>(node:Node):Extract<Type,{kind:Node['kind'];}>|('tuple'extends Node['kind']?ListType:never);/** An indexable array of `element` — `Array<element>`. */export function array(element:Type):ArrayType;export function array(spec:Spec<ArrayType>):ArrayType;/**
 * A constructor signature — `new (...args) => instance`.
 *
 * @example
 * ```ts
 * Type.ctor(box, [[string]]);                                             // new (string) => box
 * Type.ctor(box, [[string], []]);                                         // new (; string) => box
 * Type.ctor(box, Type.signatures([Type.tuple(string), Type.tuple()]));    // same, slot pre-built
 * Type.ctor({ instance: box, signatures: Type.signatures([Type.tuple()]) });
 * ```
 *
 * @throws TypeError - when a pre-built slot carries a row that is neither a tuple nor a list.
 */export function ctor(instance:Type,signatures:TupleType|ListType|UnionType):ConstructorType;export function ctor(instance:Type,signatures:readonly(readonly Type[])[]):ConstructorType;export function ctor(spec:Spec<ConstructorType>):ConstructorType;export function ctor(spec:{instance:Type;signatures:readonly(readonly Type[])[];}):ConstructorType;/**
 * An abstract constructor signature — `abstract new (...args) => instance`.
 *
 * @example
 * ```ts
 * Type.abstractCtor(box, [[]]);                             // abstract new () => box
 * Type.abstractCtor(box, Type.signatures([Type.tuple()]));  // same, slot pre-built
 * Type.abstractCtor({ instance: box, signatures: Type.signatures([Type.tuple()]) });
 * ```
 *
 * @throws TypeError - when a pre-built slot carries a row that is neither a tuple nor a list.
 */export function abstractCtor(instance:Type,signatures:TupleType|ListType|UnionType):AbstractConstructorType;export function abstractCtor(instance:Type,signatures:readonly(readonly Type[])[]):AbstractConstructorType;export function abstractCtor(spec:Spec<AbstractConstructorType>):AbstractConstructorType;export function abstractCtor(spec:{instance:Type;signatures:readonly(readonly Type[])[];}):AbstractConstructorType;/**
 * Reads a type token back into the {@link Type} it spells — the inverse of {@link stringify}.
 *
 * @remarks
 * The token format: `docs/features/type-token-format.md`. The token is read literally and the
 * tree handed to {@link adopt}, so a token is canonicalized exactly as a hand-built node is.
 *
 * @throws TypeParseError - when the token is malformed.
 */export const from:(token:string)=>Type;/**
 * A function signature — `(...args) => return`.
 *
 * @example
 * ```ts
 * Type.func(box, [[string]]);                                             // (string) => box
 * Type.func(box, [[string], []]);                                         // (; string) => box
 * Type.func(box, Type.signatures([Type.tuple(string), Type.tuple()]));    // same, slot pre-built
 * Type.func({ return: box, signatures: Type.signatures([Type.tuple()]) });
 * ```
 *
 * @throws TypeError - when a pre-built slot carries a row that is neither a tuple nor a list.
 */export function func(returns:Type,signatures:TupleType|ListType|UnionType):FunctionType;export function func(returns:Type,signatures:readonly(readonly Type[])[]):FunctionType;export function func(spec:Spec<FunctionType>):FunctionType;export function func(spec:{return:Type;signatures:readonly(readonly Type[])[];}):FunctionType;/** An open generic argument — a labeled hole standing for a type bound later. */export function generic(label:string):GenericType;export function generic(spec:Spec<GenericType>):GenericType;/** The node kind one list spelling names. */type List<Name extends ListName>=Extract<ListType,{kind:typeof LIST_KINDS[Name];}>;/**
 * What a {@link Type.global} spelling mints, as narrowly as the call can prove it.
 */type Global<Name extends string,Args extends readonly Type[]>=string extends Name?ListType|GlobalType:Name extends ListName?Args extends readonly[Type]?List<Name>:number extends Args['length']?List<Name>|GlobalType:GlobalType:GlobalType;/** A type the ambient scope already carries, referenced by name. */export function global<const Name extends string,const Args extends readonly Type[]=readonly[]>(name:Name,genericArgs?:Args):Global<Name,Args>;export function global<const Named extends Spec<GlobalType>>(spec:Named):Global<Named['name'],Named['genericArgs']>;/**
 * A type reached through a package — parallel to `import { name } from '…'`.
 *
 * @throws TypeError - when `from` names the ambient scope rather than a package.
 */export function imported(name:string,from:string,genericArgs?:readonly Type[]):ImportedType;export function imported(spec:Spec<ImportedType>):ImportedType;/**
 * An intersection of the given members — satisfied only by satisfying all of them.
 *
 * @remarks
 * Canonicalized exactly as {@link union} is, minus the literal reduction.
 *
 * @throws TypeError - when no member survives.
 */export function intersection<Member extends Type>(type:Member):Member;export function intersection(first:Type,second:Type,...rest:readonly Type[]):IntersectionType;export function intersection(spec:Spec<IntersectionType>):Type;export function intersection(...types:readonly Type[]):Type;/** A lazily-walked sequence of `element` — `Iterable<element>`. */export function iterable(element:Type):IterableType;export function iterable(spec:Spec<IterableType>):IterableType;/** A structural object type — members keyed in sorted order, so member order never splits identity. */export function object(members:Readonly<Record<string,Type>>):ObjectType;/** `Promise<settled>` — idempotent: `promise(Promise<X>)` returns the interned `Promise<X>`. */export function promise(settled:Type):GlobalType;/**
 * A `JSON.parse` reviver that {@link adopt}s each type embedded in a document, leaving every
 * other value as it was parsed.
 *
 * @remarks
 * For a document that is one type, `Type.adopt(JSON.parse(text))` says the same thing more
 * directly. A value is taken for a type when it names a kind and carries that kind's fields, so
 * a foreign object wearing that exact shape is adopted too.
 *
 * @example
 * ```ts
 * JSON.parse(text, Type.reviver);
 * ```
 */export function reviver(key:string,value:unknown):unknown;/**
 * The given type wearing a tag — a distinct name for the same underlying type, so the same
 * type under a different tag is a different type.
 *
 * @throws TypeError - when the type is already tagged; a type wears at most one tag.
 */export const tag:{(type:Exclude<Type,TagType>,tag:string):TagType;(spec:Spec<TagType>):TagType;};/**
 * An ordered list of member types — `[A, B, C]`. The variadic spelling is fixed-length; a
 * trailing rest slot needs the spec form.
 *
 * @remarks
 * A tuple that is nothing but a rest slot is the list its open length draws from, so
 * `{ members: [], rest: x }` collapses to `Type.array(x)`; `{ members: [] }` with no rest is
 * the zero-length tuple.
 *
 * @example
 * ```ts
 * Type.tuple(a, b);                          // [a, b]
 * Type.tuple({ members: [a], rest: b });     // [a, ...b[]]
 * Type.tuple({ members: [], rest: b });      // b[] — the list itself
 * ```
 */export function tuple(...types:readonly Type[]):TupleType;export function tuple(spec:Spec<TupleType>):TupleType|ListType;/** A single literal value as a type — `'on'`, `42`, `true`, `null`. */export function typeLiteral<const Value extends LiteralValue>(value:Value):TypeLiteralType<Value>;export function typeLiteral<const Value extends LiteralValue>(spec:Spec<TypeLiteralType<Value>>):TypeLiteralType<Value>;/**
 * A union of the given members — satisfied by satisfying any one of them.
 *
 * @remarks
 * Members are flattened, deduped and ordered canonically, so `union(a, b)` and `union(b, a)`
 * name the same type; a literal standing beside its own primitive base is dropped, and a lone
 * surviving member is returned as itself rather than as a one-member union.
 *
 * @throws TypeError - when no member survives.
 */export function union(...types:readonly Type[]):Type;export function union(spec:Spec<UnionType>):Type;/**
 * Is `type` address-only — a pure reference, with nothing of its own to build from?
 *
 * @remarks
 * A tag is address-only whatever it wraps — the tag exists to be a distinct name.
 */export const isIdentifier:(type:Type)=>type is TypeIdentifier;/** Does `type` still hold a generic hole anywhere? */export const isOpen:(type:Type)=>boolean;export function isClosed(type:Type):boolean;/** Does the type admit `undefined` — the `undefined` literal itself, or a union carrying it? */export function isOptional(type:Type):boolean;/** Is `type` a `Promise<…>` — the one spelling the container reads as deferred delivery? */export function isPromise(type:Type):boolean;/** What `type` settles to: the inner type for a `Promise<T>`, the type itself otherwise. */export function awaited(type:Type):Type;/**
 * Does some instantiation of `{@link candidate}` equal `{@link constraint}`? Success carries the
 * instantiation — one binding per generic label in the candidate.
 *
 * @remarks
 * Matching is identity modulo holes: outside a hole, the two sides must be the same interned
 * node — there is no assignability, so no width subtyping, no literal widening to its primitive
 * base, and no member search.
 *
 * @throws Error - when `constraint` itself holds a generic hole.
 */export const extractMatchedGenerics:(possiblyOpenCandidate:Type,closedConstraint:Type)=>[isMatch:false]|[isMatch:true,generics:Record<string,Type>];/**
 * Does some instantiation of `pattern` equal `candidate`?
 *
 * @param pattern - may contain generic holes.
 * @param candidate - may not contain generic holes.
 * @throws Error - when `candidate` holds a generic hole.
 */export function isMatch(pattern:Type,candidate:Type):boolean;/** Writes the type as its token spelling — the inverse of {@link from}. */export function stringify(type:Type):string;/** Replaces each generic hole whose label the map names; other holes stay. */export function substitute(type:ConstructorType,substitutions:Readonly<Record<string,Type>>):ConstructorType;export function substitute(type:FunctionType,substitutions:Readonly<Record<string,Type>>):FunctionType;export function substitute(type:Type,substitutions:Readonly<Record<string,Type>>):Type;/**
 * Builds the signatures slot a callable carries. Each row is one overload: a {@link TupleType}
 * for a fixed argument list (an open one when it carries a rest slot), a {@link ListType} for a
 * signature that is entirely a rest. Several rows become a union; one returns the row itself.
 *
 * @throws TypeError - when no row is given (a callable answers to at least one call), or a row
 * is neither a tuple nor a list.
 */export function signatures(rows:readonly(TupleType|ListType)[]):TupleType|ListType|UnionType;/**
 * The per-overload rows a callable's signature slot carries, in stored order: one entry per
 * overload, each a {@link TupleType} (fixed arity) or a {@link ListType} (rest-only).
 *
 * @remarks
 * A union's members are returned as-stored — the canonical order the slot was interned with.
 * Consumers that need a different order (e.g. longest-first) sort the result themselves.
 */export function signatureRows(slot:TupleType|ListType|UnionType):readonly(TupleType|ListType)[];/**
 * The dispatch surface over the node kinds — subclass it and implement the `visit*` member for
 * each kind the walk cares about.
 *
 * @example
 * ```ts
 * class Depth extends Type.Visitor<number> {
 *   protected override visitUnion(type: UnionType): number { … }
 * }
 * ```
 */export const Visitor:typeof TypeVisitor;export type Visitor<Return,Context=never>=TypeVisitor<Return,Context>;export{};}/**
 * Append `set`'s members into `receiver`'s bag, then install just those members onto
 * every class already decorated with `@augment(receiver)`.
 *
 * @remarks
 * Types intern, so every spelling of the receiver — `typefor<R>()`, a factory
 * composition, `Type.from` over a token string — reaches the same bag.
 *
 * A member name a prior set already contributed accumulates rather than throwing;
 * the collision is resolved (by a supplied `merge` strategy) or refused at install
 * time. Subscribers are invoked synchronously, so that refusal reaches this caller.
 *
 * @throws TypeError - when the receiver names a shape rather than a declaration.
 */declare function registerAugmentations<R>(receiver:Type,set:AugmentationSet<R>,merge?:MergeStrategies<R>):void;/**
 * Class decorator that installs the augmentations registered for `receiver` onto the
 * decorated class's prototype: on application it catches up on everything registered
 * so far, and thereafter installs each later registration's delta. Usable as
 * `@augment(typefor<IReceiver>())` or as a plain `augment(receiver)(TheClass)`.
 *
 * @remarks
 * The class constraint is `{ prototype: object }`, not a constructor signature, so a
 * class with a private constructor (a singleton) — assignable to no
 * `new (...) => ...` type — can still be a receiver; only its prototype is touched.
 *
 * @throws TypeError - when the receiver names a shape rather than a declaration.
 */declare function augment(receiver:Type):<C extends{readonly prototype:object;}>(Ctor:C,_context?:unknown)=>void;/**
 * Propagates notifications that a change has occurred.
 */interface IChangeToken{/**
 * A value that indicates if a change has occurred.
 */readonly hasChanged:boolean;/**
 * A value that indicates whether this token will proactively raise
 * callbacks. If `false`, the token consumer must poll {@link hasChanged}
 * to detect changes.
 *
 * A `true` value does not guarantee that callbacks will be raised for all
 * changes. Consumers should also check {@link hasChanged} when complete
 * accuracy is required.
 */readonly activeChangeCallbacks:boolean;/**
 * Registers a callback that will be invoked when the token has changed.
 * {@link hasChanged} MUST be set before the callback is invoked.
 *
 * @param callback The callback to invoke.
 * @param state State to be passed into the callback.
 * @returns A {@link Disposable} that is used to unregister the callback.
 */
registerChangeCallback(callback:Func<[state:unknown],void>,state?:unknown):Disposable;}/**
 * Produces an {@link IChangeToken}. `null`/`undefined` means "no token to
 * subscribe to right now" -- registration is skipped until a subsequent call
 * returns one.
 */type ChangeTokenProducer=Func<[],IChangeToken|null|undefined>;/**
 * A change-token consumer. Returning a thenable opts into the async consumer
 * contract: the token is only re-registered once the returned promise settles.
 *
 * A union of the sync and async function shapes rather than one signature
 * returning `void | PromiseLike<void>`: TS's "anything is assignable to a void
 * return" rule only applies to a bare `void` return type, so the union keeps
 * terse sync consumers like `() => count++` assignable.
 */type ChangeTokenConsumer<TState>=Func<[state:TState],void>|Func<[state:TState],PromiseLike<void>>;/**
 * An {@link IChangeToken} implementation backed by an `AbortSignal`.
 */declare class CancellationChangeToken implements IChangeToken{#private;readonly activeChangeCallbacks=true;constructor(signal:AbortSignal);get hasChanged():boolean;/**
 * @inheritdoc
 *
 * Per the {@link IChangeToken.registerChangeCallback} contract,
 * `hasChanged` MUST be set before the callback is invoked -- so if the
 * signal is already aborted, `callback` runs synchronously rather than
 * being wired to an `"abort"` event that has already fired.
 */
registerChangeCallback(callback:Func<[state:unknown],void>,state?:unknown):Disposable;}/**
 * An {@link IChangeToken} that represents one or more {@link IChangeToken}
 * instances.
 *
 * Callbacks are only propagated from inner tokens whose
 * {@link IChangeToken.activeChangeCallbacks} is `true`. Changes in other
 * inner tokens are detected only when {@link hasChanged} is polled.
 */declare class CompositeChangeToken implements IChangeToken{#private;/**
 * The list of {@link IChangeToken} that compose the current
 * {@link CompositeChangeToken}.
 */readonly changeTokens:readonly IChangeToken[];/**
 * `true` if at least one of the {@link changeTokens} has active change
 * callbacks; otherwise, `false`.
 */readonly activeChangeCallbacks:boolean;/**
 * Creates a new instance of {@link CompositeChangeToken}.
 *
 * @param changeTokens The list of {@link IChangeToken} to compose.
 */constructor(changeTokens:readonly IChangeToken[]);get hasChanged():boolean;/** @inheritdoc */
registerChangeCallback(callback:Func<[state:unknown],void>,state?:unknown):Disposable;}/**
 * Propagates notifications that a change has occurred.
 */declare const ChangeToken:{/**
 * Registers `consumeToken` to be called whenever the token `produceToken`
 * returns changes.
 *
 * A consumer may be synchronous or asynchronous. When it returns a
 * thenable, the token is only re-registered once the returned promise
 * settles; synchronous throws (from either kind of consumer) propagate to
 * the code that triggers the change token, while rejections of the
 * returned promise are left unobserved -- a consumer that needs its async
 * failures seen must handle them itself.
 *
 * @param produceToken Produces the change token.
 * @param consumeToken Called when the token changes. The token is
 * re-registered once this returns (or, for an async consumer, once the
 * returned promise settles).
 * @param state State passed through to `consumeToken`.
 * @returns A {@link Disposable} that, when disposed, unregisters the consumer.
 */
onChange<TState=undefined>(produceToken:ChangeTokenProducer,consumeToken:ChangeTokenConsumer<TState>,state?:TState):Disposable;};/**
 * A member declared so callers can be written against it, which has no behaviour yet.
 *
 * @remarks
 * Reaching one is a gap in what has been built rather than anything wrong with the call, so it is
 * not a failure to fall back from. The stack trace names the call site; `member` only has to name
 * what was reached.
 */declare class NotImplementedError extends Error{constructor(member?:string);}/** Thrown when a type token cannot be read, pointing at the offending offset. */declare class TypeParseError extends Error{/** The token that failed to parse, whole. */readonly token:string;/** Zero-based offset into {@link token} where the parse stopped. */readonly position:number;/** What the reader needed to find there. */readonly expectation:string;constructor(token:string,position:number,expectation:string);}export{CancellationChangeToken,ChangeToken,CompositeChangeToken,NotImplementedError,Type,TypeParseError,applyAugmentations,augment,registerAugmentations};export type{AbstractConstructorType,ArrayType,AugmentationSet,ChangeTokenConsumer,ChangeTokenProducer,ConstructorType,FunctionType,GenericType,GlobalType,IChangeToken,ImportedType,IntersectionType,IterableType,ListType,LiteralValue,MergeStrategies,MergeStrategy,NamedType,ObjectType,TagType,TupleType,TypeIdentifier,TypeLiteralType,UnionType};