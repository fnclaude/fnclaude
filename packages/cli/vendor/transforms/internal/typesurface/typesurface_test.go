package typesurface

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// load writes a one-file strict project, loads it, and returns the checker plus
// the declared type of `export declare const probe: <name>`.
func load(t *testing.T, source, name string) (*driver.Program, *shimchecker.Checker, *shimchecker.Type) {
	t.Helper()
	return loadWith(t, source, name, nil)
}

// loadWith is load with sibling files written beside `app.ts`, keyed by file
// name — a neighbour the fixture imports from, reached by resolution rather than
// by the `files` list.
func loadWith(t *testing.T, source, name string, siblings map[string]string) (*driver.Program, *shimchecker.Checker, *shimchecker.Type) {
	t.Helper()
	root := t.TempDir()
	for fileName, content := range siblings {
		write(t, filepath.Join(root, fileName), content)
	}
	write(t, filepath.Join(root, "app.ts"), source+"\nexport declare const probe: "+name+";\n")
	write(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["app.ts"]
}`)
	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	var probe *shimast.Node
	for _, sf := range prog.SourceFiles() {
		if !strings.HasSuffix(sf.FileName(), "app.ts") {
			continue
		}
		for _, statement := range sf.Statements.Nodes {
			if statement.Kind != shimast.KindVariableStatement {
				continue
			}
			for _, decl := range statement.AsVariableStatement().DeclarationList.AsVariableDeclarationList().Declarations.Nodes {
				if decl.Name() != nil && decl.Name().Text() == "probe" {
					probe = decl.AsVariableDeclaration().Type
				}
			}
		}
	}
	if probe == nil {
		t.Fatal("no `probe` declaration in the fixture")
	}
	return prog, prog.Checker, prog.Checker.GetTypeFromTypeNode(probe)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func names(surface Surface) []string {
	out := make([]string, 0, len(surface.Members))
	for _, m := range surface.Members {
		out = append(out, m.Name)
	}
	return out
}

func TestEnumeratesPublicMembersOnly(t *testing.T) {
	prog, checker, t0 := load(t, `
export class C {
  #hidden: number = 0;
  #alsoHidden: string = "";
  public get hidden(): number { return this.#hidden; }
  public set hidden(v: number) { this.#hidden = v; }
  public plain: string = "";
  public maybe?: number;
  private secret: string = "";
  protected shared: string = "";
  static defaultHost: string = "";
}
`, "C")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	got := names(surface)
	want := []string{"hidden", "plain", "maybe"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("members = %v; want %v", got, want)
	}
	if surface.PrivateNamed != 2 {
		t.Errorf("PrivateNamed = %d; want 2", surface.PrivateNamed)
	}
	if surface.ModifierHidden != 2 {
		t.Errorf("ModifierHidden = %d; want 2", surface.ModifierHidden)
	}
	if !surface.HasAccessor {
		t.Error("HasAccessor = false; want true (`hidden` is an accessor)")
	}
	for _, m := range surface.Members {
		if m.Name == "maybe" && !m.Optional {
			t.Error("`maybe?` is not reported optional")
		}
		if m.Name == "plain" && m.Optional {
			t.Error("`plain` is reported optional")
		}
	}
}

// An accessor's member type is the type it declares, read at its own declaration.
func TestAccessorMemberTypeIsTheDeclaredAccessorType(t *testing.T) {
	prog, checker, t0 := load(t, `
export class C {
  #value: string = "";
  public get value(): number | undefined { return 1; }
}
`, "C")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	if len(surface.Members) != 1 {
		t.Fatalf("members = %v; want exactly [value]", names(surface))
	}
	member := surface.Members[0]
	got := checker.TypeToString(checker.GetTypeOfSymbolAtLocation(member.Symbol, member.Decl))
	if got != "number | undefined" {
		t.Errorf("member type = %q; want \"number | undefined\"", got)
	}
}

// An interface has nothing to hide: every member survives and both counts are 0.
func TestInterfaceHidesNothing(t *testing.T) {
	prog, checker, t0 := load(t, `
export interface I { host: string; port: number; }
`, "I")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	if len(surface.Members) != 2 {
		t.Errorf("members = %v; want [host port]", names(surface))
	}
	if surface.PrivateNamed != 0 || surface.ModifierHidden != 0 {
		t.Errorf("counts = %d/%d; want 0/0", surface.PrivateNamed, surface.ModifierHidden)
	}
	if surface.HasAccessor {
		t.Error("HasAccessor = true for an interface with no accessors")
	}
}

// An accessor is directional, and consumers face opposite ways: a guard reads,
// a schema writes. Both directions have to be reported, or one consumer emits a
// member operation that can never succeed.
func TestAccessorDirectionsAreReportedSeparately(t *testing.T) {
	prog, checker, t0 := load(t, `
export class C {
  #a = 0;
  #b = 0;
  public get readOnly(): number { return this.#a; }
  public set writeOnly(v: number) { this.#b = v; }
  public get both(): number { return this.#a; }
  public set both(v: number) { this.#a = v; }
  public plain: string = "";
}
`, "C")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	for _, tc := range []struct {
		name               string
		readable, writable bool
	}{
		{"readOnly", true, false},
		{"writeOnly", false, true},
		{"both", true, true},
		{"plain", true, true},
	} {
		var found bool
		for _, m := range surface.Members {
			if m.Name != tc.name {
				continue
			}
			found = true
			if m.Readable != tc.readable || m.Writable != tc.writable {
				t.Errorf("%s: readable/writable = %v/%v; want %v/%v", tc.name, m.Readable, m.Writable, tc.readable, tc.writable)
			}
		}
		if !found {
			t.Errorf("%s absent from the surface %v", tc.name, names(surface))
		}
	}
	if got := len(surface.Readable()); got != 3 {
		t.Errorf("Readable() = %d members; want 3", got)
	}
	if got := len(surface.Writable()); got != 3 {
		t.Errorf("Writable() = %d members; want 3", got)
	}
}

// The refusal predicates are per-direction, and a type that declares nothing is
// neither: both consumers have to reach the same verdict on the same type.
func TestNothingReadableAndNothingWritable(t *testing.T) {
	prog, checker, t0 := load(t, `
export class Sealed { #a: number = 0; private b: string = ""; }
`, "Sealed")
	defer func() { _ = prog.Close() }()
	sealed := For(checker, t0, nil)
	if !sealed.NothingReadable() || !sealed.NothingWritable() {
		t.Error("a class whose every member is hidden is reported readable or writable")
	}

	prog2, checker2, t2 := load(t, `export interface Empty {}`, "Empty")
	defer func() { _ = prog2.Close() }()
	empty := For(checker2, t2, nil)
	if empty.NothingReadable() || empty.NothingWritable() {
		t.Error("an empty type is reported as hiding something; it declares nothing")
	}

	prog3, checker3, t3 := load(t, `
export class Half { #v = 0; public set v(x: number) { this.#v = x; } }
`, "Half")
	defer func() { _ = prog3.Close() }()
	half := For(checker3, t3, nil)
	if !half.NothingReadable() {
		t.Error("a set-only accessor is reported readable")
	}
	if half.NothingWritable() {
		t.Error("a set-only accessor is reported unwritable")
	}
}

// A mapped type reminds each member as a plain property symbol while keeping the
// original accessor node as its declaration. Reading the SYMBOL's flags makes the
// accessor invisible; reading the declaration keeps it visible, in both
// directions.
func TestMappedTypeKeepsAccessorsVisible(t *testing.T) {
	prog, checker, t0 := load(t, `
export class C {
  #a = 0;
  #b = 0;
  public get readOnly(): number { return this.#a; }
  public set writeOnly(v: number) { this.#b = v; }
  public plain: string = "";
}
export type Mapped = { [K in keyof C]: C[K] };
`, "Mapped")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	if !surface.HasAccessor {
		t.Errorf("HasAccessor = false through a mapped type; members = %v", names(surface))
	}
	for _, m := range surface.Members {
		switch m.Name {
		case "readOnly":
			if !m.Readable || m.Writable {
				t.Errorf("readOnly through a mapped type: readable/writable = %v/%v; want true/false", m.Readable, m.Writable)
			}
		case "writeOnly":
			if m.Readable || !m.Writable {
				t.Errorf("writeOnly through a mapped type: readable/writable = %v/%v; want false/true", m.Readable, m.Writable)
			}
		}
	}
}

// Library-ness is about a NOMINAL identity, not a declaration site: a standard
// mapped-type utility denotes a shape and is as checkable as its argument.
func TestStandardUtilitiesAreNotNominalBuiltIns(t *testing.T) {
	prog, checker, t0 := load(t, `
export interface Opts { host: string; port: number; }
`, "Partial<Opts>")
	defer func() { _ = prog.Close() }()
	if FromLibrary(prog, t0) {
		t.Error("Partial<Opts> is reported a nominal built-in; it is a mapped type over a project type")
	}

	prog2, _, t2 := load(t, ``, "Map<string, number>")
	defer func() { _ = prog2.Close() }()
	if !FromLibrary(prog2, t2) {
		t.Error("Map is not reported a nominal built-in")
	}
	_ = checker
}

// A COMPUTED name is not a symbol name. What the name evaluates to decides it:
// a string literal and a string-typed const both name an ordinary key an element
// access reads, while a `unique symbol` const names none.
func TestComputedNameIsClassifiedByWhatItEvaluatesTo(t *testing.T) {
	prog, checker, t0 := load(t, `
const MARK: unique symbol = Symbol("m");
const KEY = "fromConst";
export class C {
  ["a-b"]: string = "";
  [KEY]: string = "";
  [MARK]: string = "";
  [Symbol.iterator](): Iterator<string> { return [][Symbol.iterator](); }
  plain: string = "";
}
`, "C")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	got := names(surface)
	want := []string{"a-b", "fromConst", "plain"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("members = %v; want %v", got, want)
	}
	if surface.SymbolKeyed != 2 {
		t.Errorf("SymbolKeyed = %d; want 2 (the `unique symbol` const and the well-known symbol)", surface.SymbolKeyed)
	}
}

// A `declare`d const in an implementation file emits no binding, so no value can
// carry a property keyed on the symbol it names. Such a member is not part of the
// surface at all — leaving it out of the count is what keeps a consumer from
// refusing over a member nothing could have supplied.
func TestAmbientKeyInAnImplementationFileIsNotAMember(t *testing.T) {
	prog, checker, t0 := load(t, `
declare const BRAND: unique symbol;
export interface Branded {
  readonly [BRAND]: void;
  host: string;
}
`, "Branded")
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	got := names(surface)
	want := []string{"host"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("members = %v; want %v", got, want)
	}
	if surface.SymbolKeyed != 0 {
		t.Errorf("SymbolKeyed = %d; want 0 (the brand emits no binding to key on)", surface.SymbolKeyed)
	}
	if surface.Phantom != 1 {
		t.Errorf("Phantom = %d; want 1 — a consumer enumerating members some other way still keys on it", surface.Phantom)
	}
	if surface.Hidden() != 0 {
		t.Errorf("Hidden() = %d; want 0 — nothing is withheld by leaving out a member no value carries", surface.Hidden())
	}
}

// The brand is judged at the const it names, not at the import specifier
// standing in for it: importing it changes nothing about whether a binding is
// emitted.
func TestAmbientKeyIsPhantomThroughAnImport(t *testing.T) {
	prog, checker, t0 := loadWith(t, `
import { BRAND } from "./brand.ts";
export interface Branded {
  readonly [BRAND]: void;
  host: string;
}
`, "Branded", map[string]string{
		"brand.ts": "export declare const BRAND: unique symbol;\n",
	})
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	if got := names(surface); strings.Join(got, ",") != "host" {
		t.Errorf("members = %v; want [host]", got)
	}
	if surface.SymbolKeyed != 0 {
		t.Errorf("SymbolKeyed = %d; want 0 (the imported brand emits no binding either)", surface.SymbolKeyed)
	}
}

// A `.d.ts` declaration DESCRIBES a binding some emitted module really creates,
// so a value can carry the key. That member keeps its place in the count and the
// refusal it drives.
func TestAmbientKeyDeclaredInADeclarationFileStaysCounted(t *testing.T) {
	prog, checker, t0 := loadWith(t, `
import { BRAND } from "./brand.js";
export interface Branded {
  readonly [BRAND]: void;
  host: string;
}
`, "Branded", map[string]string{
		"brand.d.ts": "export declare const BRAND: unique symbol;\n",
	})
	defer func() { _ = prog.Close() }()

	surface := For(checker, t0, nil)
	if got := names(surface); strings.Join(got, ",") != "host" {
		t.Errorf("members = %v; want [host]", got)
	}
	if surface.SymbolKeyed != 1 {
		t.Errorf("SymbolKeyed = %d; want 1 (a declaration file describes a real binding)", surface.SymbolKeyed)
	}
	if surface.Phantom != 0 {
		t.Errorf("Phantom = %d; want 0", surface.Phantom)
	}
}
