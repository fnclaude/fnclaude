package tokens

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// These are the checker-backed unit tests for generics.go: the open-generic hole
// walk, the Inject/Hole/Keyed brand reads, the unbound-type-parameter failure
// channel, and the literal / singleton classifiers. Each behavior is probed off a
// real `driver.LoadProgram` fixture — the module's standard way to unit-test
// checker-dependent code (mirrors inlinetransform/matcher_test.go's loadFixture),
// NOT a ttsc host. The brand types are self-contained in the fixture, so no
// primitives dependency is pulled in.
//
// The thin alias-reader passthroughs (AliasSymbolName / AliasTypeArguments /
// SymbolName / AliasSymbol / IntrinsicToken) are pure checker delegation with no
// logic of their own; they ride the *.ttsc.e2e parity suites and are not probed as
// isolated fixtures here.

// fixtureSrc declares every type the checker-backed generics tests read, one per
// `declare const`, plus the self-contained Hole / Inject / Keyed brands and the
// class and function whose parameter lists the tuple utility types read. Every base
// token renders bare because the test Context reports every file as a default lib
// (so the assertions pin the hole / key / literal grammar, not the package tier).
const fixtureSrc = `declare const HOLE: unique symbol;
type Hole<L extends string, C = unknown> = C & { readonly [HOLE]?: L };
declare const KEY: unique symbol;
type Keyed<T, K extends string> = T & { readonly [KEY]?: K };
declare const TOK: unique symbol;
type Inject<T, K extends string> = T & { readonly [TOK]?: K };

interface IThing<T = unknown> { readonly thing: T; }
interface IOther { readonly other: number; }
interface ICache { readonly cache: number; }
interface Box<T> { readonly value: T; }

declare const litStr: "lit";
declare const intr: number;
declare const holeInThing: IThing<Hole<"1">>;
declare const anon: { readonly a: number };
declare const nestedAnon: IThing<{ readonly a: number }>;
declare const plain: IThing;

declare const hole3: Hole<"3">;
declare const inj: Inject<IThing, "tok">;
declare const injOpt: Inject<IThing, "tok"> | undefined;
declare const key: Keyed<ICache, "redis">;
declare const keyOpt: Keyed<ICache, "redis"> | undefined;

declare const kInject: Keyed<Inject<IThing, "tok">, "k">;
declare const kCache: Keyed<ICache, "redis">;
declare const kHole: Keyed<IThing<Hole<"1">>, "k">;
declare const kAnon: Keyed<{ readonly a: number }, "k">;

declare const stripOne: Keyed<IThing, "k">;
declare const stripMulti: Keyed<IThing & IOther, "k">;

declare const sStr: "hi";
declare const sNum: -5;
declare const sBig: -7n;
declare const sTrue: true;
declare const sFalse: false;
declare const sVoid: void;
declare const sUndef: undefined;
declare const sNull: null;
declare const sWideBool: boolean;
declare const sUnion: "a" | 1;

type Level = "info" | "warn";
type Handler = (x: string) => number;
declare const level: Level;
declare const handler: Handler;

type Pair = [IOther, ICache];
declare class Widget { constructor(other: IOther, cache: ICache); }
declare function build(other: IOther, cache: ICache): IOther;

declare const tuple: [IOther, ICache];
declare const tupleNested: [IOther, [ICache, IOther]];
declare const tupleHole: [IOther, Hole<"1">];
declare const tupleKeyed: [Keyed<ICache, "redis">, "a" | "b"];
declare const tupleEmpty: [];
declare const tupleReadonly: readonly [IOther, ICache];
declare const tupleLabeled: [first: IOther, second: ICache];
declare const tupleAliased: Pair;
declare const tupleOptional: [IOther, ICache?];
declare const tupleRest: [IOther, ...ICache[]];
declare const tupleRestOnly: [...ICache[]];
declare const tupleCtorParams: ConstructorParameters<typeof Widget>;
declare const tupleFnParams: Parameters<typeof build>;

class OptionalWidget { constructor(readonly cache?: ICache) {} }
class DefaultedWidget { constructor(readonly cache: ICache = { cache: 0 }) {} }
declare const optionalCtor: typeof OptionalWidget;
declare const defaultedCtor: typeof DefaultedWidget;

declare const puA: "a" | "b";
declare const puNonLit: "a" | number;
declare const puNonUnion: "a";

declare const optSorted: "b" | "a" | undefined;
declare const optOne: "a" | undefined;
declare const optBool: true | false | undefined;
declare const optNonUnion: "a";
`

// loadGenerics writes fixtureSrc into a temp program and returns it with a Context
// whose IsDefaultLib always fires, so every derived base token is the bare symbol
// name and the assertions pin only the hole / key / literal grammar.
func loadGenerics(t *testing.T) (*driver.Program, *Context, *shimast.SourceFile) {
	t.Helper()
	prog, main := loadFixtureProgram(t, fixtureSrc, false)
	ctx := &Context{
		Checker:      prog.Checker,
		ProjectRoot:  filepath.Dir(main.FileName()),
		IsDefaultLib: func(*shimast.SourceFile) bool { return true },
	}
	return prog, ctx, main
}

// loadFixtureProgram writes a single main.ts and loads a program over it. noLib
// drops the default library (needed only where a fixture redeclares a lib name).
func loadFixtureProgram(t *testing.T, src string, noLib bool) (*driver.Program, *shimast.SourceFile) {
	t.Helper()
	root := t.TempDir()
	lib := ""
	if noLib {
		lib = `"noLib": true, `
	}
	writeFixture(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true, `+lib+`"noImplicitAny": false
  },
  "files": ["main.ts"]
}`)
	writeFixture(t, filepath.Join(root, "main.ts"), src)

	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	if prog.Checker == nil {
		t.Fatal("LoadProgram did not acquire a checker")
	}
	var main *shimast.SourceFile
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), "main.ts") {
			main = sf
		}
	}
	if main == nil {
		t.Fatal("main.ts not found")
	}
	return prog, main
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// typeOfDecl returns the checker type of the `declare const <name>: T` in sf.
func typeOfDecl(t *testing.T, checker *shimchecker.Checker, sf *shimast.SourceFile, name string) *shimchecker.Type {
	t.Helper()
	var found *shimchecker.Type
	walkNode(sf.AsNode(), func(n *shimast.Node) bool {
		if n.Kind != shimast.KindVariableDeclaration {
			return false
		}
		nameNode := n.Name()
		if nameNode == nil || nameNode.Text() != name {
			return false
		}
		sym := checker.GetSymbolAtLocation(nameNode)
		if sym == nil {
			return false
		}
		found = checker.GetTypeOfSymbol(sym)
		return true
	})
	if found == nil {
		t.Fatalf("no declared type for %q", name)
	}
	return found
}

// walkNode is a pre-order traversal that stops as soon as visit returns true.
func walkNode(node *shimast.Node, visit func(*shimast.Node) bool) {
	if node == nil {
		return
	}
	var recur func(n *shimast.Node) bool
	recur = func(n *shimast.Node) bool {
		if n == nil {
			return false
		}
		if visit(n) {
			return true
		}
		return n.ForEachChild(func(child *shimast.Node) bool { return recur(child) })
	}
	recur(node)
}

func TestDeriveTokenF(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	t.Run("literal short-circuits", func(t *testing.T) {
		got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "litStr"), nil)
		if !ok || got != strconv.Quote("lit") {
			t.Fatalf("literal derive = %q ok=%v, want %q true", got, ok, strconv.Quote("lit"))
		}
	})

	t.Run("intrinsic short-circuits", func(t *testing.T) {
		got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "intr"), nil)
		if !ok || got != "number" {
			t.Fatalf("intrinsic derive = %q ok=%v, want number true", got, ok)
		}
	})

	t.Run("hole nested in a closed generic renders $N", func(t *testing.T) {
		got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "holeInThing"), nil)
		if !ok || got != "IThing<$1>" {
			t.Fatalf("hole-in-generic derive = %q ok=%v, want IThing<$1> true", got, ok)
		}
	})

	t.Run("unbound type parameter fails and populates the failure channel", func(t *testing.T) {
		tp := unboundTypeParam(t, ctx.Checker, main)
		var failure Failure
		got, ok := DeriveTokenF(ctx, tp, &failure)
		if ok {
			t.Fatalf("unbound type parameter derived a token %q, want ok=false", got)
		}
		if failure.UnboundTypeParameter == nil {
			t.Fatal("failure.UnboundTypeParameter was not populated")
		}
		if failure.UnboundTypeParameter != tp {
			t.Fatal("failure.UnboundTypeParameter is not the offending type")
		}
	})

	t.Run("nameless anonymous __type fails", func(t *testing.T) {
		if got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "anon"), nil); ok {
			t.Fatalf("anonymous structure derived %q, want ok=false", got)
		}
	})

	t.Run("a nested arg that fails aborts the whole token", func(t *testing.T) {
		if got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "nestedAnon"), nil); ok {
			t.Fatalf("generic over an anonymous arg derived %q, want ok=false", got)
		}
	})
}

// TestDeriveTokenFCollectionTruncation lives on its own fixture because it must
// redeclare the lib collection name `Iterable` with a second type parameter; noLib
// keeps that free of the real one-parameter lib declaration. collectionTokenBases
// truncation keeps only the first argument (`Iterable<A,B>` -> `Iterable<A>`).
func TestDeriveTokenFCollectionTruncation(t *testing.T) {
	src := `interface Iterable<A, B> { readonly a: A; readonly b: B; }
interface IThing { readonly t: number; }
interface IOther { readonly o: number; }
declare const it: Iterable<IThing, IOther>;
`
	prog, main := loadFixtureProgram(t, src, true)
	defer func() { _ = prog.Close() }()
	ctx := &Context{Checker: prog.Checker, IsDefaultLib: func(*shimast.SourceFile) bool { return true }}

	got, ok := DeriveTokenF(ctx, typeOfDecl(t, ctx.Checker, main, "it"), nil)
	if !ok || got != "Iterable<IThing>" {
		t.Fatalf("collection truncation = %q ok=%v, want Iterable<IThing> true", got, ok)
	}
	if strings.Contains(got, "IOther") {
		t.Fatalf("second collection arg not truncated: %q", got)
	}
}

// unboundTypeParam returns the bare type parameter T of `interface Box<T> { value:
// T }` — the `value` property type off Box's own generic declared type carries the
// TypeParameter flag with no binding.
func unboundTypeParam(t *testing.T, checker *shimchecker.Checker, sf *shimast.SourceFile) *shimchecker.Type {
	t.Helper()
	var boxSym *shimast.Symbol
	walkNode(sf.AsNode(), func(n *shimast.Node) bool {
		if n.Kind != shimast.KindInterfaceDeclaration {
			return false
		}
		name := n.Name()
		if name == nil || name.Text() != "Box" {
			return false
		}
		boxSym = checker.GetSymbolAtLocation(name)
		return true
	})
	if boxSym == nil {
		t.Fatal("Box interface symbol not found")
	}
	boxType := shimchecker.Checker_getDeclaredTypeOfSymbol(checker, boxSym)
	if boxType == nil {
		t.Fatal("Box declared type is nil")
	}
	for _, prop := range checker.GetPropertiesOfType(boxType) {
		if prop.Name == "value" {
			return checker.GetTypeOfSymbol(prop)
		}
	}
	t.Fatal("Box.value property not found")
	return nil
}

func TestGenericLabelFor(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	label, ok := GenericLabelFor(typeOfDecl(t, ctx.Checker, main, "hole3"), ctx.Checker)
	if !ok || label != "3" {
		t.Fatalf("GenericLabelFor(Hole<\"3\">) = %q ok=%v, want \"3\" true", label, ok)
	}
	if _, ok := GenericLabelFor(typeOfDecl(t, ctx.Checker, main, "plain"), ctx.Checker); ok {
		t.Fatal("GenericLabelFor(non-hole) should be ok=false")
	}
}

func TestInjectTokenFor(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	if tok, ok := InjectTokenFor(typeOfDecl(t, ctx.Checker, main, "inj"), ctx.Checker); !ok || tok != "tok" {
		t.Fatalf("InjectTokenFor(Inject<T,\"tok\">) = %q ok=%v, want tok true", tok, ok)
	}
	if tok, ok := InjectTokenFor(typeOfDecl(t, ctx.Checker, main, "injOpt"), ctx.Checker); !ok || tok != "tok" {
		t.Fatalf("InjectTokenFor optional-union = %q ok=%v, want tok true", tok, ok)
	}
	if _, ok := InjectTokenFor(typeOfDecl(t, ctx.Checker, main, "plain"), ctx.Checker); ok {
		t.Fatal("InjectTokenFor(non-inject) should be ok=false")
	}
}

func TestKeyLiteralFor(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	if k, ok := KeyLiteralFor(typeOfDecl(t, ctx.Checker, main, "key"), ctx.Checker); !ok || k != "redis" {
		t.Fatalf("KeyLiteralFor(Keyed<T,\"redis\">) = %q ok=%v, want redis true", k, ok)
	}
	if k, ok := KeyLiteralFor(typeOfDecl(t, ctx.Checker, main, "keyOpt"), ctx.Checker); !ok || k != "redis" {
		t.Fatalf("KeyLiteralFor optional-union = %q ok=%v, want redis true", k, ok)
	}
	if _, ok := KeyLiteralFor(typeOfDecl(t, ctx.Checker, main, "plain"), ctx.Checker); ok {
		t.Fatal("KeyLiteralFor(non-keyed) should be ok=false")
	}
}

func TestKeyedTokenFor(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	cases := []struct {
		decl string
		want string
	}{
		{"kInject", "tok#k"},       // Inject pins the base
		{"kCache", "ICache#redis"}, // structural base via stripBrandMembers + DeriveTokenF
		{"kHole", "IThing<$1>#k"},  // hole survives in the base (why it uses DeriveTokenF)
	}
	for _, tc := range cases {
		t.Run(tc.decl, func(t *testing.T) {
			got, ok := KeyedTokenFor(ctx, typeOfDecl(t, ctx.Checker, main, tc.decl))
			if !ok || got != tc.want {
				t.Fatalf("KeyedTokenFor(%s) = %q ok=%v, want %q true", tc.decl, got, ok, tc.want)
			}
		})
	}

	t.Run("no derivable base fails", func(t *testing.T) {
		if got, ok := KeyedTokenFor(ctx, typeOfDecl(t, ctx.Checker, main, "kAnon")); ok {
			t.Fatalf("KeyedTokenFor over an anonymous base derived %q, want ok=false", got)
		}
	})
}

func TestStripBrandMembers(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	t.Run("one non-brand constituent is returned", func(t *testing.T) {
		got := stripBrandMembers(typeOfDecl(t, ctx.Checker, main, "stripOne"), ctx.Checker)
		if SymbolName(got) != "IThing" {
			t.Fatalf("stripped constituent = %q, want IThing", SymbolName(got))
		}
	})

	t.Run("a non-intersection is returned unchanged", func(t *testing.T) {
		in := typeOfDecl(t, ctx.Checker, main, "plain")
		if got := stripBrandMembers(in, ctx.Checker); got != in {
			t.Fatal("non-intersection type was not returned unchanged")
		}
	})

	t.Run("multiple non-brand constituents are returned unchanged", func(t *testing.T) {
		in := typeOfDecl(t, ctx.Checker, main, "stripMulti")
		if got := stripBrandMembers(in, ctx.Checker); got != in {
			t.Fatal("multi-constituent intersection was not returned unchanged")
		}
	})
}

func TestSingletonValue(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	get := func(name string) *shimchecker.Type { return typeOfDecl(t, ctx.Checker, main, name) }

	t.Run("string literal", func(t *testing.T) {
		v, ok := SingletonValue(get("sStr"))
		if !ok || v.Kind != LiteralString || v.Str != "hi" {
			t.Fatalf("string singleton = %+v ok=%v", v, ok)
		}
	})
	t.Run("negative number splits sign and magnitude", func(t *testing.T) {
		v, ok := SingletonValue(get("sNum"))
		if !ok || v.Kind != LiteralNumber || v.Text != "5" || !v.Negated {
			t.Fatalf("number singleton = %+v ok=%v, want {Number 5 negated}", v, ok)
		}
	})
	t.Run("negative bigint splits sign and magnitude", func(t *testing.T) {
		v, ok := SingletonValue(get("sBig"))
		if !ok || v.Kind != LiteralBigInt || v.Text != "7" || !v.Negated {
			t.Fatalf("bigint singleton = %+v ok=%v, want {BigInt 7 negated}", v, ok)
		}
	})
	t.Run("boolean literals", func(t *testing.T) {
		v, ok := SingletonValue(get("sTrue"))
		if !ok || v.Kind != LiteralBoolean || !v.Bool {
			t.Fatalf("true singleton = %+v ok=%v", v, ok)
		}
		v, ok = SingletonValue(get("sFalse"))
		if !ok || v.Kind != LiteralBoolean || v.Bool {
			t.Fatalf("false singleton = %+v ok=%v", v, ok)
		}
	})
	t.Run("void and undefined", func(t *testing.T) {
		if v, ok := SingletonValue(get("sVoid")); !ok || v.Kind != LiteralUndefined {
			t.Fatalf("void singleton = %+v ok=%v", v, ok)
		}
		if v, ok := SingletonValue(get("sUndef")); !ok || v.Kind != LiteralUndefined {
			t.Fatalf("undefined singleton = %+v ok=%v", v, ok)
		}
	})
	t.Run("null", func(t *testing.T) {
		if v, ok := SingletonValue(get("sNull")); !ok || v.Kind != LiteralNull {
			t.Fatalf("null singleton = %+v ok=%v", v, ok)
		}
	})
	t.Run("wide boolean is not a singleton", func(t *testing.T) {
		if v, ok := SingletonValue(get("sWideBool")); ok {
			t.Fatalf("wide boolean returned a singleton %+v, want ok=false", v)
		}
	})
	t.Run("a union is not a singleton", func(t *testing.T) {
		if v, ok := SingletonValue(get("sUnion")); ok {
			t.Fatalf("union returned a singleton %+v, want ok=false", v)
		}
	})
}

func TestIsPureLiteralUnion(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	cases := []struct {
		decl string
		want bool
	}{
		{"puA", true},         // "a" | "b"
		{"puNonLit", false},   // "a" | number — a non-literal member (note: "a" | string collapses to string in TS)
		{"sWideBool", false},  // wide boolean
		{"puNonUnion", false}, // a non-union
	}
	for _, tc := range cases {
		t.Run(tc.decl, func(t *testing.T) {
			if got := IsPureLiteralUnion(typeOfDecl(t, ctx.Checker, main, tc.decl)); got != tc.want {
				t.Fatalf("IsPureLiteralUnion(%s) = %v, want %v", tc.decl, got, tc.want)
			}
		})
	}
}

func TestLiteralUnionTokenForOptional(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	t.Run("optional literal union renders sorted over non-nullish members", func(t *testing.T) {
		got, ok := LiteralUnionTokenForOptional(typeOfDecl(t, ctx.Checker, main, "optSorted"))
		want := strconv.Quote("a") + " | " + strconv.Quote("b")
		if !ok || got != want {
			t.Fatalf("LiteralUnionTokenForOptional = %q ok=%v, want %q true", got, ok, want)
		}
	})
	t.Run("fewer than two non-nullish members fails", func(t *testing.T) {
		if got, ok := LiteralUnionTokenForOptional(typeOfDecl(t, ctx.Checker, main, "optOne")); ok {
			t.Fatalf("single-member optional union derived %q, want ok=false", got)
		}
	})
	t.Run("all-boolean-literal non-nullish is excluded", func(t *testing.T) {
		if got, ok := LiteralUnionTokenForOptional(typeOfDecl(t, ctx.Checker, main, "optBool")); ok {
			t.Fatalf("all-boolean optional union derived %q, want ok=false", got)
		}
	})
	t.Run("a non-union fails", func(t *testing.T) {
		if got, ok := LiteralUnionTokenForOptional(typeOfDecl(t, ctx.Checker, main, "optNonUnion")); ok {
			t.Fatalf("non-union derived %q, want ok=false", got)
		}
	})
}
