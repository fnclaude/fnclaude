// Package inlinetransform is the generic single-expression function-inlining
// stage: at a consumer call site it substitutes an inlineable declaration's
// single-return-expression body in place of the call, binding `this` to the
// call's receiver and each value parameter to its argument expression. The
// downstream primitive stages (typefor, schemaof) then lower the substituted
// result. It runs FIRST in ttsc-std's canonical stage order.
//
// This file owns the substitution mechanism only — turning a (body, receiver,
// args) triple into one rewritten expression node, with single-evaluation of an
// effectful receiver realized as a temp binding in expression position. Matching
// call sites to inline entries and side-parsing bodies out of a declaring
// package live in sibling files (matcher.go / sideparse.go).
package inlinetransform

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// Inlining is the fully-resolved substitution plan for one call site. Body is a
// clone-safe reference to the impl's single return expression (the side-parser
// hands it over; Substitute deep-clones before mutating, so the same Body node
// may drive many call sites). Receiver is `x` in `x.member(...)` — nil for a
// free-function inline. Params are the impl's value-parameter names in order,
// paired positionally with Args, the call's argument expressions.
type Inlining struct {
	Body     *shimast.Node
	Receiver *shimast.Node
	Params   []string
	Args     []*shimast.Node
	// Unbound names the implementation's value parameters the call supplied no
	// argument for. Each stands for an argument that was never written, so an
	// argument-position reference to one is dropped rather than emitted as a
	// dangling identifier.
	Unbound []string
	// Bindings rewrites body identifiers that are not parameters — a value the body
	// reaches through its own file's import, mapped to the way the CONSUMER file
	// names that same export. Keyed by name rather than position, since these bind
	// to nothing in the call's argument list.
	Bindings map[string]*shimast.Node
	// Groups maps a splice token to the argument expressions it stands for, in
	// call order: the impl's trailing rest parameter holds the arguments past the
	// named ones, and `arguments` holds the whole set. A spread of either inside a
	// call's argument list splices the group's members in place; an empty group
	// splices nothing.
	Groups map[string][]*shimast.Node
}

// Result is Substitute's output. Expr is the rewritten expression to splice in
// for the call. When NeedsTempHoist is set the mechanism introduced a
// single-evaluation temp (Temp); the CALLER must register that identifier with
// the enclosing variable environment — `ec.AddVariableDeclaration(res.Temp)`
// between a `StartVariableEnvironment`/`EndAndMergeVariableEnvironment` pair
// wrapping the containing function body — so a `var _a;` declaration is emitted.
// Expr already references the temp; without the hoist the emitted temp name is
// undeclared.
type Result struct {
	Expr           *shimast.Node
	Temp           *shimast.Node
	NeedsTempHoist bool
}

// Substitute produces the inlined expression for one call site.
//
// The single-evaluation contract (receiver evaluated exactly once, per the
// authoring discipline) is met by counting `this` occurrences in the body and
// picking the cheapest correct shape:
//
//   - `this` used 0×, effectful receiver  → `(receiver, body)`      — keep the
//     receiver's side effect, discard its value.
//   - `this` used 0×, simple receiver     → `body`                  — a bare
//     identifier/`this` reference has no effect worth keeping.
//   - `this` used 1×                       → receiver inlined at the one site;
//     already single-eval, no temp.
//   - `this` used ≥2×, simple receiver     → receiver duplicated at each site;
//     duplicating an identifier/`this` reference is side-effect-free.
//   - `this` used ≥2×, effectful receiver  → `(_a = receiver, body[this→_a])`
//     — a temp bound once in expression position (comma sequence), so the
//     receiver runs exactly once. NeedsTempHoist is set.
//
// "Simple" is deliberately narrow: only a bare identifier or `this` is safe to
// duplicate. A property access `x.y` is treated as effectful because reading it
// can trigger a getter, and the contract forbids running that getter twice.
func Substitute(ec *shimprinter.EmitContext, in Inlining) Result {
	factory := ec.Factory.AsNodeFactory()
	body := normalizeCallForms(ec, factory.DeepCloneNode(in.Body))

	u := in.unbound()
	params := map[string]*shimast.Node{}
	for i, name := range in.Params {
		if i < len(in.Args) {
			params[name] = in.Args[i]
		}
	}
	for name, node := range in.Bindings {
		params[name] = node
	}

	if in.Receiver == nil {
		// Free function: only value parameters are substituted.
		return Result{Expr: substituteInto(ec, body, params, nil, u, in.Groups)}
	}

	receiverCount := countThis(body)
	simple := isSimpleReceiver(in.Receiver)

	if receiverCount >= 2 && !simple {
		// Effectful receiver used more than once: bind it once to a temp in
		// expression position and reference the temp at every `this` site.
		temp := ec.Factory.NewTempVariable()
		substituted := substituteInto(ec, body, params, temp, u, in.Groups)
		assign := factory.NewBinaryExpression(
			nil,
			temp,
			nil,
			factory.NewToken(shimast.KindEqualsToken),
			factory.DeepCloneNode(in.Receiver),
		)
		sequence := factory.NewBinaryExpression(
			nil,
			assign,
			nil,
			factory.NewToken(shimast.KindCommaToken),
			substituted,
		)
		return Result{
			Expr:           factory.NewParenthesizedExpression(sequence),
			Temp:           temp,
			NeedsTempHoist: true,
		}
	}

	if receiverCount == 0 && !simple {
		// Receiver's value is never read, but its side effect must still run
		// exactly once. Keep it as the left of a comma sequence.
		substituted := substituteInto(ec, body, params, nil, u, in.Groups)
		sequence := factory.NewBinaryExpression(
			nil,
			factory.DeepCloneNode(in.Receiver),
			nil,
			factory.NewToken(shimast.KindCommaToken),
			substituted,
		)
		return Result{Expr: factory.NewParenthesizedExpression(sequence)}
	}

	// Receiver read 0× (simple), 1× (any), or ≥2× (simple): inline a fresh clone
	// of it at each site. thisRepl == nil below means "clone the receiver"; a
	// non-nil node (the temp branch above) means "reference it".
	return Result{Expr: substituteIntoReceiver(ec, body, params, in.Receiver, u, in.Groups)}
}

// substituteInto rewrites body in place of a clone: every `this` becomes temp
// (when non-nil), every value-parameter identifier becomes its argument
// expression. Property-access member names are left untouched so a body member
// that happens to share a parameter's name is never rewritten.
func substituteInto(ec *shimprinter.EmitContext, body *shimast.Node, params map[string]*shimast.Node, temp *shimast.Node, u unbound, groups map[string][]*shimast.Node) *shimast.Node {
	return rewrite(ec, body, params, func() *shimast.Node { return temp }, u, groups)
}

// substituteIntoReceiver is substituteInto with the ORIGINAL receiver node
// spliced at the first `this` site and fresh clones at any further sites. The
// original is program-bound, so downstream stages that checker-query the
// receiver get an answerable node; the extra clones are bare and nothing
// downstream queries them (a duplicated `this` site only ever holds a simple,
// side-effect-free receiver by the effectful ≥2× path being handled separately).
func substituteIntoReceiver(ec *shimprinter.EmitContext, body *shimast.Node, params map[string]*shimast.Node, receiver *shimast.Node, u unbound, groups map[string][]*shimast.Node) *shimast.Node {
	factory := ec.Factory.AsNodeFactory()
	first := true
	return rewrite(ec, body, params, func() *shimast.Node {
		if first {
			first = false
			return receiver
		}
		return factory.DeepCloneNode(receiver)
	}, u, groups)
}

// unbound is the set of value parameters the call supplied no argument for.
type unbound map[string]bool

// unbound reads Unbound as a set.
func (in Inlining) unbound() unbound {
	u := unbound{}
	for _, name := range in.Unbound {
		u[name] = true
	}
	return u
}

// visitArguments walks an argument list, then drops the trailing run of
// arguments that are bare references to unbound parameters: an optional
// parameter the call omitted contributes no argument to the emitted call, which
// is what a hand author would have written. Only a TRAILING run can go — a gap
// ahead of a supplied argument would shift every later argument's position, so a
// reference left standing after the trim is reported by danglingParam instead.
// It reports whether any element changed, so an untouched list keeps its
// original node.
func (u unbound) visitArguments(visitor *shimast.NodeVisitor, args []*shimast.Node) ([]*shimast.Node, bool) {
	out := make([]*shimast.Node, 0, len(args))
	changed := false
	for _, arg := range args {
		visited := visitor.VisitNode(arg)
		if visited != arg {
			changed = true
		}
		out = append(out, visited)
	}
	for len(out) > 0 && u.names(out[len(out)-1]) {
		out = out[:len(out)-1]
		changed = true
	}
	return out, changed
}

// names reports whether node is a bare reference to an unbound parameter.
func (u unbound) names(node *shimast.Node) bool {
	return node != nil && node.Kind == shimast.KindIdentifier && u[node.Text()]
}

// danglingParam returns the name of an unbound parameter still referenced in a
// substituted expression, or "". One surviving the trim means the body used it
// somewhere the omission cannot be honored — ahead of an argument the call did
// supply, or outside an argument list altogether — and the emitted code would
// reference a binding that does not exist.
func danglingParam(node *shimast.Node, u unbound) string {
	found := ""
	var walkNode func(n *shimast.Node)
	walkNode = func(n *shimast.Node) {
		if n == nil || found != "" {
			return
		}
		if u.names(n) {
			found = n.Text()
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walkNode(child)
			return false
		})
	}
	walkNode(node)
	return found
}

// rewrite walks body substituting `this` (via thisNode, called once per site so
// each site can get its own clone) and value-parameter identifiers (via params).
// It descends manually through property-access objects so the member name — an
// identifier that is NOT a value reference — is preserved verbatim. A `this`
// inside a nested non-arrow function or class is that scope's own receiver, so
// substitution stops at those boundaries; value parameters are still rewritten
// there, since a closure captures them like any other outer binding. A spread
// of a group token (a trailing rest, or `arguments`) inside a call's argument
// list splices the group's members in place — `arguments` stops at the same
// boundaries `this` does, since a nested non-arrow function owns its own.
func rewrite(ec *shimprinter.EmitContext, body *shimast.Node, params map[string]*shimast.Node, thisNode func() *shimast.Node, u unbound, groups map[string][]*shimast.Node) *shimast.Node {
	factory := ec.Factory.AsNodeFactory()
	var visitor *shimast.NodeVisitor
	ownThisDepth := 0
	spliceGroup := func(node *shimast.Node) ([]*shimast.Node, bool) {
		if node.Kind != shimast.KindSpreadElement {
			return nil, false
		}
		expr := node.AsSpreadElement().Expression
		if expr == nil || expr.Kind != shimast.KindIdentifier {
			return nil, false
		}
		name := expr.Text()
		if name == "arguments" && ownThisDepth > 0 {
			return nil, false
		}
		group, ok := groups[name]
		return group, ok
	}
	visit := func(node *shimast.Node) *shimast.Node {
		if node == nil {
			return nil
		}
		if establishesThis(node) {
			ownThisDepth++
			result := visitor.VisitEachChild(node)
			ownThisDepth--
			return result
		}
		switch node.Kind {
		case shimast.KindThisKeyword:
			if ownThisDepth > 0 {
				return node
			}
			if repl := thisNode(); repl != nil {
				return repl
			}
			return node
		case shimast.KindIdentifier:
			if arg, ok := params[node.Text()]; ok {
				// Splice the ORIGINAL argument node (same pointer at every site):
				// positioned nodes print from source text, so reuse is print-safe,
				// and checker queries hit the one real binding. The authoring lint
				// bounds a value param to at most one runtime-position occurrence;
				// primitive-position occurrences may repeat and deliberately alias.
				return arg
			}
			return node
		case shimast.KindPropertyAccessExpression:
			access := node.AsPropertyAccessExpression()
			newObject := visitor.VisitNode(access.Expression)
			if newObject == access.Expression {
				return node
			}
			return factory.NewPropertyAccessExpression(newObject, access.QuestionDotToken, access.Name(), 0)
		case shimast.KindCallExpression:
			call := node.AsCallExpression()
			if call.Arguments == nil {
				break
			}
			newCallee := visitor.VisitNode(call.Expression)
			expanded := make([]*shimast.Node, 0, len(call.Arguments.Nodes))
			spliced := false
			for _, arg := range call.Arguments.Nodes {
				if group, ok := spliceGroup(arg); ok {
					expanded = append(expanded, group...)
					spliced = true
					continue
				}
				expanded = append(expanded, arg)
			}
			args, changed := u.visitArguments(visitor, expanded)
			if !spliced && !changed && newCallee == call.Expression {
				return node
			}
			return factory.NewCallExpression(newCallee, call.QuestionDotToken, nil, factory.NewNodeList(args), 0)
		}
		return visitor.VisitEachChild(node)
	}
	visitor = ec.NewNodeVisitor(visit)
	return visitor.VisitNode(body)
}

// normalizeCallForms rewrites the two call spellings a body may forward through
// into the direct call a hand author writes, ahead of receiver counting so the
// receiver is written exactly once:
//
//   - `x.m.apply(this, [ …elements ])` — the array literal collapses into the
//     argument list (an `as` annotation on it is dropped) and the call becomes
//     `x.m(…elements)`;
//   - `(x.m as any)(…)` — the assertion and its parentheses drop, leaving
//     `x.m(…)`.
func normalizeCallForms(ec *shimprinter.EmitContext, body *shimast.Node) *shimast.Node {
	factory := ec.Factory.AsNodeFactory()
	var visitor *shimast.NodeVisitor
	visit := func(node *shimast.Node) *shimast.Node {
		if node == nil {
			return nil
		}
		if node.Kind != shimast.KindCallExpression {
			return visitor.VisitEachChild(node)
		}
		call := node.AsCallExpression()
		callee := unwrapExpression(call.Expression)
		if method, elements, ok := applyForm(callee, call); ok {
			visited := make([]*shimast.Node, 0, len(elements))
			for _, el := range elements {
				visited = append(visited, visitor.VisitNode(el))
			}
			return factory.NewCallExpression(method, nil, call.TypeArguments, factory.NewNodeList(visited), 0)
		}
		if callee != call.Expression {
			newCallee := visitor.VisitNode(callee)
			var args []*shimast.Node
			if call.Arguments != nil {
				for _, arg := range call.Arguments.Nodes {
					args = append(args, visitor.VisitNode(arg))
				}
			}
			return factory.NewCallExpression(newCallee, call.QuestionDotToken, call.TypeArguments, factory.NewNodeList(args), 0)
		}
		return visitor.VisitEachChild(node)
	}
	visitor = ec.NewNodeVisitor(visit)
	return visitor.VisitNode(body)
}

// applyForm recognizes `x.m.apply(this, [ …elements ])`: a call whose callee is
// a property access named `apply` over the method access, whose first argument
// is `this`, and whose second is an array literal (an `as` annotation
// unwrapped). It returns the method access and the array's elements.
func applyForm(callee *shimast.Node, call *shimast.CallExpression) (*shimast.Node, []*shimast.Node, bool) {
	if callee.Kind != shimast.KindPropertyAccessExpression {
		return nil, nil, false
	}
	access := callee.AsPropertyAccessExpression()
	if access.Name() == nil || access.Name().Text() != "apply" {
		return nil, nil, false
	}
	method := unwrapExpression(access.Expression)
	if method.Kind != shimast.KindPropertyAccessExpression {
		return nil, nil, false
	}
	if call.Arguments == nil || len(call.Arguments.Nodes) != 2 {
		return nil, nil, false
	}
	if call.Arguments.Nodes[0].Kind != shimast.KindThisKeyword {
		return nil, nil, false
	}
	array := unwrapExpression(call.Arguments.Nodes[1])
	if array.Kind != shimast.KindArrayLiteralExpression {
		return nil, nil, false
	}
	return method, array.AsArrayLiteralExpression().Elements.Nodes, true
}

// countThis reports how many substitutable `this` keywords appear in node —
// the same sites rewrite replaces, so the two agree on the receiver's use
// count. A `this` behind a nested non-arrow function or class boundary belongs
// to that scope and is not counted.
func countThis(node *shimast.Node) int {
	count := 0
	var walk func(n *shimast.Node)
	walk = func(n *shimast.Node) {
		if n == nil || establishesThis(n) {
			return
		}
		if n.Kind == shimast.KindThisKeyword {
			count++
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(node)
	return count
}

// establishesThis reports whether node introduces its own `this` scope — a
// non-arrow function, method, accessor, constructor, class, or class static
// block. Arrows inherit the enclosing `this` and are never boundaries.
func establishesThis(node *shimast.Node) bool {
	switch node.Kind {
	case shimast.KindFunctionExpression,
		shimast.KindFunctionDeclaration,
		shimast.KindMethodDeclaration,
		shimast.KindGetAccessor,
		shimast.KindSetAccessor,
		shimast.KindConstructor,
		shimast.KindClassDeclaration,
		shimast.KindClassExpression,
		shimast.KindClassStaticBlockDeclaration:
		return true
	}
	return false
}

// isSimpleReceiver reports whether a receiver expression may be duplicated
// without changing behavior — true only for a bare identifier or `this`.
func isSimpleReceiver(node *shimast.Node) bool {
	return node.Kind == shimast.KindIdentifier || node.Kind == shimast.KindThisKeyword
}
