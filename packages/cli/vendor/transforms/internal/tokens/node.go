package tokens

import (
	"sort"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
)

// NodeKind discriminates a Node's populated fields — one case per member of the
// runtime `Type` union the derivation can spell. A container's member is another
// Node of any kind, so the walk that builds a container recurses through the same
// classification whatever shape the member turns out to be.
type NodeKind int

const (
	// KindNamed is a type addressed by its own name — `Type.global(name)` when
	// the ambient scope declares it, `Type.imported(name, from)` when an import
	// reaches it — carrying its closed generic arguments.
	KindNamed NodeKind = iota
	// KindLiteral is a single literal value — `Type.typeLiteral(value)` — over
	// any of the six LiteralValue kinds, the two nullish singletons included.
	KindLiteral
	// KindGeneric is an open-generic hole — `Type.generic(label)`.
	KindGeneric
	// KindTag is a branded base wearing a key — `Type.tag(inner, key)`.
	KindTag
	// KindFunc is a call signature — `Type.func(return, signatures)`.
	KindFunc
	// KindCtor is a construct signature — `Type.ctor(instance, signatures)`.
	KindCtor
	// KindAbstractCtor is a construct signature from an `abstract class` —
	// `Type.abstractCtor(instance, signatures)`, its own kind rather than a flag
	// on KindCtor so the two intern distinctly.
	KindAbstractCtor
	// KindUnion is a union of alternatives — `Type.union(...members)`. Member
	// order is not part of its identity; the runtime factory canonicalizes.
	KindUnion
	// KindTuple is an ordered slot list — `Type.tuple(...members)`, plus a rest
	// slot when its length is open. Slot order IS part of its identity, so it is
	// never sorted.
	KindTuple
	// KindObject is a record of named members — `Type.object({ key: member })`.
	KindObject
	// KindIntersection is an intersection of members —
	// `Type.intersection(...members)`.
	KindIntersection
)

// Node is the single derivation tree the walk builds and every emitter consumes.
// One kind per `Type` union member; children are the same type at every depth.
type Node struct {
	Kind NodeKind

	// Name/From are a KindNamed node's export name and its qualifying source
	// ("global" for an ambient / default-lib name); Args are its closed generic
	// type arguments, in order.
	Name string
	From string
	Args []*Node

	// Literal is a KindLiteral node's value.
	Literal LiteralValue

	// Label is a KindGeneric hole's label.
	Label string

	// Inner/Tag are a KindTag node's branded base and the key composed onto it.
	Inner *Node
	Tag   string

	// Ret is a KindFunc's return type, or a KindCtor's / KindAbstractCtor's
	// instance type; Sig is the signatures slot — one KindTuple (fixed argument
	// list) or list-shaped node (a signature that is entirely a rest) for a
	// single signature, a KindUnion of those for an overload set.
	Ret *Node
	Sig *Node

	// Members are a KindUnion's / KindTuple's / KindIntersection's member nodes.
	// A tuple keeps them in declaration order; a union and an intersection do not
	// depend on order for identity.
	Members []*Node

	// TupleRest is a KindTuple's open length: a trailing rest slot's element
	// type, nil for a fixed-length tuple. A slot that may be absent is spelled
	// as its type being (or containing) a union with the `undefined` literal,
	// the same way a `?`-optional object property spells its own.
	TupleRest *Node

	// Properties are a KindObject's members, each a key paired with its type, in
	// declaration order. A `?`-optional property is spelled as its type being (or
	// containing) a union with the `undefined` literal.
	Properties []Property
}

// Property is one member of a KindObject node.
type Property struct {
	Key  string
	Type *Node
}

// seen is the set of checker types currently on the walk's own path, keyed on
// pointer identity — the same shape the merge-synthesis walk guards with. A named
// type terminates the walk by naming, so in practice a cycle only forms when a
// name-losing structural type (a conditional reminting an anonymous shape that
// contains itself) re-reaches its own checker type; the guard refuses that repeat
// visit rather than recursing forever. A type reached twice in sibling positions
// is not a cycle — each visit leaves the set before the next enters — so a DAG
// still derives in full.
type seen map[*shimchecker.Type]bool

// DeriveNode classifies a checker type into the unified vocabulary. ok=false is a
// LOUD refusal reported through failure when the sharper unbound-type-parameter
// diagnostic applies: the shape has no `Type` member to express it, never a
// silent approximation.
func DeriveNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure) (*Node, bool) {
	return deriveNode(ctx, checker, t, failure, nil)
}

// deriveNode is DeriveNode's guarded body. The gate order is load-bearing: a
// single literal short-circuits first, an intrinsic name next, then the hole and
// brand reads that a symbol-bearing type would otherwise be named by, the named
// gate for a spellable non-anonymous type, the two callable shapes (construct
// before call, matching the conditional order a type-level reflection over the
// same type reads them in), the nullish singletons, a general union, and finally
// the anonymous shapes. A second name read sits ahead of those anonymous shapes:
// an anonymous type that still carries an addressable alias — a mapped-type alias
// like `Partial<Foo>` — is spelled by that name, and only a genuinely nameless
// structure is opened as a tuple, object, or intersection.
func deriveNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure, s seen) (*Node, bool) {
	if t == nil {
		return nil, false
	}
	if s == nil {
		s = seen{}
	}
	if s[t] {
		return nil, false
	}
	s[t] = true
	defer delete(s, t)

	if node, ok := deriveSingleLiteral(t); ok {
		return node, true
	}
	if name, ok := intrinsicToken(t); ok {
		return &Node{Kind: KindNamed, Name: name, From: "global"}, true
	}
	// A Hole-branded placeholder is read before the alias/symbol path: an aliased
	// or constrained hole carries a symbol that would otherwise mint a named node,
	// and the bare `Hole<"1">` is an anonymous `__type`.
	if label, ok := GenericLabelFor(t, checker); ok {
		return &Node{Kind: KindGeneric, Label: label}, true
	}
	if t.Flags()&shimchecker.TypeFlagsTypeParameter != 0 {
		if failure != nil {
			failure.UnboundTypeParameter = t
		}
		return nil, false
	}
	// The Keyed brand is read before alias naming: the brand alias carries a
	// symbol that would otherwise mint a named node for `Keyed` itself. An Inject
	// pin under the key names an arbitrary token string with no `Type` spelling,
	// and a base this walk cannot recover has nothing to wrap — both refuse.
	if key, ok := KeyLiteralFor(t, checker); ok {
		if _, pinned := InjectTokenFor(t, checker); pinned {
			return nil, false
		}
		base := KeyedBaseType(t, checker)
		if base == t {
			// No single recoverable base: the brand rode in through union members
			// (an optional keyed slot's `| undefined`, or a keyed union spelled
			// member by member), so derive the union itself and let each member's
			// own brand read fire.
			if isGeneralUnion(t) {
				return deriveUnionNode(ctx, checker, t, failure, s)
			}
			return nil, false
		}
		inner, ok := deriveNode(ctx, checker, base, failure, s)
		if !ok {
			return nil, false
		}
		return &Node{Kind: KindTag, Inner: inner, Tag: key}, true
	}

	// A named type is derived by the node it is SPELLED as, before any structural
	// classification: its address is its name plus its own closed type arguments.
	// An anonymous object is excluded so it falls through to the structural
	// branches; a general union defers to its own gate; the func package's
	// Ctor/Func/AbstractCtor are the narrow exception that derives structurally.
	if t.ObjectFlags()&shimchecker.ObjectFlagsAnonymous == 0 && !isGeneralUnion(t) {
		if symbol := resolvedSymbolFor(t); symbol != nil && !isTypesPackageCallable(ctx, symbol) {
			return deriveNamedNode(ctx, checker, t, symbol, failure, s)
		}
	}

	// A named callable ALIAS (`type Handler = (x: string) => number`) must derive
	// by its name, not structurally as a callable. Only addressable aliases fire
	// here; a declared function (`declare function f()`) carries no alias and falls
	// through to the callable gates below.
	if symbol := addressableAliasSymbol(ctx, t); symbol != nil && !isTypesPackageCallable(ctx, symbol) {
		if hasCallableSignatures(checker, t) {
			return deriveNamedNode(ctx, checker, t, symbol, failure, s)
		}
	}

	if ctorSigs := shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindConstruct); len(ctorSigs) != 0 {
		kind := KindCtor
		if isAbstractConstructor(t) {
			kind = KindAbstractCtor
		}
		return deriveSignatureNode(ctx, checker, ctorSigs, failure, kind, s)
	}
	if callSigs := shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindCall); len(callSigs) != 0 {
		return deriveSignatureNode(ctx, checker, callSigs, failure, KindFunc, s)
	}

	// void reads as the same undefined literal SingletonValue already gives it
	// (generics.go) — the Type model has no separate void member of its own.
	if t.Flags()&(shimchecker.TypeFlagsUndefined|shimchecker.TypeFlagsVoid) != 0 {
		return &Node{Kind: KindLiteral, Literal: LiteralValue{Kind: LiteralUndefined}}, true
	}
	if t.Flags()&shimchecker.TypeFlagsNull != 0 {
		return &Node{Kind: KindLiteral, Literal: LiteralValue{Kind: LiteralNull}}, true
	}

	if isGeneralUnion(t) {
		// A union spelled through an addressable alias derives as the NAME it was
		// spelled through, so its address cannot shift with the union's membership.
		// A local alias has no spellable address, so its union derives structurally.
		if symbol := addressableAliasSymbol(ctx, t); symbol != nil {
			return deriveNamedNode(ctx, checker, t, symbol, failure, s)
		}
		return deriveUnionNode(ctx, checker, t, failure, s)
	}

	// An anonymous type that kept an addressable name — a mapped-type alias whose
	// members were reminted under one name — is spelled by that name rather than
	// opened up. A conditional or index-access that LOST its alias carries no such
	// symbol and falls through to the structural shapes below.
	if symbol := resolvedSymbolFor(t); symbol != nil && !isTypesPackageCallable(ctx, symbol) {
		return deriveNamedNode(ctx, checker, t, symbol, failure, s)
	}

	if node, ok := deriveTupleNode(ctx, checker, t, failure, s); ok {
		return node, true
	}
	if node, ok := deriveObjectNode(ctx, checker, t, failure, s); ok {
		return node, true
	}
	if t.Flags()&shimchecker.TypeFlagsIntersection != 0 {
		return deriveIntersectionNode(ctx, checker, t, failure, s)
	}

	return nil, false
}

// deriveNamedNode builds the Named node a symbol-bearing type spells: the
// FROM/NAME pair off the symbol's primary declaration, plus the closed generic
// type arguments, each recursively derived.
func deriveNamedNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, symbol *shimast.Symbol, failure *Failure, s seen) (*Node, bool) {
	decl := primaryDeclaration(symbol)
	if decl == nil {
		return nil, false
	}
	sourceFile := shimast.GetSourceFileOfNode(decl)
	if sourceFile == nil {
		return nil, false
	}
	from, baseName := baseTokenForPair(ctx, symbol, sourceFile)

	args := genericTypeArguments(ctx, t)
	if collectionTokenBases[renderNamedBase(from, baseName)] && len(args) > 1 {
		args = args[:1]
	}
	argNodes := make([]*Node, 0, len(args))
	for _, arg := range args {
		argNode, ok := deriveNode(ctx, checker, arg, failure, s)
		if !ok {
			return nil, false
		}
		argNodes = append(argNodes, argNode)
	}
	return &Node{Kind: KindNamed, Name: baseName, From: from, Args: argNodes}, true
}

// deriveTupleNode builds the Tuple node an anonymous tuple type spells: its slot
// types in declaration order, each recursively derived, so a slot that is itself
// a union, a callable, or an object reaches its own kind. An OPTIONAL slot's
// checker type already carries `| undefined`, which is the one spelling the model
// gives an absent-able position, so it derives as-is; a trailing REST slot's
// element becomes TupleRest. Only a VARIADIC slot (a `...T` spread of a generic
// array/tuple, rather than a plain `...T[]` rest) or a rest slot anywhere but
// last has no member this walk can spell, so those refuse. A readonly modifier
// and slot labels say nothing about the slots and are dropped. ok=false also
// covers "not a tuple at all" — the checker normalizes a rest-only spelling
// like `[...E[]]` to the array `E[]` itself, so it never arrives here.
func deriveTupleNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure, s seen) (*Node, bool) {
	if !shimchecker.IsTupleType(t) {
		return nil, false
	}
	flags := t.TargetTupleType().ElementFlags()
	restIndex := -1
	for i, slotFlags := range flags {
		switch slotFlags {
		case shimchecker.ElementFlagsRequired, shimchecker.ElementFlagsOptional:
			if restIndex != -1 {
				return nil, false
			}
		case shimchecker.ElementFlagsRest:
			if restIndex != -1 || i != len(flags)-1 {
				return nil, false
			}
			restIndex = i
		default:
			return nil, false
		}
	}
	slots := checker.GetTypeArguments(t)
	members := make([]*Node, 0, len(slots))
	var rest *Node
	for i, slot := range slots {
		member, ok := deriveNode(ctx, checker, slot, failure, s)
		if !ok {
			return nil, false
		}
		if i == restIndex {
			rest = member
			continue
		}
		members = append(members, member)
	}
	return &Node{Kind: KindTuple, Members: members, TupleRest: rest}, true
}

// deriveObjectNode builds the Object node an anonymous record spells: its public,
// string-keyed members paired with their types, in declaration order. A named
// record is derived by its name before this gate, so only a genuinely anonymous
// structure reaches here. A `?`-optional member is its own type unioned with the
// `undefined` literal, the only per-key optionality a members record can carry. An
// index signature has no member list a fixed record can state, so an indexed
// object refuses — `ObjectType.members` has no wildcard-key slot.
func deriveObjectNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure, s seen) (*Node, bool) {
	if t.Flags()&shimchecker.TypeFlagsObject == 0 {
		return nil, false
	}
	if len(shimchecker.Checker_getIndexInfosOfType(checker, t)) != 0 {
		return nil, false
	}
	allProps := shimchecker.Checker_getPropertiesOfType(checker, t)
	properties := make([]Property, 0, len(allProps))
	for _, sym := range allProps {
		if isInternalSymbolName(sym.Name) {
			continue
		}
		memberType := checker.GetTypeOfSymbol(sym)
		if memberType == nil {
			return nil, false
		}
		member, ok := deriveNode(ctx, checker, memberType, failure, s)
		if !ok {
			return nil, false
		}
		if sym.Flags&shimast.SymbolFlagsOptional != 0 {
			member = withUndefined(member)
		}
		properties = append(properties, Property{Key: sym.Name, Type: member})
	}
	if len(allProps) != 0 && len(properties) == 0 {
		return nil, false
	}
	return &Node{Kind: KindObject, Properties: properties}, true
}

// deriveIntersectionNode builds the Intersection node an anonymous intersection
// spells: its members, each recursively derived. An aliased intersection derives
// by its name before this gate, and a Keyed brand intersection is read as a tag
// earlier still, so only a plain `A & B` reaches here.
func deriveIntersectionNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure, s seen) (*Node, bool) {
	constituents := t.Types()
	members := make([]*Node, 0, len(constituents))
	for _, constituent := range constituents {
		member, ok := deriveNode(ctx, checker, constituent, failure, s)
		if !ok {
			return nil, false
		}
		members = append(members, member)
	}
	return &Node{Kind: KindIntersection, Members: members}, true
}

// deriveUnionNode decomposes a union into its DERIVED members, non-nullish first
// and the nullish singletons last — an optional slot's implicit `| undefined`
// reads as its real type qualified by absence. A true/false literal PAIR collapses
// back into the single wide `boolean` member they stand for; any other lone
// boolean literal derives as itself.
func deriveUnionNode(ctx *Context, checker *shimchecker.Checker, t *shimchecker.Type, failure *Failure, s seen) (*Node, bool) {
	types := t.Types()
	trueIdx, falseIdx := -1, -1
	for i, member := range types {
		if member.Flags()&shimchecker.TypeFlagsBooleanLiteral == 0 {
			continue
		}
		if value, ok := member.AsLiteralType().Value().(bool); ok && value {
			trueIdx = i
		} else {
			falseIdx = i
		}
	}
	collapseBoolean := trueIdx >= 0 && falseIdx >= 0

	members := make([]*Node, 0, len(types))
	if collapseBoolean {
		members = append(members, &Node{Kind: KindNamed, Name: "boolean", From: "global"})
	}
	var nullish []*Node
	for i, member := range types {
		if collapseBoolean && (i == trueIdx || i == falseIdx) {
			continue
		}
		derived, ok := deriveNode(ctx, checker, member, failure, s)
		if !ok {
			return nil, false
		}
		if isNullishLiteral(derived) {
			nullish = append(nullish, derived)
			continue
		}
		members = append(members, derived)
	}
	members = append(members, nullish...)
	return &Node{Kind: KindUnion, Members: members}, true
}

// deriveSignatureNode derives a Func/Ctor node from a whole signature list: one
// row node per signature, in declaration order, each parameter independently
// reclassified — a fixed argument list as a KindTuple, a REST parameter as the
// open length its type states. The node carries ONE head — the function's
// product, or the constructor's instance — read off the first signature; several
// rows sit in one KindUnion, matching the union the runtime signatures slot
// canonicalizes to.
func deriveSignatureNode(
	ctx *Context,
	checker *shimchecker.Checker,
	sigs []*shimchecker.Signature,
	failure *Failure,
	kind NodeKind,
	s seen,
) (*Node, bool) {
	ret, ok := deriveNode(ctx, checker, checker.GetReturnTypeOfSignature(sigs[0]), failure, s)
	if !ok {
		return nil, false
	}
	rows := make([]*Node, 0, len(sigs))
	for _, sig := range sigs {
		row, ok := deriveSignatureRow(ctx, checker, sig, failure, s)
		if !ok {
			return nil, false
		}
		rows = append(rows, row)
	}
	sigNode := rows[0]
	if len(rows) > 1 {
		sigNode = &Node{Kind: KindUnion, Members: rows}
	}
	return &Node{Kind: kind, Ret: ret, Sig: sigNode}, true
}

// deriveSignatureRow derives one signature's argument list as a single node: a
// KindTuple over the fixed parameters, absorbing a trailing REST parameter as the
// row's own open length — a list-typed rest contributes its element as
// TupleRest (the list ITSELF when it is the whole signature), and a tuple-typed
// rest splices its slots in as if they were written as parameters. A rest whose
// type is neither a list nor a tuple has no arity this vocabulary can state, so
// the signature refuses. A parameter its callers may omit — spelled `a?: T` or
// given a default, `a: T = fallback` — is its type unioned with the `undefined`
// literal either way, so the two spellings are one slot.
func deriveSignatureRow(ctx *Context, checker *shimchecker.Checker, sig *shimchecker.Signature, failure *Failure, s seen) (*Node, bool) {
	params := shimchecker.Signature_parameters(sig)
	spreadsLastParameter := shimchecker.Signature_hasRestParameter(sig)
	fixed := params
	if spreadsLastParameter {
		fixed = params[:len(params)-1]
	}
	members := make([]*Node, 0, len(params))
	for _, param := range fixed {
		paramType := checker.GetTypeOfSymbol(param)
		if paramType == nil {
			return nil, false
		}
		argNode, ok := deriveNode(ctx, checker, paramType, failure, s)
		if !ok {
			return nil, false
		}
		if decl := param.ValueDeclaration; decl != nil && (decl.Initializer() != nil || decl.QuestionToken() != nil) {
			argNode = withUndefined(argNode)
		}
		members = append(members, argNode)
	}
	if !spreadsLastParameter {
		return &Node{Kind: KindTuple, Members: members}, true
	}
	restType := checker.GetTypeOfSymbol(params[len(params)-1])
	if restType == nil {
		return nil, false
	}
	rest, ok := deriveNode(ctx, checker, restType, failure, s)
	if !ok {
		return nil, false
	}
	switch {
	case rest.Kind == KindTuple:
		return &Node{Kind: KindTuple, Members: append(members, rest.Members...), TupleRest: rest.TupleRest}, true
	case isListNode(rest):
		if len(members) == 0 {
			return rest, true
		}
		return &Node{Kind: KindTuple, Members: members, TupleRest: rest.Args[0]}, true
	default:
		return nil, false
	}
}

// isListNode reports whether a node names one of the two list aggregates the
// runtime canonicalizes to its own kind — a global `Array<E>` or `Iterable<E>`.
func isListNode(n *Node) bool {
	return n.Kind == KindNamed && n.From == "global" && (n.Name == "Array" || n.Name == "Iterable") && len(n.Args) == 1
}

// withUndefined qualifies a member with the `undefined` literal — the member
// itself when it already carries it, else a two-member union. This is how a
// `?`-optional object property spells its absence, since a members record has no
// per-key optional flag of its own.
func withUndefined(member *Node) *Node {
	undefined := &Node{Kind: KindLiteral, Literal: LiteralValue{Kind: LiteralUndefined}}
	if isUndefinedLiteral(member) {
		return member
	}
	if member.Kind == KindUnion {
		for _, m := range member.Members {
			if isUndefinedLiteral(m) {
				return member
			}
		}
		return &Node{Kind: KindUnion, Members: append(append([]*Node{}, member.Members...), undefined)}
	}
	return &Node{Kind: KindUnion, Members: []*Node{member, undefined}}
}

// isUndefinedLiteral reports whether a node is the `undefined` literal.
func isUndefinedLiteral(n *Node) bool {
	return n.Kind == KindLiteral && n.Literal.Kind == LiteralUndefined
}

// isNullishLiteral reports whether a node is the `null` or `undefined` literal.
func isNullishLiteral(n *Node) bool {
	return n.Kind == KindLiteral && (n.Literal.Kind == LiteralNull || n.Literal.Kind == LiteralUndefined)
}

// resolvedSymbolFor returns the symbol a type is spelled by, direct or through its
// alias, or nil when the type carries no addressable name: no symbol at all, or an
// anonymous / synthesized one a caller could never spell.
func resolvedSymbolFor(t *shimchecker.Type) *shimast.Symbol {
	symbol := t.Symbol()
	if alias := aliasOf(t); alias != nil && alias.symbol != nil {
		symbol = alias.symbol
	}
	if symbol == nil || symbol.Name == "" || isInternalSymbolName(symbol.Name) {
		return nil
	}
	return symbol
}

// typesPackageCallableNames are the three types-package spellings that route to a
// callable Type kind structurally regardless of naming. A same-named type declared
// anywhere else is not exempt and derives by name like everything else.
var typesPackageCallableNames = map[string]bool{"Ctor": true, "Func": true, "AbstractCtor": true}

// isTypesPackageCallable reports whether symbol is Ctor, Func, or AbstractCtor as
// exported by @rhombus-toolkit/types specifically.
func isTypesPackageCallable(ctx *Context, symbol *shimast.Symbol) bool {
	if !typesPackageCallableNames[symbol.Name] {
		return false
	}
	decl := primaryDeclaration(symbol)
	if decl == nil {
		return false
	}
	sourceFile := shimast.GetSourceFileOfNode(decl)
	if sourceFile == nil {
		return false
	}
	pkg := nearestPackage(ctx, sourceFile.FileName())
	return pkg != nil && pkg.name == "@rhombus-toolkit/types"
}

// hasCallableSignatures reports whether t carries call or construct signatures —
// the shapes the callable gates would structurally derive if not intercepted.
func hasCallableSignatures(checker *shimchecker.Checker, t *shimchecker.Type) bool {
	if len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindConstruct)) != 0 {
		return true
	}
	return len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindCall)) != 0
}

// isGeneralUnion reports whether t is a union this layer decomposes itself, rather
// than leaving it to the pure-literal-union handling — every union except the wide
// `boolean` intrinsic, which is internally a union of its two literals but is named
// directly instead of decomposed.
func isGeneralUnion(t *shimchecker.Type) bool {
	flags := t.Flags()
	if flags&shimchecker.TypeFlagsUnion == 0 {
		return false
	}
	return flags&shimchecker.TypeFlagsBoolean == 0 || flags&shimchecker.TypeFlagsBooleanLiteral != 0
}

// KeyedBaseType returns the underlying T of a `Keyed<T, K>` brand, for a caller
// that already confirmed t is keyed: the phantom-brand intersection member(s)
// stripped, or — when the checker distributed the brand intersection over a union
// T's members — the spelled T recovered from the alias record. Returns t UNCHANGED
// when no single base is recoverable; a caller must treat that as "no base", never
// re-derive t itself.
func KeyedBaseType(t *shimchecker.Type, checker *shimchecker.Checker) *shimchecker.Type {
	if base := stripBrandMembers(t, checker); base != t {
		return base
	}
	if base := distributedAliasBase(t, checker); base != nil {
		return base
	}
	return t
}

// renderNamedBase joins a Named node's From/Name pair into the flat base token:
// bare Name when From is the "global" sentinel, else "From:Name".
func renderNamedBase(from, name string) string {
	if from == "global" {
		return name
	}
	return from + ":" + name
}

// literalNodeValue extracts a String/Number/BigInt/BooleanLiteral value, excluding
// null/undefined/void, so a pure-literal node fires in exactly the cases the token
// grammar admits one.
func literalNodeValue(t *shimchecker.Type) (LiteralValue, bool) {
	v, ok := SingletonValue(t)
	if !ok || v.Kind == LiteralNull || v.Kind == LiteralUndefined {
		return LiteralValue{}, false
	}
	return v, true
}

// deriveSingleLiteral classifies a single literal value — a
// String/Number/BigInt/BooleanLiteral — as a KindLiteral. A union (a pure-literal
// one included) and the wide `boolean` scalar return ok=false: a union is
// decomposed by the general-union gate, where each member reaches this classifier
// in turn, and wide `boolean` is not a literal value.
func deriveSingleLiteral(t *shimchecker.Type) (*Node, bool) {
	if v, ok := literalNodeValue(t); ok {
		return &Node{Kind: KindLiteral, Literal: v}, true
	}
	return nil, false
}

// renderLiteral reproduces a LiteralValue's exact token text: a JSON-quoted string,
// a number/bigint with the sign reattached, or the "true"/"false" boolean text.
// Null/Undefined have no token text and return "".
func renderLiteral(v LiteralValue) string {
	switch v.Kind {
	case LiteralString:
		return strconv.Quote(v.Str)
	case LiteralNumber:
		if v.Negated {
			return "-" + v.Text
		}
		return v.Text
	case LiteralBigInt:
		if v.Negated {
			return "-" + v.Text + "n"
		}
		return v.Text + "n"
	case LiteralBoolean:
		return strconv.FormatBool(v.Bool)
	default:
		return ""
	}
}

// LiteralText is renderLiteral's exported form: the token text of a non-nullish
// literal value, for a caller keying a hoisted const on it.
func LiteralText(v LiteralValue) string {
	return renderLiteral(v)
}

// RenderNode is the flat token string a Node spells, and whether it has one. Only
// the token-representable kinds — named, literal, pure-literal union, tuple, hole,
// tag — render; a callable, an object, an intersection, or a union with a
// non-literal member has no flat token spelling, so ok=false there.
func RenderNode(n *Node) (string, bool) {
	return renderNode(n)
}

// renderNode joins a Node back into its flat token string. A kind with no token
// spelling refuses (ok=false) rather than rendering an empty or approximate one,
// so a container carrying such a member refuses in turn.
func renderNode(n *Node) (string, bool) {
	switch n.Kind {
	case KindLiteral:
		if n.Literal.Kind == LiteralNull || n.Literal.Kind == LiteralUndefined {
			return "", false
		}
		return renderLiteral(n.Literal), true
	case KindUnion:
		parts := make([]string, 0, len(n.Members))
		for _, m := range n.Members {
			if m.Kind != KindLiteral || m.Literal.Kind == LiteralNull || m.Literal.Kind == LiteralUndefined {
				return "", false
			}
			parts = append(parts, renderLiteral(m.Literal))
		}
		sort.Strings(parts)
		return strings.Join(parts, " | "), true
	case KindTuple:
		parts := make([]string, 0, len(n.Members)+1)
		for _, m := range n.Members {
			s, ok := renderNode(m)
			if !ok {
				return "", false
			}
			parts = append(parts, s)
		}
		if n.TupleRest != nil {
			s, ok := renderNode(n.TupleRest)
			if !ok {
				return "", false
			}
			parts = append(parts, "...Array<"+s+">")
		}
		return "[" + strings.Join(parts, ",") + "]", true
	case KindGeneric:
		return "$" + n.Label, true
	case KindTag:
		inner, ok := renderNode(n.Inner)
		if !ok {
			return "", false
		}
		return inner + "#" + n.Tag, true
	case KindNamed:
		base := renderNamedBase(n.From, n.Name)
		if len(n.Args) == 0 {
			return base, true
		}
		parts := make([]string, 0, len(n.Args))
		for _, a := range n.Args {
			s, ok := renderNode(a)
			if !ok {
				return "", false
			}
			parts = append(parts, s)
		}
		return base + "<" + strings.Join(parts, ",") + ">", true
	default:
		return "", false
	}
}

// KindName is the `kind` discriminant string a derivation's node carries — the
// literal the runtime `Type.*` factory the node emits as stamps on its `kind`
// field.
func KindName(n *Node) string {
	switch n.Kind {
	case KindFunc:
		return "func"
	case KindCtor:
		return "ctor"
	case KindAbstractCtor:
		return "abstract-ctor"
	case KindTag:
		return "tag"
	case KindUnion:
		return "union"
	case KindLiteral:
		return "literal"
	case KindTuple:
		return "tuple"
	case KindGeneric:
		return "generic"
	case KindObject:
		return "object"
	case KindIntersection:
		return "intersection"
	default: // KindNamed
		if n.From == "global" {
			return "global"
		}
		return "imported"
	}
}
