package inlinetransform

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// buildTransitiveWorkspace lays out the di-only TRANSITIVE-witness shape the W4
// blocker hit: a core package (`@scope/core`) owning the inline entry, a middle
// `@scope/di` package that RE-EXPORTS the core (exactly as `@rhombus-std/di`
// re-exports `@rhombus-std/di.core`), a sugar package (`@scope/sugar`, the
// di.extras analog) whose `declare module '@scope/core'` overload merges onto
// the core (sugar depends on the core, so its augmentation target resolves), and an
// app that depends on and imports `@scope/di` ONLY.
//
// The load-bearing detail: `@scope/core` is NOT linked under `@scope/di`, so di's
// `export … from '@scope/core'` re-export does NOT resolve from di's OWN location —
// exactly what a dist-referenced `@rhombus-std/di` bundle exhibits under the
// isolated linker. So the specifier-scan anchor (resolveModuleSymbol path 1) finds
// di's re-export node but ResolveExternalModuleName returns nil for it, and the
// only other `@scope/core` mention is the sugar's `declare module` (also nil).
// `@scope/core` IS a (dev)dependency of the APP, though, so real module resolution
// from the app's own file finds the module the checker loaded and merged the sugar
// augmentation into — the fallback anchor (path 2). Reproduces
// examples.app.with-transformer's exact failure: di.core absent from path 1,
// present in the program, resolvable from the app.
func buildTransitiveWorkspace(t *testing.T, mainSrc string) (*driver.Program, string) {
	t.Helper()
	root := t.TempDir()
	writeT(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)

	core := filepath.Join(root, "packages", "core")
	writeT(t, filepath.Join(core, "package.json"), `{
  "name": "@scope/core",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	writeT(t, filepath.Join(core, "src", "index.ts"), `export interface IQuery {
  isService(token: string): boolean;
}
export declare const provider: IQuery;
`)

	// The middle di package re-exports the core (the real di bundle shape). The
	// core is deliberately NOT linked under di, so this re-export does not resolve
	// from di's own location — forcing the specifier-scan anchor to fail.
	di := filepath.Join(root, "packages", "di")
	writeT(t, filepath.Join(di, "package.json"), `{
  "name": "@scope/di",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	writeT(t, filepath.Join(di, "src", "index.ts"), `export * from '@scope/core';
export declare const provider: import('@scope/core').IQuery;
`)

	// The sugar (di.extras analog): the declare-module overload only. It
	// depends on the core so its augmentation target resolves and merges.
	sugar := filepath.Join(root, "packages", "sugar")
	writeT(t, filepath.Join(sugar, "package.json"), `{
  "name": "@scope/sugar",
  "version": "1.0.0",
  "types": "./index.d.ts",
  "exports": { ".": { "types": "./index.d.ts" } },
  "dependencies": { "@scope/core": "workspace:*" }
}`)
	writeT(t, filepath.Join(sugar, "index.d.ts"), `import '@scope/core';
declare module '@scope/core' {
  interface IQuery {
    isService<T>(): boolean;
  }
}
`)
	writeT(t, filepath.Join(sugar, "src", "index.ts"), `export {};
`)
	writeT(t, filepath.Join(sugar, "src", "inline.ts"), pilotInlineBody)
	linkPackage(t, sugar, "@scope/core", core)

	app := filepath.Join(root, "packages", "app")
	writeT(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "version": "1.0.0",
  "dependencies": { "@scope/di": "workspace:*", "@scope/sugar": "workspace:*" },
  "devDependencies": { "@scope/core": "workspace:*" }
}`)
	linkPackage(t, app, "@scope/di", di)
	linkPackage(t, app, "@scope/sugar", sugar)
	linkPackage(t, app, "@scope/core", core)

	writeT(t, filepath.Join(app, "main.ts"), mainSrc)
	// The app never force-loads @scope/core via `files`; it reaches the core only
	// transitively through @scope/di's re-export and the sugar augmentation.
	writeT(t, filepath.Join(app, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["@scope/sugar"]
  },
  "files": ["main.ts"]
}`)

	prog, diags, err := driver.LoadProgram(app, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	return prog, app
}

func writeT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func transitiveEntry(app string) OwnedEntry {
	sugar := filepath.Join(filepath.Dir(app), "sugar")
	return OwnedEntry{
		Entry:      Entry{Type: "@scope/core:IQuery", Impl: "@scope/sugar:QueryInline", Member: "isService"},
		PackageDir: sugar,
	}
}

// TestTransitiveWitnessResolvesViaModuleResolution proves the W5 transitive-witness
// fix: for a consumer that reaches the sugar-target module only transitively (imports
// @scope/di, which re-exports @scope/core), the entry RESOLVES — not inert — even
// though no directly-resolvable @scope/core specifier node exists in the program.
// The specifier-scan anchor fails here by construction (the core is not linked under
// di, so di's re-export does not resolve from di's location), so a pass proves the
// module-resolution fallback is load-bearing.
func TestTransitiveWitnessResolvesViaModuleResolution(t *testing.T) {
	prog, app := buildTransitiveWorkspace(t, `import { provider } from '@scope/di';
interface IThing { id: number }
export const ok = provider.isService<IThing>();
`)
	defer func() { _ = prog.Close() }()

	// Path 1 (specifier scan) alone must fail: the only @scope/core mentions are
	// di's unresolvable re-export and the sugar's declare-module, neither of which
	// ResolveExternalModuleName resolves. Pin that so the test provably exercises
	// the fallback rather than silently passing on path 1.
	if scanOnly := resolveModuleSymbolByScan(prog, prog.Checker, "@scope/core"); scanOnly != nil {
		t.Fatal("specifier-scan resolved @scope/core — the fixture no longer isolates the module-resolution fallback")
	}

	sym := resolveModuleSymbol(prog, prog.Checker, "@scope/core")
	if sym == nil {
		t.Fatal("resolveModuleSymbol(@scope/core) returned nil — the module-resolution fallback did not anchor the transitive target")
	}

	_, outcome, err := Resolve(prog, prog.Checker, newBodyExtractor(), transitiveEntry(app))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if outcome != OutcomeActive {
		t.Fatalf("outcome = %v for a transitive consumer — the transitive-witness fix regressed", outcome)
	}
}
