package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// pilotMemberEntry is the standard IQuery/QueryInline/isService member entry a
// buildWorkspace workspace declares, owned by its sugar package.
func pilotMemberEntry(app string) OwnedEntry {
	sugar := filepath.Join(filepath.Dir(app), "sugar")
	return OwnedEntry{
		Entry:      Entry{Type: "@scope/core:IQuery", Impl: "@scope/sugar:QueryInline", Member: "isService"},
		PackageDir: sugar,
	}
}

const pilotCoreIndex = `export interface IQuery {
  isService(token: string): boolean;
}
export declare const provider: IQuery;
`

const pilotInlineBody = `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export const QueryInline = {
  isService<T>(this: IQuery): boolean {
    return this.isService(typefor<T>());
  },
};
`

// TestResolveMemberAbsentNoWitness: the entry's module is never witnessed by the
// program (main.ts neither imports @scope/core nor carries the declare-module),
// so the entry contributes nothing — skip silently, never an error.
func TestResolveMemberAbsentNoWitness(t *testing.T) {
	prog, app := buildWorkspace(t, pilotCoreIndex, pilotInlineBody, `export {};
`, `export const x = 1;
`)
	defer func() { _ = prog.Close() }()

	_, outcome, err := Resolve(prog, prog.Checker, newBodyExtractor(), pilotMemberEntry(app))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if outcome != OutcomeAbsent {
		t.Fatalf("outcome = %v, want OutcomeAbsent — @scope/core is not witnessed by the program", outcome)
	}
}

// TestResolveMemberUnmatchedPublishesShape: the module IS witnessed but the sugar
// overload (`isService<T>()`) is not loaded — only the primitive `isService(token)`
// exists — so no declaration matches the impl discriminator. Nothing can inline,
// yet the entry still publishes its call shape: a call written in that shape has
// no way to lower and must reach the sweep rather than pass through.
func TestResolveMemberUnmatchedPublishesShape(t *testing.T) {
	mainSrc := `import { provider } from '@scope/core';
export const y = provider.isService('x');
`
	prog, app := buildWorkspace(t, pilotCoreIndex, pilotInlineBody, `export {};
`, mainSrc)
	defer func() { _ = prog.Close() }()

	_, outcome, err := Resolve(prog, prog.Checker, newBodyExtractor(), pilotMemberEntry(app))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if outcome != OutcomeUnmatched {
		t.Fatalf("outcome = %v, want OutcomeUnmatched — the sugar overload is not present, only the primitive", outcome)
	}

	artifacts := NewArtifacts()
	var diags []plugin.Diagnostic
	Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { diags = append(diags, d) })
	if len(diags) != 0 {
		t.Fatalf("Build raised diagnostics: %+v", diags)
	}
	if !artifacts.Active {
		t.Fatal("artifacts.Active should be true — the marker's surface is in this program")
	}
	shapes := artifacts.SugarMembers["isService"]
	if len(shapes) != 1 {
		t.Fatal("the unmatched member published no shape, so the sweep cannot see a call to it")
	}
	if shapes[0].TypeArgCount != 1 {
		t.Fatalf("published shape = %+v, want the body's one type parameter", shapes[0])
	}
}

// coreIndexWithArityCollidingOverload is TestResolveMemberUnmatchedPublishesShape's
// fixture plus ONE further declaration: a second, wholly unrelated overload of
// isService that happens to share the sugar body's type-parameter count (one) but
// takes two value parameters where the sugar body takes none — the exact shape
// IServiceProvider.getService gained once it carried the two-argument
// ConstructorType/FunctionType overloads alongside its base form.
const coreIndexWithArityCollidingOverload = `export interface IQuery {
  isService(token: string): boolean;
  isService<T>(node: string, value: string): boolean;
}
export declare const provider: IQuery;
`

// TestResolveMemberUnmatchedDespiteArityCollidingOverload is the regression for
// the type-parameter-count-only signal anyDeclarationTakes used to decide between
// a silent OutcomeUnmatched and a hard INLINE_DISCRIMINATOR_MISMATCH. The sugar
// overload itself (isService<T>(): boolean, zero value parameters) is genuinely
// NOT loaded here — only the primitive and the arity-colliding overload above
// are — so this must still resolve as unmatched, not error: type-parameter count
// alone cannot tell "the sugar's own declaration" apart from "a same-arity-count
// coincidence with something else entirely". Before the fix, the colliding
// overload's shared type-parameter count made anyDeclarationTakes report the
// sugar as present, turning this into a hard error over a program that never
// loaded the sugar at all — exactly what broke di.extras' pre-existing
// zero-argument getService<T>() sugar the moment IServiceProvider gained direct
// getService overloads of its own carrying one type parameter each.
func TestResolveMemberUnmatchedDespiteArityCollidingOverload(t *testing.T) {
	mainSrc := `import { provider } from '@scope/core';
export const y = provider.isService('x');
`
	prog, app := buildWorkspace(t, coreIndexWithArityCollidingOverload, pilotInlineBody, `export {};
`, mainSrc)
	defer func() { _ = prog.Close() }()

	_, outcome, err := Resolve(prog, prog.Checker, newBodyExtractor(), pilotMemberEntry(app))
	if err != nil {
		t.Fatalf("Resolve: %v — the arity-colliding overload's shared type-parameter count must not "+
			"turn a genuinely-absent sugar overload into a hard error", err)
	}
	if outcome != OutcomeUnmatched {
		t.Fatalf("outcome = %v, want OutcomeUnmatched — the sugar overload is not present, "+
			"only the primitive and an unrelated same-type-parameter-count overload", outcome)
	}
}

// TestResolveUnresolvedTypeAndMember: the two loud-failure guarantees. A type
// token naming a member the module does not export → INLINE_UNRESOLVED_TYPE; an
// interface member the type does not carry (but the impl does, so Extract passes)
// → INLINE_UNRESOLVED_MEMBER. Both are hard errors, never inert.
func TestResolveUnresolvedTypeAndMember(t *testing.T) {
	// The impl carries BOTH isService and a `missing` member, so Extract of the
	// `missing` member succeeds and resolution reaches the interface-member check.
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export const QueryInline = {
  isService<T>(this: IQuery): boolean {
    return this.isService(typefor<T>());
  },
  missing<T>(this: IQuery): boolean {
    return this.isService(typefor<T>());
  },
};
`
	mainSrc := `/// <reference path="./sugar.d.ts" />
import { provider } from '@scope/core';
interface Foo { readonly brand: 'foo'; }
export const known = provider.isService<Foo>();
`
	prog, app := buildWorkspace(t, pilotCoreIndex, inlineBody, pilotSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	sugar := filepath.Join(filepath.Dir(app), "sugar")

	t.Run("unresolved type", func(t *testing.T) {
		e := OwnedEntry{Entry: Entry{Type: "@scope/core:Missing", Impl: "@scope/sugar:QueryInline", Member: "isService"}, PackageDir: sugar}
		_, _, err := Resolve(prog, prog.Checker, newBodyExtractor(), e)
		if err == nil || !strings.Contains(err.Error(), "INLINE_UNRESOLVED_TYPE") {
			t.Fatalf("want INLINE_UNRESOLVED_TYPE, got %v", err)
		}
	})

	t.Run("unresolved member", func(t *testing.T) {
		e := OwnedEntry{Entry: Entry{Type: "@scope/core:IQuery", Impl: "@scope/sugar:QueryInline", Member: "missing"}, PackageDir: sugar}
		_, _, err := Resolve(prog, prog.Checker, newBodyExtractor(), e)
		if err == nil || !strings.Contains(err.Error(), "INLINE_UNRESOLVED_MEMBER") {
			t.Fatalf("want INLINE_UNRESOLVED_MEMBER, got %v", err)
		}
	})
}

// setupOverloadedFunctionWorkspace lays out an impl-only floater whose
// export is OVERLOADED (a signature declaration plus its implementation).
func setupOverloadedFunctionWorkspace(t *testing.T) (*driver.Program, string) {
	t.Helper()
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)

	prims := filepath.Join(root, "packages", "prims")
	write(t, filepath.Join(prims, "package.json"), `{
  "name": "@scope/prims",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "rhombus-std": { "inline": { "entries": [ { "impl": "@scope/prims:identity" } ] } }
}`)
	write(t, filepath.Join(prims, "src", "index.ts"), `export function identity<T>(value: T): T;
export function identity<T>(value: T): T {
  return value;
}
`)

	app := filepath.Join(root, "packages", "app")
	write(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "version": "1.0.0",
  "dependencies": { "@scope/prims": "workspace:*" }
}`)
	linkPackage(t, app, "@scope/prims", prims)
	write(t, filepath.Join(app, "main.ts"), `import { identity } from '@scope/prims';
export const x = identity<number>(1);
`)
	write(t, filepath.Join(app, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["main.ts", "node_modules/@scope/prims/src/index.ts"]
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

// TestResolveFreeFunctionOverloadedRejected: an overloaded floater is not
// certified. The rejection surfaces as INLINE_BODY_SHAPE, because Extract runs
// first and the first-found declaration is the bodyless overload signature — the
// fnDecls!=1 (INLINE_ENTRY_SHAPE) guard in resolveFloater sits behind it as
// defense in depth. This pins the reachable behavior.
//
// Spec deviation: the gap named the fnDecls!=1 / INLINE_ENTRY_SHAPE branch; that
// branch is shadowed by Extract's bodyless-signature check for any well-formed TS
// overload, so the reachable, asserted code is INLINE_BODY_SHAPE.
func TestResolveFreeFunctionOverloadedRejected(t *testing.T) {
	prog, app := setupOverloadedFunctionWorkspace(t)
	defer func() { _ = prog.Close() }()

	e := collectFreeFunction(t, app)
	_, _, err := Resolve(prog, prog.Checker, newBodyExtractor(), e)
	if err == nil || !strings.Contains(err.Error(), "INLINE_BODY_SHAPE") {
		t.Fatalf("want INLINE_BODY_SHAPE (Extract sees the bodyless overload signature first), got %v", err)
	}
}

// setupFunctionWorkspace lays out a two-package workspace for the floater
// grammar row: a scoped-name `@scope/prims` package that exports a function
// and declares it inlineable with an `{ "impl": "@scope/prims:identity" }`
// entry (no type — no type-side anchor exists), plus an `app` consumer that
// imports and calls it (the witness). importsPrims toggles whether the app
// imports the package, exercising the witness/inert branch.
func setupFunctionWorkspace(t *testing.T, importsPrims bool) (*driver.Program, string) {
	t.Helper()
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)

	prims := filepath.Join(root, "packages", "prims")
	write(t, filepath.Join(prims, "package.json"), `{
  "name": "@scope/prims",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "rhombus-std": {
    "inline": { "entries": [ { "impl": "@scope/prims:identity" } ] }
  }
}`)
	write(t, filepath.Join(prims, "src", "index.ts"), `export function identity<T>(value: T): T {
  return value;
}
`)

	app := filepath.Join(root, "packages", "app")
	write(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "version": "1.0.0",
  "dependencies": { "@scope/prims": "workspace:*" }
}`)
	linkPackage(t, app, "@scope/prims", prims)

	var mainSrc, files string
	if importsPrims {
		mainSrc = `import { identity } from '@scope/prims';
export const x = identity<number>(1);
`
		files = `["main.ts", "node_modules/@scope/prims/src/index.ts"]`
	} else {
		// No import of @scope/prims: nothing anchors its module specifier, so the
		// witness rule makes the entry inert.
		mainSrc = `export const x = 1;
`
		files = `["main.ts"]`
	}
	write(t, filepath.Join(app, "main.ts"), mainSrc)
	write(t, filepath.Join(app, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": `+files+`
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

func collectFreeFunction(t *testing.T, app string) OwnedEntry {
	t.Helper()
	owned, err := Collect(app)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	for _, oe := range owned {
		if oe.Entry.Impl == "@scope/prims:identity" && oe.Entry.Type == "" && oe.Entry.Member == "" {
			return oe
		}
	}
	t.Fatalf("floater entry not collected: %+v", owned)
	return OwnedEntry{}
}

// TestResolveFreeFunctionAgainstOwningPackage round-trips an impl-only entry
// through resolution: the module specifier comes from the OWNING package's own
// (scoped) name, not from a type token, and the entry resolves active.
func TestResolveFreeFunctionAgainstOwningPackage(t *testing.T) {
	prog, app := setupFunctionWorkspace(t, true)
	defer func() { _ = prog.Close() }()

	fnEntry := collectFreeFunction(t, app)
	resolved, outcome, rerr := Resolve(prog, prog.Checker, newBodyExtractor(), fnEntry)
	if rerr != nil {
		t.Fatalf("Resolve: %v", rerr)
	}
	if outcome != OutcomeActive {
		t.Fatalf("outcome = %v, want OutcomeActive — the owning package name did not anchor a witness", outcome)
	}
	if resolved.Kind != KindFloater {
		t.Fatalf("Kind = %v, want KindFloater", resolved.Kind)
	}
	if resolved.Module != "@scope/prims" {
		t.Fatalf("Module = %q, want @scope/prims (the owning package name)", resolved.Module)
	}
	if resolved.Member != "identity" {
		t.Fatalf("Member = %q, want identity", resolved.Member)
	}
}

// TestResolveFreeFunctionAbsent asserts the witness rule for the impl-only row:
// when the owning package's module is not touched by the program, the entry
// contributes nothing (skip silently), never an error.
func TestResolveFreeFunctionAbsent(t *testing.T) {
	prog, app := setupFunctionWorkspace(t, false)
	defer func() { _ = prog.Close() }()

	fnEntry := collectFreeFunction(t, app)
	resolved, outcome, rerr := Resolve(prog, prog.Checker, newBodyExtractor(), fnEntry)
	if rerr != nil {
		t.Fatalf("Resolve: %v", rerr)
	}
	if outcome != OutcomeAbsent {
		t.Fatalf("expected OutcomeAbsent (no witness for @scope/prims), got %v resolved=%+v", outcome, resolved)
	}
}

// TestResolveRejectsUncertifiedKinds asserts Resolve raises the distinct
// INLINE_KIND_UNCERTIFIED error (not the malformed-shape error) for the two
// specced-but-not-certified rows, defending in depth behind the loader.
func TestResolveRejectsUncertifiedKinds(t *testing.T) {
	prog, app := setupFunctionWorkspace(t, true)
	defer func() { _ = prog.Close() }()

	cases := map[string]Entry{
		"own-body member": {Type: "@scope/prims:Foo", Member: "bar"},
		"static member":   {Impl: "@scope/prims:FooBase", Member: "bar"},
	}
	for name, e := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, rerr := Resolve(prog, prog.Checker, newBodyExtractor(), OwnedEntry{Entry: e, PackageDir: app})
			if rerr == nil {
				t.Fatal("expected INLINE_KIND_UNCERTIFIED error")
			}
			if !strings.Contains(rerr.Error(), "INLINE_KIND_UNCERTIFIED") {
				t.Fatalf("want INLINE_KIND_UNCERTIFIED, got %v", rerr)
			}
		})
	}
}
