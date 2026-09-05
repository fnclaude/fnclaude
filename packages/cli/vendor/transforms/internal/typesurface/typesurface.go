// Package typesurface enumerates a type's PUBLIC, STRING-KEYED INSTANCE SURFACE
// — the members a caller can name on a value of that type.
//
// Three member shapes are outside that surface and are never enumerated:
//
//   - a `#`-named field, which is not a string-keyed property at all
//     (`Reflect.ownKeys(new C())` does not list it, `obj["#x"]` is `undefined`),
//     so any emitted key for one is unmatchable at runtime;
//   - a `private` / `protected` member, which a caller cannot supply;
//   - a SYMBOL-keyed member such as `[Symbol.iterator]`, which has no string key
//     to emit either. A computed name is not the same thing: `["a-b"]` evaluates
//     to a string, so it stays in the surface and is read by element access.
//
// Each is COUNTED as it is skipped, so a caller can tell "this type has no
// members" from "this type's members are all outside the surface" and refuse
// loudly rather than emit something that silently cannot match. The checker
// names all three internally with a mangled, unmatchable property name; the
// tests here are on the DECLARATION's shape, never on that name.
//
// A PHANTOM member is skipped into a count of its own (Surface.Phantom), because
// it is not a member a value ever carries: its key is a `declare`d const in an
// implementation file, which emits no binding for anything to key on. Reporting
// it as hidden would ask a caller to refuse over a member that cannot be supplied
// in the first place, while dropping it silently would leave a consumer that
// enumerates members some other way to key on it unwarned.
//
// A get/set accessor IS part of the surface, enumerated as an ordinary member;
// read its type through Member.Decl, which yields the accessor's declared type.
// Static members never appear — an instance type's properties do not include
// them.
//
// An accessor is DIRECTIONAL, and the two directions are reported separately
// (Member.Readable / Member.Writable) because the consumers face opposite ways: a
// runtime type guard READS a member, so a set-only accessor gives it nothing to
// check; a schema WRITES one, so a get-only accessor gives it nowhere to put a
// value. Filtering by the wrong direction yields a member operation that can
// never succeed, so neither consumer may assume both.
//
// EVERY test here is on the member's DECLARATIONS, never on its symbol flags. A
// mapped type — `Partial<T>`, `Readonly<T>`, `{ [K in keyof T]: T[K] }` — remints
// each member as a plain property symbol while keeping the original `get`/`set`
// node as that symbol's declaration, so the flags say "property" exactly where
// the declaration still says "accessor". Reading the flags makes an accessor
// invisible behind any mapped type, which is the whole hazard this package
// exists to close.
package typesurface

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimtspath "github.com/microsoft/typescript-go/shim/tspath"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// Member is one public member: its symbol, its property name, the declaration
// node its type is read at, whether it is `?`-optional, and which directions it
// supports. A plain property is both Readable and Writable; an accessor is
// whichever halves it declares.
type Member struct {
	Symbol   *shimast.Symbol
	Name     string
	Decl     *shimast.Node
	Optional bool
	Readable bool
	Writable bool
}

// Surface is a type's enumerated public surface plus what was skipped to reach
// it.
type Surface struct {
	// Members are the public members, in declaration order.
	Members []Member
	// PrivateNamed counts skipped `#`-named fields.
	PrivateNamed int
	// ModifierHidden counts skipped `private` / `protected` members.
	ModifierHidden int
	// SymbolKeyed counts skipped symbol-keyed members.
	SymbolKeyed int
	// Phantom counts skipped members whose key never exists at runtime. They are
	// not part of Hidden(): nothing is withheld from a consumer by leaving out a
	// member no value carries. A consumer that reads members through some OTHER
	// enumeration still has to know they were declared, since that enumeration
	// will key on them.
	Phantom int
	// HasAccessor reports whether any surviving member is a get/set accessor.
	HasAccessor bool
}

// Hidden is the number of members skipped for any reason. A type with no
// Members and a non-zero Hidden has a surface, just not one anything can be
// emitted for.
func (s Surface) Hidden() int {
	return s.PrivateNamed + s.ModifierHidden + s.SymbolKeyed
}

// NothingReadable and NothingWritable are the refusal predicates, one per
// direction: the type DECLARES members, and none of them faces the way the
// consumer needs. A guard over such a type would decide nothing about the type
// it claims to check; a schema for it would be `{}`, which coerces nothing.
//
// A type that declares no members at all — `{}`, `object` — is neither: there is
// nothing it fails to expose, and a consumer emitting the empty result for it is
// correct rather than blind. Splitting the two apart is what keeps the guard walk
// and the schema walk from reaching different verdicts on the same type.
func (s Surface) NothingReadable() bool {
	return s.declaresMembers() && len(s.Readable()) == 0
}

func (s Surface) NothingWritable() bool {
	return s.declaresMembers() && len(s.Writable()) == 0
}

func (s Surface) declaresMembers() bool {
	return len(s.Members) > 0 || s.Hidden() > 0
}

// Readable returns the members a value can be read FROM, in declaration order —
// the surface a type guard can check.
func (s Surface) Readable() []Member {
	return s.filter(func(m Member) bool { return m.Readable })
}

// Writable returns the members a value can be written TO, in declaration order —
// the surface a coercion can populate.
func (s Surface) Writable() []Member {
	return s.filter(func(m Member) bool { return m.Writable })
}

func (s Surface) filter(keep func(Member) bool) []Member {
	kept := make([]Member, 0, len(s.Members))
	for _, m := range s.Members {
		if keep(m) {
			kept = append(kept, m)
		}
	}
	return kept
}

// For enumerates t's public surface. anchor is the fallback node a member's type
// is read at when the symbol carries no declaration of its own.
func For(checker *shimchecker.Checker, t *shimchecker.Type, anchor *shimast.Node) Surface {
	surface := Surface{}
	if checker == nil || t == nil {
		return surface
	}
	for _, sym := range shimchecker.Checker_getPropertiesOfType(checker, t) {
		decl := declarationOf(sym)
		switch {
		case isPrivateNamed(decl):
			surface.PrivateNamed++
			continue
		case isModifierHidden(decl):
			surface.ModifierHidden++
			continue
		case isSymbolKeyed(checker, decl):
			if isPhantomKeyed(checker, decl) {
				surface.Phantom++
			} else {
				surface.SymbolKeyed++
			}
			continue
		}
		if decl == nil {
			decl = anchor
		}
		readable, writable, accessor := directionsOf(sym)
		if accessor {
			surface.HasAccessor = true
		}
		surface.Members = append(surface.Members, Member{
			Symbol:   sym,
			Name:     sym.Name,
			Decl:     decl,
			Optional: sym.Flags&shimast.SymbolFlagsOptional != 0,
			Readable: readable,
			Writable: writable,
		})
	}
	return surface
}

// directionsOf reads a member's directions off its DECLARATIONS: a `get` node
// makes it readable, a `set` node writable, and anything else — a property, a
// method — both. A member with no declaration at all (a mapped type over a
// literal key union synthesizes one) is an ordinary property.
func directionsOf(sym *shimast.Symbol) (readable, writable, accessor bool) {
	for _, decl := range sym.Declarations {
		switch decl.Kind {
		case shimast.KindGetAccessor:
			accessor, readable = true, true
		case shimast.KindSetAccessor:
			accessor, writable = true, true
		default:
			readable, writable = true, true
		}
	}
	if len(sym.Declarations) == 0 {
		readable, writable = true, true
	}
	return readable, writable, accessor
}

// declarationOf picks the node a member's accessibility and type are read at: its
// value declaration, else its first declaration.
func declarationOf(sym *shimast.Symbol) *shimast.Node {
	if sym.ValueDeclaration != nil {
		return sym.ValueDeclaration
	}
	if len(sym.Declarations) > 0 {
		return sym.Declarations[0]
	}
	return nil
}

// isPrivateNamed reports whether a declaration's name is a `#`-identifier.
func isPrivateNamed(decl *shimast.Node) bool {
	if decl == nil {
		return false
	}
	name := decl.Name()
	return name != nil && name.Kind == shimast.KindPrivateIdentifier
}

// isModifierHidden reports whether a declaration carries `private` or
// `protected`.
func isModifierHidden(decl *shimast.Node) bool {
	if decl == nil {
		return false
	}
	flags := shimast.GetCombinedModifierFlags(decl)
	return flags&(shimast.ModifierFlagsPrivate|shimast.ModifierFlagsProtected) != 0
}

// isSymbolKeyed reports whether a declaration's name carries no string key: what
// the name EVALUATES to decides it, not that it is computed. `[Symbol.iterator]`
// and `[MARK]` (a `unique symbol` const) name no string; `["a-b"]` and `[KEY]`
// (a string const) name an ordinary one an element access reads, and belong to
// the surface.
//
// A computed name whose type will not resolve counts as symbol-keyed. That is the
// honest answer to "I could not tell": the member is skipped and COUNTED, so a
// consumer reports it rather than emitting a key that may name nothing.
func isSymbolKeyed(checker *shimchecker.Checker, decl *shimast.Node) bool {
	if decl == nil {
		return false
	}
	name := decl.Name()
	if name == nil || name.Kind != shimast.KindComputedPropertyName {
		return false
	}
	expr := name.AsComputedPropertyName().Expression
	if expr == nil {
		return true
	}
	if shimast.IsStringLiteral(expr) || expr.Kind == shimast.KindNumericLiteral {
		return false
	}
	if checker == nil || expr.Pos() < 0 {
		return true
	}
	symbol := checker.GetSymbolAtLocation(expr)
	if symbol == nil {
		return true
	}
	nameType := shimchecker.Checker_getTypeOfSymbol(checker, symbol)
	if nameType == nil {
		return true
	}
	return nameType.Flags()&shimchecker.TypeFlagsESSymbolLike != 0
}

// isPhantomKeyed reports whether a symbol-keyed member's key provably never
// exists at runtime, which makes the member unreachable rather than merely
// unnameable. A `declare`d binding in an implementation file emits nothing, so
// the symbol it names is never constructed and no value can carry a property
// keyed on it — a brand written purely to separate two structurally identical
// types is the shape. The same declaration in a `.d.ts` file DESCRIBES a binding
// that some emitted module really creates — a well-known symbol, a compiled
// package's own brand — so it stays symbol-keyed and counted.
//
// The key is reached through the name's TYPE rather than the name itself, so an
// imported brand is judged at the const it ultimately names instead of at the
// import specifier standing in for it. Every declaration has to qualify: one that
// emits is enough for the key to exist, and an unresolvable name proves nothing
// either way.
func isPhantomKeyed(checker *shimchecker.Checker, decl *shimast.Node) bool {
	if checker == nil || decl == nil {
		return false
	}
	name := decl.Name()
	if name == nil || name.Kind != shimast.KindComputedPropertyName {
		return false
	}
	expr := name.AsComputedPropertyName().Expression
	if expr == nil || expr.Pos() < 0 {
		return false
	}
	nameSymbol := checker.GetSymbolAtLocation(expr)
	if nameSymbol == nil {
		return false
	}
	nameType := shimchecker.Checker_getTypeOfSymbol(checker, nameSymbol)
	if nameType == nil {
		return false
	}
	keySymbol := nameType.Symbol()
	if keySymbol == nil || len(keySymbol.Declarations) == 0 {
		return false
	}
	for _, keyDecl := range keySymbol.Declarations {
		if shimast.GetCombinedModifierFlags(keyDecl)&shimast.ModifierFlagsAmbient == 0 {
			return false
		}
		file := shimast.GetSourceFileOfNode(keyDecl)
		if file == nil || shimtspath.IsDeclarationFileName(file.FileName()) {
			return false
		}
	}
	return true
}

// FromLibrary reports whether t is a NOMINAL built-in: a class or interface
// declared entirely in a default library file — `Date`, `Map`, `Promise`,
// `Error`. Membership in one of those is an IDENTITY, not a shape, so
// enumerating its members says nothing useful about whether a value really is
// one; a consumer that emits per-member clauses has to treat it as opaque.
//
// Two kinds of type are deliberately NOT one, and both used to be:
//
//   - A STRUCTURAL type, wherever it is declared. `Partial<T>`, `Readonly<T>`,
//     `Pick<T, K>` and `Record<K, V>` are mapped types whose declarations sit in
//     `lib.es5.d.ts`, but they denote a shape: `Partial<Opts>` is exactly as
//     checkable as `Opts` is. Only a class or interface declaration carries a
//     nominal identity, so nothing else qualifies.
//   - A type from an installed package. A third-party `interface` is a shape the
//     same way a first-party one is, and treating `node_modules` as "library"
//     made every non-primitive type an external consumer imports opaque — which
//     is every such type, since in-repo packages resolve to real paths and
//     published ones do not.
func FromLibrary(prog *driver.Program, t *shimchecker.Type) bool {
	if prog == nil || t == nil {
		return false
	}
	symbol := t.Symbol()
	if symbol == nil || len(symbol.Declarations) == 0 {
		return false
	}
	nominal := false
	for _, decl := range symbol.Declarations {
		file := shimast.GetSourceFileOfNode(decl)
		if file == nil || !prog.TSProgram.IsSourceFileDefaultLibrary(file.Path()) {
			return false
		}
		nominal = nominal || isNominalDeclaration(decl)
	}
	return nominal
}

// isNominalDeclaration reports whether a declaration introduces a named type
// whose membership is an identity — a class or an interface. A mapped type, a
// type literal and an alias body all describe a shape instead. ANY of a symbol's
// declarations qualifying is enough: a built-in merges its interface with the
// `declare var` for its constructor, and both are the same identity.
func isNominalDeclaration(decl *shimast.Node) bool {
	switch decl.Kind {
	case shimast.KindClassDeclaration, shimast.KindClassExpression, shimast.KindInterfaceDeclaration:
		return true
	}
	return false
}
