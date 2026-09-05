import{Addon,StandardLifetime,DiError,Manifest,Registration,IDisposableServiceProvider}from'@rhombus-std/di.core';export{CycleError,DiError,ManifestValidationError,Middleware,ObjectDisposedError,UniversalAddressError,UnsatisfiableError,ValidationFailure}from'@rhombus-std/di.core';import{Type}from'@rhombus-std/primitives';/**
 * The standard lifetime model as an addon: singleton, scoped and transient, a clone of
 * Microsoft.Extensions.DependencyInjection's lifetimes on this repository's own API.
 *
 * @example
 * ```ts
 * await using provider = Builder
 *   .useAddon(standardLifetime())
 *   .withServices(m => m.add(typefor<IRepo>(), SqlRepo, typefor(SqlRepo), 'scoped'))
 *   .build();
 *
 * using scope = provider.resolve(typefor<IServiceScopeFactory>()).openScope();
 * const repo = scope.resolve(typefor<IRepo>());
 * ```
 */declare function standardLifetime():Addon<StandardLifetime>;/**
 * A scoped registration reached under the singleton scope: resolved outside an opened scope, or
 * consumed by a singleton — the conditions Microsoft.Extensions.DependencyInjection's scope
 * validation refuses.
 */declare class ScopeValidationError extends DiError{/** The scoped service type that was reached. */readonly address:Type;constructor(address:Type);}/**
 * Optional layer over {@link standardLifetime} refusing a scoped registration reached under the
 * singleton scope — a clone of Microsoft.Extensions.DependencyInjection's `ValidateScopes`, off
 * unless added.
 *
 * @remarks
 * Two checks, both raising {@link ScopeValidationError}: a scoped registration resolved outside an
 * opened scope, directly or beneath a transient, checked on every ask; and a scoped
 * registration consumed by a singleton — directly, through a transient, or through another
 * singleton — checked wherever the singleton's dependencies are constructed, from any provider. A
 * singleton holding {@link IServiceScopeFactory} trips neither: the factory is a value, never
 * constructed. Only a registration's own lifetime is read, so the last registration of an address
 * decides a single ask and each element of a collection ask is checked as it is walked.
 *
 * @example
 * ```ts
 * const provider = Builder
 *   .useAddon(standardLifetime())
 *   .useAddon(validateScopes())
 *   .withServices(m => m.add(typefor<IRepo>(), SqlRepo, typefor(SqlRepo), 'scoped'))
 *   .build();
 *
 * provider.resolve(typefor<IRepo>()); // throws ScopeValidationError
 * ```
 */declare function validateScopes():Addon<StandardLifetime>;/**
 * The tagged lifetime model as an addon over the vocabulary of the caller's choosing: a scope per
 * tag, opened in any order and nested in any order, each caching the registrations of its own tag
 * alone.
 *
 * @remarks
 * The built provider caches nothing and captures nothing; it only hands out
 * {@link ITaggedServiceScopeFactory}, whose `openScope(tag)` answers a provider caching the
 * registrations tagged `tag`. A factory resolved from a scope opens scopes chained onto that
 * scope, so an ask entering a `'request'` scope opened inside a `'session'` scope is checked by
 * both: a hit anywhere on the chain, the innermost scope first, answers the cached instance, and a
 * miss constructs under the scope carrying the registration's tag. A registration whose tag no
 * scope on the chain carries, or whose lifetime is `undefined` or omitted, is constructed afresh on
 * every ask and is never captured for disposal. A value registration is handed back as it stands.
 *
 * What a construction produced is what is cached, a promise included, so concurrent asynchronous
 * asks share one pending construction; a promise that rejects is forgotten, and its settled value
 * is what disposal reaches. A construction that throws caches nothing.
 *
 * Disposing a scope's provider disposes what that scope owns, most recently constructed first, each
 * instance once; every error is collected — one rethrows as itself, several as one
 * `AggregateError` — and the scope, with every scope opened beneath it, refuses every later ask
 * with {@link ObjectDisposedError}. Disposing the built provider refuses every provider from then
 * on; what an open scope owns is disposed only with that scope. The synchronous dispose counts an
 * instance offering only `Symbol.asyncDispose` as an error; the asynchronous dispose awaits each
 * such instance and calls the rest synchronously.
 *
 * @typeParam Lifetime - the vocabulary exactly as the caller spells it, `undefined` included;
 * the model reads each registration's `lifetime` as one of its tags.
 *
 * @example
 * ```ts
 * type Lifetime = 'session' | 'request' | undefined;
 *
 * await using provider = Builder
 *   .useAddon(taggedLifetime<Lifetime>())
 *   .withServices(m => m.add(typefor<Session>(), Session, typefor(Session), 'session'))
 *   .build();
 *
 * using session = provider.resolve(typefor<ITaggedServiceScopeFactory<Lifetime>>()).openScope('session');
 * using request = session.resolve(typefor<ITaggedServiceScopeFactory<Lifetime>>()).openScope('request');
 * const current = request.resolve(typefor<Session>()); // constructed once per session scope
 * ```
 */declare function taggedLifetime<Lifetime>():Addon<Lifetime>;/**
 * Installs a middleware rejecting a registration addressed by nothing but a hole — no request
 * could ever close it, so it can never answer one.
 *
 * @remarks
 * Such a registration matches every ask — this addon's own control ask included — so a manifest
 * already carrying one usually poisons the registry read itself, and the refusal then comes from
 * the control guard rather than as a per-registration failure.
 *
 * @throws {ManifestValidationError} when any registration fails.
 */declare function validateUniversalAddresses<Lifetime>():Addon<Lifetime>;/**
 * Installs a middleware planning every registration of every closed address the manifest answers —
 * a plan that cannot build is a failure.
 *
 * @remarks
 * A registration a newer one shadows is planned on its own, since a collection ask walks it: a
 * fault only the shadowed registration carries is reported here rather than at that ask.
 *
 * @throws {ManifestValidationError} when any registration fails to plan.
 */declare function validateBuildability<Lifetime>():Addon<Lifetime>;type Func<in Args extends readonly any[]=any[],out Return=any,in This=unknown>=(this:This,...args:Args)=>Return;/**
 * Assembles a service provider: every genesis input — the lifetime model, every other addon, and
 * any manifest content — arrives through this one surface, and {@link build} seals it into a
 * provider. The builder holds one list; registrations are an addon like any other.
 *
 * @typeParam Lifetime - the lifetime vocabulary every addon on this builder must thread: `unknown`
 * until the first input carrying a vocabulary locks it on, and fixed for the chain from there.
 */interface Builder<Lifetime>{/**
 * Installs `addon`: {@link build} opens one installation of it, whose registrations file in call
 * order and whose middleware composes into the same chain alongside every other installation's,
 * at this call's position.
 */
useAddon<Candidate>(addon:Addon<Candidate>&Addon<unknown extends Lifetime?Candidate:Lifetime>&(0 extends 1&Candidate?never:unknown)):Builder<unknown extends Lifetime?Candidate:Lifetime>;/**
 * Installs the registrations `fn` composes onto an empty manifest, as an addon contributing no
 * middleware of its own.
 */
withServices<Candidate>(fn:Func<[Manifest<unknown extends Lifetime?Candidate:Lifetime>],Iterable<Registration<unknown extends Lifetime?Candidate:Lifetime>>>&(0 extends 1&Candidate?never:unknown)):Builder<unknown extends Lifetime?Candidate:Lifetime>;/** Seals the configured manifest into a provider. */
build():IDisposableServiceProvider;}/** The chain openers — services or the model may come first, and either fixes the vocabulary. */declare namespace Builder{function useAddon<Lifetime>(addon:Addon<Lifetime>&(0 extends 1&Lifetime?never:unknown)):Builder<Lifetime>;function withServices<Lifetime>(fn:Func<[Manifest<Lifetime>],Iterable<Registration<Lifetime>>>&(0 extends 1&Lifetime?never:unknown)):Builder<Lifetime>;}export{Builder,ScopeValidationError,standardLifetime,taggedLifetime,validateBuildability,validateScopes,validateUniversalAddresses};