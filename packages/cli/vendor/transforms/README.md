# @rhombus-std/transforms

**The Go transform engine every `@rhombus-std/*.extras` package builds through `ttsc` — one host
binary, one stage table, one spawn for your whole project.**

The `@rhombus-std` authoring packages give you compile-time sugar: `typefor<T>()` deriving a
structured `Type` for a TypeScript type, `add<T>()` and `addOptions<T>()` registering a service
from its type alone, `withType<T>()` generating a configuration schema. All of it is rewritten at
build time by a single Go program, and this package is that program's source.

## Install

You do not install this package. Every authoring package that needs the engine already depends on
it, so it arrives in your lockfile the moment you add one:

```sh
bun add @rhombus-std/primitives.extras
```

## How it works

`ttsc` reads your project's direct dependencies looking for a `"ttsc": { "plugin": ... }` marker.
Each authoring package carries one pointing at its own one-line descriptor, which re-exports this
package's `./ttsc` descriptor. The descriptor hands `ttsc` the absolute path to the Go host under
`cmd/`, and `ttsc` compiles that source into a cached binary and runs it as a sidecar of the
TypeScript build.

Because every authoring package resolves to this same host, a project depending on several of them
still compiles and spawns exactly one binary. The host runs its full stage table on every file, so
there is nothing to select or configure: the sugar you actually imported is what gets rewritten,
and the rest of the table finds nothing to match.

You do not need Go on your machine. `ttsc` ships a platform-specific Go SDK as an optional
dependency and uses it unless you point it somewhere else.

## Contents

`cmd/ttsc-std` is the host command; `internal/` holds the stage implementations and the shared
host loop. There is no JavaScript API — `./ttsc` is the package's only export, and it exists for
`ttsc` to load, not for your code to import.
