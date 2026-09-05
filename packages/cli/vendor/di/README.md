# @rhombus-std/di

**The dependency-injection engine — open a `Builder` chain, feed it addons and registrations, and seal the result into a provider you resolve services out of.**

`@rhombus-std/di` builds on [`@rhombus-std/di.core`](../di.core/README.md) — the `Manifest` registration surface and the error taxonomy — adding the genesis front door (`Builder.useAddon(...)` / `Builder.withServices(...)`) and the concrete provider it produces. Install this at your application's composition root, the place that actually builds the container. A library that only needs to declare registrations or accept an already-built `IServiceProvider` should depend on `di.core` alone.

## Install

```sh
bun add @rhombus-std/di
```

`@rhombus-std/di.core` and `@rhombus-std/primitives` are dependencies and are pulled in automatically.

## Usage

```ts
import { Builder } from '@rhombus-std/di';
import { Manifest, Type } from '@rhombus-std/di.core';

interface IGreeter {
  greet(name: string): string;
}
const IGreeter = Type.imported('IGreeter', 'app');

class ConsoleGreeter implements IGreeter {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

const manifest = Manifest.empty<unknown>().add(IGreeter, ConsoleGreeter, Type.ctor(IGreeter, [[]]));

const provider = Builder.withServices(() => manifest).build();

provider.resolve(IGreeter).greet('world'); // "Hello, world!"
```

`Builder.useAddon(addon)` and `Builder.withServices(fn)` open the chain, and the same two verbs extend it. `useAddon` installs an addon: `.build()` opens one installation of it, whose registrations file in call order and whose middleware composes into the resolution chain at that call's position. `withServices` installs the registrations a delegate composes onto an empty manifest, as an addon with no middleware of its own. The first input carrying a concrete lifetime vocabulary locks the chain onto it, and every addon after that must speak the same one. `.build()` seals everything into a provider; an ask nothing in the manifest answers throws `UnsatisfiableError`. Every verb returns a **new** `Builder`, so — exactly like `Manifest` itself — a discarded result configures nothing.

The whole ask surface is `di.core`'s own set of augmentations on `IServiceProvider`, so it is there the moment `di.core` is loaded — which it always is, since `di` depends on it. Each verb names the shape you want and composes the address for it; `di.extras` derives that address from a type argument instead of taking it in front.

| Ask for                                           | Explicit                             | Type-driven                          |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| the value                                         | `resolve(address)`                   | `resolve<T>()`                       |
| every registration, as an array                   | `resolveArray(address)`              | `resolveArray<T>()`                  |
| every registration, walked lazily                 | `resolveIterable(address)`           | `resolveIterable<T>()`               |
| the value, everything beneath it awaited          | `resolveAsync(address)`              | `resolveAsync<T>()`                  |
| the array, awaited                                | `resolveArrayAsync(address)`         | `resolveArrayAsync<T>()`             |
| the sequence, awaited                             | `resolveIterableAsync(address)`      | `resolveIterableAsync<T>()`          |
| one element awaited per step of the walk          | `resolveAsyncIterable(address)`      | `resolveAsyncIterable<T>()`          |
| what calling the registered callable returns      | `resolveWith(address, ...args)`      | `resolveWith<T, Args>(...args)`      |
| the same, from a promise-returning callable       | `resolveWithAsync(address, ...args)` | `resolveWithAsync<T, Args>(...args)` |
| a class you hold, built with its dependencies     | `instantiate(ctorType, ctor)`        | `instantiate(ctor)`                  |
| a function you hold, called with its dependencies | `invoke(funcType, func)`             | `invoke(func)`                       |

Every row has a `try` twin — `tryResolve`, `tryResolveArray`, `tryInvoke` — answering `undefined` where the plain verb throws, by asking for the same shape beside the `undefined` literal. The async twins settle on `undefined` rather than answering it, so their type is `Promise<T | undefined>`. An aggregate with no registrations is empty rather than absent, so a collection's `try` twin hands back the empty collection.

```ts
provider.resolveArray<IGreeting>(); // [formal, casual]
provider.tryResolve<IMissing>(); // undefined, never a throw
await provider.resolveAsync<IBanner>(); // the Promise<IBanner> registration, settled
provider.instantiate(ReportBuilder); // fresh, never registered
```

## Key exports

| Export                                                                                                                                        | What it is                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Builder`                                                                                                                                     | The one entry point: `Builder.useAddon(...)` / `Builder.withServices(...)` open a chain, `useAddon` / `withServices` extend it, and `build()` seals it into an `IServiceProvider`.                                                                                                                                                             |
| `validateUniversalAddresses`, `validateBuildability`                                                                                          | Validation addons: the first rejects a registration addressed by nothing but a hole, the second plans every registration of every closed address while building, a shadowed registration included — so an unsatisfiable graph fails at the build instead of at some later resolution.                                                          |
| `standardLifetime`                                                                                                                            | The standard lifetime model as an addon — a clone of Microsoft.Extensions.DependencyInjection's service lifetimes, caching and disposal: `'singleton'` / `'scoped'` / `'transient'` registrations, scopes opened through `IServiceScopeFactory`, and disposal of what each scope constructed when its provider is disposed.                    |
| `taggedLifetime`                                                                                                                              | The tagged lifetime model as an addon over a vocabulary of your own: each constructed registration carries one of your tags, `openScope(tag)` on `ITaggedServiceScopeFactory<Lifetime>` answers a provider caching that tag alone, a scope opened from a scope chains onto it, and an omitted or `undefined` lifetime is transient everywhere. |
| `validateScopes`, `ScopeValidationError`                                                                                                      | The optional layer over the model refusing a scoped registration reached under the singleton scope — resolved from the container's own provider, or consumed by a singleton — with `ScopeValidationError` naming the scoped address.                                                                                                           |
| `DiError`, `UnsatisfiableError`, `CycleError`, `ManifestValidationError`, `UniversalAddressError`, `ObjectDisposedError`, `ValidationFailure` | Re-exported from `di.core` — the same classes, so `instanceof` holds whichever package a caller imports the taxonomy from.                                                                                                                                                                                                                     |

## How it fits

`@rhombus-std/di` depends on [`@rhombus-std/di.core`](../di.core/README.md) for the `Manifest`/`Registration`/`Addon` surface and `@rhombus-std/primitives` for `Type` and the augmentation registry. It re-exports the whole `di.core` error taxonomy, so code that already imports the engine doesn't need a second import from the abstractions package just to catch what it throws.

[`@rhombus-std/di.extras`](../di.extras/README.md) supplies type-argument-derived (`<T>`-only) authoring sugar for the registration verbs, for a program built through this repo's Go/ttsc transform; `di` and `di.core` work identically without it.

## Notes

- A discarded `.add(...)`, `.describe(...)`, or `.withServices(...)` result configures nothing — both `Manifest` and `Builder` are immutable, so always chain or reassign.
- The engine seeds two registrations of its own, filed oldest so yours shadow them: `IServiceProvider` — a factory answering the provider that opened the ask — and `ControlService`, the control surface a middleware resolves at fold time for the registry and the two hook verbs (`stageHooks`/`installHooks`, each answering a disposable `Handle`). A factory slot typed `ServiceRequest` (or the base `Request`) receives the live ask itself.
- `build()` and `openScope()` return an `IDisposableServiceProvider`, disposable in both forms (`using` / `await using`): disposing tells that provider's subscribers once, most recent first, through the form the holder used — the seam an addon releases per-provider state through — and never flows through `getService`.
- Under `standardLifetime()`, disposing a scope's provider disposes what that scope constructed, most recent first, and the scope refuses every later ask with `ObjectDisposedError`; disposing the container's provider does the same for the singletons and closes every provider. A construction still pending when its scope ends is disposed as it settles and the ask waiting on it is refused. Add `validateBuildability()` ahead of `validateScopes()` in the chain to refuse a captive dependency at build rather than at the first ask.
- Under `taggedLifetime<Lifetime>()`, the built provider caches and captures nothing; a scope caches its own tag, passes every other tag through, and is checked before the scopes it was opened from. Disposing a scope's provider disposes what that scope cached and closes every scope opened beneath it; a transient is never captured.
- A registration whose own slot names its own address resolves that slot from what it shadows — a factory for `IFoo` shaped `Func<[IFoo], IFoo>` decorates the older `IFoo` registration, with no decorator verb. Nothing older makes the ask unsatisfiable; a collection ask still enumerates decorator and shadowed both.
- A union dependency settles deterministically: a registration for the union's own address answers it outright; otherwise each member is tried, registration then synthesis, in the union's canonical order, and the first one that resolves settles it. Literals order last among members, which is what keeps a literal member (such as `undefined`) as the fallback of an optional dependency.
