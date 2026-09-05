package schemaoftransform

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/typefortransform"
	"github.com/fnioc/std/transforms/internal/typesurface"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// Diagnostic codes for the expansion. The high offset keeps them clear of
// TypeScript's own code space; they are part of the transformer's observable
// surface. All three are errors — the walk never emits a warning and never a
// silent partial: a member it cannot spell aborts the whole tree.
const (
	// CodeUnsupportedType marks a member whose type the Type grammar has no
	// spelling for — a callable, or an anonymous structure with nothing nameable
	// about it.
	CodeUnsupportedType = "992001"
	// CodeNonObjectRoot marks a root that is not an object type. There is nothing
	// to expand.
	CodeNonObjectRoot = "992002"
	// CodePrivateOnlySurface marks a type nothing can be written into: every
	// member is a `#`-named field, a `private`/`protected` one, symbol-keyed, or
	// a get-only accessor. Its expansion would be an empty object type.
	CodePrivateOnlySurface = "992003"
)

// The exact diagnostic texts.
const (
	MessageNonObjectRoot = "schemaof<T>() expands an object type into its members. A bare leaf or " +
		"non-record type has nothing to expand -- name it with typefor<T>() instead, or wrap " +
		"the fields in an interface or object type."

	MessageUnsupportedType = "unsupported type for an expanded member. A member is either named -- " +
		"kept as its own address -- or one of the structural spellings the Type grammar " +
		"admits: an object, a union, a tuple, a list, or a literal. A callable, and an " +
		"anonymous structure with no nameable shape, are neither."

	MessagePrivateOnlySurface = "no member of this type can be written from outside it -- each is a #-named " +
		"field, a private or protected member, symbol-keyed, or a get-only accessor -- so " +
		"there is nothing to expand. Expose the fields as public properties or settable " +
		"accessors."
)

// expansion threads everything the walk needs, plus the abort flag it sets when a
// member has no spelling. Binding is the resolved value-import for the runtime
// `Type` object; the walk sets its Used flag as it emits factory calls,
// and the caller materializes the import via valueimport.Ensure afterward.
// hoisted is nil for INLINE emission; when set, a member that stops at a name,
// literal, or nullish singleton is spelled through it instead of inline — the
// same const a typefor<T>() call site of that same type would reference.
type expansion struct {
	checker       *shimchecker.Checker
	types         *tokens.Context
	factory       *shimast.NodeFactory
	binding       *valueimport.Binding
	hoisted       *typefortransform.HoistEmitter
	addDiagnostic func(code, message string, anchor *shimast.Node)
	failed        bool
}

// emitLeaf spells a member's derived leaf — a name, a literal, or a nullish
// singleton — through the shared const table when the project hoists, else
// inline at the call site. The object/tuple/union shapes schemaof composes
// AROUND a leaf are always inline: they are this expansion's own structure, not
// a type a hand-writer would address by name.
func emitLeaf(ex *expansion, n *tokens.Node) *shimast.Node {
	if ex.hoisted != nil {
		return ex.hoisted.Node(n)
	}
	return typeemit.EmitNode(ex.factory, ex.binding, n)
}

// undefinedNode and nullNode are the two nullish literals an expansion spells
// directly: an optional member's absence and an explicit `null` alternative.
func undefinedNode() *tokens.Node {
	return &tokens.Node{Kind: tokens.KindLiteral, Literal: tokens.LiteralValue{Kind: tokens.LiteralUndefined}}
}

func nullNode() *tokens.Node {
	return &tokens.Node{Kind: tokens.KindLiteral, Literal: tokens.LiteralValue{Kind: tokens.LiteralNull}}
}

// expandRoot builds the `Type.object({...})` tree for a root type t (anchor is the
// node diagnostics point at). It returns (tree, true), or (nil, false) — pushing a
// diagnostic — when the root is not an object type or some member has no spelling.
func expandRoot(ex *expansion, t *shimchecker.Type, anchor *shimast.Node) (*shimast.Node, bool) {
	if !isRecord(ex, t) {
		ex.addDiagnostic(CodeNonObjectRoot, MessageNonObjectRoot, anchor)
		return nil, false
	}
	tree := objectFor(ex, t, anchor)
	if ex.failed {
		return nil, false
	}
	return tree, true
}

// objectFor builds `Type.object({ name: <member>, ... })` over a record's PUBLIC,
// WRITABLE surface. Coercion assigns into a member, so a get-only accessor is no
// more of a target than a `#`-named field is; a type left with nothing to write to
// would expand to an empty object type, which is refused rather than emitted.
func objectFor(ex *expansion, t *shimchecker.Type, anchor *shimast.Node) *shimast.Node {
	f := ex.factory
	surface := typesurface.For(ex.checker, t, anchor)
	if surface.NothingWritable() {
		ex.failed = true
		ex.addDiagnostic(CodePrivateOnlySurface, MessagePrivateOnlySurface, anchor)
		return typeemit.Call(f, ex.binding, "object", []*shimast.Node{
			f.NewObjectLiteralExpression(f.NewNodeList(nil), true),
		})
	}
	members := []*shimast.Node{}
	for _, member := range surface.Writable() {
		memberType := ex.checker.GetTypeOfSymbolAtLocation(member.Symbol, member.Decl)
		value := memberFor(ex, memberType, member.Optional, member.Decl)
		members = append(members, f.NewPropertyAssignment(nil, propertyKey(f, member.Name), nil, nil, value))
	}
	return typeemit.Call(f, ex.binding, "object", []*shimast.Node{
		f.NewObjectLiteralExpression(f.NewNodeList(members), true),
	})
}

// memberFor spells one member's type. A `?`-optional member is its own type
// unioned with `undefined`, decided SOLELY by the `?` modifier: an existing
// `undefined` alternative is dropped first, so the union carries exactly one
// however the checker spelled the property (`exactOptionalPropertyTypes` decides
// whether the type itself already names it).
func memberFor(ex *expansion, t *shimchecker.Type, optional bool, anchor *shimast.Node) *shimast.Node {
	alternatives := unionMembers(t)
	if optional {
		alternatives = withoutUndefined(alternatives)
	}
	nodes := alternativeNodes(ex, alternatives, anchor)
	if optional {
		nodes = append(nodes, emitLeaf(ex, undefinedNode()))
	}
	if len(nodes) == 1 {
		return nodes[0]
	}
	return typeemit.Call(ex.factory, ex.binding, "union", nodes)
}

// alternativeNodes spells each alternative of a flattened union.
//
// The two boolean literals standing side by side are how the checker decomposes
// the intrinsic `boolean` inside a wider union. Boolean has a name of its own, so
// the pair collapses back to it rather than emitting `true | false`.
func alternativeNodes(ex *expansion, types []*shimchecker.Type, anchor *shimast.Node) []*shimast.Node {
	collapse := hasBothBooleanLiterals(types)
	nodes := make([]*shimast.Node, 0, len(types))
	emitted := false
	for _, t := range types {
		if collapse && t.Flags()&shimchecker.TypeFlagsBooleanLiteral != 0 {
			if emitted {
				continue
			}
			emitted = true
			nodes = append(nodes, booleanNode(ex))
			continue
		}
		nodes = append(nodes, singleFor(ex, t, anchor))
	}
	return nodes
}

// hasBothBooleanLiterals reports whether types carries `true` AND `false`.
func hasBothBooleanLiterals(types []*shimchecker.Type) bool {
	yes, no := false, false
	for _, t := range types {
		if t.Flags()&shimchecker.TypeFlagsBooleanLiteral == 0 {
			continue
		}
		if value, ok := t.AsLiteralType().Value().(bool); ok && value {
			yes = true
		} else {
			no = true
		}
	}
	return yes && no
}

// booleanNode is the intrinsic `boolean` spelled as its own address.
func booleanNode(ex *expansion) *shimast.Node {
	return emitLeaf(ex, &tokens.Node{Kind: tokens.KindNamed, Name: "boolean", From: typeemit.GlobalFrom})
}

// singleFor spells one union-free type.
//
// EXPANSION STOPS AT A NAME. A named type is kept as its own address, exactly as
// typefor would have spelled it, so a member reads as a reference to the type it
// names and a self-referential type terminates by construction. Only what has no
// name of its own — an inline structure, a tuple — is opened up and expanded in
// place.
func singleFor(ex *expansion, t *shimchecker.Type, anchor *shimast.Node) *shimast.Node {
	f := ex.factory
	// The intrinsic `boolean` is modeled as `false | true`, so it reaches here as
	// a union standing for a name — spelled as the name it is.
	if isWideBoolean(t) {
		return booleanNode(ex)
	}
	if shimchecker.IsTupleType(t) {
		elements := ex.checker.GetTypeArguments(t)
		nodes := make([]*shimast.Node, 0, len(elements))
		for _, element := range elements {
			nodes = append(nodes, memberFor(ex, element, false, anchor))
		}
		return typeemit.Call(f, ex.binding, "tuple", nodes)
	}
	// The nullish singletons are literal values with no token spelling of their
	// own, so they never reach the address deriver below.
	if t.Flags()&shimchecker.TypeFlagsUndefined != 0 {
		return emitLeaf(ex, undefinedNode())
	}
	if t.Flags()&shimchecker.TypeFlagsNull != 0 {
		return emitLeaf(ex, nullNode())
	}
	if node, ok := tokens.DeriveNode(ex.types, ex.checker, t, nil); ok && expandable(node) {
		// An anonymous record is opened through schemaof's own writable surface,
		// not kept as the derived object node — coercion writes into a member, so a
		// get-only accessor and a private-only surface are refused, which the walk
		// below decides. Every other derivable leaf is kept as its own address.
		if node.Kind == tokens.KindObject {
			return objectFor(ex, t, anchor)
		}
		return emitLeaf(ex, node)
	}
	if isRecord(ex, t) {
		return objectFor(ex, t, anchor)
	}
	ex.failed = true
	ex.addDiagnostic(CodeUnsupportedType, MessageUnsupportedType, anchor)
	// A harmless placeholder; the failed flag aborts the whole tree.
	return typeemit.Named(f, ex.binding, "unknown", typeemit.GlobalFrom, nil)
}

// expandable reports whether a derived node is a shape schemaof spells — a name,
// literal, hole, tag, tuple, or record. A callable and a bare intersection are
// not: neither is a member a coercion can write, so both are refused loudly rather
// than emitted.
func expandable(n *tokens.Node) bool {
	switch n.Kind {
	case tokens.KindFunc, tokens.KindCtor, tokens.KindAbstractCtor, tokens.KindIntersection:
		return false
	default:
		return true
	}
}

// unionMembers flattens a union into its alternatives, or yields t alone.
//
// WIDE BOOLEAN IS NOT A UNION here, though the checker models it as `false |
// true` and flags it as one: it has a name of its own and must keep it.
func unionMembers(t *shimchecker.Type) []*shimchecker.Type {
	if t.Flags()&shimchecker.TypeFlagsUnion == 0 || isWideBoolean(t) {
		return []*shimchecker.Type{t}
	}
	flattened := []*shimchecker.Type{}
	for _, member := range t.Types() {
		flattened = append(flattened, unionMembers(member)...)
	}
	return flattened
}

// isWideBoolean reports whether t is the intrinsic `boolean` — the union of its
// own two literals, which carries BOTH the Union and the Boolean flag.
func isWideBoolean(t *shimchecker.Type) bool {
	flags := t.Flags()
	return flags&shimchecker.TypeFlagsBoolean != 0 && flags&shimchecker.TypeFlagsBooleanLiteral == 0
}

// withoutUndefined drops every `undefined` alternative, so an optional member's
// union carries exactly the one the `?` modifier puts there.
func withoutUndefined(types []*shimchecker.Type) []*shimchecker.Type {
	kept := make([]*shimchecker.Type, 0, len(types))
	for _, t := range types {
		if t.Flags()&shimchecker.TypeFlagsUndefined != 0 {
			continue
		}
		kept = append(kept, t)
	}
	return kept
}

// isRecord reports whether t is a plain structure the walk can open up: an object
// type with no call/construct signatures, not an array/tuple, and with no index
// signature (which has no member list to expand). Pure predicate — pushes no
// diagnostics.
func isRecord(ex *expansion, t *shimchecker.Type) bool {
	if t == nil {
		return false
	}
	if t.Flags()&shimchecker.TypeFlagsObject == 0 {
		return false
	}
	if len(shimchecker.Checker_getSignaturesOfType(ex.checker, t, shimchecker.SignatureKindCall)) > 0 {
		return false
	}
	if len(shimchecker.Checker_getSignaturesOfType(ex.checker, t, shimchecker.SignatureKindConstruct)) > 0 {
		return false
	}
	if shimchecker.Checker_isArrayType(ex.checker, t) || shimchecker.IsTupleType(t) {
		return false
	}
	if len(shimchecker.Checker_getIndexInfosOfType(ex.checker, t)) > 0 {
		return false
	}
	return true
}

// propertyKey delegates to typeemit.PropertyKey — a bare identifier when the name
// is a valid JS identifier, else a string literal.
func propertyKey(f *shimast.NodeFactory, name string) *shimast.Node {
	return typeemit.PropertyKey(f, name)
}
