import{Type,ConstructorType,FunctionType}from'@rhombus-std/primitives';type Func<in Args extends readonly any[]=any[],out Return=any,in This=unknown>=(this:This,...args:Args)=>Return;interface Ctor<in Args extends readonly any[]=any[],out Instance=any>{new(...args:Args):Instance;prototype:Instance;}type _AbstractCtor<in Args extends readonly any[]=any[],out Instance=any>=abstract new(...args:Args)=>Instance;interface AbstractCtor<in Args extends readonly any[]=any[],out Instance=any>extends _AbstractCtor<Args,Instance>{prototype:Instance;}/**
 * Restates `T`'s members as a type literal — one flat, readable shape instead of
 * a chain of intersections and aliases.
 */type Simplify<T>={[KeyType in keyof T]:T[KeyType];};/**
 * {@link Simplify}, plus the implicit index signature an `interface` lacks —
 * the shape that lets a namespace's members merge onto an interface through
 * `extends Flatten<typeof TheNamespace>`.
 *
 * @remarks
 * `Flatten` and `Simplify` are the same restatement; the trailing `& {}` is the
 * whole difference, and it is for the reader, not the checker: it makes an error
 * or a hover print the members rather than the alias name. Keep it — deleting it
 * changes nothing that type-checks, so nothing will fail to tell you it is gone.
 * Both names ship because both call sites read wrong under the other: you
 * `Simplify` a computed type to see it, and you `Flatten` a namespace to merge
 * it.
 */type Flatten<T>=Simplify<T>&{};/**
 * The lifetime a constructed registration is cached under — a model's own vocabulary value.
 * Omittable only where the vocabulary admits `undefined`.
 */interface WithLifetimeMembers<Lifetime>{readonly lifetime:Lifetime;}type WithLifetime<Lifetime>=Readonly<undefined extends Lifetime?Partial<WithLifetimeMembers<Lifetime>>:Required<WithLifetimeMembers<Lifetime>>>;/**
 * A registration the container constructs with `new`.
 *
 * @remarks
 * `ctorType` is where the registration's signatures live, so `ctor` and the calls it answers
 * to are read from one place and cannot disagree.
 */type CtorRegistration<Lifetime>=Flatten<{readonly address:Type;readonly ctor:Ctor;readonly ctorType:ConstructorType;}&WithLifetime<Lifetime>>;/** A registration the container calls. */type FactoryRegistration<Lifetime>=Flatten<{readonly address:Type;readonly factory:Func;readonly factoryType:FunctionType;}&WithLifetime<Lifetime>>;/**
 * A registration the container hands back as it stands.
 *
 * @remarks
 * It carries no lifetime: a value IS its instance, so there is no construction for a lifetime to
 * govern and nothing a lifetime could mean. And it carries no implementer type — a value has no
 * signature to read, no injection list, and nothing to call.
 */interface ValueRegistration{readonly address:Type;readonly value:unknown;}/** A step the chain has not spent yet. Each verb removes its own, so none can be taken twice. */type Slot='implementer'|'lifetime'|'tag';/**
 * The steps still open, as one type: an intersection of the interfaces whose slots survive.
 * `Described` is `unknown` until an implementer is chosen; from then on the node IS that
 * registration, refined by whatever steps remain — except while a required lifetime is unspent:
 * when `undefined` is not assignable to `Lifetime` and the `lifetime` slot is still open, the
 * node withholds registration-ness, so a manifest verb refuses it until `withLifetime` is taken.
 */type RegistrationBuilder<T,Lifetime,Slots extends Slot,Described>=('lifetime'extends Slots?(undefined extends Lifetime?Described:unknown):Described)&('implementer'extends Slots?IAsImplementer<T,Lifetime,Slots>:unknown)&('lifetime'extends Slots?IWithLifetime<T,Lifetime,Slots,Described>:unknown)&('tag'extends Slots?ITaggedAs<T,Lifetime,Slots,Described>:unknown);/**
 * Choosing what produces the service. Each door takes the implementation together with its own
 * type — the node carrying its signatures — and takes only implementations that produce `T`,
 * so a registration that could not satisfy its own address is refused where it is written. Taking
 * a door completes the registration: the result is a {@link Registration}.
 */interface IAsImplementer<T,Lifetime,Slots extends Slot>{asClass(ctor:AbstractCtor<any[],T>&Ctor,ctorType:ConstructorType):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,CtorRegistration<Lifetime>>;asFactory(fn:Func<any[],T>,fnType:FunctionType):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,FactoryRegistration<Lifetime>>;asValue(value:T):RegistrationBuilder<T,Lifetime,Extract<Slots,'tag'>,ValueRegistration>;}interface IWithLifetime<T,Lifetime,Slots extends Slot,Described>{withLifetime(lifetime:Lifetime):RegistrationBuilder<T,Lifetime,Exclude<Slots,'lifetime'>,Described>;}interface ITaggedAs<T,Lifetime,Slots extends Slot,Described>{taggedAs(key:string):RegistrationBuilder<T,Lifetime,Exclude<Slots,'tag'>,Described>;}/** A registration with nothing chosen yet — what {@link Manifest.describe} opens. */type RegistrationBuilderFor<T,Lifetime>=RegistrationBuilder<T,Lifetime,'implementer'|'lifetime'|'tag',unknown>;/**
 * The chain `describe` opens. Every step hands back a new node, so a discarded intermediate
 * configures nothing — the same rule the manifest itself follows.
 */declare function openRegistration<Lifetime>(address:Type):RegistrationBuilderFor<any,Lifetime>;export{openRegistration};export type{IAsImplementer,RegistrationBuilder,RegistrationBuilderFor,Slot};