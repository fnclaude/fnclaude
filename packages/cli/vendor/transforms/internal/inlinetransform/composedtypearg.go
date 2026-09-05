// Package inlinetransform's composedtypearg.go substitutes an impl's type
// parameters where they sit INSIDE a type argument rather than standing as one.
// A bare `typefor<ServiceType>()` needs no more than the env binding itself, but
// `typefor<Func<Args, ServiceType>>()` names a type that only exists once both
// parameters are replaced — so the written type is read through the checker and
// instantiated with the call site's types, landing on the very type a hand-written
// `typefor<Func<[IBar], IGadget>>()` would have derived from.
package inlinetransform

import (
	"path/filepath"
	"strconv"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
)

// composedTypeArgs resolves every composed type argument the body's primitive
// calls spell — one that mentions a bound type parameter without being one — to
// the type it denotes at this call site, keyed by shape.
//
// THE KEY IS THE SHAPE, NOT THE NODE. Substitution deep-clones the body and a
// clone carries no source position, so the registration walk meets a node that
// can no longer be paired with the one resolved here by identity or position. Two
// type arguments of the same shape in one body denote the same type under one
// env, which is what makes the shape a sound key.
func (st *fileState) composedTypeArgs(body *ResolvedBody, env map[string]*shimchecker.Type) map[string]*shimchecker.Type {
	if len(env) == 0 {
		return nil
	}
	declared := make(map[string]bool, len(env))
	for name := range env {
		declared[name] = true
	}
	// The body is side-parsed, outside the program: its own nodes have no symbols
	// for the checker to resolve. The program's copy of the same file parses the
	// same text, so a node is found there at the position the side parse reports.
	source := st.implFiles[filepath.ToSlash(filepath.Clean(body.File))]
	if source == nil {
		return nil
	}
	var composed map[string]*shimchecker.Type
	walk(body.Body, func(n *shimast.Node) bool {
		if n.Kind != shimast.KindCallExpression {
			return false
		}
		callee := n.AsCallExpression().Expression
		if callee.Kind != shimast.KindIdentifier {
			return false
		}
		if _, ok := body.PrimitiveImports[callee.Text()]; !ok {
			return false
		}
		typeArgs := n.AsCallExpression().TypeArguments
		if typeArgs == nil {
			return false
		}
		for _, ta := range typeArgs.Nodes {
			if _, bare := env[bareTypeParamName(ta)]; bare {
				continue
			}
			names := typeParamsIn(ta, declared)
			if len(names) == 0 {
				continue
			}
			written := nodeAt(source, ta)
			if written == nil {
				continue
			}
			sources, targets := st.mapping(written, names, env)
			instantiated, ok := instantiateType(st.checker, st.checker.GetTypeFromTypeNode(written), sources, targets)
			if !ok {
				continue
			}
			if composed == nil {
				composed = map[string]*shimchecker.Type{}
			}
			composed[typeArgShape(ta)] = instantiated
		}
		return false
	})
	return composed
}

// mapping pairs each named type parameter's own type — read off its reference
// inside the written node, the only place the checker can be asked for it — with
// the type the call site bound it to.
func (st *fileState) mapping(written *shimast.Node, names []string, env map[string]*shimchecker.Type) ([]*shimchecker.Type, []*shimchecker.Type) {
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		wanted[name] = true
	}
	var sources, targets []*shimchecker.Type
	var visit func(n *shimast.Node)
	visit = func(n *shimast.Node) {
		if n == nil {
			return
		}
		if name := bareTypeParamName(n); name != "" && wanted[name] {
			delete(wanted, name)
			sources = append(sources, st.checker.GetTypeFromTypeNode(n))
			targets = append(targets, env[name])
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			visit(child)
			return false
		})
	}
	visit(written)
	if len(wanted) != 0 {
		return nil, nil
	}
	return sources, targets
}

// bareTypeParamName returns the name a type node spells when it is a plain
// reference standing on its own (`ServiceType`), or "" for anything composed —
// `Func<Args, ServiceType>` is a reference too, but to a generic type whose own
// arguments are where the parameters hide.
func bareTypeParamName(node *shimast.Node) string {
	if node == nil || node.Kind != shimast.KindTypeReference {
		return ""
	}
	ref := node.AsTypeReferenceNode()
	if ref.TypeArguments != nil {
		return ""
	}
	if ref.TypeName == nil || ref.TypeName.Kind != shimast.KindIdentifier {
		return ""
	}
	return ref.TypeName.Text()
}

// nodeAt returns the node of the same kind and span as want, or nil when the
// file's text has moved on from what the side parse read.
func nodeAt(source *shimast.SourceFile, want *shimast.Node) *shimast.Node {
	var found *shimast.Node
	var visit func(n *shimast.Node)
	visit = func(n *shimast.Node) {
		if n == nil || found != nil || n.End() < want.Pos() || n.Pos() > want.End() {
			return
		}
		if n.Kind == want.Kind && n.Pos() == want.Pos() && n.End() == want.End() {
			found = n
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			visit(child)
			return found != nil
		})
	}
	visit(source.AsNode())
	return found
}

// typeArgShape renders a type node as its structure — every kind in traversal
// order, with each identifier and literal spelled out — so the same type argument
// is recognized again after a deep clone has stripped its positions.
func typeArgShape(node *shimast.Node) string {
	var b strings.Builder
	var visit func(n *shimast.Node)
	visit = func(n *shimast.Node) {
		if n == nil {
			return
		}
		b.WriteString(strconv.Itoa(int(n.Kind)))
		switch n.Kind {
		case shimast.KindIdentifier, shimast.KindStringLiteral, shimast.KindNumericLiteral:
			b.WriteByte(':')
			b.WriteString(n.Text())
		}
		b.WriteByte('(')
		n.ForEachChild(func(child *shimast.Node) bool {
			visit(child)
			return false
		})
		b.WriteByte(')')
	}
	visit(node)
	return b.String()
}
