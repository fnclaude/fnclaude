package plugin

import (
	"path/filepath"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimparser "github.com/microsoft/typescript-go/shim/parser"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	shimtspath "github.com/microsoft/typescript-go/shim/tspath"
)

// parse builds a standalone source file for the cases below. Syntax only: the
// anchor never consults a checker, it walks emit-context Original links.
func parse(t *testing.T, fileName, text string) *shimast.SourceFile {
	t.Helper()
	sf := shimparser.ParseSourceFile(
		shimast.SourceFileParseOptions{
			FileName: fileName,
			Path:     shimtspath.ToPath(fileName, filepath.Dir(fileName), true),
		},
		text,
		shimcore.ScriptKindTS,
	)
	if sf == nil {
		t.Fatalf("ParseSourceFile(%s) returned nil", fileName)
	}
	shimast.SetParentInChildrenUnset(sf.AsNode())
	return sf
}

// firstCall returns the first call expression in sf.
func firstCall(t *testing.T, sf *shimast.SourceFile) *shimast.Node {
	t.Helper()
	var found *shimast.Node
	var walk func(n *shimast.Node)
	walk = func(n *shimast.Node) {
		if n == nil || found != nil {
			return
		}
		if n.Kind == shimast.KindCallExpression {
			found = n
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return found != nil
		})
	}
	walk(sf.AsNode())
	if found == nil {
		t.Fatal("no call expression found")
	}
	return found
}

// TestAnchorIsIdentityOnAParseNode: a pristine node is its own anchor, so a
// first-pass matcher behaves exactly as it did before anchoring.
func TestAnchorIsIdentityOnAParseNode(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	sf := parse(t, "/app.ts", "typefor(Foo);\n")
	call := firstCall(t, sf)

	if got := NewCheckerAnchor(ec, sf)(call); got != call {
		t.Fatalf("anchor(parse node) = %v, want the node itself", got)
	}
}

// TestAnchorRejectsAMintedNode: a node built through the emit factory carries the
// synthesized flag and no Original link, so it has no anchor. This is the shape a
// stage produces when it rebuilds a call from scratch (factory.New*), and the
// matcher must skip it rather than hand the checker a node the binder never saw.
func TestAnchorRejectsAMintedNode(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	sf := parse(t, "/app.ts", "typefor(Foo);\n")
	factory := ec.Factory.AsNodeFactory()

	minted := factory.NewCallExpression(
		factory.NewIdentifier("typefor"),
		nil,
		nil,
		factory.NewNodeList([]*shimast.Node{factory.NewIdentifier("Foo")}),
		shimast.NodeFlagsNone,
	)
	if got := NewCheckerAnchor(ec, sf)(minted); got != nil {
		t.Fatalf("anchor(minted node) = %v, want nil", got)
	}
}

// TestAnchorResolvesARebuiltNode is the crux of the repair. `ast.updateNode`
// copies the ORIGINAL's position and flags onto the rebuilt node, so a rebuild
// looks source-written to a `Pos() < 0` guard — which is exactly why that guard
// could not stop the checker being walked into a rewritten chain. The Original
// link the same update records is what the anchor follows back, through as many
// rebuilds as the loop performs.
func TestAnchorResolvesARebuiltNode(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	sf := parse(t, "/app.ts", "typefor(Foo);\n")
	call := firstCall(t, sf)
	factory := ec.Factory.AsNodeFactory()

	rebuilt := factory.UpdateCallExpression(
		call.AsCallExpression(),
		call.AsCallExpression().Expression,
		nil,
		nil,
		factory.NewNodeList([]*shimast.Node{factory.NewIdentifier("Bar")}),
		call.Flags,
	)
	if rebuilt == call {
		t.Fatal("test setup: the update did not rebuild the call")
	}
	if rebuilt.Pos() < 0 {
		t.Fatalf("test setup: a rebuilt node must KEEP its position (that is the point), got %d", rebuilt.Pos())
	}

	anchor := NewCheckerAnchor(ec, sf)
	if got := anchor(rebuilt); got != call {
		t.Fatalf("anchor(rebuilt) = %v, want the pass-0 call", got)
	}

	// Rebuilt again on a later pass: the chain still walks all the way back.
	twice := factory.UpdateCallExpression(
		rebuilt.AsCallExpression(),
		rebuilt.AsCallExpression().Expression,
		nil,
		nil,
		factory.NewNodeList([]*shimast.Node{factory.NewIdentifier("Baz")}),
		rebuilt.Flags,
	)
	if got := anchor(twice); got != call {
		t.Fatalf("anchor(twice-rebuilt) = %v, want the pass-0 call", got)
	}
}

// TestAnchorRejectsAForeignFileNode pins the same-file half. The inline stage
// substitutes a sugar body by deep-cloning it, and the clone hook records the
// side-parsed BODY node as the clone's original — a real parse node, in the
// declaring package's file. Without this comparison the anchor would hand the
// checker syntax from a file the consumer program never loaded, which nil-derefs a
// different way (a body's `this.…` has no enclosing class here).
func TestAnchorRejectsAForeignFileNode(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	body := parse(t, "/body.ts", "this.withSignature(x);\n")
	bodyCall := firstCall(t, body)

	clone := ec.Factory.AsNodeFactory().DeepCloneNode(bodyCall)
	if ec.ParseNode(clone) != bodyCall {
		t.Fatalf("test setup: a clone must record its original, got %v", ec.ParseNode(clone))
	}

	consumer := parse(t, "/app.ts", "export const x = 1;\n")
	if got := NewCheckerAnchor(ec, consumer)(clone); got != nil {
		t.Fatalf("anchor(foreign-file clone) = %v, want nil", got)
	}
	// The same clone IS anchorable from its own file — proving the rejection is
	// the file comparison, not a broken Original chain.
	if got := NewCheckerAnchor(ec, body)(clone); got != bodyCall {
		t.Fatalf("anchor(clone, own file) = %v, want the body call", got)
	}
}

// TestAnchoredCallRejectsANonCall: AnchoredCall is a call-shaped convenience, so
// anything else anchors to nil rather than to a mistyped node.
func TestAnchoredCallRejectsANonCall(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	sf := parse(t, "/app.ts", "typefor(Foo);\n")
	call := firstCall(t, sf)
	anchor := NewCheckerAnchor(ec, sf)

	if got := anchor.AnchoredCall(call); got != call.AsCallExpression() {
		t.Fatalf("AnchoredCall(call) = %v, want the call expression", got)
	}
	if got := anchor.AnchoredCall(call.AsCallExpression().Expression); got != nil {
		t.Fatalf("AnchoredCall(identifier) = %v, want nil", got)
	}
	if got := anchor.AnchoredCall(nil); got != nil {
		t.Fatalf("AnchoredCall(nil) = %v, want nil", got)
	}
}
