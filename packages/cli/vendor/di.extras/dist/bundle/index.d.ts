import{CtorRegistration as CtorRegistration$1,FactoryRegistration as FactoryRegistration$1,LifetimeArgument,Registration,RegistrationBuilderFor,Manifest,IServiceProvider}from'@rhombus-std/di.core';import{Type,ConstructorType,FunctionType}from'@rhombus-std/primitives';import{Flatten,Ctor,Func,AbstractCtor,ButNot}from'@rhombus-toolkit/types';/**
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
 */interface IAsImplementer<T,Lifetime,Slots extends Slot>{asClass(ctor:AbstractCtor<any[],T>&Ctor,ctorType:ConstructorType):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,CtorRegistration<Lifetime>>;asFactory(fn:Func<any[],T>,fnType:FunctionType):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,FactoryRegistration<Lifetime>>;asValue(value:T):RegistrationBuilder<T,Lifetime,Extract<Slots,'tag'>,ValueRegistration>;}interface IWithLifetime<T,Lifetime,Slots extends Slot,Described>{withLifetime(lifetime:Lifetime):RegistrationBuilder<T,Lifetime,Exclude<Slots,'lifetime'>,Described>;}interface ITaggedAs<T,Lifetime,Slots extends Slot,Described>{taggedAs(key:string):RegistrationBuilder<T,Lifetime,Exclude<Slots,'tag'>,Described>;}declare module'@rhombus-std/di.core/builders'{interface IAsImplementer<T,Lifetime,Slots extends Slot>{/**
 * Takes the constructor door with the implementer's type observed from `ctor` instead of
 * taken explicitly.
 */
asClass(ctor:AbstractCtor<any[],T>&Ctor):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,CtorRegistration$1<Lifetime>>;/**
 * Takes the factory door with the producer's type observed from `fn` instead of taken
 * explicitly.
 */
asFactory(fn:Func<any[],T>):RegistrationBuilder<T,Lifetime,Exclude<Slots,'implementer'>,FactoryRegistration$1<Lifetime>>;}}declare const AsImplementerRegistrationAugmentations:{asClass(this:IAsImplementer<any,any,Slot>,ctor:Ctor):RegistrationBuilder<any,any,Exclude<Slot,"implementer">,CtorRegistration$1<any>>;asFactory(this:IAsImplementer<any,any,Slot>,fn:Func):RegistrationBuilder<any,any,Exclude<Slot,"implementer">,FactoryRegistration$1<any>>;};declare module'@rhombus-std/di.core'{interface Manifest<Lifetime>{/**
 * Registers a constructor as the implementation of `ServiceType`, the service type derived from the
 * type argument instead of taken explicitly.
 */
add<ServiceType>(implementer:Ctor<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/**
 * Registers a factory as the producer of `ServiceType`, the service type derived from the
 * type argument instead of taken explicitly.
 */
add<ServiceType>(implementer:Func<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/**
 * Registers a non-callable `value` as-is under `ServiceType`, the service type derived from
 * the type argument instead of taken explicitly. A callable lands on the shapes above
 * instead; {@link Manifest.addValue} is the door that forces one down the value path. A
 * registration stream lands on {@link Manifest.add}'s own batch shape instead, so this
 * overload never captures it either.
 */
add<ServiceType>(value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>|Iterable<Registration<any>>>):Manifest<Lifetime>;/**
 * Registers `value` as-is under `ServiceType`, the service type derived from the type
 * argument instead of taken explicitly.
 */
addValue<ServiceType>(value:ServiceType):Manifest<Lifetime>;/** {@link Manifest.add}'s constructor shape, registering only when the service type has no registration yet. */
tryAdd<ServiceType>(implementer:Ctor<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s factory shape, registering only when the service type has no registration yet. */
tryAdd<ServiceType>(implementer:Func<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s value shape, registering only when the service type has no registration yet. */
tryAdd<ServiceType>(value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>>):Manifest<Lifetime>;/** {@link Manifest.addValue}, registering only when the service type has no registration yet. */
tryAddValue<ServiceType>(value:ServiceType):Manifest<Lifetime>;/** {@link Manifest.add}'s constructor shape, replacing the service type's existing registration. */
replace<ServiceType>(implementer:Ctor<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s factory shape, replacing the service type's existing registration. */
replace<ServiceType>(implementer:Func<any[],ServiceType>,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s value shape, replacing the service type's existing registration. */
replace<ServiceType>(value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>>):Manifest<Lifetime>;/** {@link Manifest.addValue}, replacing the service type's existing registration. */
replaceValue<ServiceType>(value:ServiceType):Manifest<Lifetime>;/**
 * Drops every registration of `ServiceType`, the service type derived from the type argument
 * instead of taken explicitly.
 */
removeAll<ServiceType>():Manifest<Lifetime>;/**
 * {@link Manifest.describe} with `ServiceType` derived from the type argument instead of
 * taken explicitly.
 */
describe<ServiceType>():RegistrationBuilderFor<ServiceType,Lifetime>;}}declare const ManifestRegistrationAugmentations:{add<ServiceType>(this:Manifest<unknown>,implementer:any,lifetime?:unknown):Manifest<unknown>;addValue<ServiceType>(this:Manifest<unknown>,value:ServiceType):Manifest<unknown>;tryAdd<ServiceType>(this:Manifest<unknown>,implementer:any,lifetime?:unknown):Manifest<unknown>;tryAddValue<ServiceType>(this:Manifest<unknown>,value:ServiceType):Manifest<unknown>;replace<ServiceType>(this:Manifest<unknown>,implementer:any,lifetime?:unknown):Manifest<unknown>;replaceValue<ServiceType>(this:Manifest<unknown>,value:ServiceType):Manifest<unknown>;removeAll<ServiceType>(this:Manifest<unknown>):Manifest<unknown>;describe<ServiceType>(this:Manifest<unknown>):RegistrationBuilderFor<any,unknown>;};declare const ManifestRegistrationValueAugmentations:{add<ServiceType>(this:Manifest<unknown>,value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>|Iterable<Registration<any>>>):Manifest<unknown>;tryAdd<ServiceType>(this:Manifest<unknown>,value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>>):Manifest<unknown>;replace<ServiceType>(this:Manifest<unknown>,value:ButNot<ServiceType,Func|AbstractCtor|Registration<any>>):Manifest<unknown>;};declare module'@rhombus-std/di.core'{interface IServiceProvider{/**
 * The value registered for `ServiceType`, the service type derived from the type argument
 * instead of taken explicitly.
 *
 * @throws UnsatisfiableError - when nothing can produce `ServiceType`.
 */
resolve<ServiceType>():ServiceType;/**
 * The value registered for `ServiceType`, the service type derived from the type argument
 * instead of taken explicitly, delivered asynchronously — every dependency beneath it that
 * arrives as a promise is awaited before the value is handed over.
 *
 * @throws UnsatisfiableError - when nothing can produce `ServiceType`.
 */
resolveAsync<ServiceType>():Promise<ServiceType>;/**
 * Every registration of `ServiceType`, the service type derived from the type argument
 * instead of taken explicitly, as one sequence.
 */
resolveMany<ServiceType>():Iterable<ServiceType>;}}declare const ServiceProviderServiceAugmentations:{resolve<ServiceType>(this:IServiceProvider):ServiceType;resolveAsync<ServiceType>(this:IServiceProvider):Promise<ServiceType>;resolveMany<ServiceType>(this:IServiceProvider):Iterable<ServiceType>;};export{AsImplementerRegistrationAugmentations,ManifestRegistrationAugmentations,ManifestRegistrationValueAugmentations,ServiceProviderServiceAugmentations};