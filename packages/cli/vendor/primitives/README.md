# @rhombus-std/primitives

**Change notifications and a few platform types every other package here builds on.**

This is the zero-dependency leaf of the `@rhombus-std` stack. Its core job is
the change-token pattern: a small, uniform way to say "tell me when this
thing changes" — used for config reload, cache invalidation, and anything
else that needs to react to a value changing without polling. It also owns a
handful of small platform typings (`AbortSignal`, `process`, timers,
streams) so downstream libraries don't need `@types/node` or `lib.dom` just
to type-check.

## Install

```sh
bun add @rhombus-std/primitives
```

## Usage

```ts
import { CancellationChangeToken, ChangeToken } from '@rhombus-std/primitives';

let controller = new AbortController();

const disposable = ChangeToken.onChange(() => new CancellationChangeToken(controller.signal),
  () => console.log('changed'));

controller.abort(); // logs "changed"
disposable[Symbol.dispose]();
```

`ChangeToken.onChange` takes a function that produces a token and a callback
to run when it fires. After each fire it calls the producer again and
re-subscribes — so `produceToken` should hand back a token representing the
_next_ change window each time it's called. A `CancellationChangeToken`
wrapping an already-aborted signal will fire synchronously and repeatedly if
the producer keeps returning the same stale token.

The consumer callback may be synchronous or return a thenable; if it returns
a thenable, `onChange` waits for it to settle before re-subscribing.

## Key exports

| Export                                                                         | What it does                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IChangeToken`                                                                 | The interface every change token implements: `hasChanged`, `activeChangeCallbacks`, and `registerChangeCallback(callback, state?)`.                                                                                                                             |
| `ChangeToken.onChange(produceToken, consumeToken, state?)`                     | Subscribes `consumeToken` to a token, re-subscribing to a fresh token after every fire. Returns a `Disposable` that unsubscribes.                                                                                                                               |
| `CancellationChangeToken`                                                      | An `IChangeToken` backed by a platform `AbortSignal`. `hasChanged` mirrors `signal.aborted`; registering a callback after the signal has already aborted invokes it immediately.                                                                                |
| `CompositeChangeToken`                                                         | Combines several `IChangeToken`s into one. It reflects a change from any inner token that raises callbacks; changes in tokens that don't raise callbacks are only caught when `hasChanged` is polled.                                                           |
| `AbortController`, `neverSignal`                                               | The platform `AbortController`, re-exported with a self-contained `AbortSignal` type so consumers don't need `lib.dom`/`@types/node` to name it. `neverSignal` is an inert signal that never aborts, for APIs that require a signal but have nothing to cancel. |
| `process`, `ProcessLike`                                                       | The platform `process` global, typed against the small surface this stack actually touches (`env`, `cwd()`, `stdout.write`, `on`/`off`).                                                                                                                        |
| `setTimeout`, `clearTimeout`, `TimeoutHandle`                                  | Typed re-exports of the platform timer functions, with an opaque handle type that round-trips only through these two functions.                                                                                                                                 |
| `ReadableStream<R>`                                                            | A structural `ReadableStream` type covering the members common across the major platform stream variants.                                                                                                                                                       |
| `registerAugmentations`, `augment`, `applyAugmentations`, `AugmentationSet<R>` | Infrastructure for attaching extension methods to a class after the fact — see Notes below. Most consumers of this stack never call these directly.                                                                                                             |

## How it fits

`@rhombus-std/primitives` has no dependencies on other `@rhombus-std`
packages — it's the leaf every other family builds on, directly or
transitively. Nothing needs to be installed alongside it.

Packages that build on it include:

- [`di.core`](../di.core/README.md) and the rest of the dependency-injection
  family, for wiring services together.
- [`config`](../config/README.md) and its providers, for configuration
  reload notifications.
- [`options`](../options/README.md), for the change-driven options pipeline.
- [`caching.memory`](../caching.memory/README.md) and
  [`fileproviders.composite`](../fileproviders.composite/README.md), for
  cache/file-watch invalidation.

If you're using one of those libraries, you're already depending on
`@rhombus-std/primitives` transitively — you generally don't need to import
it directly unless you're consuming an `IChangeToken` yourself or writing
code that composes several of them.

## Notes

The augmentation helpers (`registerAugmentations`, `augment`,
`applyAugmentations`) exist so that a package can add methods onto a class
defined in a _different_ package — for example, a configuration provider
adding an `addJsonFile` method onto the shared configuration builder. This
is infrastructure that library authors across the stack use to extend each
other's builder types; if you're just consuming these libraries rather than
authoring one, you won't call this surface directly.
