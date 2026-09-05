package plugin

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// CheckerAnchor maps a node in the CURRENT (already-rewritten) tree back to the
// pristine parse-tree node it came from. It is the ONLY node a stage may hand to
// the checker; nil means "no such node", which every caller treats as a clean
// skip.
//
// THE RULE THIS EXISTS TO ENFORCE: anchor = checker input, current node = rewrite
// input. A stage asks the checker about the ANCHOR and splices from the CURRENT
// tree. Never the other way round.
//
// WHY. RunToFixedPoint hands each stage a tree earlier passes have already
// rewritten, and a rewritten tree contains MINTED nodes — object literals, array
// literals and string literals a stage built through the emit factory. The binder
// never saw those, so they carry no symbol. That is harmless while nobody asks
// about them, but a checker query is not a question about ONE node: answering
// "what symbol is this callee?" makes the checker type the whole enclosing call,
// which resolves the receiver's overloads, which contextually types every
// argument — including the minted literal. `getContextualTypeForObjectLiteralElement`
// assumes every element it is given has a symbol and dereferences it, so the
// query nil-derefs and takes the process down.
//
// The concrete shape: a class with an OPTIONAL constructor parameter derives a
// union slot, so the typefor stage mints `{ union: [token, { value: void 0 }] }`
// into the registration's third argument. One trailing chain call
// (`.as("singleton")`) is then enough — on a later pass a matcher asks about that
// source-written callee, and answering walks into the minted literal.
//
// WHY NOT JUST WIDEN THE SYNTHETIC-NODE GUARD. The `Pos() < 0 || Parent == nil`
// guard each matcher used to carry protects the node a matcher HANDS the checker,
// not the nodes the checker WALKS TO in order to answer, and it cannot be widened
// to cover them: skipping any call whose subtree holds a minted node would strand
// the ordinary mid-loop state, where a sugar call legitimately sits over
// already-lowered arguments. The guard is also structurally unable to see the
// crashing node — `ast.updateNode` copies the original's Loc and Flags onto a
// rebuilt node, so a rebuild keeps `Pos() >= 0` and loses the synthesized flag.
//
// What the rebuild DOES leave behind is the EmitContext's Original link, and
// walking it back to the parse node is TypeScript's own long-standing transformer
// discipline (`getParseTreeNode`). Every checker question this engine asks is a
// question about SOURCE-WRITTEN syntax — which primitive is this callee, which
// overload does this sugar call bind to, what type is this argument — and the
// answer cannot change as the loop lowers the tree underneath it. So asking about
// the pass-0 node is not an approximation; it is the question the stage meant to
// ask, and the checker's own per-node memoization makes the repeat queries cheap.
//
// ANCHORING ALSO MAKES THE ANSWERS RIGHT, NOT ONLY SAFE. A chain link over an
// already-lowered registration used to have its overload resolved against the
// LOWERED receiver — and di.extras states outright that the lowered 5-argument form
// satisfies only `ServiceManifestClass`'s implementation signature, never the public
// overload list a hand-writer is held to. The question the stage means to ask is
// "which sugar did the AUTHOR call", so resolving against the pass-0 receiver is
// the correct answer as well as the surviving one.
//
// The synthetic (inline-substituted) counterparts are NOT lost by this: they are
// resolved at substitution time into inlinetransform.Artifacts, and every stage
// consults that table alongside its source-written matcher. Anchored matching and
// artifacts partition cleanly — a minted node has no parse anchor by construction.
//
// AN ARTIFACTS ENTRY IS NOT AUTOMATICALLY SAFE, THOUGH, AND THAT IS THE SUBTLE
// HALF. Substitution happens on whatever pass the inline visitor first REACHES a
// sugar call, which is not always pass 0 — the visitor does not descend past a
// match, so a registration in receiver or argument position under another sugar
// call waits, and the primitive stages rewrite its arguments while it waits. Any
// artifacts field holding a NODE must therefore be anchored when it is RECORDED,
// or it carries the rewritten tree straight past every matcher into the checker.
// `PrimitiveUse.ValueArg` is the one such field; inlinetransform.fileState's
// anchorValueArg is where that is enforced.
type CheckerAnchor func(node *shimast.Node) *shimast.Node

// NewCheckerAnchor builds the anchor for one file's pass: nodes resolve through
// ec's Original chain, and only nodes belonging to sf itself are accepted.
//
// THE SAME-FILE HALF IS LOAD-BEARING, NOT DECORATION. The inline stage substitutes
// a sugar body by DEEP-CLONING it, and the clone hook records the SIDE-PARSED body
// node as the clone's original — a real parse node, in the declaring package's
// file. Without the file comparison a substituted body's `this.withSignature(...)`
// would anchor back into that body file and be handed to the checker, which then
// resolves a `this` with no enclosing class in the consumer program and nil-derefs
// a different way (checkThisExpression → getSignatureFromDeclaration). Those nodes
// belong to the artifacts path, and the file check is what routes them there.
//
// A stage that reconstructs a node with `factory.New*` instead of `factory.Update*`
// gets NO Original link, so it has no anchor and stops matching. That is the
// pre-existing behavior (such nodes carry Pos -1 and the old guard skipped them
// too), but it is now load-bearing: new code that rebuilds a node the checker must
// still answer about has to use `Update*`, or call ec.SetOriginal explicitly.
func NewCheckerAnchor(ec *shimprinter.EmitContext, sf *shimast.SourceFile) CheckerAnchor {
	fileName := sf.FileName()
	return func(node *shimast.Node) *shimast.Node {
		if node == nil {
			return nil
		}
		anchor := ec.ParseNode(node)
		if anchor == nil || anchor.Parent == nil {
			return nil
		}
		anchorFile := shimast.GetSourceFileOfNode(anchor)
		if anchorFile == nil || anchorFile.FileName() != fileName {
			return nil
		}
		return anchor
	}
}

// AnchoredCall returns the parse-tree CallExpression behind node, or nil when node
// has no anchor in this file (a minted call, or a substituted body clone). It is
// the form every call-matching stage wants: the callee, the type arguments and the
// value arguments all read off ONE pass-0 node, so a matcher can never mix an
// anchored callee with a rewritten argument.
func (anchor CheckerAnchor) AnchoredCall(node *shimast.Node) *shimast.CallExpression {
	anchored := anchor(node)
	if anchored == nil || anchored.Kind != shimast.KindCallExpression {
		return nil
	}
	return anchored.AsCallExpression()
}
