import{Type,ConstructorType,FunctionType,NamedType}from'@rhombus-std/primitives';import{RegistrationBuilderFor}from'@rhombus-std/di.core/builders';export{RegistrationBuilderFor}from'@rhombus-std/di.core/builders';type Func<in Args extends readonly any[]=any[],out Return=any,in This=unknown>=(this:This,...args:Args)=>Return;interface Ctor<in Args extends readonly any[]=any[],out Instance=any>{new(...args:Args):Instance;prototype:Instance;}type _AbstractCtor<in Args extends readonly any[]=any[],out Instance=any>=abstract new(...args:Args)=>Instance;interface AbstractCtor<in Args extends readonly any[]=any[],out Instance=any>extends _AbstractCtor<Args,Instance>{prototype:Instance;}/**
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
 * `T`, refused outright when it is assignable to `Not` — an assignability veto in a parameter
 * position, where {@link Exclude} could only filter union members.
 */type ButNot<T,Not>=T&Exclude<T,Not>;/**
 * One registration: what a manifest resolves `address` to. The member naming the
 * implementer — `ctor`, `factory`, or `value` — is what says which door the registration came in
 * by: the implementer's own type cannot (a `Func` registered as a value is handed back; the same
 * `Func` registered as a factory is called).
 */type Registration$1<Lifetime>=CtorRegistration<Lifetime>|FactoryRegistration<Lifetime>|ValueRegistration;/**
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
 */interface ValueRegistration{readonly address:Type;readonly value:unknown;}/**
 * Each factory names how the container reaches the service, which its implementer's type cannot
 * say on its own: a function registered as a VALUE is handed back, never called.
 *
 * @remarks
 * The lifetime is a separate overload rather than an optional argument so that omitting it yields
 * a registration whose lifetime is `undefined` — accepted by a vocabulary that admits omission, and
 * refused by one that does not.
 */declare function ctor<Lifetime>(address:Type,implementer:Ctor,ctorType:ConstructorType,lifetime:Lifetime):CtorRegistration<Lifetime>;declare function ctor(address:Type,implementer:Ctor,ctorType:ConstructorType):CtorRegistration<undefined>;declare function factory<Lifetime>(address:Type,implementer:Func,factoryType:FunctionType,lifetime:Lifetime):FactoryRegistration<Lifetime>;declare function factory(address:Type,implementer:Func,factoryType:FunctionType):FactoryRegistration<undefined>;/**
 * @throws TypeError - when `address` still holds a generic hole anywhere but under a callable
 * root: one erased callable honestly is every closing of its holes, while one instance cannot
 * stand for every closing of an open type.
 */declare function value(address:Type,implementer:unknown):ValueRegistration;declare const factories_ctor:typeof ctor;declare const factories_factory:typeof factory;declare const factories_value:typeof value;declare namespace factories{export{factories_ctor as ctor,factories_factory as factory,factories_value as value,};}/** Which door the registration came in by, read from the member the registration carries. */declare function kind(registration:Registration$1<unknown>):readonly['ctor',CtorRegistration<unknown>]|readonly['factory',FactoryRegistration<unknown>]|readonly['value',ValueRegistration];declare function isCtorRegistration(registration:Registration$1<any>):registration is CtorRegistration<any>;declare function isFactoryRegistration(registration:Registration$1<any>):registration is FactoryRegistration<any>;declare function isValueRegistration(registration:Registration$1<any>):registration is ValueRegistration;/**
 * Are the two registrations interchangeable — same service type and the same implementer,
 * lifetime, and implementer type?
 */declare function equals(left:Registration$1<unknown>,right:Registration$1<unknown>):boolean;declare const op_equals:typeof equals;declare const op_isCtorRegistration:typeof isCtorRegistration;declare const op_isFactoryRegistration:typeof isFactoryRegistration;declare const op_isValueRegistration:typeof isValueRegistration;declare const op_kind:typeof kind;declare namespace op{export{op_equals as equals,op_isCtorRegistration as isCtorRegistration,op_isFactoryRegistration as isFactoryRegistration,op_isValueRegistration as isValueRegistration,op_kind as kind,};}type Registration<Lifetime>=Registration$1<Lifetime>;/** The registration constructors and the operations over them, under the name of the type itself. */declare const Registration:typeof factories&typeof op;/**
 * One installed behavior's slot in the engine's installed list.
 *
 * @remarks
 * Disposing it uninstalls the behavior: install and dispose are cold, and a request that
 * activated the handle afterwards simply fails its gate.
 */interface Handle extends Disposable{/** The installed slot; an ask's gate is one comparison against it. */readonly index:number;}/**
 * The four handlers one behavior contributes, every one of them present — a `Behavior` is the same
 * four with each of them optional.
 *
 * @remarks
 * A standalone implementation of one member on its own, predefined before it's assigned, is typed
 * by indexed access — `Hooks['beginResolve']`.
 *
 * @typeParam State - the shape of the state it threads through a resolution.
 */interface Hooks<State=unknown>{/**
 * Runs once for a registered node as the planner makes it, answering the state the node's
 * dependencies are planned under — `undefined` places them under none.
 *
 * @remarks
 * A plan is made once per address and registry — lazily by the first resolution that needs it,
 * and up front wherever every address is planned at build — so this hook sees the graph moment,
 * not the resolve moment: a construction realized from an already-made plan fires no planning
 * hook, and the state threads through the planning walk alone, never into a construction.
 *
 * Declared with a second `next` parameter, this hook runs as middleware; with one, as a plain
 * handler.
 */readonly beforePlan:Func<[construction:Hooks.Construction<State>],State|undefined>;/**
 * Opens one resolution, answering the state its constructions start under.
 *
 * @remarks
 * Declared with a third `next` parameter, this hook runs as middleware; with two, as a plain
 * handler.
 */readonly beginResolve:Func<[request:Request,injected:State],State>;/**
 * Runs before the engine constructs, answering a result in place of constructing or the state the dependencies resolve under.
 *
 * @remarks
 * Declared with a second `next` parameter, this hook runs as middleware; with one, as a plain
 * handler.
 */readonly beforeConstruct:Func<[construction:Hooks.Construction<State>],Hooks.Interception<State>>;/**
 * Swaps the instance the engine has just constructed for the one this hook answers — a proxy, a
 * frozen copy, a decorator — everything downstream reading what it returns.
 *
 * @remarks
 * Runs only where the engine BUILT: a beforeConstruct that supplied a result skips it entirely. The
 * engine hands over the raw product and takes back whatever is answered: it never tests for a
 * thenable, never awaits, and never unwraps, so a construction that produced a pending promise
 * arrives here as that promise.
 *
 * Declared with a third `next` parameter, this hook runs as middleware; with two, as a plain
 * handler.
 */readonly canonicalize:Func<[construction:Hooks.Construction<State>,instance:unknown],unknown>;/**
 * Runs once the engine has constructed, on the instance as it stands — never awaited, never unwrapped.
 *
 * @remarks
 * Declared with a third `next` parameter, this hook runs as middleware; with two, as a plain
 * handler.
 */readonly afterConstruct:Func<[construction:Hooks.Construction<State>,instance:unknown],void>;}declare namespace Hooks{/**
 * One construction the engine is performing, as one behavior sees it.
 *
 * @typeParam State - the shape of the state these handlers thread through a resolution.
 */interface Construction<State=unknown>{/** This node's position in the resolution: one per node, referentially stable, opaque. */readonly node:object;/** The address this node answers, as it was requested, with any captures filled in. */readonly populatedAddress:Type;/** The registration this construction realizes. */readonly registration:Registration<unknown>;/** This behavior's own state, as the enclosing construction left it — never this node's own answer, and never anyone else's. */readonly state:State;}/** What a pre-construction handler answers: a result in place of constructing, or the state this construction's dependencies resolve under — `undefined` placing them under none. */type Interception<State=unknown>={readonly result:unknown;}|{readonly state:State|undefined;};}/** Resolves service instances by {@link Type}. */interface IServiceProvider{/** Internal use only. Use {@link resolve} instead. */
getService(address:Type):any;}/**
 * What flows through the middleware chain for one ask: the address being resolved, and whatever a
 * middleware attaches on the way down under a symbol it exports.
 *
 * @remarks
 * The two inheritors are the ask's arms — {@link ServiceRequest} for an ask a provider opened,
 * {@link ControlRequest} for one a middleware makes at fold time — told apart by `instanceof`.
 * A slot naming an arm is answered with the ask in flight only when the ask IS that arm; a slot
 * naming this base class is answered with either.
 *
 * The index signature declares the attachment mechanism without naming any contents, so a core
 * type carries no lifetime vocabulary while an addon still attaches what it needs under a symbol
 * it exports. A string key would be reachable by anyone who types the same string with nothing
 * recording that they did; an imported symbol is reachable only through an import a reviewer can
 * see. Attachment happens on the way DOWN, before `next` — the object is shared with every layer
 * beneath and with the engine, so a write on the unwind is invisible to everything it was meant for.
 */declare abstract class Request{readonly address:Type;/** The staged-hook handles this ask activated, in activation order. */private readonly active;[key:symbol]:unknown;constructor(address:Type);/**
 * Records `handle` as active for this ask and answers the same request — a middleware layer
 * writes `next(request.activate(handle))`.
 */
activate(handle:Handle):this;}/** An ask a provider opened, carrying the provider so the ask resolves back to it. */declare class ServiceRequest extends Request{readonly serviceProvider:IServiceProvider;constructor(address:Type,serviceProvider:IServiceProvider);}/** An ask a middleware makes at fold time, before any provider exists. */declare class ControlRequest extends Request{}/**
 * The container's one request-grain pipeline type: what the builder composes around the engine,
 * and what an addon's own contribution rides too.
 *
 * @remarks
 * The chain composes once, at build: a factory runs exactly once, and may do install-time work of
 * its own there — planting a permanent hook, sweeping the manifest — resolving through `next`
 * whatever that work needs, which resolves at build time. The function it answers is what each
 * request runs through from then on.
 *
 * One traversal serves one ask, and everything reached through `next` belongs to it: a request
 * substituted for the one that arrived, or resolved beside it, is answered in that ask's context —
 * its scope, and whatever its asker put under it — exactly as the ask itself would be. Middleware
 * wanting a resolution of its own asks a provider instead, injected or closed over, which opens an
 * ask of its own. A `next` held onto and called after its traversal has answered belongs to no ask
 * at all, and resolves under nothing.
 */type Middleware=Func<[next:GetService],GetService>;/** The resolution function one ask runs through: a request in, whatever answers it out. */type GetService=Func<[request:Request],unknown>;/**
 * One addon a builder installs.
 *
 * @remarks
 * The addon itself is the reusable handle — a plain object or an instance carrying whatever state
 * it was constructed with. Everything one container needs of its own is minted by {@link create},
 * which the builder calls once per installation, so installing the same addon on two builders
 * shares nothing between the two containers.
 *
 * @typeParam Lifetime - the lifetime vocabulary this addon's registrations name values from.
 */interface Addon<Lifetime>{/** Opens one installation of this addon. */
create():AddonInstallation<Lifetime>;}/**
 * What one installation of an addon contributes: the registrations it files and the middleware it
 * composes into the container's one chain.
 *
 * @typeParam Lifetime - the lifetime vocabulary this installation's registrations name values from.
 */interface AddonInstallation<Lifetime>{/** Registrations filed beneath the user's own, above the lifetime model's floor; the lifetime each carries is the model's to read at runtime. */readonly registrations:Iterable<Registration<Lifetime>>;/**
 * Middleware the builder composes into the container's one chain, alongside every other
 * installation's, in call order.
 *
 * @remarks
 * Composes once, at build — see {@link Middleware}'s own remarks for what that means. An
 * installation that only needs install-time work does that work directly here and returns `next`
 * unchanged.
 */readonly middleware:Middleware;}/**
 * The koa pattern: a handler's middleware form is the same signature with a trailing `next` —
 * standing for everything beneath this layer — appended to the argument list, called in `next`'s
 * own place rather than run for it automatically.
 */type Koa<Handler>=Handler extends Func<infer Args extends readonly unknown[],infer Answer>?Func<[...Args,next:Handler],Answer>:never;/**
 * One contribution to what a resolution runs through: any of the four hooks, none of them required.
 *
 * @remarks
 * Every member takes either a plain handler — {@link Hooks}' own shape for it — or middleware for
 * that hook, the {@link Koa} form: the same signature with a trailing `next`, everything composed
 * beneath it run by calling it. Form is chosen by arity — a hook declaring more parameters than its
 * handler form is middleware.
 *
 * State is this behavior's own: a hook is handed the bare value and what it answers goes straight
 * back, so no state another behavior threads is reachable from here and none of this one's is
 * reachable from there. What a middleware's `next` answers therefore carries the outcome alone — a
 * result standing in place of the construction, or the very state the middleware handed it, meaning
 * everything beneath ran and had nothing to report.
 *
 * A standalone implementation of one member on its own, predefined before it's assigned, is typed
 * by indexed access — `Behavior['beforeConstruct']`.
 *
 * @typeParam State - the shape of the state these handlers thread through a resolution.
 */type Behavior<State=any>={readonly[K in keyof Hooks<State>]?:Hooks<State>[K]|Koa<Hooks<State>[K]>;};/** True for a union, false for anything else — including `never`, which distributes to nothing. */type IsUnion<T,Members=T>=T extends unknown?([Members]extends[T]?false:true):never;declare const TOKEN:unique symbol;/**
 * Pins one arg's service type, overriding the type it would otherwise
 * derive from its own declaration.
 *
 * @remarks
 * The value type stays `T` — a plain `T` remains assignable, because the brand
 * property is optional.
 *
 * @example
 * ```ts
 * class Handler {
 *   public constructor(
 *     cache: Inject<ICache, 'pkg:redis-cache'>, // pinned
 *     log: ILogger, // derived
 *   ) {}
 * }
 * ```
 */type Inject<T,K extends string>=T&{readonly[TOKEN]?:K;};/**
 * Marks a constructor arg that receives the {@link NamedType} of a type argument instead of a
 * resolved instance of it — `Logger<T>` naming its category after `T` rather than constructing one.
 *
 * @remarks
 * A bare type argument in a signature already means "resolve the service of the closing type", so
 * the witness has to be spelled differently; this is that spelling.
 *
 * A witness is only useful when the type has a name to read, so anything else resolves to `never`
 * and is refused where it is written rather than arriving as an `undefined` name. The refusal is
 * type-level because it has to hold for a caller who never runs the transformer.
 *
 * Witnesses for different types do not interchange, so a swapped one is refused where it is passed.
 * Two structurally identical types are one type here as everywhere, and share a witness.
 *
 * @example
 * ```ts
 * class Logger<T> {
 *   public constructor(factory: ILoggerFactory, category: Typeof<T>) {
 *     this.#logger = factory.createLogger(category.name);
 *   }
 * }
 * ```
 */declare const WITNESS:unique symbol;type Typeof<T>=IsUnion<T>extends true?never:[T]extends[Func<never[],unknown>]?never:NamedType&{readonly[WITNESS]?:T;};/**
 * The engine's own control surface, reached through the door like any service: a middleware asks
 * for it at fold time with `next(new ControlRequest(typefor<ControlService>()))`.
 */interface ControlService{/**
 * The registrations the engine resolves against, newest first.
 *
 * @remarks
 * The engine's own two rows — `IServiceProvider` and this control — carry a `null` lifetime.
 */readonly registry:Iterable<Registration<unknown>>;/**
 * Installs `hooks` gated: they run only for an ask that activated the answered handle —
 * a layer writes `next(request.activate(handle))`. Disposing the handle uninstalls them.
 */
stageHooks(hooks:Partial<Behavior>):Handle;/**
 * Installs `hooks` always active: they run for every ask, outermost, ahead of every staged
 * behavior. Disposing the handle uninstalls them.
 */
installHooks(hooks:Partial<Behavior>):Handle;}/**
 * The root every error the container raises extends.
 *
 * @remarks
 * A library holding only the abstractions can tell a container failure from anything else with
 * one check, without naming the engine or knowing which failure it was:
 *
 * ```ts
 * catch (error) {
 *   if (error instanceof DiError) {
 *     return fallback;
 *   }
 *   throw error;
 * }
 * ```
 *
 * Reach for a leaf type when the distinction matters — {@link UnsatisfiableError} is a candidate
 * to fall back from, while {@link CycleError} is a fault in the registrations that a fall-back
 * handler should let through.
 */declare abstract class DiError extends Error{}/**
 * Nothing in the manifest can produce a value for {@link address}.
 *
 * @remarks
 * Catch this to fall back to another candidate — a union member, a later signature.
 * Anything else escaping a resolution is a fault rather than an unsatisfiable
 * request, so a handler that swallows it should rethrow what it does not recognise:
 *
 * ```ts
 * catch (error) {
 *   if (error instanceof UnsatisfiableError) {
 *     return undefined;
 *   }
 *   throw error;
 * }
 * ```
 */declare class UnsatisfiableError extends DiError{/** The service type that could not be resolved. */readonly address:Type;constructor(address:Type,reason:string,cause?:UnsatisfiableError);}/**
 * A type was requested again while it was still being lowered — the graph loops, so no order
 * of constructions satisfies it.
 *
 * @remarks
 * Deliberately not an {@link UnsatisfiableError}: a loop is a fault in the registrations rather
 * than a candidate to fall back from, so a handler swallowing unsatisfiable requests lets this
 * through.
 */declare class CycleError extends DiError{/** The path that closed the loop, outermost first, ending in the repeat. */readonly chain:readonly Type[];constructor(chain:readonly Type[]);}/**
 * The installed lifetime model threw while realizing {@link address} — the model's own code,
 * not the construction it was asked to perform. The model's error is the `cause`.
 *
 * @remarks
 * Deliberately not an {@link UnsatisfiableError}: a throwing model is a fault in the installed
 * engine rather than a candidate to fall back from.
 */declare class LifetimeModelError extends DiError{/** The service type whose realization the model failed. */readonly address:Type;constructor(address:Type,cause:unknown);}/**
 * A registration is addressed by a bare type parameter, which unifies with every request — so it
 * answers every address no newer registration already answers.
 */declare class UniversalAddressError extends DiError{/** The address that is nothing but a hole. */readonly address:Type;constructor(address:Type);}/**
 * A resolution or scope opening reached a provider whose container or scope is already disposed —
 * the standard lifetime model's refusal, a clone of the one
 * Microsoft.Extensions.DependencyInjection raises.
 *
 * @remarks
 * Disposing a scope's provider refuses every later ask through it; disposing the container's
 * refuses every later ask through every provider, and refuses opening a scope.
 */declare class ObjectDisposedError extends DiError{constructor();}/** One registration that could not be lowered. */interface ValidationFailure{/** The service type of the registration that failed. */readonly address:Type;/** What lowering it produced — an {@link UnsatisfiableError}, a {@link CycleError}, or a fault. */readonly error:Error;}/**
 * Every registration an up-front validation pass could not lower, raised together so one attempt
 * surfaces the whole broken graph instead of its first fault. {@link errors} carries the failures
 * themselves, positionally matching {@link failures}.
 */declare class ManifestValidationError extends DiError{/** Each failure paired with the registration it came from. */readonly failures:readonly ValidationFailure[];/** The failures themselves, positionally matching {@link failures}. */readonly errors:readonly Error[];constructor(failures:readonly ValidationFailure[]);}/**
 * The provider of a scope, whose disposal ends that scope.
 *
 * @remarks
 * Disposable in both forms — `using` and `await using` alike. Disposing releases whatever its
 * subscribers hold for that particular provider, is idempotent, and costs nothing where nobody
 * subscribed. Disposal flows from the holder into the provider, never through
 * {@link IServiceProvider.getService}.
 */interface IDisposableServiceProvider extends IServiceProvider,Disposable,AsyncDisposable{}/**
 * Calls `callable`, its dependencies resolved from the constructor or function type it closes
 * over — the same shape any other registered implementer carries.
 *
 * @remarks
 * Nothing registers one — the engine answers the address by synthesis; `resolve`'s callable
 * overloads are the usual door.
 */interface Invoker<C extends Ctor|Func>{(callable:C):C extends Ctor<any[],infer R>?R:C extends Func<any[],infer R>?R:never;}/**
 * Opens scopes under the standard lifetime model — a clone of
 * Microsoft.Extensions.DependencyInjection's `IServiceScopeFactory`. One instance per container,
 * resolvable from every provider, always the same one.
 *
 * @remarks
 * Every scope it opens is a direct child of the container, never of the scope the factory was
 * resolved from: scopes are flat, and share nothing but the container's singletons. A singleton may
 * hold the factory — it is a value, never constructed, so it trips no scope validation.
 *
 * @example
 * ```ts
 * using scope = provider.resolve(typefor<IServiceScopeFactory>()).openScope();
 * const repo = scope.resolve(typefor<IRepo>());
 * ```
 */interface IServiceScopeFactory{/**
 * A new scope's provider, independent of every other scope; disposing it ends the scope.
 *
 * @throws {ObjectDisposedError} once the container is disposed.
 */
openScope():IDisposableServiceProvider;}/**
 * Opens scopes under the tagged lifetime model: one per tag of the vocabulary, each over the
 * provider this factory was resolved from, so a scope opened from a scoped provider chains onto it.
 *
 * @remarks
 * The factory is constructed afresh on every resolution and bound to the provider the ask came
 * from — asked for directly or injected, it opens scopes over that provider. An ask through a
 * scope is checked by every scope on its chain, the innermost first, and a hit anywhere answers
 * the cached instance; a registration whose tag no open scope on the chain carries is constructed
 * afresh, as a registration naming no lifetime always is.
 *
 * @typeParam Lifetime - the vocabulary exactly as the container spells it, `undefined` included;
 * `openScope` takes every member but `undefined`, since no scope holds transients.
 *
 * @example
 * ```ts
 * type Lifetime = 'session' | 'request' | undefined;
 *
 * using session = provider.resolve(typefor<ITaggedServiceScopeFactory<Lifetime>>()).openScope('session');
 * using request = session.resolve(typefor<ITaggedServiceScopeFactory<Lifetime>>()).openScope('request');
 * const current = request.resolve(typefor<Session>()); // one per session scope, reached from the request scope
 * ```
 */interface ITaggedServiceScopeFactory<Lifetime>{/**
 * A provider caching registrations of `lifetime` alone, chained onto the provider this factory
 * came from; disposing it ends the scope.
 */
openScope(lifetime:Exclude<Lifetime,undefined>):IDisposableServiceProvider;}/** Lets the lifetime argument be omitted entirely when `undefined` is in the vocabulary. */type LifetimeArgument<Lifetime>=undefined extends Lifetime?[lifetime?:Lifetime]:[lifetime:Lifetime];/**
 * An immutable registration ledger: an iterable chain of {@link Registration}s. Every
 * registration verb returns a NEW manifest rather than mutating the receiver, so a discarded
 * result registers nothing.
 *
 * @remarks
 * `add`/`remove`/`replace` are the substrate every other registration verb composes from; each
 * also carries sugared shapes contributed by augmentation. Iterating a manifest yields its
 * registrations newest-registration-first. A verb that changes nothing returns the receiver
 * itself, so `===` answers "did this change anything" and an unchanged manifest keeps its
 * cached plans.
 */interface Manifest<Lifetime>extends Iterable<Registration<Lifetime>>{/** Prepends `registration`, ahead of every registration already in the chain. */
_add(registration:Registration<Lifetime>):Manifest<Lifetime>;/**
 * Swaps in `registration` for the first registration registered under the same service type, leaving
 * every other registration untouched.
 */
_replace(registration:Registration<Lifetime>):Manifest<Lifetime>;/** Drops the registration that is {@link Registration.equals} to `registration`, if one is present. */
_remove(registration:Registration<Lifetime>):Manifest<Lifetime>;}declare namespace Manifest{function empty<Lifetime>():Manifest<Lifetime>;/** The registrations `fn` composes onto an empty manifest. */function build<Lifetime>(fn:Func<[Manifest<Lifetime>],Iterable<Registration<Lifetime>>>):Iterable<Registration<Lifetime>>;}interface DefaultManifest<Lifetime>extends Manifest<Lifetime>{}declare class DefaultManifest<Lifetime>implements Manifest<Lifetime>{readonly[Symbol.iterator]:Func<[],Iterator<Registration<Lifetime>>>;constructor();constructor(registrations:Iterable<Registration<Lifetime>>);constructor(generator:Func<[],Iterator<Registration<Lifetime>>>);_add(registration:Registration<Lifetime>):Manifest<Lifetime>;_remove(registration:Registration<Lifetime>):Manifest<Lifetime>;_replace(registration:Registration<Lifetime>):DefaultManifest<Lifetime>;}/**
 * The standard lifetime model's vocabulary — a clone of Microsoft.Extensions.DependencyInjection's
 * service lifetimes.
 *
 * @remarks
 * Every constructed registration names one; a value registration carries none and is handed
 * back as it stands, exactly as a pre-built instance is under
 * Microsoft.Extensions.DependencyInjection.
 *
 * - `'singleton'` — one instance per container, shared by every scope, disposed with the container.
 * - `'scoped'` — one instance per opened scope, disposed with that scope.
 * - `'transient'` — a fresh instance per ask and per injection site, disposed with whichever scope
 *   the ask ran under.
 */type StandardLifetime='singleton'|'scoped'|'transient';declare module'@rhombus-std/di.core'{interface Manifest<Lifetime>{/** Prepends `registration`, ahead of every registration already in the chain. */
add(registration:Registration<Lifetime>):Manifest<Lifetime>;/**
 * Merges `manifest`'s registrations in as one batch, ahead of everything already in the
 * chain, in `manifest`'s own order.
 */
add(manifest:Manifest<Lifetime>):Manifest<Lifetime>;/**
 * Files each registration in `registrations` in turn, exactly as calling {@link Manifest.add}
 * for each in order would — the last one ends up newest. A `Manifest` binds the wholesale-merge
 * overload above instead, order preserved.
 */
add(registrations:ButNot<Iterable<Registration<Lifetime>>,Manifest<any>>):Manifest<Lifetime>;/**
 * Swaps in `registration` for the first registration registered under the same service type, leaving
 * every other registration untouched.
 */
replace(registration:Registration<Lifetime>):Manifest<Lifetime>;/** Drops the registration that is {@link Registration.equals} to `registration`, if one is present. */
remove(registration:Registration<Lifetime>):Manifest<Lifetime>;/** Adds each registration whose service type has no registration yet. */
tryAdd(...registrations:ReadonlyArray<Registration<Lifetime>>):Manifest<Lifetime>;/** Registers `ctor` — constructed with `new` — as the implementation of `address`. */
add(address:Type,ctor:Ctor,ctorType:ConstructorType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s constructor shape, registering only when the service type has no registration yet. */
tryAdd(address:Type,ctor:Ctor,ctorType:ConstructorType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s constructor shape, replacing the service type's existing registration. */
replace(address:Type,ctor:Ctor,ctorType:ConstructorType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** Registers `factory` — called, never `new`ed — as the producer of `address`. */
add(address:Type,factory:Func,factoryType:FunctionType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s factory shape, registering only when the service type has no registration yet. */
tryAdd(address:Type,factory:Func,factoryType:FunctionType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/** {@link Manifest.add}'s factory shape, replacing the service type's existing registration. */
replace(address:Type,factory:Func,factoryType:FunctionType,...lifetime:LifetimeArgument<Lifetime>):Manifest<Lifetime>;/**
 * Registers a non-callable `value` under `address` as it stands: it is handed back on
 * resolution, never constructed or called. A callable cannot come in this door — its own
 * type cannot say it is data — so a function meant as a value goes through
 * {@link Manifest.addValue}.
 */
add<Value>(address:Type,value:ButNot<Value,Func|AbstractCtor>):Manifest<Lifetime>;/** {@link Manifest.add}'s value shape, registering only when the service type has no registration yet. */
tryAdd<Value>(address:Type,value:ButNot<Value,Func|AbstractCtor>):Manifest<Lifetime>;/** {@link Manifest.add}'s value shape, replacing the service type's existing registration. */
replace<Value>(address:Type,value:ButNot<Value,Func|AbstractCtor>):Manifest<Lifetime>;/**
 * {@link Manifest.add}'s value shape as its own verb: the door that forces a callable down
 * the value path, and takes any value besides.
 */
addValue(address:Type,value:unknown):Manifest<Lifetime>;/** {@link Manifest.addValue}, registering only when the service type has no registration yet. */
tryAddValue(address:Type,value:unknown):Manifest<Lifetime>;/** {@link Manifest.addValue}, replacing the service type's existing registration. */
replaceValue(address:Type,value:unknown):Manifest<Lifetime>;/**
 * Opens a registration chain for `address`: choose the implementer through one of the
 * `as*` doors, refined by `withLifetime`/`taggedAs`. Once a door is taken the node IS a
 * {@link Registration} — hand it to the registration-taking verbs, hold it in a variable,
 * or build several in a helper and register them together.
 */
describe(address:Type):RegistrationBuilderFor<any,Lifetime>;/** Drops the first registration registered for `address`, if one is present. */
remove(address:Type):Manifest<Lifetime>;/** Drops every registration registered for `address`, leaving every other entry untouched. */
removeAll(address:Type):Manifest<Lifetime>;}}declare module'@rhombus-std/di.core'{interface IServiceProvider{/**
 * Every registration of `address`, as one sequence. Nothing registered is an empty
 * sequence rather than an absence, so this neither throws nor answers `undefined`.
 */
resolveMany(address:Type):Iterable<any>;/**
 * The value registered for `address`.
 *
 * @remarks
 * A caller for whom absence is an answer rather than a fault spells that in the address it
 * asks for: `resolve(Type.union(address, typefor<undefined>()))` orders the `undefined`
 * literal last, so it answers only once `address` itself has no way to build.
 *
 * @throws UnsatisfiableError - when nothing can produce `address`.
 */
resolve(address:Type):any;/**
 * The value registered for `address`, delivered asynchronously: every dependency beneath it
 * that arrives as a promise is awaited before the value is handed over.
 *
 * @remarks
 * Equivalent to asking for `Promise<address>` through {@link resolve}, and the same registration
 * answers either spelling.
 *
 * @throws UnsatisfiableError - when nothing can produce `address`.
 */
resolveAsync(address:Type):Promise<any>;/**
 * Constructs `ctor` fresh, its dependencies resolved from `ctorType` — `ctor`'s own arg
 * types, in order, the same shape {@link ConstructorType} carries for any other registered
 * constructor.
 *
 * @remarks
 * Nothing here is registered or cached: two calls build two instances, even for a `ctor`
 * separately registered elsewhere under its own address.
 */
resolve<R>(ctorType:ConstructorType,ctor:Ctor<any[],R>):R;/**
 * Calls `func`, its dependencies resolved from `funcType` — `func`'s own arg types, in
 * order, the same shape {@link FunctionType} carries for any other registered factory.
 *
 * @remarks
 * Nothing here is registered or cached: two calls build two results, even for a `func`
 * separately registered elsewhere under its own address.
 */
resolve<R>(funcType:FunctionType,func:Func<any[],R>):R;}}export{ControlRequest,CycleError,DefaultManifest,DiError,Hooks,LifetimeModelError,Manifest,ManifestValidationError,ObjectDisposedError,Registration,Request,ServiceRequest,UniversalAddressError,UnsatisfiableError};export type{Addon,AddonInstallation,Behavior,ControlService,CtorRegistration,FactoryRegistration,GetService,Handle,IDisposableServiceProvider,IServiceProvider,IServiceScopeFactory,ITaggedServiceScopeFactory,Inject,Invoker,Koa,LifetimeArgument,Middleware,StandardLifetime,Typeof,ValidationFailure,ValueRegistration};