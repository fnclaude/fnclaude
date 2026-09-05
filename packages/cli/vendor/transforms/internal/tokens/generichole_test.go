package tokens

import (
	"path/filepath"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// These tests pin how DeriveNode classifies an OPEN type — one carrying the
// `Generic<L, C>` / `$<L>` hole brand. A hole, and any template applied with
// one, derives by the node it is spelled as, ahead of the callable/union
// classification: a constrained hole is still a hole even though its constraint
// bears signatures, and a named template (Opener) is its named address whether
// its argument is open or closed — a call signature never overrides a name, so
// the OPEN and CLOSED instantiations classify identically. A hole sitting in a
// signature SLOT is the other reading and keeps the callable classification.

// genericHoleFixtureSrc mirrors the shapes an open registration is authored
// with: the brand pair, a callable template (a scope factory), a plain
// template, and a class whose constructor takes a hole.
const genericHoleFixtureSrc = `declare const HOLE: unique symbol;
type Generic<L extends string, C = unknown> = C & { readonly [HOLE]?: L };
type $<L extends string> = Generic<L>;

type Ctor<A extends any[] = any[], R = any> = abstract new (...args: A) => R;
type Func<A extends any[] = any[], R = any> = (...args: A) => R;

interface IProvider { readonly provider: number; }
interface IThing<T = unknown> { readonly thing: T; }
interface Opener<Lifetime> { (lifetime: Lifetime): IProvider; }

declare class Widget { constructor(dep: $<"1">); }

declare const bareHole: $<"X">;
declare const constrainedHole: Generic<"C", Ctor | Func>;
declare const openThing: IThing<$<"X">>;
declare const openOpener: Opener<$<"T">>;
declare const closedOpener: Opener<IProvider>;
declare const widgetCtor: typeof Widget;
`

// loadGenericHoles loads genericHoleFixtureSrc with the same
// every-file-is-a-default-lib Context the other derivation tests use, so every
// named node derives with the bare "global" FROM and the assertions pin only
// the hole grammar.
func loadGenericHoles(t *testing.T) (func(name string) *Node, func()) {
	t.Helper()
	prog, main := loadFixtureProgram(t, genericHoleFixtureSrc, false)
	ctx := &Context{
		Checker:      prog.Checker,
		ProjectRoot:  filepath.Dir(main.FileName()),
		IsDefaultLib: func(*shimast.SourceFile) bool { return true },
	}
	derive := func(name string) *Node {
		t.Helper()
		n, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, name), nil)
		if !ok {
			t.Fatalf("%s did not derive", name)
		}
		return n
	}
	return derive, func() { _ = prog.Close() }
}

// requireHole asserts n is the hole node with the expected label.
func requireHole(t *testing.T, n *Node, label string) {
	t.Helper()
	if n.Kind != KindGeneric || n.Label != label {
		t.Fatalf("expected the hole %q, got %+v", label, n)
	}
}

func TestDeriveNodeBareHole(t *testing.T) {
	derive, done := loadGenericHoles(t)
	defer done()

	requireHole(t, derive("bareHole"), "X")
}

func TestDeriveNodeConstrainedHoleIgnoresItsConstraint(t *testing.T) {
	derive, done := loadGenericHoles(t)
	defer done()

	requireHole(t, derive("constrainedHole"), "C")
}

func TestDeriveNodeOpenTemplateNamesItsArgument(t *testing.T) {
	derive, done := loadGenericHoles(t)
	defer done()

	for _, tc := range []struct{ decl, name, label string }{
		{"openThing", "IThing", "X"},
		{"openOpener", "Opener", "T"},
	} {
		t.Run(tc.decl, func(t *testing.T) {
			node := requireNamed(t, derive(tc.decl))
			if node.Name != tc.name || node.From != "global" {
				t.Fatalf("open template derived %+v, want the bare name %s", node, tc.name)
			}
			if len(node.Args) != 1 {
				t.Fatalf("expected exactly one generic arg, got %d: %+v", len(node.Args), node.Args)
			}
			requireHole(t, node.Args[0], tc.label)
		})
	}
}

func TestDeriveNodeClosedCallableTemplateStaysNamed(t *testing.T) {
	derive, done := loadGenericHoles(t)
	defer done()

	node := requireNamed(t, derive("closedOpener"))
	if node.Name != "Opener" || node.From != "global" {
		t.Fatalf("closed callable template derived %+v, want the bare name Opener", node)
	}
	if len(node.Args) != 1 {
		t.Fatalf("expected exactly one generic arg, got %d: %+v", len(node.Args), node.Args)
	}
	if node.Args[0].Kind != KindNamed || node.Args[0].Name != "IProvider" {
		t.Fatalf("expected IProvider as the closed argument, got %+v", node.Args[0])
	}
}

func TestDeriveNodeHoleInASignatureSlotKeepsTheCallable(t *testing.T) {
	derive, done := loadGenericHoles(t)
	defer done()

	n := derive("widgetCtor")
	if n.Kind != KindCtor {
		t.Fatalf("open constructor derived kind %v, want a constructor: %+v", n.Kind, n)
	}
	if n.Sig == nil || n.Sig.Kind != KindTuple || len(n.Sig.Members) != 1 {
		t.Fatalf("expected one signature of one parameter, got %+v", n.Sig)
	}
	requireHole(t, n.Sig.Members[0], "1")
}
