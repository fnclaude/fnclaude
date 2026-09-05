package plugin

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// RunToFixedPoint runs a set of file transforms over one source file REPEATEDLY,
// back to back, until a full pass changes nothing (a fixed point). It is the
// engine of the owner host's per-file lowering: the transform set is unordered by
// contract (every transform owns matches no other can claim), and each chain of
// sugar peels one layer per pass, so applying the whole set again reveals the next
// layer until nothing is left to lower.
//
// Change detection is POINTER IDENTITY: every transform returns the IDENTICAL
// *SourceFile it was handed when it made no change (the shim's VisitEachChild /
// factory Update contract — a no-op visitor returns the same node, and every tail
// helper returns its input unchanged when it elided nothing). So after running the
// whole set, `result == before` means the pass was a no-op and the file has
// settled. A transform that rebuilt the tree on a no-op would defeat this by
// returning a fresh pointer every pass; the canary and table-driven no-op identity
// tests guard that contract, and the maxPasses cap catches any regression loudly
// rather than spinning forever.
//
// After each CHANGED pass parent pointers are re-fixed (SetParentInChildrenUnset)
// so the next pass's checker-anchored matchers and file-walk helpers see a
// fully-parented tree — a node a prior pass revealed needs its parent link before
// the checker can resolve it. The final (fixed-point) pass makes no change and
// mints no new nodes, so the tree stays fully parented for the caller's emit sweep
// and print.
//
// It returns the settled file, the number of CHANGED passes it took, and whether
// it hit maxPasses without settling (exhausted). The caller turns exhaustion into
// a loud per-file diagnostic — never a silent cap.
//
// THE CAP BOUNDS PRODUCTIVE PASSES, AND EXHAUSTION IS ONLY EVER OBSERVED. A pass
// that changes the file says nothing about whether the NEXT one would; only a
// no-op pass proves the file has settled. So the cap is checked after the pass
// that exceeds it, not on the last one it allows: a file that uses its whole
// budget still gets its confirming pass and is reported settled. Checking at
// `>= maxPasses` instead made the effective capacity maxPasses-1 and failed the
// run on byte-correct output — with a diagnostic accusing a stage of rewriting the
// same node back and forth, when in fact the file had finished lowering on exactly
// the last allowed pass.
func RunToFixedPoint(ec *shimprinter.EmitContext, transforms []FileTransform, sf *shimast.SourceFile, maxPasses int) (result *shimast.SourceFile, passes int, exhausted bool) {
	result = sf
	for {
		before := result
		for _, transform := range transforms {
			if next := transform(ec, result); next != nil {
				result = next
			}
		}
		if result == before {
			return result, passes, false
		}
		passes++
		shimast.SetParentInChildrenUnset(result.AsNode())
		if passes > maxPasses {
			return result, passes, true
		}
	}
}
