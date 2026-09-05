package stdhost

import (
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// loadTrivialSourceFile materializes a one-file project and returns its program
// and the src/app.ts source file — enough for a transform to run over.
func loadTrivialSourceFile(t *testing.T) (*driver.Program, *shimast.SourceFile) {
	t.Helper()
	dir := t.TempDir()
	writeFixture(t, dir, selfFixturePkg, map[string]string{
		"src/app.ts": "export const x = 1;\nexport const y = 2;\n",
	})
	prog, diags, err := driver.LoadProgram(dir, filepath.Join(dir, "tsconfig.json"), driver.LoadProgramOptions{ForceEmit: true})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), "app.ts") {
			return prog, sf
		}
	}
	t.Fatal("app.ts not in program")
	return nil, nil
}

// TestTransformFileEmitsFixedPointExhaustedDiag pins the HOST wiring the pure
// plugin.RunToFixedPoint exhaustion test cannot reach: that transformFileToTypeScript
// turns a loop that never settles into a per-file FIXED_POINT_EXHAUSTED Diag on the
// emit Sink — the right code, the offending file, a non-empty message — and does so
// per file rather than aborting the whole run (it still prints and returns the
// file's text). Modeled with a flip-flop loop transform that alternates between two
// distinct *SourceFile pointers, so no pass is ever a no-op and the loop runs to
// maxLoopPasses.
func TestTransformFileEmitsFixedPointExhaustedDiag(t *testing.T) {
	prog, a := loadTrivialSourceFile(t)
	defer func() { _ = prog.Close() }()

	// b: a distinct rebuild of a with a duplicated statement, guaranteed a different
	// *SourceFile pointer (different child count — the factory cannot dedup it to a).
	scratch := shimprinter.NewEmitContext()
	factory := scratch.Factory.AsNodeFactory()
	dup := append([]*shimast.Node{}, a.Statements.Nodes...)
	dup = append(dup, a.Statements.Nodes[0])
	b := factory.UpdateSourceFile(a, factory.NewNodeList(dup), a.EndOfFileToken).AsSourceFile()
	if b == a {
		t.Fatal("could not build a distinct source-file pointer for the non-settling fixture")
	}

	flip := func(_ *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		if sf == a {
			return b
		}
		return a
	}

	var diags []Diag
	emit := func(d Diag) { diags = append(diags, d) }

	out, survived := transformFileToTypeScript(prog, []plugin.FileTransform{flip}, a, nil, emit, &phaseTracker{})
	if !survived {
		t.Fatal("exhaustion is a reported diagnostic, not a panic — the file must survive")
	}

	// The run still produces the file's text rather than aborting.
	if strings.TrimSpace(out) == "" {
		t.Fatal("transformFileToTypeScript returned empty output — exhaustion must still print the file, not abort")
	}

	var got *Diag
	for i := range diags {
		if diags[i].Code == "FIXED_POINT_EXHAUSTED" {
			got = &diags[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("no FIXED_POINT_EXHAUSTED diagnostic emitted for a non-settling loop; got %+v", diags)
	}
	if got.Warning {
		t.Error("FIXED_POINT_EXHAUSTED must be a hard error, not a warning")
	}
	wantFile := filepath.ToSlash(a.FileName())
	if got.File != wantFile {
		t.Errorf("diag File = %q, want the offending file %q", got.File, wantFile)
	}
	if strings.TrimSpace(got.Message) == "" {
		t.Error("FIXED_POINT_EXHAUSTED diag carries an empty message")
	}
}

// TestTransformFileSettlesWithoutExhaustionDiag is the negative control: a loop that
// reaches a fixed point (a transform that changes nothing) emits NO exhaustion diag.
// Without it, a transformFileToTypeScript that emitted the diag unconditionally would
// still pass the positive test above.
func TestTransformFileSettlesWithoutExhaustionDiag(t *testing.T) {
	prog, sf := loadTrivialSourceFile(t)
	defer func() { _ = prog.Close() }()

	noop := func(_ *shimprinter.EmitContext, in *shimast.SourceFile) *shimast.SourceFile { return in }

	var diags []Diag
	emit := func(d Diag) { diags = append(diags, d) }

	transformFileToTypeScript(prog, []plugin.FileTransform{noop}, sf, nil, emit, &phaseTracker{})

	for _, d := range diags {
		if d.Code == "FIXED_POINT_EXHAUSTED" {
			t.Fatalf("a settling loop must emit no exhaustion diag; got %+v", diags)
		}
	}
}
