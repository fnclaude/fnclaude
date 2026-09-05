package inlinetransform

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// substituteBody runs Substitute over a parsed body and call fixture, returning
// the reprinted output. bodySrc must contain a function whose single return is
// the body; callSrc must contain the call to member.
func substituteBody(t *testing.T, bodySrc, callSrc, member string, params []string, groupsFor func(args []*shimast.Node) (named []*shimast.Node, groups map[string][]*shimast.Node)) string {
	t.Helper()
	bodySF := parse(t, "body.ts", bodySrc)
	callSF := parse(t, "call.ts", callSrc)
	body := returnExpr(t, bodySF)
	call, receiver, args := findCall(t, callSF, member)

	named, groups := groupsFor(args)
	ec := shimprinter.NewEmitContext()
	res := Substitute(ec, Inlining{
		Body:     body,
		Receiver: receiver,
		Params:   params,
		Args:     named,
		Groups:   groups,
	})
	return reprint(ec, splice(ec, callSF, call, res.Expr))
}

// TestSubstituteSplicesRestGroupSpreadCall: the spread call form —
// `(this.add as any)(typefor<T>(), ...args)` — collapses the assertion and
// splices the group, emitting the direct call a hand author writes.
func TestSubstituteSplicesRestGroupSpreadCall(t *testing.T) {
	out := substituteBody(t,
		`function add(this: any, ...args: any[]) { return (this.add as any)(token(), ...args); }`,
		`manifest.add(Greeter, ctorType, 'scoped');`,
		"add", nil,
		func(args []*shimast.Node) ([]*shimast.Node, map[string][]*shimast.Node) {
			return nil, map[string][]*shimast.Node{"args": args, "arguments": args}
		})
	if !strings.Contains(out, "manifest.add(token(), Greeter, ctorType, 'scoped')") {
		t.Errorf("spread-call splice: got\n%s", out)
	}
}

// TestSubstituteSplicesArgumentsApplyForm: the `.apply` form —
// `this.add.apply(this, [token(), ...arguments])` — collapses the array,
// splices the whole argument set, and writes the receiver exactly once.
func TestSubstituteSplicesArgumentsApplyForm(t *testing.T) {
	out := substituteBody(t,
		`function tryAdd(this: any) { return this.tryAdd.apply(this, [token(), ...arguments] as any); }`,
		`make().tryAdd(Greeter, ctorType);`,
		"tryAdd", nil,
		func(args []*shimast.Node) ([]*shimast.Node, map[string][]*shimast.Node) {
			return nil, map[string][]*shimast.Node{"arguments": args}
		})
	if !strings.Contains(out, "make().tryAdd(token(), Greeter, ctorType)") {
		t.Errorf(".apply splice: got\n%s", out)
	}
	if strings.Contains(out, "apply") {
		t.Errorf("the .apply call form must normalize away:\n%s", out)
	}
	if strings.Count(out, "make()") != 1 {
		t.Errorf("the receiver must be written exactly once:\n%s", out)
	}
}

// TestSubstituteSplicesEmptyGroup: a zero-argument call splices an empty group
// and needs no special case.
func TestSubstituteSplicesEmptyGroup(t *testing.T) {
	out := substituteBody(t,
		`function removeAll(this: any) { return this.removeAll.apply(this, [token(), ...arguments] as any); }`,
		`manifest.removeAll();`,
		"removeAll", nil,
		func(args []*shimast.Node) ([]*shimast.Node, map[string][]*shimast.Node) {
			return nil, map[string][]*shimast.Node{"arguments": args}
		})
	if !strings.Contains(out, "manifest.removeAll(token())") {
		t.Errorf("empty-group splice: got\n%s", out)
	}
}

// TestSubstituteReordersNamedLeadAndGroup: leading named parameters keep
// binding positionally, so a body may reorder and interleave them around the
// group — `asdf(a, b, ...c)` forwarding `this.qwer(b, ...c, a)`.
func TestSubstituteReordersNamedLeadAndGroup(t *testing.T) {
	out := substituteBody(t,
		`function asdf(this: any, a: any, b: any, ...c: any[]) { return this.qwer(b, ...c, a); }`,
		`x.asdf(q, w, e, d, f);`,
		"asdf", []string{"a", "b"},
		func(args []*shimast.Node) ([]*shimast.Node, map[string][]*shimast.Node) {
			return args[:2], map[string][]*shimast.Node{"c": args[2:], "arguments": args}
		})
	if !strings.Contains(out, "x.qwer(w, e, d, f, q)") {
		t.Errorf("reorder splice: got\n%s", out)
	}
}

// TestRestShapeUnboundedInSweep: a trailing rest makes the accepted argument
// count unbounded while the leading named parameters stay required.
func TestRestShapeUnboundedInSweep(t *testing.T) {
	shape := MemberShape{TypeArgCount: 1, MinValueArgCount: 2, MaxValueArgCount: 3, Unbounded: true}
	if sugarShapeMatches(shape, 1, 1) {
		t.Error("an argument count below the required lead must not match")
	}
	for _, n := range []int{2, 3, 7} {
		if !sugarShapeMatches(shape, 1, n) {
			t.Errorf("%d arguments must match an unbounded shape", n)
		}
	}
	if sugarShapeMatches(MemberShape{TypeArgCount: 1, MinValueArgCount: 2, MaxValueArgCount: 3}, 1, 7) {
		t.Error("a bounded shape must keep its upper bound")
	}
}

// TestAssignBodiesFaceWithoutBodyDiagnosed: a publisher-owned face whose
// signature no body spells — and no rest body blankets — is a hard error at
// resolution, never a silent runtime death.
func TestAssignBodiesFaceWithoutBodyDiagnosed(t *testing.T) {
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T>(this: IQuery, other: string): boolean {
    return this.isService(typefor<T>(), other);
  }
}
`
	mainSrc := `import { provider } from '@scope/core';
export const x = provider;
`
	prog, app := buildWorkspace(t, declaredFaceCoreIndex, inlineBody, declaredFaceSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	var diags []plugin.Diagnostic
	Build(prog, bodiesFor(t, app), NewArtifacts(), func(d plugin.Diagnostic) { diags = append(diags, d) })

	foundFace, foundBody := false, false
	for _, d := range diags {
		if d.Code == "INLINE_FACE_WITHOUT_BODY" {
			foundFace = true
		}
		if d.Code == "INLINE_BODY_WITHOUT_FACE" {
			foundBody = true
		}
	}
	if !foundFace {
		t.Errorf("want INLINE_FACE_WITHOUT_BODY for the publisher face the body does not spell, got %+v", diags)
	}
	if !foundBody {
		t.Errorf("want INLINE_BODY_WITHOUT_FACE for the body no face declares, got %+v", diags)
	}
}

// restTupleCoreIndex and restTupleSugarDTS set up a face whose trailing rest
// parameter's type is a conditional alias — `LifetimeArg<L> = undefined
// extends L ? [lifetime?: L] : [lifetime: L]` — the AST shape `add`'s
// `...lifetime: LifetimeArgument<Lifetime>` face takes: a rest parameter at
// the declaration level whose two conditional branches both name exactly one
// tuple element, "lifetime".
const restTupleCoreIndex = `export interface IQuery {
  isService(token: string): boolean;
}
export declare const provider: IQuery;
`

const restTupleSugarDTS = `export type LifetimeArg<L> = undefined extends L ? [lifetime?: L] : [lifetime: L];

declare module '@scope/core' {
  interface IQuery {
    isService<T, L>(extra: number, ...lifetime: LifetimeArg<L>): boolean;
  }
}
export {};
`

// TestRestTupleFaceMatchesOptionalBody: a face whose trailing rest parameter
// resolves to a fixed one-element tuple in both branches of its conditional
// alias pairs with a body spelling that element as a plain optional
// parameter of the same name — the rest-vs-optional difference at the AST
// level is exactly what the tuple shape absorbs, so the two serve the same
// signature and no INLINE_FACE_WITHOUT_BODY / INLINE_BODY_WITHOUT_FACE fires.
func TestRestTupleFaceMatchesOptionalBody(t *testing.T) {
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T, L>(this: IQuery, extra: number, lifetime?: unknown): boolean {
    return this.isService(typefor<T>(), extra, lifetime);
  }
}
`
	mainSrc := `import { provider } from '@scope/core';
interface Foo { readonly brand: 'foo'; }
export const withoutLifetime = provider.isService<Foo, undefined>(5);
export const withLifetime = provider.isService<Foo, string>(5, 'x');
`
	prog, app := buildWorkspace(t, restTupleCoreIndex, inlineBody, restTupleSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	artifacts := NewArtifacts()
	var diags []plugin.Diagnostic
	transform := Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { diags = append(diags, d) })
	if len(diags) != 0 {
		t.Fatalf("Build raised diagnostics: %+v", diags)
	}

	ec := shimprinter.NewEmitContext()
	main := sourceFileWithSuffix(t, prog, "main.ts")
	out := reprint(ec, transform(ec, main))

	if strings.Contains(out, "isService<") {
		t.Errorf("sugar form isService<> survived:\n%s", out)
	}
	if !strings.Contains(out, "5") || !strings.Contains(out, "'x'") && !strings.Contains(out, `"x"`) {
		t.Errorf("expected both calls spliced with their arguments intact, got:\n%s", out)
	}
}

// TestRestTupleFaceAliasImportedFromAnotherModule: the same conditional-alias
// unrolling, but with the alias declared in a THIRD package and reached
// through a type-only import — the exact shape `LifetimeArgument` takes in
// `di.extras` (`import type { LifetimeArgument } from '@rhombus-std/di.core'`).
// Resolving the alias through an import binding needs following the import's
// own alias symbol before its declarations are visible; a face that resolves
// through a local alias but not an imported one would silently keep failing
// to pair in the real package even after the local-alias case above passes.
func TestRestTupleFaceAliasImportedFromAnotherModule(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)

	core := filepath.Join(root, "packages", "core")
	write(t, filepath.Join(core, "package.json"), `{
  "name": "@scope/core",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	write(t, filepath.Join(core, "src", "index.ts"), `export interface IQuery {
  isService(token: string): boolean;
}
export declare const provider: IQuery;
export type LifetimeArg<L> = undefined extends L ? [lifetime?: L] : [lifetime: L];
`)

	sugar := filepath.Join(root, "packages", "sugar")
	write(t, filepath.Join(sugar, "package.json"), fmt.Sprintf(`{
  "name": "@scope/sugar",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "dependencies": { "@scope/core": "workspace:*" },
  "rhombus-std": { "inline": { "entries": %s } }
}`, pilotEntries))
	write(t, filepath.Join(sugar, "src", "index.ts"), `import type { LifetimeArg } from '@scope/core';

declare module '@scope/core' {
  interface IQuery {
    isService<T, L>(extra: number, ...lifetime: LifetimeArg<L>): boolean;
  }
}
export {};
`)
	write(t, filepath.Join(sugar, "src", "inline.ts"), `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T, L>(this: IQuery, extra: number, lifetime?: unknown): boolean {
    return this.isService(typefor<T>(), extra, lifetime);
  }
}
`)
	linkPackage(t, sugar, "@scope/core", core)

	app := filepath.Join(root, "packages", "app")
	write(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "version": "1.0.0",
  "dependencies": { "@scope/core": "workspace:*", "@scope/sugar": "workspace:*" }
}`)
	linkPackage(t, app, "@scope/core", core)
	linkPackage(t, app, "@scope/sugar", sugar)
	write(t, filepath.Join(app, "main.ts"), `import { provider } from '@scope/core';
interface Foo { readonly brand: 'foo'; }
export const withLifetime = provider.isService<Foo, string>(5, 'x');
`)
	write(t, filepath.Join(app, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["main.ts", "node_modules/@scope/core/src/index.ts", "node_modules/@scope/sugar/src/index.ts"]
}`)

	prog, diags, err := driver.LoadProgram(app, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	defer func() { _ = prog.Close() }()

	artifacts := NewArtifacts()
	var buildDiags []plugin.Diagnostic
	transform := Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { buildDiags = append(buildDiags, d) })
	if len(buildDiags) != 0 {
		t.Fatalf("Build raised diagnostics: %+v", buildDiags)
	}

	ec := shimprinter.NewEmitContext()
	main := sourceFileWithSuffix(t, prog, "main.ts")
	out := reprint(ec, transform(ec, main))

	if strings.Contains(out, "isService<") {
		t.Errorf("sugar form isService<> survived:\n%s", out)
	}
}

// TestRestTupleFaceWithRequiredElementMatchesBody: the same rest-tuple
// unrolling, but through a plain (non-conditional) tuple-type alias whose one
// element is REQUIRED — exercising the type-reference-to-alias-to-tuple path
// on its own, independent of conditional-branch unification.
func TestRestTupleFaceWithRequiredElementMatchesBody(t *testing.T) {
	sugarDTS := `export type RequiredArg<L> = [lifetime: L];

declare module '@scope/core' {
  interface IQuery {
    isService<T, L>(extra: number, ...lifetime: RequiredArg<L>): boolean;
  }
}
export {};
`
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T, L>(this: IQuery, extra: number, lifetime: unknown): boolean {
    return this.isService(typefor<T>(), extra, lifetime);
  }
}
`
	mainSrc := `import { provider } from '@scope/core';
interface Foo { readonly brand: 'foo'; }
export const withLifetime = provider.isService<Foo, string>(5, 'x');
`
	prog, app := buildWorkspace(t, restTupleCoreIndex, inlineBody, sugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	artifacts := NewArtifacts()
	var diags []plugin.Diagnostic
	transform := Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { diags = append(diags, d) })
	if len(diags) != 0 {
		t.Fatalf("Build raised diagnostics: %+v", diags)
	}

	ec := shimprinter.NewEmitContext()
	main := sourceFileWithSuffix(t, prog, "main.ts")
	out := reprint(ec, transform(ec, main))

	if strings.Contains(out, "isService<") {
		t.Errorf("sugar form isService<> survived:\n%s", out)
	}
}

// TestRestTupleFaceNameMismatchStillDiagnosed: unrolling a rest-tuple face
// must not paper over a GENUINE mismatch — a body naming the trailing
// parameter differently from the tuple's own label still draws
// INLINE_FACE_WITHOUT_BODY / INLINE_BODY_WITHOUT_FACE, exactly as an
// ordinary (non-tuple) signature mismatch does.
func TestRestTupleFaceNameMismatchStillDiagnosed(t *testing.T) {
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T, L>(this: IQuery, extra: number, something?: unknown): boolean {
    return this.isService(typefor<T>(), extra, something);
  }
}
`
	mainSrc := `import { provider } from '@scope/core';
export const x = provider;
`
	prog, app := buildWorkspace(t, restTupleCoreIndex, inlineBody, restTupleSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	var diags []plugin.Diagnostic
	Build(prog, bodiesFor(t, app), NewArtifacts(), func(d plugin.Diagnostic) { diags = append(diags, d) })

	foundFace, foundBody := false, false
	for _, d := range diags {
		if d.Code == "INLINE_FACE_WITHOUT_BODY" {
			foundFace = true
		}
		if d.Code == "INLINE_BODY_WITHOUT_FACE" {
			foundBody = true
		}
	}
	if !foundFace {
		t.Errorf("want INLINE_FACE_WITHOUT_BODY for the tuple-unrolled face a differently-named body does not spell, got %+v", diags)
	}
	if !foundBody {
		t.Errorf("want INLINE_BODY_WITHOUT_FACE for the differently-named body no face declares, got %+v", diags)
	}
}
