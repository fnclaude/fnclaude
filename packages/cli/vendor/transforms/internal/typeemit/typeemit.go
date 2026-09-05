// Package typeemit builds the `Type.*` factory-call expressions a lowered
// primitive leaves behind — the runtime spelling of a derived type, identical to
// what an author would have written by hand.
//
// Every primitive that emits a Type tree shares this vocabulary, so a node spells
// the same whichever primitive produced it: `string` is always
// `Type.global("string")`, an `Array<T>` always carries its element as a single
// generic argument, a literal always its own scalar expression.
//
// The `Type` object is referenced through a valueimport.Binding, so an
// existing (possibly aliased) import in the consuming file is honored and a fresh
// one is injected only when at least one call was emitted.
package typeemit

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/tokens"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
	"github.com/fnioc/std/transforms/internal/valueimport"
)

// Ref identifies the runtime `Type` object every emitted factory call
// reaches through.
var Ref = valueimport.Ref{Module: "@rhombus-std/primitives", Export: "Type"}

// GlobalFrom is the FROM a derived name carries when the ambient scope declares
// it. Such a type is reached by no import, so it spells as `Type.global`.
const GlobalFrom = "global"

// HoistRef is Ref in the const table's own reference form, so a table of hoisted
// consts and the call sites referencing them name one `Type`.
func HoistRef() typeforhoist.TypeRef {
	return typeforhoist.TypeRef{Module: Ref.Module, Export: Ref.Export}
}

// Call builds `<Type>.<method>(...args)`, marking binding as referenced so the
// caller knows to materialize its import.
func Call(f *shimast.NodeFactory, binding *valueimport.Binding, method string, args []*shimast.Node) *shimast.Node {
	binding.Used = true
	callee := f.NewPropertyAccessExpression(binding.Expr(f), nil, f.NewIdentifier(method), 0)
	return f.NewCallExpression(callee, nil, nil, f.NewNodeList(args), 0)
}

// EmitNode builds the `Type.*` factory-call expression a derived node spells,
// recursing into each kind's children — a named type's arguments, a callable's
// head and signatures, a tag's inner type, a composite's members, an object's
// property types.
func EmitNode(f *shimast.NodeFactory, binding *valueimport.Binding, n *tokens.Node) *shimast.Node {
	switch n.Kind {
	case tokens.KindLiteral:
		return LiteralNode(f, binding, n.Literal)
	case tokens.KindGeneric:
		return Call(f, binding, "generic", []*shimast.Node{f.NewStringLiteral(n.Label, shimast.TokenFlagsNone)})
	case tokens.KindTag:
		return Call(f, binding, "tag", []*shimast.Node{
			EmitNode(f, binding, n.Inner),
			f.NewStringLiteral(n.Tag, shimast.TokenFlagsNone),
		})
	case tokens.KindFunc:
		return signatureShaped(f, binding, n, "func")
	case tokens.KindCtor:
		return signatureShaped(f, binding, n, "ctor")
	case tokens.KindAbstractCtor:
		return signatureShaped(f, binding, n, "abstractCtor")
	case tokens.KindUnion:
		return Call(f, binding, "union", emitMembers(f, binding, n.Members))
	case tokens.KindTuple:
		return emitTuple(f, binding, n)
	case tokens.KindIntersection:
		return Call(f, binding, "intersection", emitMembers(f, binding, n.Members))
	case tokens.KindObject:
		return emitObject(f, binding, n)
	default: // tokens.KindNamed
		args := make([]*shimast.Node, 0, len(n.Args))
		for _, a := range n.Args {
			args = append(args, EmitNode(f, binding, a))
		}
		return Named(f, binding, n.Name, n.From, args)
	}
}

// emitMembers builds the factory call for each member of a composite, in order.
func emitMembers(f *shimast.NodeFactory, binding *valueimport.Binding, members []*tokens.Node) []*shimast.Node {
	out := make([]*shimast.Node, 0, len(members))
	for _, m := range members {
		out = append(out, EmitNode(f, binding, m))
	}
	return out
}

// emitTuple builds a tuple's factory call: the plain `Type.tuple(...members)`
// a fixed-length tuple spells, or — when it carries a rest slot — the spec form
// `Type.tuple({ members: [...], rest })` that alone can state one.
func emitTuple(f *shimast.NodeFactory, binding *valueimport.Binding, n *tokens.Node) *shimast.Node {
	if n.TupleRest == nil {
		return Call(f, binding, "tuple", emitMembers(f, binding, n.Members))
	}
	spec := f.NewObjectLiteralExpression(f.NewNodeList([]*shimast.Node{
		f.NewPropertyAssignment(nil, PropertyKey(f, "members"), nil, nil, f.NewArrayLiteralExpression(f.NewNodeList(emitMembers(f, binding, n.Members)), false)),
		f.NewPropertyAssignment(nil, PropertyKey(f, "rest"), nil, nil, EmitNode(f, binding, n.TupleRest)),
	}), false)
	return Call(f, binding, "tuple", []*shimast.Node{spec})
}

// emitObject builds `Type.object({ key: <member>, ... })`, each member keyed by
// its property name in declaration order.
func emitObject(f *shimast.NodeFactory, binding *valueimport.Binding, n *tokens.Node) *shimast.Node {
	members := make([]*shimast.Node, 0, len(n.Properties))
	for _, property := range n.Properties {
		value := EmitNode(f, binding, property.Type)
		members = append(members, f.NewPropertyAssignment(nil, PropertyKey(f, property.Key), nil, nil, value))
	}
	return Call(f, binding, "object", []*shimast.Node{
		f.NewObjectLiteralExpression(f.NewNodeList(members), false),
	})
}

// signatureShaped builds a callable's factory call — the return/instance type
// followed by its signatures. When every signature is a fixed argument list the
// rows spelling is used — `func(returns, [[…], […]])` — the same text a hand
// author writes; a signature carrying an open length takes the slot node's own
// spelling instead, since a rows array cannot state one.
func signatureShaped(f *shimast.NodeFactory, binding *valueimport.Binding, n *tokens.Node, method string) *shimast.Node {
	slot := EmitNode(f, binding, n.Sig)
	if rows, fixed := fixedRows(n.Sig); fixed {
		items := make([]*shimast.Node, 0, len(rows))
		for _, row := range rows {
			items = append(items, f.NewArrayLiteralExpression(f.NewNodeList(emitMembers(f, binding, row)), false))
		}
		slot = f.NewArrayLiteralExpression(f.NewNodeList(items), false)
	}
	return Call(f, binding, method, []*shimast.Node{
		EmitNode(f, binding, n.Ret),
		slot,
	})
}

// fixedRows reads a signatures slot back as fixed parameter rows — ok=false
// when any signature carries an open length (a rest slot, or a row that IS a
// list), which the rows spelling cannot state.
func fixedRows(sig *tokens.Node) ([][]*tokens.Node, bool) {
	rowNodes := signatureRowNodes(sig)
	rows := make([][]*tokens.Node, 0, len(rowNodes))
	for _, row := range rowNodes {
		if row.Kind != tokens.KindTuple || row.TupleRest != nil {
			return nil, false
		}
		rows = append(rows, row.Members)
	}
	return rows, true
}

// signatureRowNodes is a signatures slot's per-overload rows, in stored order:
// a union's members, or the lone row itself.
func signatureRowNodes(sig *tokens.Node) []*tokens.Node {
	if sig.Kind == tokens.KindUnion {
		return sig.Members
	}
	return []*tokens.Node{sig}
}

// Named builds the factory call a name-addressed type spells: `Type.global(name)`
// when the ambient scope declares it, `Type.imported(name, from)` when an import
// reaches it, each followed by its generic arguments as one array when it has any.
func Named(f *shimast.NodeFactory, binding *valueimport.Binding, name, from string, args []*shimast.Node) *shimast.Node {
	method := "global"
	callArgs := []*shimast.Node{f.NewStringLiteral(name, shimast.TokenFlagsNone)}
	if from != GlobalFrom {
		method = "imported"
		callArgs = append(callArgs, f.NewStringLiteral(from, shimast.TokenFlagsNone))
	}
	if len(args) != 0 {
		callArgs = append(callArgs, f.NewArrayLiteralExpression(f.NewNodeList(args), false))
	}
	return Call(f, binding, method, callArgs)
}

// LiteralNode builds a literal type's factory call: the two nullish singletons as
// `Type.typeLiteral(undefined)` / `Type.typeLiteral(null)`, every scalar literal as
// `Type.typeLiteral(<value>)`.
func LiteralNode(f *shimast.NodeFactory, binding *valueimport.Binding, v tokens.LiteralValue) *shimast.Node {
	switch v.Kind {
	case tokens.LiteralUndefined:
		return Undefined(f, binding)
	case tokens.LiteralNull:
		return Call(f, binding, "typeLiteral", []*shimast.Node{f.NewKeywordExpression(shimast.KindNullKeyword)})
	default:
		return Call(f, binding, "typeLiteral", []*shimast.Node{Literal(f, v)})
	}
}

// Literal renders a scalar literal value as its TS literal expression — a string /
// boolean keyword, a numeric / bigint literal (negative rendered as a unary minus
// over the magnitude). The nullish singletons are spelled by LiteralNode instead,
// so those two LiteralKind cases have no branch here.
func Literal(f *shimast.NodeFactory, v tokens.LiteralValue) *shimast.Node {
	switch v.Kind {
	case tokens.LiteralString:
		return f.NewStringLiteral(v.Str, shimast.TokenFlagsNone)
	case tokens.LiteralBoolean:
		if v.Bool {
			return f.NewKeywordExpression(shimast.KindTrueKeyword)
		}
		return f.NewKeywordExpression(shimast.KindFalseKeyword)
	case tokens.LiteralBigInt:
		lit := f.NewBigIntLiteral(v.Text+"n", shimast.TokenFlagsNone)
		if v.Negated {
			return f.NewPrefixUnaryExpression(shimast.KindMinusToken, lit)
		}
		return lit
	default: // LiteralNumber
		lit := f.NewNumericLiteral(v.Text, shimast.TokenFlagsNone)
		if v.Negated {
			return f.NewPrefixUnaryExpression(shimast.KindMinusToken, lit)
		}
		return lit
	}
}

// Undefined is the `undefined` literal type's factory call — the member an
// optional slot carries beside its own type.
func Undefined(f *shimast.NodeFactory, binding *valueimport.Binding) *shimast.Node {
	return Call(f, binding, "typeLiteral", []*shimast.Node{f.NewIdentifier("undefined")})
}

// PropertyKey builds an object member's key node preserving its exact casing,
// over the same identifier test the string renderer spells its keys with: a bare
// identifier when the name is a valid JS identifier, else a string literal.
func PropertyKey(f *shimast.NodeFactory, name string) *shimast.Node {
	if typeforhoist.IsIdentifier(name) {
		return f.NewIdentifier(name)
	}
	return f.NewStringLiteral(name, shimast.TokenFlagsNone)
}
