# @rhombus-std/primitives.extras

**A compile-time transformer that turns `typefor<T>()` into a structured runtime
`Type` value for a TypeScript type — no reflection, no decorators, no runtime cost.**

Libraries that key things by type (a dependency-injection container, an
augmentation registry, anything that needs "the identity of this interface" as
a plain value) need a `Type` that is stable across a rename-resistant type
reference. Hand-writing those values works, but it's brittle: rename the
type, forget to update the reference, and things silently stop matching. This
package gives you a `typefor<T>()` call that a build-time transformer rewrites,
at compile time, into the exact `Type` tree you'd otherwise have had to build
by hand.

It has no dependency on any dependency-injection runtime — it's the
standalone type-derivation toolkit that any package can use to mint `Type`
values from types.

## Install

```sh
bun add @rhombus-std/primitives.extras @rhombus-std/primitives
```

`primitives.extras` supplies both the build-time engine and the `typefor<T>()` import
itself (below); it depends on `@rhombus-std/primitives` in turn, so both packages
end up in your lockfile either way.

## Usage

The explicit form — passing a `Type` value directly — is the real, complete
API. It works everywhere, with or without a build step:

```ts
import { Type } from '@rhombus-std/primitives';

const type = Type.imported('IUserRepository', 'my-package');
```

`typefor<T>()` is optional sugar over exactly that: write the type instead of
building the `Type` tree by hand, and let the transformer fill it in for you.

```ts
import { typefor } from '@rhombus-std/primitives.extras';

interface IUserRepository {
  findById(id: string): Promise<User>;
}

const type = typefor<IUserRepository>();
// compiled to: const type = Type.imported('IUserRepository', 'my-package');
```

Calling `typefor<T>()` without the build-time engine wired up throws a clear error naming the
missing plugin at runtime — it never silently returns `undefined`. An optional Go/`ttsc` engine
lowers the call, at build time, into exactly the `Type.*` tree shown above.

A value argument derives from the value's OWN type, never unwrapped: a class arrives as the
constructor it is, not the instance it builds.

```ts
class SqlUserRepository implements IUserRepository {/* … */}

const ctorType = typefor(SqlUserRepository);
// compiled to: const ctorType = Type.ctor(Type.imported('SqlUserRepository', 'my-package'), […]);
const instanceType = ctorType.instanceType; // → Type.imported('SqlUserRepository', 'my-package')
```

## Type grammar

A derived `Type` addresses where the underlying type is actually declared and how a caller would
import it:

- a type exported from a package's public entry derives `Type.imported(name, from)` with that
  package's exact import specifier (`Type.imported('IUserRepository', 'my-package')`, or
  `Type.imported('IUserRepository', 'my-package/contracts')` for a subpath export);
- a type that's only internal to a package (owned by a `package.json`, not publicly exported)
  derives a package-qualified specifier;
- a type with no owning `package.json` falls back to a best-effort project-relative specifier;
- a built-in or ambient type derives `Type.global(name, genericArgs?)` instead.

Generic references close over their arguments recursively —
`typefor<Array<IUserRepository>>()` derives
`Type.global('Array', [Type.imported('IUserRepository', 'my-package')])` — and literal types
(`typefor<'dev' | 'prod'>()`) derive a sorted `Type.union` of `Type.typeLiteral` members. The
package version is deliberately excluded, so compatible versions of the same dependency unify on
one `Type`.

## Key exports

Its JavaScript API is `typefor<T>()` / `typefor(value)` — one function, narrowed by which overload
a call site binds to — plus its build-time-only guard-rail error. Alongside it: `schemaof<T>()`,
expanding a type into the `Type` tree describing its members; `registerAugmentations<R>(set, merge?)`,
registering an augmentation set against a receiver type by deriving its `Type` the same way
`typefor<T>()` does; and `registerInlineBodies(bodies)`, a runtime no-op that marks an object
literal, in code, as the inline sugar body set published in the package's `package.json`
`"rhombus-std"` marker's `"inline"` list. Everything else this package carries is the Go/`ttsc`
engine descriptor those calls lower through. See [Usage](#usage) above.

## How it fits

This package sits at the same leaf level as
[`primitives`](../primitives/README.md), but is dependency-injection-free by
design — it's a pure Go/`ttsc` engine descriptor with nothing beyond the
TypeScript compiler API underneath it.

Downstream, `di.extras` and `di.extras.options` declare it as a
dependency so `ttsc` activates its `inline`/`typefor` stages
alongside their own; a dependency-injection consumer usually doesn't need to
reference this package directly. A library author minting their own
augmentation types, outside dependency injection entirely, can depend on it
the same way and call `typefor<T>()` directly on their own terms.

## Notes

- Its JavaScript surface is small on purpose: `typefor<T>()` / `typefor(value)`, `schemaof<T>()`,
  `registerAugmentations`, and `registerInlineBodies` (see [Key exports](#key-exports) above) are
  the whole of it — everything else the package carries is the build-time-only Go/`ttsc` engine
  descriptor those calls lower through.
- `typefor<T>()`'s runtime body only ever executes if the transformer isn't
  wired up; a correctly configured build never reaches it.
- `typefor<T>()` calls are rewritten in the same pass as `di.extras`'s own stages — the
  build-time engine runs every activated stage together in one hardcoded order, not as separate
  plugins racing to rewrite the same call.
