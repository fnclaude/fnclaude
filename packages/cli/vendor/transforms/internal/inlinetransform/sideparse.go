package inlinetransform

import (
	"path/filepath"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimparser "github.com/microsoft/typescript-go/shim/parser"
	shimtspath "github.com/microsoft/typescript-go/shim/tspath"
)

// SideParse parses a standalone .ts source OUTSIDE any program — no driver, no
// checker, no module graph — returning its syntax-only SourceFile AST. Body
// extraction reads the declaring package's src this way: the inliner never needs
// the body checked until it is substituted into a consumer call site, at which
// point the CONSUMER program's checker takes over. Parsing the declaring src
// directly (rather than pulling it into every consumer program) is what keeps
// the stage a cheap, cache-per-package side parse.
func SideParse(fileName, sourceText string) *shimast.SourceFile {
	opts := shimast.SourceFileParseOptions{
		FileName: fileName,
		Path:     shimtspath.ToPath(fileName, filepath.Dir(fileName), true),
	}
	return shimparser.ParseSourceFile(opts, sourceText, shimcore.ScriptKindTS)
}

// SingleReturnExpression returns the sole `return <expr>` expression of a
// function-like body node (a method's or function's block), or nil when the body
// is absent, is not exactly one return statement, or returns nothing. The
// inlining hygiene lint constrains an inlineable body to precisely this shape, so
// a nil here is a well-formedness signal, not a parse failure.
func SingleReturnExpression(body *shimast.Node) *shimast.Node {
	if body == nil || body.Kind != shimast.KindBlock {
		return nil
	}
	statements := body.AsBlock().Statements
	if statements == nil || len(statements.Nodes) != 1 {
		return nil
	}
	stmt := statements.Nodes[0]
	if stmt.Kind != shimast.KindReturnStatement {
		return nil
	}
	expr := stmt.AsReturnStatement().Expression
	if expr == nil {
		return nil
	}
	return expr
}

// FindMemberBody locates, in a side-parsed source file, the body of member
// memberName declared on the export named implName (an interface is a pure type
// and has no body, so implName names the concrete impl — a class or an object
// literal held by a const). It returns the member's function-like body node, or
// nil when not found. Syntax-only: it matches by declared name, since the side
// parse has no checker.
func FindMemberBody(sf *shimast.SourceFile, implName, memberName string) *shimast.Node {
	impl := findTopLevelDeclaration(sf, implName)
	if impl == nil {
		return nil
	}
	var body *shimast.Node
	walk(impl, func(node *shimast.Node) bool {
		switch node.Kind {
		case shimast.KindMethodDeclaration, shimast.KindPropertyAssignment, shimast.KindFunctionDeclaration:
			name := node.Name()
			if name == nil || name.Text() != memberName {
				return false
			}
			if fn := functionLikeBody(node); fn != nil {
				body = fn
				return true
			}
		}
		return false
	})
	return body
}

// findTopLevelDeclaration returns the first class / function / variable /
// namespace declaration in sf that introduces the name implName, or nil. A
// namespace is matched by its identifier name, so a `declare module '<specifier>'`
// block — string-named — is never a candidate.
func findTopLevelDeclaration(sf *shimast.SourceFile, implName string) *shimast.Node {
	var found *shimast.Node
	walk(sf.AsNode(), func(node *shimast.Node) bool {
		switch node.Kind {
		case shimast.KindClassDeclaration, shimast.KindFunctionDeclaration:
			if name := node.Name(); name != nil && name.Text() == implName {
				found = node
				return true
			}
		case shimast.KindVariableDeclaration, shimast.KindModuleDeclaration:
			if name := node.Name(); name != nil && name.Kind == shimast.KindIdentifier && name.Text() == implName {
				found = node
				return true
			}
		}
		return false
	})
	return found
}

// functionLikeBody returns the block body of a method / function / property
// holding a function expression, or nil.
func functionLikeBody(node *shimast.Node) *shimast.Node {
	switch node.Kind {
	case shimast.KindMethodDeclaration:
		return node.AsMethodDeclaration().Body
	case shimast.KindFunctionDeclaration:
		return node.AsFunctionDeclaration().Body
	case shimast.KindPropertyAssignment:
		initializer := node.AsPropertyAssignment().Initializer
		if initializer == nil {
			return nil
		}
		switch initializer.Kind {
		case shimast.KindFunctionExpression:
			return initializer.AsFunctionExpression().Body
		case shimast.KindArrowFunction:
			return initializer.AsArrowFunction().Body
		}
	}
	return nil
}
