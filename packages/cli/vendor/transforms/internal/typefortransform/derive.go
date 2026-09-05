package typefortransform

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// emitter turns a derived tree into the expression that replaces a matched
// typefor call. inlineEmitter spells the whole `Type.*` tree at the call site;
// hoistEmitter references one const per distinct type and leaves the trees in
// the project's generated module. node returns nil when the emission failed —
// the emitter has already reported why, and the caller leaves the original node
// alone.
type emitter interface {
	node(n *tokens.Node) *shimast.Node
}

// inlineEmitter spells a derived tree as the `Type.*` factory calls themselves,
// at the call site.
type inlineEmitter struct {
	factory *shimast.NodeFactory
	binding *valueimport.Binding
}

func (e *inlineEmitter) node(n *tokens.Node) *shimast.Node {
	return typeemit.EmitNode(e.factory, e.binding, n)
}

// emitAccessor projects a TypeBase member name onto a derived node, returning the
// AST expression the property access folds to and applies=true — or applies=false
// when the member does not exist on this node's kind, so the caller reports the
// mismatch rather than silently producing nothing.
func emitAccessor(f *shimast.NodeFactory, e emitter, n *tokens.Node, accessor string) (*shimast.Node, bool) {
	switch accessor {
	case "kind":
		return f.NewStringLiteral(tokens.KindName(n), shimast.TokenFlagsNone), true
	case "return":
		if n.Kind != tokens.KindFunc {
			return nil, false
		}
		return e.node(n.Ret), true
	case "instance":
		if n.Kind != tokens.KindCtor && n.Kind != tokens.KindAbstractCtor {
			return nil, false
		}
		return e.node(n.Ret), true
	case "signatures":
		if n.Kind != tokens.KindFunc && n.Kind != tokens.KindCtor && n.Kind != tokens.KindAbstractCtor {
			return nil, false
		}
		slot := e.node(n.Sig)
		if slot == nil {
			return nil, true
		}
		return slot, true
	case "tag":
		if n.Kind != tokens.KindTag {
			return nil, false
		}
		return f.NewStringLiteral(n.Tag, shimast.TokenFlagsNone), true
	case "type":
		if n.Kind != tokens.KindTag {
			return nil, false
		}
		return e.node(n.Inner), true
	case "value":
		if n.Kind != tokens.KindLiteral || n.Literal.Kind == tokens.LiteralNull || n.Literal.Kind == tokens.LiteralUndefined {
			return nil, false
		}
		return typeemit.Literal(f, n.Literal), true
	default:
		return nil, false
	}
}
