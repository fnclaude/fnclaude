package tokens

import (
	"unsafe"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
)

// The checker's Type struct records the type ALIAS a reference was spelled
// through (`type Foo<...> = ...`) in an unexported `alias` field. The ttsc shim
// surfaces that field only as audit metadata (its extra-shim.json ExtraFields),
// never as an accessor, and the field's element type is itself unexported — so
// the sole route to the alias symbol and its type arguments is a field-offset
// read of the pinned struct.
//
// typeHeader mirrors the leading fields of checker.Type for the typescript-go
// revision pinned in go.mod; the mirror stops at `alias` and omits every trailing
// field. aliasData mirrors checker.TypeAlias — a symbol pointer and a []*Type
// slice, layout-identical to the shim-aliased element types below, so the values
// read straight out with no conversion.
type typeHeader struct {
	flags       shimchecker.TypeFlags
	objectFlags shimchecker.ObjectFlags
	id          uint32
	symbol      *shimast.Symbol
	alias       *aliasData
}

type aliasData struct {
	symbol        *shimast.Symbol
	typeArguments []*shimchecker.Type
}

// aliasOf returns the type's alias record, or nil when the type is not an alias
// instantiation. A layout checksum guards the offset read: the mirror's `symbol`
// field sits one pointer-slot ahead of `alias` and must equal the sanctioned
// Type.Symbol() accessor. If the pinned struct ever drifts the two disagree, and
// we fail safe to "no alias" rather than dereferencing a bogus pointer.
func aliasOf(t *shimchecker.Type) *aliasData {
	if t == nil {
		return nil
	}
	header := (*typeHeader)(unsafe.Pointer(t))
	if header.symbol != t.Symbol() {
		return nil
	}
	return header.alias
}

// distributedAliasBase recovers the spelled base T of a `Keyed<T, K>` whose
// brand intersection the checker distributed over a union T's members —
// `(A | B) & Brand` normalizes to `(A & Brand) | (B & Brand)`, a union that
// keeps the spelling's alias record but has no brand constituent of its own
// for stripBrandMembers to drop. The candidate is the alias type argument
// whose union members are exactly this union's members with their brand
// constituents stripped; pointer identity suffices because distribution
// reuses the interned member types. Returns nil when t is not such a union
// or no alias argument matches.
func distributedAliasBase(t *shimchecker.Type, checker *shimchecker.Checker) *shimchecker.Type {
	if t.Flags()&shimchecker.TypeFlagsUnion == 0 {
		return nil
	}
	alias := aliasOf(t)
	if alias == nil || len(alias.typeArguments) == 0 {
		return nil
	}
	members := t.Types()
	stripped := make(map[*shimchecker.Type]int, len(members))
	for _, member := range members {
		base := stripBrandMembers(member, checker)
		if base == member {
			// A member the brand did not ride into: not a distributed brand
			// intersection.
			return nil
		}
		stripped[base]++
	}
	for _, candidate := range alias.typeArguments {
		if matchesMemberSet(candidate, stripped, len(members)) {
			return candidate
		}
	}
	return nil
}

// matchesMemberSet reports whether candidate is exactly the union of the
// stripped member multiset (or, for count 1, that single member).
func matchesMemberSet(candidate *shimchecker.Type, stripped map[*shimchecker.Type]int, count int) bool {
	if candidate.Flags()&shimchecker.TypeFlagsUnion == 0 {
		return count == 1 && stripped[candidate] == 1
	}
	members := candidate.Types()
	if len(members) != count {
		return false
	}
	remaining := make(map[*shimchecker.Type]int, len(stripped))
	for member, n := range stripped {
		remaining[member] = n
	}
	for _, member := range members {
		if remaining[member] == 0 {
			return false
		}
		remaining[member]--
	}
	return true
}

// addressableAliasSymbol returns the alias symbol a type's reference was spelled
// through, provided the alias is addressable from another module: an exported
// declaration (the `export` modifier, or an export list — a rolled declaration
// bundle spells `type X = …; export { X }`), or a top-level declaration in a
// global (non-module) file. A local alias returns nil — no other module can
// spell its name, so no derived address may carry it.
func addressableAliasSymbol(ctx *Context, t *shimchecker.Type) *shimast.Symbol {
	alias := aliasOf(t)
	if alias == nil || alias.symbol == nil {
		return nil
	}
	var decl *shimast.Node
	for _, d := range alias.symbol.Declarations {
		if d.Kind == shimast.KindTypeAliasDeclaration {
			decl = d
			break
		}
	}
	if decl == nil {
		return nil
	}
	if shimast.GetCombinedModifierFlags(decl)&shimast.ModifierFlagsExport != 0 {
		return alias.symbol
	}
	parent := decl.Parent
	if parent == nil || parent.Kind != shimast.KindSourceFile {
		return nil
	}
	// A non-module file's top-level declarations are ambient: spellable from
	// anywhere with no import, so no export modifier is needed. A module file
	// carries a module symbol; a global script does not.
	moduleSym := ctx.Checker.GetSymbolAtLocation(parent)
	if moduleSym == nil {
		return alias.symbol
	}
	targetDecls := map[*shimast.Node]bool{}
	for _, d := range alias.symbol.Declarations {
		targetDecls[d] = true
	}
	if moduleReExports(ctx, moduleSym, targetDecls) {
		return alias.symbol
	}
	return nil
}
