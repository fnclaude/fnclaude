# @rhombus-std/di.extras

**Authoring-time sugar for `@rhombus-std/di.core`'s registration verbs — the type-argument-derived forms a program built through this repo's Go/ttsc transform can write.**

`di.extras` has no runtime behavior you call directly. It declares the typings that let a type argument stand in for an explicit `Type` address (`add<T>(ctor)` instead of `add(typeof T, ctor, ctorType)`), and it's the source the repo's transform reads at build time to substitute the equivalent, address-first call at each site. A program that doesn't run through the transform can ignore this package entirely — `di.core`'s explicit, address-first verbs are the complete, hand-writable API on their own.

## Install

```sh
bun add -D @rhombus-std/di.extras
```

Add it as a **devDependency**, alongside `@rhombus-std/di.core` as a regular dependency — `di.extras` peers on `di.core` and contributes no code to your published bundle; it only needs to be present so the transform can find its sugar bodies and so the type-argument-derived typings are in scope while you write.

## Usage

With `di.extras` installed, this typechecks and, when built through the repo's Go/ttsc transform, substitutes to the explicit call beneath it:

```ts
manifest.add<IGreeter>(ConsoleGreeter);
```

```ts
// what the above substitutes to, and what a no-transformer author writes by hand instead
import { Type } from '@rhombus-std/di.core';

manifest.add(Type.imported('IGreeter', 'app'), ConsoleGreeter, Type.ctor(Type.imported('ConsoleGreeter', 'app'), [[]]));
```

`add<T>(...)` derives the registration address from `T` instead of an explicit `Type` argument, and derives the implementer's own type from the implementer value itself (`typefor(ConsoleGreeter)`, straight from `ConsoleGreeter`'s own construct signature) — the sugar elides both `Type` arguments, forwarding everything after them positionally. The `describe`/`asClass`/`asFactory` chain gets the same treatment: `manifest.describe<IGreeter>().asClass(ConsoleGreeter).withLifetime('singleton')` derives both the chain's address and the implementer's type the same way the flat form does. Every one of these throws if called without the transform having run — they exist to be substituted, not executed.

## Key exports

| Export                                   | What it is                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ManifestRegistrationAugmentations`      | The type-argument-derived bodies for `add`, `addValue`, `tryAdd`, `tryAddValue`, `replace`, `replaceValue`, `removeAll`, and `describe`. `ManifestRegistrationValueAugmentations` carries `add`/`tryAdd`/`replace`'s value shape as a second set, since one object literal can't declare two same-named members. |
| `AsImplementerRegistrationAugmentations` | The type-argument-derived bodies for `describe(...).asClass(ctor)` / `.asFactory(fn)` — the implementer's type derived from the value instead of taken explicitly.                                                                                                                                               |
| `ServiceProviderServiceAugmentations`    | The type-argument-derived bodies backing the ask surface on `IServiceProvider` — `resolve<T>()`, `resolveArray<T>()`, `resolveIterable<T>()`, their async and `AsyncIterable` siblings, `resolveWith<T, Args>()`, the value-observing `instantiate(ctor)` / `invoke(func)`, and a `try` twin of each.            |

`di.extras` carries no primitive of its own: every body above imports `typefor<T>()` from [`@rhombus-std/primitives.extras`](../primitives.extras/README.md) to derive the address or implementer type it needs, then forwards its remaining arguments untouched.

These three augmentation sets aren't meant to be called directly — they're what the transform's marker list (`package.json`'s `"rhombus-std": { "inline": { "entries": [...] } }`) points at as each type-argument-derived verb's source body.

## How it fits

`di.extras` peers on [`@rhombus-std/di.core`](../di.core/README.md) — never on the `@rhombus-std/di` runtime engine, so depending on `di.extras` never pulls in a resolution engine your library doesn't otherwise need. It depends on `@rhombus-std/primitives.extras` for `typefor<T>()`, the primitive its sugar bodies derive a type from.

[`@rhombus-std/di.extras.options`](../di.extras.options/README.md) is a satellite of this package, lowering the separate `addOptions<T>()` sugar the same way.

## Notes

- Every substitution is byte-for-byte what a no-transformer author would have written by hand — the transform deletes boilerplate, never adds a capability or changes behavior.
- `typefor` throws at runtime if the transform never ran — a program that has `di.extras` as a devDependency but doesn't build through the repo's Go/ttsc transform will typecheck cleanly and then fail the first time one of these calls executes.
