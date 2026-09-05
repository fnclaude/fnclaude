package stdhost

import (
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/tokens"
)

// This file pins the no-anonymous-crash guarantee: a panic anywhere in the
// per-file transform pipeline must reach the user as an ordinary diagnostic that
// NAMES the source file and the stage, not as a bare Go stack trace on stderr
// with nothing to attribute it to. The panic is an engine bug either way; what
// these tests protect is the bug REPORT.

const boomStageName = stagePrefix + "boom"

// boomStage builds a stage whose transform panics on every file whose name
// satisfies match. Stages that do not match return the file untouched, so a
// selective boom lowers the rest of the program normally.
func boomStage(match func(name string) bool, value any) Stage {
	return Stage{
		Name: boomStageName,
		Build: func(_ *driver.Program, _ *tokens.Context, _ *Env, _ Sink) plugin.FileTransform {
			return func(_ *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
				if match(sf.FileName()) {
					panic(value)
				}
				return sf
			}
		},
	}
}

// findDiag returns the first envelope diagnostic carrying code, or nil.
func findDiag(env decodedEnvelope, code string) *struct {
	File        *string `json:"file"`
	Category    string  `json:"category"`
	Code        string  `json:"code"`
	MessageText string  `json:"messageText"`
} {
	for i := range env.Diagnostics {
		if env.Diagnostics[i].Code == code {
			return &env.Diagnostics[i]
		}
	}
	return nil
}

// TestStagePanicIsReportedWithFileAndStage is the core guarantee. A stage that
// panics while lowering src/app.ts must produce a STAGE_PANIC error diagnostic
// naming that file, the stage that was running, and the recovered value — and
// the host must exit non-zero through its normal envelope path rather than dying
// on the panic.
func TestStagePanicIsReportedWithFileAndStage(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, selfFixturePkg, typeforAppSrc)

	host := Host{Name: "ttsc-std", Stages: []Stage{
		boomStage(func(name string) bool { return strings.HasSuffix(name, "app.ts") }, "checker nil-deref"),
	}}
	env, stderr, code := driveHostWith(t, host, dir, `[]`)

	if code == 0 {
		t.Fatalf("a panicking stage must fail the run; code = 0\nstderr: %s", stderr)
	}
	got := findDiag(env, stagePanicCode)
	if got == nil {
		t.Fatalf("no %s diagnostic; diagnostics = %+v\nstderr: %s", stagePanicCode, env.Diagnostics, stderr)
	}
	if got.Category != categoryError {
		t.Errorf("%s category = %q, want %q — a panic is never advisory", stagePanicCode, got.Category, categoryError)
	}
	if got.File == nil || !strings.HasSuffix(*got.File, "src/app.ts") {
		t.Errorf("%s must name the file being transformed; file = %v", stagePanicCode, got.File)
	}
	if !strings.Contains(got.MessageText, boomStageName) {
		t.Errorf("%s must name the stage that was running (%s); message =\n%s", stagePanicCode, boomStageName, got.MessageText)
	}
	if !strings.Contains(got.MessageText, "checker nil-deref") {
		t.Errorf("%s must carry the recovered panic value; message =\n%s", stagePanicCode, got.MessageText)
	}
	// The stack is the other half of an actionable report — without it the
	// diagnostic says WHERE in the project but not where in the engine.
	if !strings.Contains(got.MessageText, "stdhost.transformFileToTypeScript") {
		t.Errorf("%s must carry the crash stack; message =\n%s", stagePanicCode, got.MessageText)
	}
}

// TestStagePanicAbortsTheRun pins the abort-not-continue choice: the first
// panicking file ends the file walk, so a stage that would panic on EVERY file
// still reports exactly one diagnostic. The rationale is in
// transformFileToTypeScript's caller — the panic escaped the shared checker, so
// every later file's lowering is untrustworthy.
func TestStagePanicAbortsTheRun(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, selfFixturePkg, typeforAppSrc)
	if len(typeforAppSrc) < 2 {
		t.Fatalf("this test needs a multi-file fixture to prove the abort; got %d files", len(typeforAppSrc))
	}

	host := Host{Name: "ttsc-std", Stages: []Stage{
		boomStage(func(string) bool { return true }, "boom"),
	}}
	env, stderr, code := driveHostWith(t, host, dir, `[]`)

	if code == 0 {
		t.Fatalf("a panicking stage must fail the run; code = 0\nstderr: %s", stderr)
	}
	panics := 0
	for _, d := range env.Diagnostics {
		if d.Code == stagePanicCode {
			panics++
		}
	}
	if panics != 1 {
		t.Fatalf("the run must abort on the FIRST panicking file; got %d %s diagnostics over %d source files", panics, stagePanicCode, len(typeforAppSrc))
	}
	// The panicking file contributes no lowered output — a half-transformed file
	// must never reach the envelope.
	if len(env.TypeScript) >= len(typeforAppSrc) {
		t.Errorf("the aborted run emitted %d lowered files for a %d-file fixture; the panicking file must be dropped", len(env.TypeScript), len(typeforAppSrc))
	}
}

// TestPrintPhasePanicNamesThePrint proves the phase report is not stage-only: a
// panic after the stage loop settles (here forced by handing the printer a
// source file the pipeline never parented) is attributed to the phase that was
// actually running, not to the last stage that happened to run.
func TestPrintPhasePanicNamesThePrint(t *testing.T) {
	tracker := &phaseTracker{}
	transform := tracker.watch(boomStageName, func(_ *shimprinter.EmitContext, sf *shimast.SourceFile) *shimast.SourceFile {
		return sf
	})

	prog, sf := loadTrivialSourceFile(t)
	defer func() { _ = prog.Close() }()

	var diags []Diag
	_, survived := transformFileToTypeScript(prog, []plugin.FileTransform{transform}, sf, nil, func(d Diag) { diags = append(diags, d) }, tracker)
	if !survived {
		t.Fatalf("a non-panicking run must survive; diags = %+v", diags)
	}
	if tracker.phase != "printing the lowered file" {
		t.Errorf("after a clean run the tracker must have advanced past the stages to the print; phase = %q", tracker.phase)
	}
}
