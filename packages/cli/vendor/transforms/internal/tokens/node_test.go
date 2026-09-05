package tokens

import (
	"reflect"
	"testing"
)

// These tests pin what the derivation answers: the exact flat token per shape
// (including the shapes with none), and the tree DeriveNode builds under it where
// the rendered string alone would not distinguish two structures.

func mustRender(t *testing.T, n *Node) string {
	t.Helper()
	s, ok := renderNode(n)
	if !ok {
		t.Fatalf("node %+v has no flat spelling", n)
	}
	return s
}

// TestDeriveTokenFRendersEachShapesToken pins the exact token string DeriveTokenF
// answers per shape, and the refusal where a shape has no flat spelling. Two of
// these come from a name gate rather than the structure the type carries: a named
// callable alias renders its own name, and a union spelled through an addressable
// alias renders that alias rather than its members. The wide `boolean` scalar
// reaches the checker as a union of its two literals carrying no intrinsic name,
// so it renders no token.
func TestDeriveTokenFRendersEachShapesToken(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	cases := map[string]struct {
		token string
		ok    bool
	}{
		"litStr":      {`"lit"`, true},
		"intr":        {"number", true},
		"holeInThing": {"IThing<$1>", true},
		"plain":       {"IThing<unknown>", true},
		"anon":        {"", false},
		"nestedAnon":  {"", false},
		"hole3":       {"$3", true},
		"handler":     {"Handler", true},
		"level":       {"Level", true},
		"puA":         {`"a" | "b"`, true},
		"puNonLit":    {"", false},
		"puNonUnion":  {`"a"`, true},
		"sWideBool":   {"", false},
		"sUnion":      {`"a" | 1`, true},
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			decl := typeOfDecl(t, ctx.Checker, main, name)

			token, ok := DeriveTokenF(ctx, decl, nil)
			if ok != want.ok || token != want.token {
				t.Fatalf("DeriveTokenF = (%q, %v), want (%q, %v)", token, ok, want.token, want.ok)
			}

			var rendered string
			renderedOK := false
			if node, derived := DeriveNode(ctx, ctx.Checker, decl, nil); derived {
				rendered = mustRenderOrRefuse(t, node)
				renderedOK = rendered != ""
			}
			if renderedOK != ok || rendered != token {
				t.Fatalf("renderNode(DeriveNode) = (%q, %v), want the same token", rendered, renderedOK)
			}
		})
	}
}

// mustRenderOrRefuse renders a node, answering "" for a kind with no flat token
// spelling, so a refusal is a value the caller compares rather than a failure.
func mustRenderOrRefuse(t *testing.T, n *Node) string {
	t.Helper()
	s, ok := renderNode(n)
	if !ok {
		return ""
	}
	return s
}

// TestDeriveNodeNestedGenericShape pins the actual TREE shape for a nested hole
// inside a closed generic — not just its rendered string — so a change that
// happens to render the same string but restructures the tree is still caught.
func TestDeriveNodeNestedGenericShape(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "holeInThing"), nil)
	if !ok {
		t.Fatal("holeInThing did not derive a node")
	}
	if node.Kind != KindNamed || node.Name != "IThing" || node.From != "global" {
		t.Fatalf("unexpected named node: %+v", node)
	}
	if len(node.Args) != 1 {
		t.Fatalf("expected exactly one generic arg, got %d", len(node.Args))
	}
	arg := node.Args[0]
	if arg.Kind != KindGeneric || arg.Label != "1" {
		t.Fatalf("expected a $1 hole arg, got %+v", arg)
	}
}

// TestDeriveNodeLiteralUnionShape pins the tree shape of a pure-literal union:
// a KindUnion of KindLiteral members, one per union member, in checker order
// (unsorted — the sort is a rendering concern).
func TestDeriveNodeLiteralUnionShape(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "puA"), nil)
	if !ok {
		t.Fatal("puA did not derive a node")
	}
	if node.Kind != KindUnion {
		t.Fatalf("expected a union node, got kind %v", node.Kind)
	}
	if len(node.Members) != 2 {
		t.Fatalf("expected 2 members, got %d: %+v", len(node.Members), node.Members)
	}
	for _, m := range node.Members {
		if m.Kind != KindLiteral || m.Literal.Kind != LiteralString {
			t.Fatalf("expected a string literal member, got %+v", m)
		}
	}
	if rendered := mustRender(t, node); rendered != `"a" | "b"` {
		t.Fatalf("rendered union = %q, want %q", rendered, `"a" | "b"`)
	}
}

// TestDeriveNodeTupleShape pins the tree shape of a tuple: a KindTuple whose
// Members are the slot types in declaration order, one node per slot, each
// derived by the same walk that derives any other node — so a nested tuple, a
// hole and a keyed literal union all reach their own kinds.
func TestDeriveNodeTupleShape(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	cases := map[string]string{
		"tuple":         "[IOther,ICache]",
		"tupleNested":   "[IOther,[ICache,IOther]]",
		"tupleHole":     "[IOther,$1]",
		"tupleKeyed":    `[ICache#redis,"a" | "b"]`,
		"tupleEmpty":    "[]",
		"tupleReadonly": "[IOther,ICache]",
		"tupleLabeled":  "[IOther,ICache]",
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, name), nil)
			if !ok {
				t.Fatalf("%s did not derive a node", name)
			}
			if node.Kind != KindTuple {
				t.Fatalf("expected a tuple node, got kind %v", node.Kind)
			}
			if got := mustRender(t, node); got != want {
				t.Fatalf("rendered tuple = %q, want %q", got, want)
			}
		})
	}

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "tupleNested"), nil)
	if !ok {
		t.Fatal("tupleNested did not derive a node")
	}
	if len(node.Members) != 2 {
		t.Fatalf("expected 2 slots, got %d: %+v", len(node.Members), node.Members)
	}
	if node.Members[0].Kind != KindNamed || node.Members[0].Name != "IOther" {
		t.Fatalf("expected a named first slot, got %+v", node.Members[0])
	}
	inner := node.Members[1]
	if inner.Kind != KindTuple || len(inner.Members) != 2 {
		t.Fatalf("expected a 2-slot tuple second slot, got %+v", inner)
	}
	if inner.Members[1].Kind != KindNamed || inner.Members[1].Name != "IOther" {
		t.Fatalf("expected IOther in the inner tuple's last slot, got %+v", inner.Members[1])
	}
}

// TestDeriveNodeTupleSlotOrderIsIdentity pins that the slots are NOT sorted the
// way a union's members are at render time: two tuples over the same types in
// different orders are two types and must render as two tokens.
func TestDeriveNodeTupleSlotOrderIsIdentity(t *testing.T) {
	other := &Node{Kind: KindNamed, Name: "IOther", From: "global"}
	cache := &Node{Kind: KindNamed, Name: "ICache", From: "global"}

	forward, _ := renderNode(&Node{Kind: KindTuple, Members: []*Node{other, cache}})
	reversed, _ := renderNode(&Node{Kind: KindTuple, Members: []*Node{cache, other}})
	if forward == reversed {
		t.Fatalf("both orderings rendered %q", forward)
	}
}

// TestDeriveNodeVariableLengthTupleStatesItsOpenLength pins that an optional or
// rest slot derives honestly rather than refusing or approximating: an optional
// slot keeps the `| undefined` its checker type already carries — the one
// spelling the model gives an absent-able position — and a trailing rest slot's
// element becomes TupleRest, held OUT of Members rather than folded into it.
func TestDeriveNodeVariableLengthTupleStatesItsOpenLength(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "tupleOptional"), nil)
	if !ok {
		t.Fatal("tupleOptional did not derive a node")
	}
	if node.Kind != KindTuple || node.TupleRest != nil || len(node.Members) != 2 {
		t.Fatalf("tupleOptional derived %+v, want a two-slot fixed tuple", node)
	}
	if node.Members[0].Name != "IOther" {
		t.Fatalf("tupleOptional members %+v, want IOther first", node.Members)
	}
	optional := node.Members[1]
	if optional.Kind != KindUnion || len(optional.Members) != 2 || optional.Members[0].Name != "ICache" || !isNullishLiteral(optional.Members[1]) {
		t.Fatalf("tupleOptional's optional slot derived %+v, want ICache | undefined", optional)
	}

	node, ok = DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "tupleRest"), nil)
	if !ok {
		t.Fatal("tupleRest did not derive a node")
	}
	if node.Kind != KindTuple || len(node.Members) != 1 || node.Members[0].Name != "IOther" {
		t.Fatalf("tupleRest derived %+v, want a tuple of [IOther]", node)
	}
	if node.TupleRest == nil || node.TupleRest.Kind != KindNamed || node.TupleRest.Name != "ICache" {
		t.Fatalf("tupleRest's rest slot derived %+v, want the named ICache", node.TupleRest)
	}
}

// TestDeriveNodeDefaultedParameterIsOptionalToItsCallers pins that a parameter
// with a default value derives the same slot an explicitly optional one does:
// `new DefaultedWidget()` is a legal call, so its slot admits undefined exactly
// as `cache?: ICache` spells it, and the two constructors are one row shape.
func TestDeriveNodeDefaultedParameterIsOptionalToItsCallers(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	rowOf := func(name string) *Node {
		t.Helper()
		node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, name), nil)
		if !ok {
			t.Fatalf("%s did not derive a node", name)
		}
		if node.Kind != KindCtor || node.Sig == nil || node.Sig.Kind != KindTuple || len(node.Sig.Members) != 1 {
			t.Fatalf("%s derived %+v, want one single-parameter constructor row", name, node)
		}
		return node.Sig
	}

	defaulted := rowOf("defaultedCtor").Members[0]
	if defaulted.Kind != KindUnion || len(defaulted.Members) != 2 || defaulted.Members[0].Name != "ICache" || !isNullishLiteral(defaulted.Members[1]) {
		t.Fatalf("defaultedCtor's slot derived %+v, want ICache | undefined", defaulted)
	}
	if optional := rowOf("optionalCtor"); !reflect.DeepEqual(rowOf("defaultedCtor"), optional) {
		t.Fatalf("defaultedCtor's row %+v differs from the explicit-optional spelling %+v", defaulted, optional)
	}
}

// TestDeriveNodeRestOnlyTupleDerivesAsTheList pins that a rest-only spelling
// like `[...ICache[]]` derives as the Array node: the checker normalizes the
// tuple away to the array itself before the tuple walk ever sees it, so the
// derivation answers the list the open length draws from.
func TestDeriveNodeRestOnlyTupleDerivesAsTheList(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "tupleRestOnly"), nil)
	if !ok {
		t.Fatal("tupleRestOnly did not derive a node")
	}
	if node.Kind != KindNamed || node.Name != "Array" || node.From != "global" {
		t.Fatalf("tupleRestOnly derived %+v, want the global Array", node)
	}
	if len(node.Args) != 1 || node.Args[0].Name != "ICache" {
		t.Fatalf("tupleRestOnly's element derived %+v, want ICache", node.Args)
	}
}

// TestDeriveNodeAliasedTupleDerivesByName pins that a tuple spelled through a
// type alias derives as the NAME it was spelled through, like an aliased union:
// its address must not shift with the element list.
func TestDeriveNodeAliasedTupleDerivesByName(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, "tupleAliased"), nil)
	if !ok {
		t.Fatal("tupleAliased did not derive a node")
	}
	if node.Kind != KindNamed || node.Name != "Pair" {
		t.Fatalf("expected the Pair name, got %+v", node)
	}
}

// TestDeriveNodeParameterListUtilitiesAreTuples pins that the checker hands
// ConstructorParameters<> and Parameters<> back already resolved to concrete
// tuples, so they derive through the tuple walk with no case of their own.
func TestDeriveNodeParameterListUtilitiesAreTuples(t *testing.T) {
	prog, ctx, main := loadGenerics(t)
	defer func() { _ = prog.Close() }()

	for _, name := range []string{"tupleCtorParams", "tupleFnParams"} {
		t.Run(name, func(t *testing.T) {
			node, ok := DeriveNode(ctx, ctx.Checker, typeOfDecl(t, ctx.Checker, main, name), nil)
			if !ok {
				t.Fatalf("%s did not derive a node", name)
			}
			if node.Kind != KindTuple {
				t.Fatalf("expected a tuple node, got kind %v", node.Kind)
			}
			if got := mustRender(t, node); got != "[IOther,ICache]" {
				t.Fatalf("rendered %q, want %q", got, "[IOther,ICache]")
			}
		})
	}
}
