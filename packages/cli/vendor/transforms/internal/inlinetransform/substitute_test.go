package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// parse builds a source file AST from text via SideParse — the same side-parse
// the inliner runs against a declaring package. It routes through an ABSOLUTE
// filename: shim's parser derives a canonical Path from the filename, and a
// non-absolute name yields an empty Path that panics NewSourceFile.
func parse(t *testing.T, name, text string) *shimast.SourceFile {
	t.Helper()
	if !filepath.IsAbs(name) {
		name = "/" + name
	}
	sf := SideParse(name, text)
	if sf == nil {
		t.Fatalf("parse %s returned nil", name)
	}
	return sf
}

// reprint runs the exact emit pipeline plugin/host.go's transformFileToTypeScript
// uses: fix up parent pointers on the mixed original/synthetic tree, then print
// through a fresh TextWriter + Printer bound to the same EmitContext. This is the
// assertion surface — if substitution corrupted positions or produced an
// unprintable node shape, this panics or garbles.
func reprint(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	shimast.SetParentInChildrenUnset(sf.AsNode())
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

// findCall returns the first call expression whose callee is a property access
// naming member, along with its receiver and argument expressions.
func findCall(t *testing.T, sf *shimast.SourceFile, member string) (call, receiver *shimast.Node, args []*shimast.Node) {
	t.Helper()
	var walk func(n *shimast.Node)
	walk = func(n *shimast.Node) {
		if n == nil || call != nil {
			return
		}
		if n.Kind == shimast.KindCallExpression {
			callee := n.AsCallExpression().Expression
			if callee.Kind == shimast.KindPropertyAccessExpression && callee.Name().Text() == member {
				call = n
				receiver = callee.AsPropertyAccessExpression().Expression
				if list := n.AsCallExpression().Arguments; list != nil {
					args = list.Nodes
				}
				return
			}
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return call != nil
		})
	}
	walk(sf.AsNode())
	if call == nil {
		t.Fatalf("no call to .%s() found", member)
	}
	return call, receiver, args
}

// returnExpr returns the first return statement's expression in sf.
func returnExpr(t *testing.T, sf *shimast.SourceFile) *shimast.Node {
	t.Helper()
	var found *shimast.Node
	var walk func(n *shimast.Node)
	walk = func(n *shimast.Node) {
		if n == nil || found != nil {
			return
		}
		if n.Kind == shimast.KindReturnStatement {
			found = n.AsReturnStatement().Expression
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return found != nil
		})
	}
	walk(sf.AsNode())
	if found == nil {
		t.Fatal("no return statement found")
	}
	return found
}

// splice replaces target (matched by identity) with replacement across sf,
// returning the rewritten source file.
func splice(ec *shimprinter.EmitContext, sf *shimast.SourceFile, target, replacement *shimast.Node) *shimast.SourceFile {
	var visitor *shimast.NodeVisitor
	visit := func(node *shimast.Node) *shimast.Node {
		if node == target {
			return replacement
		}
		return visitor.VisitEachChild(node)
	}
	visitor = ec.NewNodeVisitor(visit)
	return visitor.VisitNode(sf.AsNode()).AsSourceFile()
}

// TestSubstituteInterfaceMember inlines an interface-member sugar body over a
// simple receiver with one `this` and one value parameter — the pilot shape
// (`return this.<primitive>(param)`). It asserts the reprint pipeline emits the
// substituted primitive call, drops the sugar call, leaves surrounding code
// intact, and produces output that re-parses cleanly.
func TestSubstituteInterfaceMember(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function query(key: string) {
	return this.isService(key);
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const before = 1;
const answer = reg.query(k);
const after = 2;
`)
	call, receiver, args := findCall(t, consumer, "query")

	res := Substitute(ec, Inlining{
		Body:     body,
		Receiver: receiver,
		Params:   []string{"key"},
		Args:     args,
	})
	if res.NeedsTempHoist {
		t.Fatalf("simple receiver, single `this`: expected no temp hoist")
	}

	out := reprint(ec, splice(ec, consumer, call, res.Expr))

	if !strings.Contains(out, "reg.isService(k)") {
		t.Errorf("expected inlined primitive call `reg.isService(k)`, got:\n%s", out)
	}
	if strings.Contains(out, "query") {
		t.Errorf("sugar call `.query` should be gone, got:\n%s", out)
	}
	for _, marker := range []string{"before", "after"} {
		if !strings.Contains(out, marker) {
			t.Errorf("surrounding statement %q was corrupted, got:\n%s", marker, out)
		}
	}
	// The output must be valid syntax again.
	reparsed := parse(t, "out.ts", out)
	if len(reparsed.Statements.Nodes) != 3 {
		t.Errorf("expected 3 top-level statements after reprint, got %d:\n%s", len(reparsed.Statements.Nodes), out)
	}
}

// TestSubstituteZeroThisEffectfulReceiverKeepsSideEffect drives the `this` used
// 0× with an EFFECTFUL receiver branch: the receiver's value is never read but
// its side effect must still run exactly once, so it is kept as the left of a
// comma sequence — `(makeReg(), 42)`.
func TestSubstituteZeroThisEffectfulReceiverKeepsSideEffect(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function konst() {
	return 42;
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const answer = makeReg().konst();
`)
	call, receiver, args := findCall(t, consumer, "konst")
	if isSimpleReceiver(receiver) {
		t.Fatalf("makeReg() must be classified effectful")
	}

	res := Substitute(ec, Inlining{Body: body, Receiver: receiver, Args: args})
	if res.NeedsTempHoist {
		t.Fatalf("zero-`this` receiver keeps a comma sequence, not a temp hoist")
	}
	out := reprint(ec, splice(ec, consumer, call, res.Expr))

	if !strings.Contains(out, "(makeReg(), 42)") {
		t.Errorf("effectful receiver whose value is unused must be kept in a comma sequence `(makeReg(), 42)`, got:\n%s", out)
	}
}

// TestSubstituteTwoThisSimpleReceiverDuplicates drives the `this` used ≥2× with a
// SIMPLE receiver branch: a bare identifier is side-effect-free to read, so it is
// duplicated at each `this` site rather than bound to a temp.
func TestSubstituteTwoThisSimpleReceiverDuplicates(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function chained() {
	return this.a(this.b());
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const answer = reg.chained();
`)
	call, receiver, args := findCall(t, consumer, "chained")
	if !isSimpleReceiver(receiver) {
		t.Fatalf("bare identifier `reg` must be classified simple")
	}

	res := Substitute(ec, Inlining{Body: body, Receiver: receiver, Args: args})
	if res.NeedsTempHoist {
		t.Fatalf("a simple receiver used twice must be duplicated, not hoisted to a temp")
	}
	out := reprint(ec, splice(ec, consumer, call, res.Expr))

	if n := strings.Count(out, "reg"); n != 2 {
		t.Errorf("simple receiver used twice must be duplicated to two occurrences, found %d:\n%s", n, out)
	}
}

// TestWrapForPrecedence covers the stage helper that parenthesizes a substituted
// root which is not self-delimiting: a binary-expression body (`n + n`) spliced
// into a larger context must be wrapped `(value + value)` so evaluation order is
// preserved.
func TestWrapForPrecedence(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function twice(n: number) {
	return n + n;
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const answer = wrap.twice(value);
`)
	call, _, args := findCall(t, consumer, "twice")

	res := Substitute(ec, Inlining{Body: body, Params: []string{"n"}, Args: args})
	wrapped := wrapForPrecedence(ec, res.Expr)
	out := reprint(ec, splice(ec, consumer, call, wrapped))

	if !strings.Contains(out, "(value + value)") {
		t.Errorf("a binary-expression body must be parenthesized when spliced, expected `(value + value)`, got:\n%s", out)
	}
}

// TestSubstituteFreeFunction inlines a free-function body (no receiver): only the
// value parameter is substituted.
func TestSubstituteFreeFunction(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function twice(n: number) {
	return n + n;
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const answer = wrap.twice(value);
`)
	call, _, args := findCall(t, consumer, "twice")

	res := Substitute(ec, Inlining{
		Body:   body,
		Params: []string{"n"},
		Args:   args,
	})
	out := reprint(ec, splice(ec, consumer, call, res.Expr))

	if !strings.Contains(out, "value + value") {
		t.Errorf("expected free-function body `value + value`, got:\n%s", out)
	}
	parse(t, "out.ts", out) // must re-parse without panic
}

// TestSubstituteEffectfulReceiverSingleEval drives the single-evaluation temp
// mechanism: an effectful receiver (`makeReg()`) whose body reads `this` twice.
// The receiver must run exactly once, so the mechanism binds it to a temp in
// expression position (a parenthesized comma sequence) and references the temp
// at both `this` sites. It then drives the accompanying variable-environment
// hoist so the emitted output is valid TypeScript, and asserts the reprint
// declares the temp and references it.
func TestSubstituteEffectfulReceiverSingleEval(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function combined(k: string) {
	return this.first(k) + this.second(k);
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", `
const before = 1;
const answer = makeReg().combined(k);
const after = 2;
`)
	call, receiver, args := findCall(t, consumer, "combined")
	if isSimpleReceiver(receiver) {
		t.Fatalf("makeReg() should be classified effectful (non-simple)")
	}

	res := Substitute(ec, Inlining{
		Body:     body,
		Receiver: receiver,
		Params:   []string{"k"},
		Args:     args,
	})
	if !res.NeedsTempHoist || res.Temp == nil {
		t.Fatalf("effectful receiver with two `this` uses must request a temp hoist; got NeedsTempHoist=%v temp=%v", res.NeedsTempHoist, res.Temp)
	}

	// The receiver expression must appear exactly once in the substituted output
	// (single evaluation), inside the assignment to the temp.
	rewritten := splice(ec, consumer, call, res.Expr)

	// Drive the hoist: register the temp with the enclosing variable environment
	// and prepend the resulting `var` declaration(s) so the emit is well-formed.
	ec.StartVariableEnvironment()
	ec.AddVariableDeclaration(res.Temp)
	decls := ec.EndVariableEnvironment()
	if len(decls) == 0 {
		t.Fatalf("AddVariableDeclaration produced no hoisted statements")
	}
	factory := ec.Factory.AsNodeFactory()
	merged := append(append([]*shimast.Node{}, decls...), rewritten.Statements.Nodes...)
	withHoist := factory.UpdateSourceFile(rewritten, factory.NewNodeList(merged), rewritten.EndOfFileToken).AsSourceFile()

	out := reprint(ec, withHoist)

	if strings.Count(out, "makeReg()") != 1 {
		t.Errorf("receiver `makeReg()` must be evaluated exactly once, found %d occurrences:\n%s", strings.Count(out, "makeReg()"), out)
	}
	if !strings.Contains(out, "var ") {
		t.Errorf("expected a hoisted `var` temp declaration, got:\n%s", out)
	}
	if !strings.Contains(out, ".first(k)") || !strings.Contains(out, ".second(k)") {
		t.Errorf("expected both primitive calls inlined, got:\n%s", out)
	}
	for _, marker := range []string{"before", "after"} {
		if !strings.Contains(out, marker) {
			t.Errorf("surrounding statement %q was corrupted, got:\n%s", marker, out)
		}
	}
	// Valid syntax again: before + var-hoist + two consts + after.
	reparsed := parse(t, "out.ts", out)
	if len(reparsed.Statements.Nodes) == 0 {
		t.Errorf("reprint produced no statements:\n%s", out)
	}
}

// Every parameter is named, so a call that stops short has omitted the optional
// tail: those names reach Substitute as unbound and their argument-position
// references drop out, leaving exactly the call a hand author would have
// written. Driven at all arities, because the interesting boundaries are "one"
// and "none".
func TestSubstituteOmittedArgumentsDropOut(t *testing.T) {
	params := []string{"ctor", "signatures", "scope"}
	cases := []struct {
		name string
		call string
		want string
	}{
		{"every argument supplied", `reg.addClass(Foo, sigs, scope);`, `reg.register(tok, Foo, sigs, scope)`},
		{"the optional tail omitted", `reg.addClass(Foo, sigs);`, `reg.register(tok, Foo, sigs)`},
		{"a single argument", `reg.addClass(Foo);`, `reg.register(tok, Foo)`},
		{"no arguments at all", `reg.addClass();`, `reg.register(tok)`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ec := shimprinter.NewEmitContext()

			decl := parse(t, "declaring.ts", `
export function addClass(ctor, signatures, scope) {
	return this.register(tok, ctor, signatures, scope);
}
`)
			body := returnExpr(t, decl)

			consumer := parse(t, "consumer.ts", "const answer = "+c.call+"\n")
			call, receiver, args := findCall(t, consumer, "addClass")

			res := Substitute(ec, Inlining{
				Body:     body,
				Receiver: receiver,
				Params:   params,
				Args:     args,
				Unbound:  params[len(args):],
			})

			out := reprint(ec, splice(ec, consumer, call, res.Expr))
			if !strings.Contains(out, c.want) {
				t.Errorf("expected %q, got:\n%s", c.want, out)
			}
			for _, name := range params[len(args):] {
				if strings.Contains(out, name) {
					t.Errorf("the omitted parameter %q must not survive substitution, got:\n%s", name, out)
				}
			}
		})
	}
}

// An omission can only be honored at the tail. A body that reads an omitted
// parameter ahead of one the call did supply leaves the name standing, and
// danglingParam is what turns that into a loud diagnostic rather than emitted
// code referencing a binding that does not exist.
func TestDanglingParamFindsANonTrailingOmission(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function addClass(scope, ctor) {
	return this.register(ctor, scope);
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", "const answer = reg.addClass(here);\n")
	_, receiver, args := findCall(t, consumer, "addClass")

	params := []string{"scope", "ctor"}
	in := Inlining{Body: body, Receiver: receiver, Params: params, Args: args, Unbound: params[len(args):]}
	res := Substitute(ec, in)

	if got := danglingParam(res.Expr, in.unbound()); got != "ctor" {
		t.Errorf("danglingParam = %q, want %q", got, "ctor")
	}
}

// A `this` behind a nested non-arrow function belongs to that function's own
// scope and must survive substitution untouched, while an arrow inherits the
// enclosing `this` and is substituted. The two substitutable sites sit on a
// simple receiver, so they duplicate without a temp.
func TestSubstituteStopsAtOwnThisBoundaries(t *testing.T) {
	ec := shimprinter.NewEmitContext()

	decl := parse(t, "declaring.ts", `
export function wire() {
	return this.use(() => this.tag, function () { return this.tag; });
}
`)
	body := returnExpr(t, decl)

	consumer := parse(t, "consumer.ts", "const answer = reg.wire();\n")
	call, receiver, args := findCall(t, consumer, "wire")

	res := Substitute(ec, Inlining{Body: body, Receiver: receiver, Args: args})
	if res.NeedsTempHoist {
		t.Fatalf("simple receiver must duplicate, not hoist a temp")
	}

	out := reprint(ec, splice(ec, consumer, call, res.Expr))
	if !strings.Contains(out, "reg.use(") {
		t.Errorf("outer `this` must become the receiver, got:\n%s", out)
	}
	if !strings.Contains(out, "=> reg.tag") {
		t.Errorf("an arrow's `this` inherits the inline site and must be substituted, got:\n%s", out)
	}
	if !strings.Contains(out, "this.tag") {
		t.Errorf("a nested function's own `this` must survive untouched, got:\n%s", out)
	}
}
