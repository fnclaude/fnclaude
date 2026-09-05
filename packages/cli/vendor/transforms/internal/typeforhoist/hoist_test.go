package typeforhoist

import (
	"strings"
	"testing"
)

func clockNode() *Node {
	return Named("IClock", "orders", nil)
}

func TestOneConstPerDistinctNode(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	clock := clockNode()
	promised := Named("Promise", "global", []*Node{clockNode()})
	iterable := Named("Iterable", "global", []*Node{clockNode()})

	for _, node := range []*Node{clock, promised, iterable, clockNode(), promised} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}
	if registry.Len() != 3 {
		t.Fatalf("want 3 distinct nodes, got %d", registry.Len())
	}
	if got := strings.Count(registry.Module(), "\nexport const "); got != registry.Len() {
		t.Fatalf("want %d consts rendered, got %d:\n%s", registry.Len(), got, registry.Module())
	}
}

func TestChildrenAreDeclaredBeforeParents(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	inner := Named("IClock", "orders", nil)
	if _, err := registry.Ref(Named("Promise", "global", []*Node{inner})); err != nil {
		t.Fatal(err)
	}
	module := registry.Module()
	innerName, err := registry.Ref(inner)
	if err != nil {
		t.Fatal(err)
	}
	declaration := strings.Index(module, "export const "+innerName+" = ")
	reference := strings.Index(module, "["+innerName+"]")
	if declaration < 0 || reference < 0 || declaration > reference {
		t.Fatalf("a member const is declared before the composite referencing it:\n%s", module)
	}
}

func TestNamingIsIndependentOfEncounterOrder(t *testing.T) {
	forward := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	backward := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	nodes := []func() *Node{
		func() *Node { return Named("IClock", "orders", nil) },
		func() *Node { return Named("IMessageSink", "orders", nil) },
		func() *Node { return Tag(Named("IClock", "orders", nil), "vendor") },
	}
	for i := range nodes {
		if _, err := forward.Ref(nodes[i]()); err != nil {
			t.Fatal(err)
		}
		if _, err := backward.Ref(nodes[len(nodes)-1-i]()); err != nil {
			t.Fatal(err)
		}
	}
	for _, build := range nodes {
		node := build()
		left, err := forward.Ref(node)
		if err != nil {
			t.Fatal(err)
		}
		right, err := backward.Ref(node)
		if err != nil {
			t.Fatal(err)
		}
		if left != right {
			t.Fatalf("%s named %s one way and %s the other", node.Key(), left, right)
		}
	}
}

func TestUnionIdentityIgnoresMemberOrder(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	ascending := Union([]*Node{Literal(`"a"`), Literal(`"b"`)})
	descending := Union([]*Node{Literal(`"b"`), Literal(`"a"`)})
	if ascending.Key() != descending.Key() {
		t.Fatalf("member order fragments identity: %q vs %q", ascending.Key(), descending.Key())
	}
	if _, err := registry.Ref(ascending); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Ref(descending); err != nil {
		t.Fatal(err)
	}
	// The union plus its two literal members.
	if registry.Len() != 3 {
		t.Fatalf("want 3 distinct nodes, got %d:\n%s", registry.Len(), registry.Module())
	}
}

func TestKeyMirrorsTheFlatTokenSpelling(t *testing.T) {
	cases := map[string]*Node{
		"IClock":                        Named("IClock", "global", nil),
		"orders:IClock":                 Named("IClock", "orders", nil),
		"Promise<orders:IClock>":        Named("Promise", "global", []*Node{Named("IClock", "orders", nil)}),
		"$1":                            Generic("1"),
		`"a" | "b"`:                     Union([]*Node{Literal(`"a"`), Literal(`"b"`)}),
		`#tag(orders:IClock,"vendor")`:  Tag(Named("IClock", "orders", nil), "vendor"),
		"[orders:IClock]~orders:IStore": Tuple([]*Node{Named("IClock", "orders", nil)}, Named("IStore", "orders", nil)),
		"#func(IClock)([])":             Func(Named("IClock", "global", nil), Tuple(nil, nil)),
		"#ctor(IClock)([orders:IClock])": Ctor(
			Named("IClock", "global", nil), Tuple([]*Node{Named("IClock", "orders", nil)}, nil),
		),
		"#abstractCtor(IClock)([orders:IClock])": AbstractCtor(
			Named("IClock", "global", nil), Tuple([]*Node{Named("IClock", "orders", nil)}, nil),
		),
	}
	for want, node := range cases {
		if node.Key() != want {
			t.Errorf("want key %q, got %q", want, node.Key())
		}
	}
}

// TestObjectAndIntersectionRender pins the record and intersection consts: an
// object references each member by name keyed on its property, an intersection
// references its members positionally, and both key structurally so declaration
// order never fragments one type into two consts.
func TestObjectAndIntersectionRender(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	str := Named("string", "global", nil)
	num := Named("number", "global", nil)
	thing := Named("IThing", "orders", nil)
	other := Named("IOther", "orders", nil)

	object := Object([]ObjectMember{{Key: "host", Type: str}, {Key: "port", Type: num}})
	inter := Intersection([]*Node{thing, other})
	for _, node := range []*Node{object, inter} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}

	module := registry.Module()
	wantObject := "export const " + refOf(t, registry, object) + " = Type.object({ host: " +
		refOf(t, registry, str) + ", port: " + refOf(t, registry, num) + " });"
	if !strings.Contains(module, wantObject) {
		t.Errorf("want %q in:\n%s", wantObject, module)
	}
	wantInter := "export const " + refOf(t, registry, inter) + " = Type.intersection(" +
		refOf(t, registry, thing) + ", " + refOf(t, registry, other) + ");"
	if !strings.Contains(module, wantInter) {
		t.Errorf("want %q in:\n%s", wantInter, module)
	}

	// Member order does not fragment an object's identity.
	reordered := Object([]ObjectMember{{Key: "port", Type: num}, {Key: "host", Type: str}})
	if reordered.Key() != object.Key() {
		t.Fatalf("object key depends on member order: %q vs %q", reordered.Key(), object.Key())
	}
}

// TestACallableSpellsFixedRowsAndReferencesAnOpenSlot: a const holding a
// callable renders a slot of fixed argument lists as the rows spelling over
// member consts — one array per signature — while a slot carrying an open
// length references the slot node's own const.
func TestACallableSpellsFixedRowsAndReferencesAnOpenSlot(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	widget := Named("IWidget", "orders", nil)
	clock := Named("IClock", "orders", nil)
	options := Named("IOptions", "orders", nil)

	oneRow := Ctor(widget, Tuple([]*Node{clock}, nil))
	several := Ctor(widget, Union([]*Node{Tuple([]*Node{clock}, nil), Tuple([]*Node{clock, options}, nil)}))
	openSlot := Tuple([]*Node{clock}, options)
	open := Ctor(widget, openSlot)
	for _, node := range []*Node{oneRow, several, open} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}

	widgetName := refOf(t, registry, widget)
	clockName := refOf(t, registry, clock)
	optionsName := refOf(t, registry, options)
	module := registry.Module()
	wantOneRow := "export const " + refOf(t, registry, oneRow) + " = Type.ctor(" + widgetName + ", [[" + clockName + "]]);"
	if !strings.Contains(module, wantOneRow) {
		t.Errorf("want %q in:\n%s", wantOneRow, module)
	}
	wantSeveral := "export const " + refOf(t, registry, several) + " = Type.ctor(" + widgetName +
		", [[" + clockName + "], [" + clockName + ", " + optionsName + "]]);"
	if !strings.Contains(module, wantSeveral) {
		t.Errorf("want %q in:\n%s", wantSeveral, module)
	}
	wantOpen := "export const " + refOf(t, registry, open) + " = Type.ctor(" + widgetName + ", " + refOf(t, registry, openSlot) + ");"
	if !strings.Contains(module, wantOpen) {
		t.Errorf("want %q in:\n%s", wantOpen, module)
	}
	wantSlot := "export const " + refOf(t, registry, openSlot) + " = Type.tuple({ members: [" + clockName + "], rest: " + optionsName + " });"
	if !strings.Contains(module, wantSlot) {
		t.Errorf("want %q in:\n%s", wantSlot, module)
	}
}

// TestARowShapeIsPartOfIdentity: two callables over the same head and the same
// parameters, grouped into different rows, are different types and so different
// consts — the empty call among them, which is not the same as answering to no
// call at all.
func TestARowShapeIsPartOfIdentity(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	head := Named("IWidget", "orders", nil)
	clock := Named("IClock", "orders", nil)
	options := Named("IOptions", "orders", nil)

	together := Func(head, Tuple([]*Node{clock, options}, nil))
	apart := Func(head, Union([]*Node{Tuple([]*Node{clock}, nil), Tuple([]*Node{options}, nil)}))
	takesNothing := Func(head, Tuple(nil, nil))
	if together.Key() == apart.Key() {
		t.Errorf("one row of two parameters keys the same as two rows of one: %s", together.Key())
	}
	if takesNothing.Key() == together.Key() {
		t.Errorf("an empty row keys the same as a populated one: %s", takesNothing.Key())
	}
	for _, node := range []*Node{together, apart, takesNothing} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}
	// The three callables plus the three names they are built over — a fixed
	// slot's rows spell inline, so they mint no consts of their own.
	if registry.Len() != 6 {
		t.Fatalf("want 6 distinct nodes, got %d:\n%s", registry.Len(), registry.Module())
	}
}

// TestAbstractCtorIsItsOwnKind: a concrete and an abstract constructor over
// the same instance type and signatures are two distinct kinds, so they key —
// and intern — differently, and each renders through its own factory method
// with no shared trailing flag.
func TestAbstractCtorIsItsOwnKind(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	instance := Named("IWidget", "orders", nil)
	clock := Named("IClock", "orders", nil)

	sig := Tuple([]*Node{clock}, nil)
	concrete := Ctor(instance, sig)
	abstract := AbstractCtor(instance, sig)
	if concrete.Key() == abstract.Key() {
		t.Errorf("a concrete and an abstract constructor over the same shape key the same: %s", concrete.Key())
	}
	for _, node := range []*Node{concrete, abstract} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}
	// The two constructors plus the two names they are built over.
	if registry.Len() != 4 {
		t.Fatalf("want 4 distinct nodes, got %d:\n%s", registry.Len(), registry.Module())
	}

	instanceName := refOf(t, registry, instance)
	clockName := refOf(t, registry, clock)
	module := registry.Module()
	wantConcrete := "export const " + refOf(t, registry, concrete) + " = Type.ctor(" + instanceName + ", [[" + clockName + "]]);"
	if !strings.Contains(module, wantConcrete) {
		t.Errorf("want %q in:\n%s", wantConcrete, module)
	}
	wantAbstract := "export const " + refOf(t, registry, abstract) + " = Type.abstractCtor(" + instanceName + ", [[" + clockName + "]]);"
	if !strings.Contains(module, wantAbstract) {
		t.Errorf("want %q in:\n%s", wantAbstract, module)
	}
}

func refOf(t *testing.T, registry *Registry, node *Node) string {
	t.Helper()
	name, err := registry.Ref(node)
	if err != nil {
		t.Fatal(err)
	}
	return name
}

func TestAnAlphanumericKeyNamesItself(t *testing.T) {
	if got := nameFor("string"); got != "$string" {
		t.Fatalf("want $string, got %s", got)
	}
	// Anything with punctuation carries the hash that keeps `a:b` and `a.b` apart.
	if nameFor("a:b") == nameFor("a.b") {
		t.Fatal("two keys with the same sanitized spelling must not share a name")
	}
	if !strings.HasPrefix(nameFor("orders:IClock"), "$orders_IClock_") {
		t.Fatalf("want a readable prefix, got %s", nameFor("orders:IClock"))
	}
}

// TestTupleKeepsSlotOrder: a tuple's identity is its slots IN ORDER, where a
// union's is its sorted member set, so two tuples over the same two names are
// two consts — each one factory call over its slots by name.
func TestTupleKeepsSlotOrder(t *testing.T) {
	registry := NewRegistry(TypeRef{Module: "@rhombus-std/primitives", Export: "Type"})
	clock := Named("IClock", "orders", nil)
	store := Named("IStore", "orders", nil)

	forward := Tuple([]*Node{clock, store}, nil)
	reversed := Tuple([]*Node{store, clock}, nil)
	if forward.Key() == reversed.Key() {
		t.Errorf("both slot orders key the same: %s", forward.Key())
	}
	for _, node := range []*Node{forward, reversed} {
		if _, err := registry.Ref(node); err != nil {
			t.Fatal(err)
		}
	}
	// The two tuples plus the two names they are built over.
	if registry.Len() != 4 {
		t.Fatalf("want 4 distinct nodes, got %d:\n%s", registry.Len(), registry.Module())
	}

	module := registry.Module()
	want := "export const " + refOf(t, registry, forward) + " = Type.tuple(" +
		refOf(t, registry, clock) + ", " + refOf(t, registry, store) + ");"
	if !strings.Contains(module, want) {
		t.Errorf("want %q in:\n%s", want, module)
	}
}
