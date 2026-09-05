package inlinetransform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// The fixture is one program carrying the two receiver shapes the anchor has to
// survive. `core.ts` declares primitive members; `sugar.d.ts` and `sugar2.d.ts`
// add overloads of one the ordinary way — DIRECTLY on the interface, which merges
// into a single member. `hidden.d.ts` adds an overload the other way, through an
// `extends` clause on a member-map interface, which does not merge: the property
// lookup keeps the interface's own declaration and hides the map's. Both shapes
// must resolve to the declaration the marker names, and calls to both must match.

const fixtureCore = `export interface IServiceManifest {
  isService(token: string): boolean;
  reach(token: string): boolean;
}
export declare const manifest: IServiceManifest;
`

// First augmentation file: the inlineable sugar overload of isService (the pilot
// body is ` return this.isService(typefor<T>()) `) and a second member `pick`
// whose type parameter appears in a value position so it is INFERABLE.
const fixtureSugar = `declare module './core' {
  interface IServiceManifest {
    isService<T>(): boolean;
    pick<T>(sample: T): T;
  }
}
export {};
`

// Second augmentation file: a THIRD declaration of isService, in a different
// file, so the marker's declaration set provably spans three sources. Its arity
// differs from the primitive form to keep primitive-call overload resolution
// unambiguous.
const fixtureSugar2 = `declare module './core' {
  interface IServiceManifest {
    isService<T>(hintA: string, hintB: number): boolean;
  }
}
export {};
`

// Third augmentation file: `reach<T>()` arrives through a member-map `extends`
// clause rather than as a direct member, so the interface's own `reach` shadows
// it. This is the shape a real augmentation package publishes, and the one a
// property lookup cannot see past.
const fixtureHidden = `interface IReachAugmentations {
  reach<T>(): boolean;
}
declare module './core' {
  interface IServiceManifest extends IReachAugmentations {}
}
export {};
`

const fixtureMain = `/// <reference path="./sugar.d.ts" />
/// <reference path="./sugar2.d.ts" />
/// <reference path="./hidden.d.ts" />
import { manifest } from './core';

interface Foo { readonly brand: 'foo'; }
declare const theFoo: Foo;

manifest.isService<Foo>();     // explicit sugar — the (a) target
manifest.isService('literal'); // primitive form — matches the member, no type arg to inline
manifest.pick(theFoo);         // inferred T = Foo — the (b) target
manifest.reach<Foo>();         // the hidden-declaration target
`

func loadFixture(t *testing.T) (*driver.Program, *shimchecker.Checker, *shimast.SourceFile) {
	t.Helper()
	root := t.TempDir()
	write(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  },
  "files": ["main.ts", "core.ts", "sugar.d.ts", "sugar2.d.ts", "hidden.d.ts"]
}
`)
	write(t, filepath.Join(root, "core.ts"), fixtureCore)
	write(t, filepath.Join(root, "sugar.d.ts"), fixtureSugar)
	write(t, filepath.Join(root, "sugar2.d.ts"), fixtureSugar2)
	write(t, filepath.Join(root, "hidden.d.ts"), fixtureHidden)
	write(t, filepath.Join(root, "main.ts"), fixtureMain)

	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(diags) != 0 {
		t.Fatalf("unexpected config diagnostics: %v", diags)
	}
	if prog.Checker == nil {
		t.Fatal("LoadProgram did not acquire a checker")
	}
	main := sourceFileWithSuffix(t, prog, "main.ts")
	return prog, prog.Checker, main
}

// markerType resolves the fixture's IServiceManifest to its symbol the way
// resolveMember does: module specifier, then exported type. In production the
// package part is a bare specifier ("@rhombus-std/di.core"); a relative "./core"
// exercises the identical resolution path.
func markerType(t *testing.T, prog *driver.Program, checker *shimchecker.Checker) *shimast.Symbol {
	t.Helper()
	moduleSym := resolveModuleSymbol(prog, checker, "./core")
	if moduleSym == nil {
		t.Fatal("./core did not resolve to a module symbol")
	}
	typeSym := exportedMember(checker, moduleSym, "IServiceManifest")
	if typeSym == nil {
		t.Fatal("./core exports no IServiceManifest")
	}
	return typeSym
}

// receiverOf returns the receiver expression of a property-access call.
func receiverOf(call *shimast.Node) *shimast.Node {
	return call.AsCallExpression().Expression.AsPropertyAccessExpression().Expression
}

// TestResolvedSignatureToDeclarationForExplicitCall is probe (a): the whole build
// dies if this fails. An explicit `manifest.isService<Foo>()` binds to the
// authored sugar overload, and that overload is one of the declarations the
// marker names — the fast path where binding and marker agree.
func TestResolvedSignatureToDeclarationForExplicitCall(t *testing.T) {
	prog, checker, main := loadFixture(t)
	defer func() { _ = prog.Close() }()

	named := map[*shimast.Node]bool{}
	for _, decl := range markerMemberDeclarations(checker, markerType(t, prog, checker), "isService") {
		named[decl] = true
	}

	explicit := callContaining(t, main, "isService<Foo>")
	decl := resolvedDeclaration(checker, explicit)
	if decl == nil {
		t.Fatal("GetResolvedSignature -> declaration returned nil for isService<Foo>()")
	}
	if decl.Kind != shimast.KindMethodSignature {
		t.Fatalf("resolved declaration kind = %v, want a method signature", decl.Kind)
	}
	if !named[decl] {
		t.Fatal("explicit isService<Foo>() bound outside the marker's declaration set")
	}

	// The resolved overload must be the generic sugar form (one type parameter,
	// zero value parameters) — the body-bearing overload, not the primitive.
	sig := checker.GetResolvedSignature(explicit)
	if got := len(shimchecker.Signature_parameters(sig)); got != 0 {
		t.Fatalf("explicit call resolved to a %d-parameter overload, want the 0-parameter sugar form", got)
	}

	// The primitive form shares the member, so its declaration is named too — but
	// it is gated OUT of inlining downstream by carrying no recoverable type
	// argument. That gate, not the member match, is the sugar/primitive
	// discriminator.
	primitive := callContaining(t, main, "isService('literal')")
	if !named[resolvedDeclaration(checker, primitive)] {
		t.Fatal("primitive isService('literal') bound outside the marker's declaration set")
	}
	if _, ok := RecoverTypeArguments(checker, primitive, nil); ok {
		t.Fatal("primitive isService('literal') must yield no type arguments (the inlining gate)")
	}
}

// TestRecoverTypeArgumentsExplicitAndInferred is probe (b): the build dies if
// inferred recovery fails. Explicit `isService<Foo>()` recovers [Foo] from the
// syntactic type argument; inferred `pick(theFoo)` recovers [Foo] from the
// resolved instantiation with NO type argument written.
func TestRecoverTypeArgumentsExplicitAndInferred(t *testing.T) {
	prog, checker, main := loadFixture(t)
	defer func() { _ = prog.Close() }()

	explicit := callContaining(t, main, "isService<Foo>")
	args, ok := RecoverTypeArguments(checker, explicit, nil)
	if !ok {
		t.Fatal("RecoverTypeArguments failed for explicit isService<Foo>()")
	}
	if len(args) != 1 || typeName(checker, args[0]) != "Foo" {
		t.Fatalf("explicit recovery = %v, want [Foo]", typeNames(checker, args))
	}

	inferred := callContaining(t, main, "pick(theFoo)")
	iargs, ok := RecoverTypeArguments(checker, inferred, nil)
	if !ok {
		t.Fatal("RecoverTypeArguments failed for INFERRED pick(theFoo) — kill signal")
	}
	if len(iargs) != 1 || typeName(checker, iargs[0]) != "Foo" {
		t.Fatalf("inferred recovery = %v, want [Foo]", typeNames(checker, iargs))
	}
}

// TestMarkerDeclarationsSpanEveryContributingFile is probe (c): the marker names
// EVERY declaration of the member on the surface it named — the base in core.ts
// plus both `declare module` augmentations — so the set is authoritative
// regardless of which file a call binds to.
func TestMarkerDeclarationsSpanEveryContributingFile(t *testing.T) {
	prog, checker, _ := loadFixture(t)
	defer func() { _ = prog.Close() }()

	declarations := markerMemberDeclarations(checker, markerType(t, prog, checker), "isService")
	if len(declarations) != 3 {
		t.Fatalf("marker names %d declarations of isService, want 3 (core + sugar + sugar2)", len(declarations))
	}

	files := map[string]bool{}
	for _, decl := range declarations {
		sf := shimast.GetSourceFileOfNode(decl)
		if sf == nil {
			t.Fatal("a marker declaration has no source file")
		}
		files[filepath.Base(sf.FileName())] = true
	}
	for _, want := range []string{"core.ts", "sugar.d.ts", "sugar2.d.ts"} {
		if !files[want] {
			t.Fatalf("marker declaration set missing a declaration from %s; got files %v", want, files)
		}
	}
}

// TestMarkerReachesAMemberMapDeclaration is the regression the anchor exists for.
// `reach<T>()` is declared on a member map the receiver extends, and the
// receiver's own `reach` hides it: the property lookup answers with the primitive
// and never mentions the generic one. Walking the surface finds both, so the
// marker still names the declaration it was told to.
func TestMarkerReachesAMemberMapDeclaration(t *testing.T) {
	prog, checker, main := loadFixture(t)
	defer func() { _ = prog.Close() }()

	typeSym := markerType(t, prog, checker)

	// What a property lookup alone can see: the primitive, and nothing generic.
	lookup := checker.GetPropertyOfType(checker.GetDeclaredTypeOfSymbol(typeSym), "reach")
	if lookup == nil {
		t.Fatal("the fixture no longer declares reach on IServiceManifest itself")
	}
	for _, decl := range lookup.Declarations {
		if len(typeParamNames(decl)) != 0 {
			t.Fatal("the property lookup surfaced the generic declaration — the fixture no longer hides it")
		}
	}

	// What the marker names: both, the hidden generic one included.
	generic := 0
	for _, decl := range markerMemberDeclarations(checker, typeSym, "reach") {
		if len(typeParamNames(decl)) == 1 {
			generic++
		}
	}
	if generic != 1 {
		t.Fatalf("marker names %d generic declarations of reach, want 1 — the member map was not walked", generic)
	}
	_ = main
}

// ── fixture / AST helpers ────────────────────────────────────────────────────

// bodiesFor collects the inline bodies for a fixture consumer dir, failing the
// test on error. Build now takes pre-collected bodies (the host runs the one
// §100 scan for stages and bodies); tests that set up a fixture workspace collect
// through this helper.
func bodiesFor(t *testing.T, cwd string) []OwnedEntry {
	t.Helper()
	owned, err := Collect(cwd)
	if err != nil {
		t.Fatalf("Collect(%s): %v", cwd, err)
	}
	return owned
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sourceFileWithSuffix(t *testing.T, prog *driver.Program, suffix string) *shimast.SourceFile {
	t.Helper()
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), suffix) {
			return sf
		}
	}
	t.Fatalf("source file %q not found", suffix)
	return nil
}

// callContaining returns the first call expression in sf whose source text
// contains needle, failing when none is found.
func callContaining(t *testing.T, sf *shimast.SourceFile, needle string) *shimast.Node {
	t.Helper()
	var found *shimast.Node
	walk(sf.AsNode(), func(node *shimast.Node) bool {
		if node.Kind == shimast.KindCallExpression && strings.Contains(shimast.NodeText(node), needle) {
			found = node
			return true
		}
		return false
	})
	if found == nil {
		t.Fatalf("no call expression containing %q", needle)
	}
	return found
}

func typeName(checker *shimchecker.Checker, t *shimchecker.Type) string {
	if t == nil {
		return "<nil>"
	}
	if sym := t.Symbol(); sym != nil {
		return sym.Name
	}
	return "<anonymous>"
}

func typeNames(checker *shimchecker.Checker, ts []*shimchecker.Type) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = typeName(checker, t)
	}
	return out
}

// ── static / namespace / const-member / class-member resolution ─────────────

const staticFixtureSrc = `export class Klass {
  static doStatic(): number { return 1; }
  doInstance(): string { return "a"; }
}

export namespace Ns {
  export function doNamespace(): boolean { return true; }
}

export const Obj = {
  doConst(): string { return "c"; },
};

const inst = new Klass();
Klass.doStatic();
inst.doInstance();
Ns.doNamespace();
Obj.doConst();
`

func loadStaticFixture(t *testing.T) (*driver.Program, *shimchecker.Checker, *shimast.SourceFile) {
	t.Helper()
	root := t.TempDir()
	write(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true
  },
  "files": ["main.ts"]
}`)
	write(t, filepath.Join(root, "main.ts"), staticFixtureSrc)
	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	main := sourceFileWithSuffix(t, prog, "main.ts")
	return prog, prog.Checker, main
}

func TestStaticMemberCallResolvesToDeclaration(t *testing.T) {
	prog, checker, main := loadStaticFixture(t)
	defer func() { _ = prog.Close() }()

	call := callContaining(t, main, "Klass.doStatic()")
	decl := resolvedDeclaration(checker, call)
	if decl == nil {
		t.Fatal("Klass.doStatic() did not resolve to a declaration")
	}
	if name := decl.Name(); name == nil || name.Text() != "doStatic" {
		t.Fatalf("resolved declaration named %v, want doStatic", name)
	}
}

func TestNamespaceMemberCallResolvesToDeclaration(t *testing.T) {
	prog, checker, main := loadStaticFixture(t)
	defer func() { _ = prog.Close() }()

	call := callContaining(t, main, "Ns.doNamespace()")
	decl := resolvedDeclaration(checker, call)
	if decl == nil {
		t.Fatal("Ns.doNamespace() did not resolve to a declaration")
	}
	if name := decl.Name(); name == nil || name.Text() != "doNamespace" {
		t.Fatalf("resolved declaration named %v, want doNamespace", name)
	}
}

func TestConstMemberCallResolvesToDeclaration(t *testing.T) {
	prog, checker, main := loadStaticFixture(t)
	defer func() { _ = prog.Close() }()

	call := callContaining(t, main, "Obj.doConst()")
	decl := resolvedDeclaration(checker, call)
	if decl == nil {
		t.Fatal("Obj.doConst() did not resolve to a declaration")
	}
	if name := decl.Name(); name == nil || name.Text() != "doConst" {
		t.Fatalf("resolved declaration named %v, want doConst", name)
	}
}

func TestClassInstanceMemberCallResolvesToDeclaration(t *testing.T) {
	prog, checker, main := loadStaticFixture(t)
	defer func() { _ = prog.Close() }()

	call := callContaining(t, main, "inst.doInstance()")
	decl := resolvedDeclaration(checker, call)
	if decl == nil {
		t.Fatal("inst.doInstance() did not resolve to a declaration")
	}
	if name := decl.Name(); name == nil || name.Text() != "doInstance" {
		t.Fatalf("resolved declaration named %v, want doInstance", name)
	}
}
