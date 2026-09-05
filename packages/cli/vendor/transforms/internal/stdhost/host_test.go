package stdhost

import (
	"bytes"
	"testing"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

func stageNames(stages []Stage) []string {
	names := make([]string, len(stages))
	for i, s := range stages {
		names[i] = s.Name
	}
	return names
}

// testHost is the base host every host-level test drives — the same stage table
// cmd/ttsc-std composes. There is no bundle map any more (W7): the whole table is
// always on.
func testHost() Host {
	return Host{Name: "ttsc-std", Stages: BaseStages()}
}

// TestBaseStagesCanonicalOrder pins the always-on stage table's membership AND
// order. Every stage runs on every file (no selection, W7), so this order — fixed
// for reproducible output — is the whole contract. inline running first is
// load-bearing: it substitutes sugar bodies before any primitive stage runs, so
// the synthetic primitive calls it mints are in place for the handoff.
func TestBaseStagesCanonicalOrder(t *testing.T) {
	want := []string{
		stagePrefix + "inline",
		stagePrefix + "mergesynth",
		stagePrefix + "typefor",
		stagePrefix + "schemaof",
	}
	got := stageNames(BaseStages())
	if len(got) != len(want) {
		t.Fatalf("BaseStages order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("BaseStages order = %v, want %v", got, want)
		}
	}
}

// TestRunTransformHasNoZeroStageGuard proves the old NO_STAGES hard error is gone
// (W7): a run with an EMPTY plugin manifest and no linked plugin must NOT bail
// out before loading the program — the whole stage table is always on, so an
// empty manifest is normal. The run proceeds past where the guard used to sit and
// fails later on the bogus tsconfig, so whatever error appears, it is not
// NO_STAGES.
func TestRunTransformHasNoZeroStageGuard(t *testing.T) {
	t.Setenv(driver.LinkedPluginsEnv, "")
	var errBuf, outBuf bytes.Buffer
	restore := swapStreams(&outBuf, &errBuf)
	defer restore()

	code := runTransform(testHost(), []string{"--tsconfig=/nonexistent/tsconfig.json", "--plugins-json", "[]"})
	if code == 0 {
		t.Fatalf("expected a non-zero exit against a bogus tsconfig, got 0")
	}
	if contains(errBuf.String(), "NO_STAGES") {
		t.Fatalf("NO_STAGES fired even though stage selection is retired: %q", errBuf.String())
	}
}

// swapStreams redirects the package-level stdout/stderr writers to the given
// buffers and returns a restore func. runTransform writes exclusively through
// these package vars, so this captures everything it emits.
func swapStreams(out, err *bytes.Buffer) func() {
	prevOut, prevErr := stdout, stderr
	stdout, stderr = out, err
	return func() { stdout, stderr = prevOut, prevErr }
}

func TestFilterKnownArgsDropsForwardedFlagsKeepsOurs(t *testing.T) {
	// The `build` subcommand token is already stripped by the router. ttsc then
	// forwards --quiet / --emit / --outDir / --tsgo-args, none of which this host
	// defines; they must be dropped while our own flags (inline and
	// space-separated) survive with their values.
	in := []string{
		"--tsconfig=/p/tsconfig.json",
		"--plugins-json", `[{"name":"rhombusstd"}]`,
		"--cwd=/p",
		"--emit",
		"--outDir=/p/dist",
		"--quiet",
		"--tsgo-args=[\"--x\"]",
	}
	got := filterKnownArgs(in)
	want := []string{
		"--tsconfig=/p/tsconfig.json",
		"--plugins-json", `[{"name":"rhombusstd"}]`,
		"--cwd=/p",
	}
	if len(got) != len(want) {
		t.Fatalf("filterKnownArgs = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("filterKnownArgs = %q, want %q", got, want)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
