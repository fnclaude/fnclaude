// Package valueimport is the engine's generic VALUE-import materialization: given
// a value export identified by (module, exportName) DATA — never a hardcoded Go
// constant — it resolves how that symbol is referenced in one source file
// (honoring an existing named / aliased / namespace binding) and injects a named
// import for it exactly once per file when no binding exists and at least one
// reference was emitted.
//
// It is the generalization of the config transformer's bespoke OPTIONAL injector:
// a primitive stage (or a body) that emits a runtime reference which SURVIVES into
// the lowered output — config's `OPTIONAL` schema marker is the first case —
// resolves its Ref against the file up front, references the symbol through the
// returned Binding, sets Binding.Used when it emits at least one reference, and
// calls Ensure to materialize the import. Nothing here knows any specific module
// or export name; the identity flows in as a Ref value.
package valueimport

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// Ref identifies a value export to materialize: a bare package specifier plus the
// exported name. It is DATA — the caller supplies it; this package branches on no
// module or export name of its own.
type Ref struct {
	// Module is the bare package specifier the value is exported from
	// (`@rhombus-std/config`). "From the module" means this specifier EXACTLY; a
	// subpath does not count.
	Module string
	// Export is the value's exported name (`OPTIONAL`).
	Export string
}

// Binding describes how to reference Ref's symbol in a given source file, and
// whether a named import must be injected. A caller sets Used = true when it emits
// at least one reference; Ensure then prepends the import only when
// Used && injectNamed.
type Binding struct {
	// Used is set by the caller when at least one reference to the symbol was
	// emitted into the file.
	Used bool
	// injectNamed is true when no existing binding was found and a named import
	// must be prepended.
	injectNamed bool
	// localName is the local identifier the symbol is referenced by (an existing
	// named import's local name, honoring an alias, or the bare Export); used when
	// namespace is empty.
	localName string
	// namespace, when non-empty, selects the `<namespace>.<Export>` reference form.
	namespace string
	// ref is the (module, export) identity this binding materializes.
	ref Ref
}

// Expr builds a FRESH expression evaluating to the referenced symbol at a use
// site. A fresh node per use avoids aliasing one node across multiple parents.
func (b *Binding) Expr(f *shimast.NodeFactory) *shimast.Node {
	if b.namespace != "" {
		return f.NewPropertyAccessExpression(
			f.NewIdentifier(b.namespace),
			nil,
			f.NewIdentifier(b.ref.Export),
			0,
		)
	}
	return f.NewIdentifier(b.localName)
}

// Resolve resolves ref's binding in sourceFile (one lookup per file): an existing
// NAMED import of ref.Export from ref.Module (alias honored — the local name is
// used), else a NAMESPACE import from ref.Module (`<ns>.Export`), else none —
// falling back to a bare `Export` identifier and flagging that an
// `import { Export } from "Module";` must be prepended IF a reference is emitted.
func Resolve(sourceFile *shimast.SourceFile, ref Ref) *Binding {
	for _, statement := range sourceFile.Statements.Nodes {
		if statement.Kind != shimast.KindImportDeclaration {
			continue
		}
		decl := statement.AsImportDeclaration()
		if decl.ModuleSpecifier == nil || decl.ModuleSpecifier.Kind != shimast.KindStringLiteral {
			continue
		}
		if decl.ModuleSpecifier.Text() != ref.Module {
			continue
		}
		if decl.ImportClause == nil {
			continue
		}
		bindings := decl.ImportClause.AsImportClause().NamedBindings
		if bindings == nil {
			continue
		}
		// Namespace import: `import * as ns from "<module>"`.
		if bindings.Kind == shimast.KindNamespaceImport {
			return &Binding{namespace: bindings.AsNamespaceImport().Name().Text(), ref: ref}
		}
		// Named imports: look for `Export` (honoring an alias).
		if bindings.Kind == shimast.KindNamedImports {
			for _, element := range bindings.AsNamedImports().Elements.Nodes {
				specifier := element.AsImportSpecifier()
				imported := element.Name().Text()
				if specifier.PropertyName != nil {
					imported = specifier.PropertyName.Text()
				}
				if imported == ref.Export {
					return &Binding{localName: element.Name().Text(), ref: ref}
				}
			}
		}
	}
	// No existing binding: use a bare `Export` identifier and flag injection.
	return &Binding{localName: ref.Export, injectNamed: true, ref: ref}
}

// Ensure prepends the named imports the Used && injectNamed bindings need, in
// the given order. Bindings naming the SAME module share one import declaration
// carrying every specifier, the way a hand-writer would spell it; the
// declaration takes the position of its first binding. A binding with an
// existing reference (namespace / named) or no emitted use injects nothing.
// Returns sourceFile unchanged (same pointer) when no binding needs an import —
// the identity contract the fixed-point loop's change detection relies on.
func Ensure(f *shimast.NodeFactory, sourceFile *shimast.SourceFile, bindings ...*Binding) *shimast.SourceFile {
	var modules []string
	specifiers := map[string][]*shimast.Node{}
	for _, b := range bindings {
		if b == nil || !b.Used || !b.injectNamed {
			continue
		}
		if _, seen := specifiers[b.ref.Module]; !seen {
			modules = append(modules, b.ref.Module)
		}
		specifiers[b.ref.Module] = append(
			specifiers[b.ref.Module],
			f.NewImportSpecifier(false, nil, f.NewIdentifier(b.ref.Export)),
		)
	}
	var injected []*shimast.Node
	for _, module := range modules {
		named := f.NewNamedImports(f.NewNodeList(specifiers[module]))
		clause := f.NewImportClause(0, nil, named)
		moduleSpecifier := f.NewStringLiteral(module, shimast.TokenFlagsNone)
		injected = append(injected, f.NewImportDeclaration(nil, clause, moduleSpecifier, nil))
	}
	if len(injected) == 0 {
		return sourceFile
	}
	statements := make([]*shimast.Node, 0, len(sourceFile.Statements.Nodes)+len(injected))
	statements = append(statements, injected...)
	statements = append(statements, sourceFile.Statements.Nodes...)
	return f.UpdateSourceFile(sourceFile, f.NewNodeList(statements), sourceFile.EndOfFileToken).AsSourceFile()
}
