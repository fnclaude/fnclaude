package inlinetransform

import (
	"fmt"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// nodeFile returns the absolute file path of node's source file, or "".
func nodeFile(node *shimast.Node) string {
	sf := shimast.GetSourceFileOfNode(node)
	if sf == nil {
		return ""
	}
	return sf.FileName()
}

// nodePosition renders node's file:line:col, or a synthetic-node fallback. It is
// diagnostic-only; a synthetic (substituted) node has no real position.
func nodePosition(node *shimast.Node) string {
	sf := shimast.GetSourceFileOfNode(node)
	if sf == nil || node.Pos() < 0 {
		return "inside a substituted expression"
	}
	text := sf.Text()
	pos := node.Pos()
	if pos > len(text) {
		return sf.FileName()
	}
	line, col := 1, 1
	for i := 0; i < pos; i++ {
		if text[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return fmt.Sprintf("%s:%d:%d", sf.FileName(), line, col)
}

// enclosingInterfaceName walks up from decl to the nearest interface declaration
// and returns its name, or "" — used only for rogue-duplicate provenance.
func enclosingInterfaceName(decl *shimast.Node) string {
	for n := decl; n != nil; n = n.Parent {
		if n.Kind == shimast.KindInterfaceDeclaration {
			if name := n.Name(); name != nil {
				return name.Text()
			}
			return ""
		}
	}
	return ""
}

// inDeclareModuleFor reports whether decl sits inside a `declare module
// '<module>'` block — provenance evidence that a stray declaration is the same
// logical member as the entry's, on a duplicate copy.
func inDeclareModuleFor(decl *shimast.Node, module string) bool {
	for n := decl; n != nil; n = n.Parent {
		if n.Kind == shimast.KindModuleDeclaration {
			name := n.Name()
			if name != nil && name.Kind == shimast.KindStringLiteral && name.Text() == module {
				return true
			}
		}
	}
	return false
}

// elideNamedImport drops any named-import specifier whose local name is in
// elide (drop specifier / drop declaration / keep). Returns nil when the whole
// declaration is dropped.
func elideNamedImport(factory *shimast.NodeFactory, statement *shimast.Node, elide map[string]bool) *shimast.Node {
	if statement.Kind != shimast.KindImportDeclaration {
		return statement
	}
	decl := statement.AsImportDeclaration()
	clauseNode := decl.ImportClause
	if clauseNode == nil {
		return statement
	}
	clause := clauseNode.AsImportClause()
	if clause.PhaseModifier == shimast.KindTypeKeyword {
		return statement
	}
	bindings := clause.NamedBindings
	if bindings == nil || bindings.Kind != shimast.KindNamedImports {
		return statement
	}
	elements := bindings.AsNamedImports().Elements.Nodes
	kept := make([]*shimast.Node, 0, len(elements))
	for _, element := range elements {
		spec := element.AsImportSpecifier()
		if spec.IsTypeOnly || !elide[element.Name().Text()] {
			kept = append(kept, element)
		}
	}
	if len(kept) == len(elements) {
		return statement
	}
	if len(kept) == 0 && clause.Name() == nil {
		return nil
	}
	var namedBindings *shimast.Node
	if len(kept) != 0 {
		namedBindings = factory.UpdateNamedImports(bindings.AsNamedImports(), factory.NewNodeList(kept))
	}
	newClause := factory.UpdateImportClause(clause, clause.PhaseModifier, clause.Name(), namedBindings)
	return factory.UpdateImportDeclaration(decl, decl.Modifiers(), newClause, decl.ModuleSpecifier, decl.Attributes)
}
