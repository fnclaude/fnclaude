package plugin

import (
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

// settleAfter builds a transform that rebuilds the file (a genuinely different
// *SourceFile pointer) on its first n calls and returns its input unchanged from
// then on — a file that needs exactly n productive passes and then settles. It also
// reports how many times it ran, so a test can tell "settled on pass n" from
// "stopped early".
func settleAfter(n int) (FileTransform, *int) {
	calls := 0
	transform := func(ec *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		calls++
		if calls > n {
			return sf
		}
		// Duplicate the first statement so the rebuilt file is structurally
		// different and the factory cannot dedup it back to the same pointer.
		factory := ec.Factory.AsNodeFactory()
		statements := append([]*shimast.Node{}, sf.Statements.Nodes...)
		statements = append(statements, sf.Statements.Nodes[0])
		return factory.UpdateSourceFile(sf, factory.NewNodeList(statements), sf.EndOfFileToken).AsSourceFile()
	}
	return transform, &calls
}

// TestRunToFixedPointSettlesOnTheLastAllowedPass pins the exhaustion BOUNDARY. A
// file that settles on exactly maxPasses productive passes has lowered completely,
// so the loop must report it as settled — the cap is a limit on how much work is
// allowed, not on how much is believed.
//
// It used to report exhaustion here: the cap was checked immediately after the
// maxPasses'th changing pass, before the confirming pass that would have shown the
// file had stopped changing. Effective capacity was maxPasses-1, and a file that
// used its whole budget failed the run with a diagnostic accusing the engine of
// rewriting the same node back and forth on byte-correct output.
func TestRunToFixedPointSettlesOnTheLastAllowedPass(t *testing.T) {
	const maxPasses = 8
	sf := parse(t, "/w/loop.ts", "export const x = 1;\n")

	transform, calls := settleAfter(maxPasses)
	_, passes, exhausted := RunToFixedPoint(shimprinter.NewEmitContext(), []FileTransform{transform}, sf, maxPasses)

	if exhausted {
		t.Fatalf("a file that settles on pass %d must not be reported as exhausted (passes = %d)", maxPasses, passes)
	}
	if passes != maxPasses {
		t.Fatalf("passes = %d, want %d", passes, maxPasses)
	}
	// maxPasses productive passes plus the confirming no-op pass.
	if *calls != maxPasses+1 {
		t.Fatalf("transform ran %d times, want %d (the productive passes plus one confirming pass)", *calls, maxPasses+1)
	}
}

// TestRunToFixedPointReportsExhaustionBeyondTheCap is the other side of the
// boundary: a file still changing after its whole budget is genuinely not settling,
// and must be reported.
func TestRunToFixedPointReportsExhaustionBeyondTheCap(t *testing.T) {
	const maxPasses = 8
	sf := parse(t, "/w/loop.ts", "export const x = 1;\n")

	transform, _ := settleAfter(maxPasses + 1)
	_, passes, exhausted := RunToFixedPoint(shimprinter.NewEmitContext(), []FileTransform{transform}, sf, maxPasses)

	if !exhausted {
		t.Fatalf("a file still changing after %d passes must be reported as exhausted (passes = %d)", maxPasses, passes)
	}
}

// TestRunToFixedPointSettlesImmediatelyOnANoOp pins the zero case: a transform set
// that changes nothing costs one pass and reports zero.
func TestRunToFixedPointSettlesImmediatelyOnANoOp(t *testing.T) {
	sf := parse(t, "/w/loop.ts", "export const x = 1;\n")

	transform, calls := settleAfter(0)
	result, passes, exhausted := RunToFixedPoint(shimprinter.NewEmitContext(), []FileTransform{transform}, sf, 8)

	if exhausted || passes != 0 {
		t.Fatalf("a no-op set must settle at once; passes = %d, exhausted = %v", passes, exhausted)
	}
	if result != sf {
		t.Fatal("a no-op set must return the identical source-file pointer")
	}
	if *calls != 1 {
		t.Fatalf("transform ran %d times, want 1", *calls)
	}
}
