package tokens

import (
	"path/filepath"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// These tests pin what the single node vocabulary newly reaches: a container's
// member is derived by the same walk as any other node, so a tuple slot, an
// object property, or an intersection member can be any kind — a union, a
// callable, a nested object — where the split vocabularies would have refused the
// whole shape over the member. The refusals that survive are justified by the
// `Type` member that cannot spell the shape, and a self-referential structure
// still terminates.

const collapseFixtureSrc = `interface IThing { readonly thing: number; }
interface IOther { readonly other: number; }
interface INode { readonly next: INode | undefined; }

declare const tupleUnionSlot: [IThing | IOther, IThing];
declare const tupleCallableSlot: [() => IThing, IThing];
declare const objUnionProp: { readonly a: IThing | IOther };
declare const objOptionalProp: { readonly a?: IThing };
declare const objNested: { readonly outer: { readonly inner: IThing } };
declare const objWithMethod: { greet(name: string): IThing };
declare const inter: IThing & IOther;
declare const selfRefNamed: INode;

type Cond<T> = T extends never ? never : { readonly self: Cond<T> };
declare const selfRefStructural: Cond<string>;

type CondFn<T> = T extends never ? never : () => CondFn<T>;
declare const selfRefCallable: CondFn<string>;
`

func loadCollapse(t *testing.T) (func(name string) (*Node, bool), func()) {
	t.Helper()
	prog, main := loadFixtureProgram(t, collapseFixtureSrc, false)
	ctx := &Context{
		Checker:      prog.Checker,
		ProjectRoot:  filepath.Dir(main.FileName()),
		IsDefaultLib: func(*shimast.SourceFile) bool { return true },
	}
	derive := func(name string) (*Node, bool) {
		t.Helper()
		return DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, name), nil)
	}
	return derive, func() { _ = prog.Close() }
}

func TestDeriveNodeTupleSlotIsAGeneralUnion(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("tupleUnionSlot")
	if !ok || n.Kind != KindTuple || len(n.Members) != 2 {
		t.Fatalf("tupleUnionSlot derived %+v ok=%v, want a two-slot tuple", n, ok)
	}
	slot := n.Members[0]
	if slot.Kind != KindUnion || len(slot.Members) != 2 {
		t.Fatalf("union slot derived %+v, want a two-member union", slot)
	}
	if n.Members[1].Kind != KindNamed || n.Members[1].Name != "IThing" {
		t.Fatalf("second slot derived %+v, want the name IThing", n.Members[1])
	}
}

func TestDeriveNodeTupleSlotIsACallable(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("tupleCallableSlot")
	if !ok || n.Kind != KindTuple || len(n.Members) != 2 {
		t.Fatalf("tupleCallableSlot derived %+v ok=%v, want a two-slot tuple", n, ok)
	}
	if n.Members[0].Kind != KindFunc {
		t.Fatalf("callable slot derived %+v, want a func node", n.Members[0])
	}
}

func TestDeriveNodeObjectWithUnionProperty(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("objUnionProp")
	if !ok || n.Kind != KindObject || len(n.Properties) != 1 {
		t.Fatalf("objUnionProp derived %+v ok=%v, want a one-member object", n, ok)
	}
	if n.Properties[0].Key != "a" || n.Properties[0].Type.Kind != KindUnion {
		t.Fatalf("property derived %+v, want a union-typed member `a`", n.Properties[0])
	}
}

func TestDeriveNodeObjectWithOptionalProperty(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("objOptionalProp")
	if !ok || n.Kind != KindObject || len(n.Properties) != 1 {
		t.Fatalf("objOptionalProp derived %+v ok=%v, want a one-member object", n, ok)
	}
	member := n.Properties[0].Type
	if member.Kind != KindUnion || len(member.Members) != 2 {
		t.Fatalf("optional member derived %+v, want a two-member union", member)
	}
	last := member.Members[len(member.Members)-1]
	if last.Kind != KindLiteral || last.Literal.Kind != LiteralUndefined {
		t.Fatalf("optional member's last alternative derived %+v, want the undefined literal", last)
	}
}

func TestDeriveNodeNestedObject(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("objNested")
	if !ok || n.Kind != KindObject || len(n.Properties) != 1 {
		t.Fatalf("objNested derived %+v ok=%v, want a one-member object", n, ok)
	}
	outer := n.Properties[0]
	if outer.Key != "outer" || outer.Type.Kind != KindObject || len(outer.Type.Properties) != 1 {
		t.Fatalf("outer member derived %+v, want a nested one-member object", outer)
	}
	if inner := outer.Type.Properties[0]; inner.Key != "inner" || inner.Type.Kind != KindNamed {
		t.Fatalf("inner member derived %+v, want the named `inner`", outer.Type.Properties[0])
	}
}

func TestDeriveNodeAnonymousIntersection(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("inter")
	if !ok || n.Kind != KindIntersection || len(n.Members) != 2 {
		t.Fatalf("inter derived %+v ok=%v, want a two-member intersection", n, ok)
	}
	names := map[string]bool{}
	for _, m := range n.Members {
		if m.Kind != KindNamed {
			t.Fatalf("intersection member derived %+v, want a named node", m)
		}
		names[m.Name] = true
	}
	if !names["IThing"] || !names["IOther"] {
		t.Fatalf("intersection members %v, want IThing and IOther", names)
	}
}

// A self-referential NAMED type terminates by naming: the walk spells INode by
// its name and never opens its `next` member, so the recursion never begins.
func TestDeriveNodeSelfReferentialNamedTerminates(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("selfRefNamed")
	if !ok || n.Kind != KindNamed || n.Name != "INode" {
		t.Fatalf("selfRefNamed derived %+v ok=%v, want the name INode", n, ok)
	}
}

// A self-referential type that LOST its name — a conditional reminting an
// anonymous `{ self: Cond<T> }` whose member is the very same checker type —
// re-reaches itself with no name to stop it. The recursion guard refuses that
// second visit rather than descending forever: a loud ok=false, not a hang.
func TestDeriveNodeSelfReferentialStructuralRefuses(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	if n, ok := derive("selfRefStructural"); ok {
		t.Fatalf("selfRefStructural derived %+v, want the recursion guard to refuse", n)
	}
}

// An object with a callable member: the method derives as a KindFunc-typed
// property inside a KindObject node, so a structural shape carrying a method
// is lowered rather than refused.
func TestDeriveNodeObjectWithMethodProperty(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	n, ok := derive("objWithMethod")
	if !ok || n.Kind != KindObject || len(n.Properties) != 1 {
		t.Fatalf("objWithMethod derived %+v ok=%v, want a one-member object", n, ok)
	}
	prop := n.Properties[0]
	if prop.Key != "greet" || prop.Type.Kind != KindFunc {
		t.Fatalf("method property derived %+v, want a func-typed member `greet`", prop)
	}
	if prop.Type.Ret == nil || prop.Type.Ret.Kind != KindNamed || prop.Type.Ret.Name != "IThing" {
		t.Fatalf("method return derived %+v, want the named IThing", prop.Type.Ret)
	}
}

// The same self-reference through a CALLABLE rather than a record — a
// name-losing conditional reminting `() => CondFn<T>` — is caught the same way:
// the guard marks the type on entry, so its return re-reaching it refuses rather
// than recursing without bound through the signature walk.
func TestDeriveNodeSelfReferentialCallableRefuses(t *testing.T) {
	derive, done := loadCollapse(t)
	defer done()

	if n, ok := derive("selfRefCallable"); ok {
		t.Fatalf("selfRefCallable derived %+v, want the recursion guard to refuse", n)
	}
}
