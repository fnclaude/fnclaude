package stdhost

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// This file pins the fix for the hole where the Go host type-checked a
// consumer program to run its stages but never carried the program's own
// ordinary TypeScript errors into the envelope: noEmitOnError is off (the
// host always force-emits), so a type-broken program "built" with no visible
// symptom beyond whatever spurious stage diagnostic happened to fire. The
// regression pinned here is a genuine TS error in an otherwise
// stage-untouched file, which must now surface in the envelope and fail the
// build.

// tsDiagnostic mirrors host.go's envelopeDiagnostic, including the position
// fields DiagFromTypeScript populates (integration_test.go's decodedEnvelope
// omits them, so this file decodes the raw envelope independently rather
// than reusing that type).
type tsDiagnostic struct {
	File        *string `json:"file"`
	Category    string  `json:"category"`
	Code        string  `json:"code"`
	Line        *int    `json:"line"`
	Character   *int    `json:"character"`
	MessageText string  `json:"messageText"`
}

// tsDiagnosticsEnvelope mirrors host.go's projectEnvelope.
type tsDiagnosticsEnvelope struct {
	Diagnostics []tsDiagnostic    `json:"diagnostics"`
	TypeScript  map[string]string `json:"typescript"`
}

// typeErrorAppSrc assigns a string literal to a `number`-typed const — an
// ordinary TS2322 the checker raises independent of any stage in this host's
// table; no stage here matches or rewrites it.
var typeErrorAppSrc = map[string]string{
	"src/app.ts": `export const total: number = "not a number";
`,
}

// driveHostForTypeScriptDiagnostics runs the real host (testHost()) over dir
// on its own goroutine and reports back over a channel, rather than blocking
// the test goroutine directly. driver.LoadProgram leases the program's single
// checker for the whole host run (released only by the deferred
// prog.Close() at the end of runTransform); collecting program diagnostics
// through prog.Diagnostics() while that lease is held queries the same
// checker pool via a fresh per-file acquisition. Running the host on its own
// goroutine and asserting via select+timeout, instead of trusting `go test
// -timeout` to eventually kill a wedged run, turns a potential deadlock into
// an immediate, named test failure rather than a multi-minute hang.
func driveHostForTypeScriptDiagnostics(t *testing.T, dir string) (tsDiagnosticsEnvelope, string, int) {
	t.Helper()
	t.Setenv(driver.LinkedPluginsEnv, "")

	type result struct {
		env    tsDiagnosticsEnvelope
		stderr string
		code   int
	}
	done := make(chan result, 1)
	go func() {
		var outBuf, errBuf bytes.Buffer
		restore := swapStreams(&outBuf, &errBuf)
		defer restore()

		code := Run(testHost(), []string{
			"--cwd=" + dir,
			"--tsconfig=" + filepath.Join(dir, "tsconfig.json"),
			"--plugins-json", "[]",
		})

		var env tsDiagnosticsEnvelope
		if outBuf.Len() > 0 {
			if err := json.Unmarshal(outBuf.Bytes(), &env); err != nil {
				t.Errorf("decode envelope: %v\nstdout: %q\nstderr: %s", err, outBuf.String(), errBuf.String())
			}
		}
		done <- result{env: env, stderr: errBuf.String(), code: code}
	}()

	select {
	case r := <-done:
		return r.env, r.stderr, r.code
	case <-time.After(20 * time.Second):
		t.Fatalf("host run did not complete within 20s — the checker pool likely deadlocked acquiring a per-file checker while LoadProgram's own lease is still held")
		return tsDiagnosticsEnvelope{}, "", 0
	}
}

// findTSDiag returns the first diagnostic carrying code, or nil.
func findTSDiag(env tsDiagnosticsEnvelope, code string) *tsDiagnostic {
	for i := range env.Diagnostics {
		if env.Diagnostics[i].Code == code {
			return &env.Diagnostics[i]
		}
	}
	return nil
}

// TestRunSurfacesOrdinaryTypeScriptError drives the full host over a fixture
// whose only defect is a genuine TS2322 (a string assigned to a `number`
// const) that no stage in the table touches. Before the fix this diagnostic
// was computed by tsgo's checker (the host needs the checker to run its
// stages) and then dropped: the envelope carried no TS error, the exit code
// was 0, and the program "built". The fix must surface it as a real
// diagnostic, with its source position, and fail the run.
func TestRunSurfacesOrdinaryTypeScriptError(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, selfFixturePkg, typeErrorAppSrc)

	env, stderr, code := driveHostForTypeScriptDiagnostics(t, dir)
	if code == 0 {
		t.Fatalf("host exit = 0, want non-zero for a program with a genuine TS error\nstderr: %s", stderr)
	}

	diag := findTSDiag(env, "TS2322")
	if diag == nil {
		codes := make([]string, 0, len(env.Diagnostics))
		for _, d := range env.Diagnostics {
			codes = append(codes, d.Code)
		}
		t.Fatalf("expected a TS2322 diagnostic in the envelope, got codes=%v\nstderr: %s", codes, stderr)
	}
	if diag.File == nil || !strings.HasSuffix(*diag.File, "src/app.ts") {
		t.Fatalf("TS2322 diagnostic file = %v, want a path ending in src/app.ts", diag.File)
	}
	if diag.Line == nil || *diag.Line != 1 {
		t.Fatalf("TS2322 diagnostic line = %v, want 1", diag.Line)
	}
	if diag.Category != categoryError {
		t.Fatalf("TS2322 diagnostic category = %q, want %q", diag.Category, categoryError)
	}
	if !strings.Contains(diag.MessageText, "not assignable") {
		t.Fatalf("TS2322 diagnostic message = %q, want an assignability message", diag.MessageText)
	}
}
