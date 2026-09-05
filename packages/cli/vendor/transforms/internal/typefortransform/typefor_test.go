package typefortransform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// buildTypeforWorkspace lays out a three-package workspace mirroring the real
// shape: `@rhombus-std/primitives` (the runtime `Type` namespace) and
// `@rhombus-std/primitives.extras` (the `typefor` primitive plus a
// self-contained Hole/Keyed brand block, so no real di.core/primitives
// dependency is pulled in), consumed by `app`.
func buildTypeforWorkspace(t *testing.T, mainSrc string) (*driver.Program, string) {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "package.json"), `{ "name": "ws", "private": true, "workspaces": ["packages/*"] }`)

	primitives := filepath.Join(root, "packages", "primitives")
	writeFile(t, filepath.Join(primitives, "package.json"), `{
  "name": "@rhombus-std/primitives",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	writeFile(t, filepath.Join(primitives, "src", "index.ts"), `export declare namespace Type {
  export function global(name: string, genericTypes?: unknown[]): unknown;
  export function imported(name: string, from: string, genericTypes?: unknown[]): unknown;
  export function func(returns: unknown, ...args: unknown[]): unknown;
  export function ctor(instance: unknown, ...args: unknown[]): unknown;
  export function tag(type: unknown, tag: string): unknown;
  export function typeLiteral(value: unknown): unknown;
  export function generic(label: string): unknown;
  export function union(...types: unknown[]): unknown;
}
`)

	extras := filepath.Join(root, "packages", "primitives.extras")
	writeFile(t, filepath.Join(extras, "package.json"), `{
  "name": "@rhombus-std/primitives.extras",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	writeFile(t, filepath.Join(extras, "src", "index.ts"), `export declare function typefor<T>(): any;
export declare function typefor<V>(value: V): any;

declare const HOLE: unique symbol;
export type Hole<L extends string, C = unknown> = C & { readonly [HOLE]?: L };
export type $<L extends string> = Hole<L>;
declare const KEY: unique symbol;
export type Keyed<T, K extends string> = T & { readonly [KEY]?: K };
`)

	app := filepath.Join(root, "packages", "app")
	writeFile(t, filepath.Join(app, "package.json"), `{
  "name": "@scope/app",
  "version": "1.0.0",
  "dependencies": {
    "@rhombus-std/primitives": "workspace:*",
    "@rhombus-std/primitives.extras": "workspace:*"
  }
}`)
	linkPkg(t, app, "@rhombus-std/primitives", primitives)
	linkPkg(t, app, "@rhombus-std/primitives.extras", extras)
	writeFile(t, filepath.Join(app, "main.ts"), mainSrc)
	writeFile(t, filepath.Join(app, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": [
    "main.ts",
    "node_modules/@rhombus-std/primitives/src/index.ts",
    "node_modules/@rhombus-std/primitives.extras/src/index.ts"
  ]
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

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func linkPkg(t *testing.T, appDir, name, target string) {
	t.Helper()
	link := filepath.Join(appDir, "node_modules", name)
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func mainSF(t *testing.T, prog *driver.Program) *shimast.SourceFile {
	t.Helper()
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), "main.ts") {
			return sf
		}
	}
	t.Fatal("main.ts not found")
	return nil
}

func reprint(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

// lowerTypefor runs the typefor stage over main.ts (source-written anchoring,
// artifacts=nil) and returns the reprinted output.
func lowerTypefor(t *testing.T, prog *driver.Program, app string) string {
	t.Helper()
	ctx := plugin.NewContext(prog, app)
	transform := New(prog, ctx, nil, nil, func(plugin.Diagnostic) {})
	ec := shimprinter.NewEmitContext()
	out := transform(ec, mainSF(t, prog))
	return reprint(ec, out)
}

// lowerTypeforDiags is lowerTypefor but also returns the diagnostics raised.
func lowerTypeforDiags(t *testing.T, prog *driver.Program, app string) (string, []plugin.Diagnostic) {
	t.Helper()
	ctx := plugin.NewContext(prog, app)
	var diags []plugin.Diagnostic
	transform := New(prog, ctx, nil, nil, func(d plugin.Diagnostic) { diags = append(diags, d) })
	ec := shimprinter.NewEmitContext()
	out := transform(ec, mainSF(t, prog))
	return reprint(ec, out), diags
}

// exprFor extracts the initializer expression of `export const <name> = <expr>;`
// from out, stopping at the trailing `;`.
func exprFor(t *testing.T, out, constName string) string {
	t.Helper()
	marker := "const " + constName + " = "
	i := strings.Index(out, marker)
	if i < 0 {
		t.Fatalf("no `const %s = ` in:\n%s", constName, out)
	}
	rest := out[i+len(marker):]
	end := strings.Index(rest, ";\n")
	if end < 0 {
		t.Fatalf("no terminating `;` for `const %s` in:\n%s", constName, out)
	}
	return rest[:end]
}

func TestTypeforBareTypeArg(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tok = typefor<IThing>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("IThing", "@scope/app/main")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<IThing>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
	if strings.Contains(out, "typefor") {
		t.Fatalf("the now-unreferenced typefor import should be elided:\n%s", out)
	}
	if !strings.Contains(out, `import { Type } from "@rhombus-std/primitives";`) {
		t.Fatalf("Type import should be injected:\n%s", out)
	}
}

func TestTypeforGenericArgs(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing<T> {}
interface IOther {}
export const tok = typefor<IThing<IOther>>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("IThing", "@scope/app/main", [Type.imported("IOther", "@scope/app/main")])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<IThing<IOther>>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforTupleGenericArg pins a tuple in TYPE-ARGUMENT position: its slots
// become the factory call's positional arguments, in order, each derived like
// any other node — so a nested tuple nests and a hole among the slots stays a
// hole.
func TestTypeforTupleGenericArg(t *testing.T) {
	src := `import { typefor, $ } from '@rhombus-std/primitives.extras';
interface IThing<T> {}
interface IClock {}
interface IStore {}
export const pair = typefor<IThing<[IClock, IStore]>>();
export const nested = typefor<IThing<[IClock, [IStore, IClock]]>>();
export const holed = typefor<IThing<[IClock, $<'TEntity'>]>>();
export const empty = typefor<IThing<[]>>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	clock := `Type.imported("IClock", "@scope/app/main")`
	store := `Type.imported("IStore", "@scope/app/main")`
	thing := func(arg string) string {
		return `Type.imported("IThing", "@scope/app/main", [` + arg + `])`
	}
	cases := map[string]string{
		"pair":   thing(`Type.tuple(` + clock + `, ` + store + `)`),
		"nested": thing(`Type.tuple(` + clock + `, Type.tuple(` + store + `, ` + clock + `))`),
		"holed":  thing(`Type.tuple(` + clock + `, Type.generic("TEntity"))`),
		"empty":  thing(`Type.tuple()`),
	}
	for name, want := range cases {
		if got := exprFor(t, out, name); got != want {
			t.Errorf("%s = %q, want %q\nfull output:\n%s", name, got, want, out)
		}
	}
}

// TestTypeforParameterListUtilities pins that ConstructorParameters<> and
// Parameters<> need no case of their own: the checker resolves both to a
// concrete tuple before derivation sees them, so they emit as one.
func TestTypeforParameterListUtilities(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IClock {}
interface IStore {}
class Widget { constructor(clock: IClock, store: IStore) { void clock; void store; } }
declare function build(clock: IClock, store: IStore): IClock;
export const ctorParams = typefor<ConstructorParameters<typeof Widget>>();
export const fnParams = typefor<Parameters<typeof build>>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.tuple(Type.imported("IClock", "@scope/app/main"), Type.imported("IStore", "@scope/app/main"))`
	for _, name := range []string{"ctorParams", "fnParams"} {
		if got := exprFor(t, out, name); got != want {
			t.Errorf("%s = %q, want %q\nfull output:\n%s", name, got, want, out)
		}
	}
}

func TestTypeforGenericPlaceholder(t *testing.T) {
	src := `import { typefor, $ } from '@rhombus-std/primitives.extras';
interface IThing<T> {}
export const tok = typefor<IThing<$<'TEntity'>>>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("IThing", "@scope/app/main", [Type.generic("TEntity")])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<IThing<$<'TEntity'>>>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforNamedTypeMultipleGenericArgs pins that a named type's OWN generic
// arguments all survive in order — unlike the collection bases in
// TestTypeforListCarriesOnlyItsElement below, an ordinary two-parameter
// interface is not truncated.
func TestTypeforNamedTypeMultipleGenericArgs(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IPair<A, B> { readonly a: A; readonly b: B; }
interface IClock {}
interface IStore {}
export const tok = typefor<IPair<IClock, IStore>>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("IPair", "@scope/app/main", [` +
		`Type.imported("IClock", "@scope/app/main"), Type.imported("IStore", "@scope/app/main")])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<IPair<IClock, IStore>>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforLiteral(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
export const tok = typefor<"dev">();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.typeLiteral("dev")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<\"dev\">() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforLiteralKinds covers the literal kinds TestTypeforLiteral's bare
// string does not reach: a negative number, a negative bigint, and — inside one
// union — the true/false PAIR collapsing back into the wide `boolean` member
// beside a `null` singleton, nullish-last.
func TestTypeforLiteralKinds(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
export const num = typefor<-5>();
export const big = typefor<-7n>();
export const boolPair = typefor<true | false | null>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	cases := map[string]string{
		"num":      `Type.typeLiteral(-5)`,
		"big":      `Type.typeLiteral(-7n)`,
		"boolPair": `Type.union(Type.global("boolean"), Type.typeLiteral(null))`,
	}
	for name, want := range cases {
		if got := exprFor(t, out, name); got != want {
			t.Errorf("%s = %q, want %q\nfull output:\n%s", name, got, want, out)
		}
	}
}

func TestTypeforKeyedTag(t *testing.T) {
	src := `import { typefor, Keyed } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tok = typefor<Keyed<IThing, "redis">>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.tag(Type.imported("IThing", "@scope/app/main"), "redis")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<Keyed<IThing,\"redis\">>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforValueArgCtorNoParams(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
class Foo {}
export const tok = typefor(Foo);
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.ctor(Type.imported("Foo", "@scope/app/main"), [[]])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor(Foo) = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforValueArgCtorWithParams(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
class Foo {
  constructor(a: IA, b: IB) { void a; void b; }
}
export const tok = typefor(Foo);
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.ctor(Type.imported("Foo", "@scope/app/main"), [[Type.imported("IA", "@scope/app/main"), Type.imported("IB", "@scope/app/main")]])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor(Foo) = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforValueArgCtorOverloaded pins the signatures slot for a CONSTRUCTOR
// carrying multiple overloaded signatures — TestTypeforAccessorSignaturesOverloaded
// below covers this for a plain function; a class constructor reaches the same
// multi-row path through Type.ctor instead of Type.func.
func TestTypeforValueArgCtorOverloaded(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
class Widget {
  constructor(a: IA);
  constructor(a: IA, b: IB);
  constructor(a: IA, b?: IB) { void a; void b; }
}
export const tok = typefor(Widget).signatures;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.union(Type.tuple(Type.imported("IA", "@scope/app/main")), ` +
		`Type.tuple(Type.imported("IA", "@scope/app/main"), Type.imported("IB", "@scope/app/main")))`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".signatures fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforValueArgAbstractCtor(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
abstract class Foo {
  constructor(a: IA) { void a; }
}
export const tok = typefor(Foo);
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.abstractCtor(Type.imported("Foo", "@scope/app/main"), [[Type.imported("IA", "@scope/app/main")]])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor(Foo) = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforValueArgAbstractCtorOverloaded is the ctor-overload test above,
// off an ABSTRACT class — KindAbstractCtor carries its signatures slot exactly
// like KindCtor and KindFunc.
func TestTypeforValueArgAbstractCtorOverloaded(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
abstract class Widget {
  constructor(a: IA);
  constructor(a: IA, b: IB);
  constructor(a: IA, b?: IB) { void a; void b; }
}
export const tok = typefor(Widget).signatures;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.union(Type.tuple(Type.imported("IA", "@scope/app/main")), ` +
		`Type.tuple(Type.imported("IA", "@scope/app/main"), Type.imported("IB", "@scope/app/main")))`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".signatures fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforAccessorInstanceAbstractCtor: `.instance` folds the same way over
// an abstract-constructor-shaped derivation as over an ordinary one — both
// kinds carry the member.
func TestTypeforAccessorInstanceAbstractCtor(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
abstract class Foo {}
export const tok = typefor(Foo).instance;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("Foo", "@scope/app/main")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".instance fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforFunctionTypeArg(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tok = typefor<() => IThing>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.func(Type.imported("IThing", "@scope/app/main"), [[]])`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("typefor<() => IThing>() = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforAccessorReturn(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
interface IThing {}
export const tok = typefor<(a: IA, b: IB) => IThing>().return;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("IThing", "@scope/app/main")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".return fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
	if strings.Contains(out, "Type.func(") {
		t.Fatalf(".return should fold away the Type.func wrapper entirely:\n%s", out)
	}
}

// TestTypeforAccessorSignatures: `.signatures` is a callable's signatures slot,
// so the fold emits the slot node itself — one tuple for an un-overloaded
// declaration.
func TestTypeforAccessorSignatures(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
interface IThing {}
export const tok = typefor<(a: IA, b: IB) => IThing>().signatures;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.tuple(Type.imported("IA", "@scope/app/main"), Type.imported("IB", "@scope/app/main"))`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".signatures fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforAccessorSignaturesOverloaded: an overloaded declaration's slot is
// the union of its per-overload rows, in declaration order.
func TestTypeforAccessorSignaturesOverloaded(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IA {}
interface IB {}
interface IThing {}
declare function make(a: IA): IThing;
declare function make(a: IA, b: IB): IThing;
export const tok = typefor<typeof make>().signatures;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.union(Type.tuple(Type.imported("IA", "@scope/app/main")), ` +
		`Type.tuple(Type.imported("IA", "@scope/app/main"), Type.imported("IB", "@scope/app/main")))`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".signatures fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforAccessorInstance(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
class Foo {}
export const tok = typefor(Foo).instance;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `Type.imported("Foo", "@scope/app/main")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".instance fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforAccessorValue(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
export const tok = typefor<"dev">().value;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	want := `"dev"`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf(".value fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
	if strings.Contains(out, "typeLiteral") {
		t.Fatalf(".value should fold away the Type.typeLiteral wrapper entirely:\n%s", out)
	}
}

func TestTypeforAccessorTagAndType(t *testing.T) {
	src := `import { typefor, Keyed } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tag = typefor<Keyed<IThing, "redis">>().tag;
export const inner = typefor<Keyed<IThing, "redis">>().type;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	if got, want := exprFor(t, out, "tag"), `"redis"`; got != want {
		t.Fatalf(".tag fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
	if got, want := exprFor(t, out, "inner"), `Type.imported("IThing", "@scope/app/main")`; got != want {
		t.Fatalf(".type fold = %q, want %q\nfull output:\n%s", got, want, out)
	}
}

func TestTypeforAccessorKind(t *testing.T) {
	src := `import { typefor, Keyed } from '@rhombus-std/primitives.extras';
interface IThing {}
class Foo {}
abstract class Bar {}
export const kFunc = typefor<() => IThing>().kind;
export const kCtor = typefor(Foo).kind;
export const kAbstractCtor = typefor(Bar).kind;
export const kImport = typefor<IThing>().kind;
export const kGlobal = typefor<string>().kind;
export const kTag = typefor<Keyed<IThing, "redis">>().kind;
export const kLit = typefor<"dev">().kind;
export const kTuple = typefor<[IThing, string]>().kind;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	cases := map[string]string{
		"kFunc":         `"func"`,
		"kCtor":         `"ctor"`,
		"kAbstractCtor": `"abstract-ctor"`,
		"kImport":       `"imported"`,
		"kGlobal":       `"global"`,
		"kTag":          `"tag"`,
		"kLit":          `"literal"`,
		"kTuple":        `"tuple"`,
	}
	for name, want := range cases {
		if got := exprFor(t, out, name); got != want {
			t.Errorf(".kind fold for %s = %q, want %q\nfull output:\n%s", name, got, want, out)
		}
	}
}

// TestTypeforImportInjection pins the injection branch: no pre-existing `Type`
// import, so exactly one gets prepended.
func TestTypeforImportInjection(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tok = typefor<IThing>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	count := strings.Count(out, `import { Type }`)
	if count != 1 {
		t.Fatalf("expected exactly one injected Type import, got %d:\n%s", count, out)
	}
}

// TestTypeforReuseExistingImport pins the reuse branch: a pre-existing named
// (possibly aliased) `Type` import from `@rhombus-std/primitives` is reused
// as-is — no second import is injected, and every lowered reference uses the
// existing local binding.
func TestTypeforReuseExistingImport(t *testing.T) {
	src := `import { Type as T2 } from '@rhombus-std/primitives';
import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const tok = typefor<IThing>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	// The reused import keeps its ORIGINAL single-quote spelling (no node was
	// minted for it); a freshly injected one would use the printer's double-quote
	// default — count both so the assertion doesn't depend on which.
	count := strings.Count(out, `from '@rhombus-std/primitives'`) + strings.Count(out, `from "@rhombus-std/primitives"`)
	if count != 1 {
		t.Fatalf("expected exactly one @rhombus-std/primitives import statement, got %d in output:\n%s", count, out)
	}
	want := `T2.imported("IThing", "@scope/app/main")`
	if got := exprFor(t, out, "tok"); got != want {
		t.Fatalf("expected the lowered call to use the existing aliased binding: got %q want %q\nfull output:\n%s", got, want, out)
	}
	if strings.Contains(out, "Type.imported(") {
		t.Fatalf("lowered call should use the existing alias T2, not a fresh Type import:\n%s", out)
	}
}

// TestTypeforUnfoldableFallback pins the "leave it alone" half of the accessor
// peephole: a typefor() result stored in a variable and read later is NOT
// folded — the bare call still lowers to its full Type.* tree, and the later
// property access on the variable is left exactly as written (a correct, just
// not maximally tidy, runtime field read).
func TestTypeforUnfoldableFallback(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
declare function factory(): IThing;
const t = typefor<typeof factory>();
export const rt = t.return;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	wantT := `Type.func(Type.imported("IThing", "@scope/app/main"), [[]])`
	if got := exprFor(t, out, "t"); got != wantT {
		t.Fatalf("bare typefor call = %q, want %q\nfull output:\n%s", got, wantT, out)
	}
	wantRt := `t.return`
	if got := exprFor(t, out, "rt"); got != wantRt {
		t.Fatalf("unfoldable use should be left unchanged: got %q, want %q\nfull output:\n%s", got, wantRt, out)
	}
}

// TestTypeforValueArgSourceWrittenPlainValue proves a value argument with
// neither a construct nor a call signature derives as its own type via the
// tokens.DeriveNode leaf path, matching typefor<AppConfig>().
func TestTypeforValueArgPlainValue(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface AppConfig { host: string }
declare const cfg: AppConfig;
export const viaValue = typefor(cfg);
export const viaType = typefor<AppConfig>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	viaValue := exprFor(t, out, "viaValue")
	viaType := exprFor(t, out, "viaType")
	if viaValue != viaType {
		t.Fatalf("value-arg typefor(cfg) must equal type-arg typefor<AppConfig>(): %q vs %q", viaValue, viaType)
	}
}

// TestTypeforTypeArgAnonymousObjectDerivesToObject covers an anonymous record
// type argument: it spells `Type.object` over its members, keyed by name, so a
// structural shape the Type grammar CAN express is lowered rather than refused.
func TestTypeforTypeArgAnonymousObjectDerivesToObject(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
export const obj = typefor<{ readonly a: number; b: string }>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out, diags := lowerTypeforDiags(t, prog, app)
	if len(diags) != 0 {
		t.Fatalf("anonymous object must derive cleanly, got %+v", diags)
	}
	want := `Type.object({ a: Type.global("number"), b: Type.global("string") })`
	if got := exprFor(t, out, "obj"); got != want {
		t.Fatalf("anonymous object derived %q, want %q\nfull output:\n%s", got, want, out)
	}
}

// TestTypeforTypeArgUnderivableReportsDiagnostic covers the failure path: an
// index-signature object has no fixed member list the `Type.object` grammar can
// state, so it cannot derive a Type, and the stage reports a targeted diagnostic
// and leaves the call UN-lowered.
func TestTypeforTypeArgUnderivableReportsDiagnostic(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
export const indexed = typefor<{ [key: string]: number }>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out, diags := lowerTypeforDiags(t, prog, app)
	if len(diags) != 1 || diags[0].Code != typeArgUnderivableCode {
		t.Fatalf("expected one %s diagnostic, got %+v", typeArgUnderivableCode, diags)
	}
	if !strings.Contains(out, "typefor<") {
		t.Fatalf("underivable typefor call must be left un-lowered:\n%s", out)
	}
}

// TestTypeforAccessorMismatchReportsDiagnostic covers the peephole's own failure
// mode: `.return` on a NAMED (non-function) type is a known accessor name
// applied to a derivation whose kind doesn't carry it.
func TestTypeforAccessorMismatchReportsDiagnostic(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const bad = typefor<IThing>().return;
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	_, diags := lowerTypeforDiags(t, prog, app)
	if len(diags) != 1 || diags[0].Code != accessorMismatchCode {
		t.Fatalf("expected one %s diagnostic, got %+v", accessorMismatchCode, diags)
	}
}

// TestTypeforListCarriesOnlyItsElement pins the arity a list spelling derives
// at. The lib declares `Iterable<T, TReturn = any, TNext = any>` and
// `AsyncIterable` identically, and a bare `Iterable<E>` reference still resolves
// all three arguments — so the derivation must keep only the element. The runtime
// `named` door mints a list kind from a SINGLE argument under `global`, so a
// spelling that carried the defaulted tail would land as an ordinary named type
// that no list registration answers.
func TestTypeforListCarriesOnlyItsElement(t *testing.T) {
	src := `import { typefor } from '@rhombus-std/primitives.extras';
interface IThing {}
export const arr = typefor<IThing[]>();
export const iter = typefor<Iterable<IThing>>();
export const aiter = typefor<AsyncIterable<IThing>>();
export const roarr = typefor<readonly IThing[]>();
`
	prog, app := buildTypeforWorkspace(t, src)
	defer func() { _ = prog.Close() }()

	out := lowerTypefor(t, prog, app)
	element := `Type.imported("IThing", "@scope/app/main")`
	for _, tc := range []struct{ name, want string }{
		{"arr", `Type.global("Array", [` + element + `])`},
		{"iter", `Type.global("Iterable", [` + element + `])`},
		{"aiter", `Type.global("AsyncIterable", [` + element + `])`},
		// readonly T[] is `ReadonlyArray<T>` — not in collectionTokenBases, and not
		// the mutable Array kind the runtime's `named` door collapses to
		// ArrayType, so it must derive as its OWN name rather than either.
		{"roarr", `Type.global("ReadonlyArray", [` + element + `])`},
	} {
		if got := exprFor(t, out, tc.name); got != tc.want {
			t.Errorf("%s = %q, want %q\nfull output:\n%s", tc.name, got, tc.want, out)
		}
	}
}
