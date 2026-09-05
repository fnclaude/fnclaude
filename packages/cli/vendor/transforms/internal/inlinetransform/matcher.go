// Package inlinetransform holds the matching and side-parse foundations for the
// generic single-expression function-inlining transform stage. It carries no
// per-library semantic knowledge: a publish-list entry — a JSON `inline` entry
// or one a `registerInlineBodies` marker call discovers — names an interface
// member (or free function), and this package resolves that entry ONCE per
// program to the publisher's own declarations, then inlines each call the
// checker resolves to one of them.
//
// The two load-bearing steps:
//
//   - Declaration lookup (markerMemberDeclarations): the entry's `type` token
//     resolves to a module symbol and then an exported type symbol, and every
//     type on that surface — the named one and each it transitively extends — is
//     asked for its OWN member of that name. The union is the member's
//     declaration set, whichever member a property lookup would have preferred;
//     the subset whose source files the entry's impl PACKAGE owns is what the
//     body serves, since a publisher declares nothing onto a receiver that is
//     not sugar.
//
//   - Selection is the checker's resolution, full stop: the signature the
//     checker resolved a call to — the one the author's editor displayed — is
//     the selection, and the engine inlines the body assigned to exactly that
//     declaration (assignBodies). The engine performs no overload resolution of
//     its own, and a publisher-owned face with no body is a resolution-time
//     hard error rather than a nearest-match substitution.
package inlinetransform

import (
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// Entry is one hand-authored `rhombus-std` marker `inline` publish-list entry.
// Field KIND distinguishes the shapes: type names a TYPE (the interface an
// instance member is declared on); impl names a VALUE (a fully-qualified
// export — the body holder for an ambient member, or a floater's own
// function); member is the member name, shared by both member shapes. See
// Entry.Kind (entries.go) for the full grammar.
type Entry struct {
	// Type is a "<package>:<TypeName>" reference identifying the interface an
	// instance member is declared on — the match anchor. Absent for a floater
	// or a static member.
	Type string
	// Impl is a "<package>:<Name>" reference to the export holding the
	// inlineable body: an ambient member's body-holder value, or a floater's
	// own function. Absent for an own-body instance member.
	Impl string
	// Member is the member name, shared by both member shapes (instance and
	// static). Absent for a floater.
	Member string
}

// markerMemberDeclarations returns every declaration of member the marker's named
// type carries: its own, and those of each type it extends, transitively.
//
// It deliberately does not ask the type for its PROPERTY of that name. A property
// lookup answers with one declaration set per name, and an interface reaching two
// same-named members through two `extends` clauses resolves the collision by
// keeping one and hiding the other — so the sugar declaration a marker names can
// be entirely invisible to it. The marker names a member on a SURFACE, so the
// surface is walked and every contributing type is asked for its own member of
// that name.
//
// An empty result means the marker names a member that exists nowhere on the
// surface it named; the caller raises that rather than skipping.
func markerMemberDeclarations(checker *shimchecker.Checker, typeSym *shimast.Symbol, member string) []*shimast.Node {
	var out []*shimast.Node
	seen := map[*shimast.Node]bool{}
	for _, surface := range surfaceTypes(checker, typeSym) {
		memberSym := checker.GetPropertyOfType(surface, member)
		if memberSym == nil {
			continue
		}
		for _, decl := range memberSym.Declarations {
			if seen[decl] {
				continue
			}
			seen[decl] = true
			out = append(out, decl)
		}
	}
	return out
}

// surfaceTypes returns the type a marker names together with every type it
// extends, transitively. Order is deterministic — the named type first, then each
// base in declaration order — so a declaration set built from it is stable across
// runs.
func surfaceTypes(checker *shimchecker.Checker, typeSym *shimast.Symbol) []*shimchecker.Type {
	var out []*shimchecker.Type
	seen := map[*shimchecker.Type]bool{}
	var visit func(t *shimchecker.Type)
	visit = func(t *shimchecker.Type) {
		if t == nil || seen[t] {
			return
		}
		seen[t] = true
		out = append(out, t)
		for _, base := range baseTypesOf(checker, t) {
			visit(base)
		}
	}
	visit(checker.GetDeclaredTypeOfSymbol(typeSym))
	return out
}

// baseTypesOf returns t's `extends` bases. A generic base arrives INSTANTIATED,
// and an instantiation carries no interface shape of its own, so the walk steps
// through such a type's symbol to its declared type first — otherwise it stops at
// the first generic link in the chain.
func baseTypesOf(checker *shimchecker.Checker, t *shimchecker.Type) []*shimchecker.Type {
	if t == nil {
		return nil
	}
	if t.ObjectFlags()&shimchecker.ObjectFlagsClassOrInterface == 0 {
		t = declaredTypeOf(checker, t.Symbol())
	}
	if t == nil || t.ObjectFlags()&shimchecker.ObjectFlagsClassOrInterface == 0 {
		return nil
	}
	return shimchecker.Checker_getBaseTypes(checker, t)
}

// declaredTypeOf returns the type a class, interface or alias symbol declares, or
// nil for a symbol that declares no type at all — the shape a base's symbol takes
// when it is not itself a named type.
func declaredTypeOf(checker *shimchecker.Checker, sym *shimast.Symbol) *shimchecker.Type {
	const declaresAType = shimast.SymbolFlagsClass | shimast.SymbolFlagsInterface | shimast.SymbolFlagsTypeAlias
	if sym == nil || sym.Flags&declaresAType == 0 {
		return nil
	}
	return checker.GetDeclaredTypeOfSymbol(sym)
}

// resolvedDeclaration returns the declaration node the call binds to. For an
// instantiated (generic) signature the declaration is carried on the target
// signature, so an explicit `isService<T>()` and an inferred call both resolve
// back to the same authored MethodSignature node.
func resolvedDeclaration(checker *shimchecker.Checker, call *shimast.Node) *shimast.Node {
	sig := checker.GetResolvedSignature(call)
	if sig == nil {
		return nil
	}
	if d := sig.Declaration(); d != nil {
		return d
	}
	if target := sig.Target(); target != nil {
		return target.Declaration()
	}
	return nil
}

// RecoverTypeArguments returns the type arguments a call was invoked with,
// covering both explicit `f<T>()` and INFERRED `f(arg)` forms.
//
//   - Explicit: the syntactic type-argument nodes are resolved through the
//     checker (`GetTypeFromTypeNode`), so the binding is the checked type, not
//     just the written text.
//   - Inferred: the resolved signature is an instantiation; its target holds the
//     declared type parameters. Where a target parameter's declared type is a
//     bare reference to a type parameter, the corresponding INSTANTIATED
//     parameter type is that parameter's binding — inference can only fix a type
//     parameter that appears in a parameter position, so this recovers every
//     inferred argument the checker bound.
//
// required marks, by type-parameter POSITION, which bindings the caller
// actually needs; a nil required treats every position as needed. A position
// beyond required's length is treated as needed too, so a length mismatch
// fails safe rather than silently skipping a check.
//
// On the INFERRED path, a position the caller does not need is free to go
// unbound — nothing in the call's arguments has to determine it — and its slot
// in the returned slice is left nil rather than sinking the whole recovery. ok
// is false when the call binds no type arguments (non-generic) or a NEEDED
// position's binding cannot be recovered.
func RecoverTypeArguments(checker *shimchecker.Checker, call *shimast.Node, required []bool) ([]*shimchecker.Type, bool) {
	callExpr := call.AsCallExpression()
	if callExpr == nil {
		return nil, false
	}

	if callExpr.TypeArguments != nil && len(callExpr.TypeArguments.Nodes) > 0 {
		out := make([]*shimchecker.Type, 0, len(callExpr.TypeArguments.Nodes))
		for _, node := range callExpr.TypeArguments.Nodes {
			out = append(out, checker.GetTypeFromTypeNode(node))
		}
		return out, true
	}

	sig := checker.GetResolvedSignature(call)
	if sig == nil {
		return nil, false
	}
	target := sig.Target()
	if target == nil {
		return nil, false
	}
	typeParams := target.TypeParameters()
	if len(typeParams) == 0 {
		return nil, false
	}

	indexOf := map[*shimchecker.Type]int{}
	for i, tp := range typeParams {
		indexOf[tp] = i
	}

	bindings := make([]*shimchecker.Type, len(typeParams))
	targetParams := target.Parameters()
	instParams := sig.Parameters()
	for i, sym := range targetParams {
		if i >= len(instParams) {
			break
		}
		decl := sym.ValueDeclaration
		if decl == nil || decl.Kind != shimast.KindParameter {
			continue
		}
		typeNode := decl.AsParameterDeclaration().Type
		if typeNode == nil {
			continue
		}
		declaredType := checker.GetTypeFromTypeNode(typeNode)
		if declaredType == nil || declaredType.Flags()&shimchecker.TypeFlagsTypeParameter == 0 {
			continue
		}
		idx, ok := indexOf[declaredType]
		if !ok || bindings[idx] != nil {
			continue
		}
		bindings[idx] = checker.GetTypeOfSymbol(instParams[i])
	}

	for i, b := range bindings {
		needed := required == nil || i >= len(required) || required[i]
		if needed && b == nil {
			return nil, false
		}
	}
	return bindings, true
}

// splitTypeToken splits a "<package>:<TypeName>" token at its FIRST colon. A
// package specifier ("@rhombus-std/di.core", "pkg/path") never contains a colon;
// a nested type name ("A.Foo") never does either — so the first colon is the
// unambiguous boundary.
func splitTypeToken(token string) (pkg, typeName string, ok bool) {
	i := strings.Index(token, ":")
	if i <= 0 || i == len(token)-1 {
		return "", "", false
	}
	return token[:i], token[i+1:], true
}

// resolveModuleSymbol resolves a bare module specifier to its (merged) module
// symbol. It tries two anchors in order:
//
//  1. A module-specifier node in the program that names it — an import, an
//     export, or a `declare module` block — resolved through the checker. This
//     succeeds whenever some SCANNED file carries a specifier that resolves from
//     ITS location.
//
//  2. Real module RESOLUTION from a consumer source file (the transitive-witness
//     fix). A dist-referenced re-export
//     (`@rhombus-std/di`'s bundle `export … from '@rhombus-std/di.core'`) carries
//     the specifier but does NOT resolve from di's OWN dist location under the
//     isolated linker, so (1) returns nil for a consumer that reaches the target
//     only through that re-export. The target IS a (dev)dependency of the
//     CONSUMER, though, so resolving the specifier from a consumer source file
//     finds the module the checker actually loaded (and merged the sugar
//     `declare module` augmentation into). Empirically this is the exact failure
//     mode examples.app.with-transformer hit: di.core absent from (1), present in
//     the program, resolvable from the app's own files.
func resolveModuleSymbol(prog *driver.Program, checker *shimchecker.Checker, specifier string) *shimast.Symbol {
	if sym := resolveModuleSymbolByScan(prog, checker, specifier); sym != nil {
		return sym
	}
	return resolveModuleByResolution(prog, checker, specifier)
}

// resolveModuleSymbolByScan is the specifier-scan anchor (resolveModuleSymbol path
// 1): it finds a module-specifier node naming specifier and resolves it through the
// checker. It succeeds whenever some scanned file carries a specifier that resolves
// from ITS location, and returns nil otherwise (leaving the module-resolution
// fallback to try).
func resolveModuleSymbolByScan(prog *driver.Program, checker *shimchecker.Checker, specifier string) *shimast.Symbol {
	for _, sf := range prog.SourceFiles() {
		node := findModuleSpecifierNode(sf, specifier)
		if node == nil {
			continue
		}
		sym := checker.ResolveExternalModuleName(node)
		if sym == nil {
			continue
		}
		if resolved := checker.ResolveExternalModuleSymbol(sym); resolved != nil {
			sym = resolved
		}
		return checker.GetMergedSymbol(sym)
	}
	return nil
}

// resolveModuleByResolution resolves specifier through the program's real module
// resolver from a consumer source file, then returns the module symbol of the
// resolved file when that file is loaded in the program. It is the fallback anchor
// for a target reached only transitively (no directly-resolvable specifier node);
// see resolveModuleSymbol. It walks non-declaration source files (the consumer's
// own code, which sits where the target is a resolvable dependency) and returns
// the first module symbol it recovers.
func resolveModuleByResolution(prog *driver.Program, checker *shimchecker.Checker, specifier string) *shimast.Symbol {
	for _, sf := range prog.SourceFiles() {
		if sf.IsDeclarationFile {
			continue
		}
		resolved := prog.TSProgram.ResolveModuleName(specifier, sf.FileName(), 0)
		if resolved == nil || !resolved.IsResolved() {
			continue
		}
		target := prog.TSProgram.GetSourceFileForResolvedModule(resolved.ResolvedFileName)
		if target == nil {
			continue
		}
		sym := checker.GetSymbolAtLocation(target.AsNode())
		if sym == nil {
			continue
		}
		if unwrapped := checker.ResolveExternalModuleSymbol(sym); unwrapped != nil {
			sym = unwrapped
		}
		return checker.GetMergedSymbol(sym)
	}
	return nil
}

// findModuleSpecifierNode returns the string-literal specifier node of the first
// import / export / `declare module` in sf whose specifier text equals
// specifier, or nil.
func findModuleSpecifierNode(sf *shimast.SourceFile, specifier string) *shimast.Node {
	var found *shimast.Node
	walk(sf.AsNode(), func(node *shimast.Node) bool {
		switch node.Kind {
		case shimast.KindImportDeclaration, shimast.KindExportDeclaration:
			spec := node.ModuleSpecifier()
			if spec != nil && spec.Kind == shimast.KindStringLiteral && spec.Text() == specifier {
				found = spec
				return true
			}
		case shimast.KindModuleDeclaration:
			name := node.Name()
			if name != nil && name.Kind == shimast.KindStringLiteral && name.Text() == specifier {
				found = name
				return true
			}
		}
		return false
	})
	return found
}

// exportedMember returns the export named name from a resolved module symbol,
// unwrapping a re-export alias (`export { X } from …`) to its target so the
// returned symbol is the real interface declaration symbol.
func exportedMember(checker *shimchecker.Checker, moduleSym *shimast.Symbol, name string) *shimast.Symbol {
	for _, exp := range checker.GetExportsOfModule(moduleSym) {
		if exp.Name != name {
			continue
		}
		if exp.Flags&shimast.SymbolFlagsAlias != 0 {
			if aliased := checker.GetAliasedSymbol(exp); aliased != nil {
				return aliased
			}
		}
		return exp
	}
	return nil
}

// walk performs a pre-order traversal of node's subtree, calling visit on each
// node and stopping the whole walk as soon as visit returns true.
func walk(node *shimast.Node, visit func(*shimast.Node) bool) {
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
		return n.ForEachChild(func(child *shimast.Node) bool {
			return recur(child)
		})
	}
	recur(node)
}
