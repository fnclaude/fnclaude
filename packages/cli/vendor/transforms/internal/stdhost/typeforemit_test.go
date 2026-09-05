package stdhost

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
)

func writeManifest(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeSidecar(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "rhombus-std.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEmissionDefaultsToHoisted(t *testing.T) {
	// No package.json at all; a package.json with no marker and no sidecar for
	// the defaulted `extends` to find; and a marker naming another block — all
	// three mean the default.
	empty := t.TempDir()
	if got, err := readEmission(empty); err != nil || got != EmissionHoisted {
		t.Fatalf("want hoisted, got %q (%v)", got, err)
	}
	unmarked := t.TempDir()
	writeManifest(t, unmarked, `{ "name": "pkg" }`)
	if got, err := readEmission(unmarked); err != nil || got != EmissionHoisted {
		t.Fatalf("want hoisted, got %q (%v)", got, err)
	}
	partial := t.TempDir()
	writeManifest(t, partial, `{ "name": "pkg", "rhombus-std": { "inline": { "entries": [] } } }`)
	if got, err := readEmission(partial); err != nil || got != EmissionHoisted {
		t.Fatalf("want hoisted, got %q (%v)", got, err)
	}
}

func TestEmissionReadsTheMarker(t *testing.T) {
	dir := t.TempDir()
	writeManifest(t, dir, `{ "name": "pkg", "rhombus-std": { "typefor": { "emit": "inline" } } }`)
	if got, err := readEmission(dir); err != nil || got != EmissionInline {
		t.Fatalf("want inline, got %q (%v)", got, err)
	}
}

func TestEmissionReadsAnExtendedFile(t *testing.T) {
	// A package.json with no marker resolves as though it extended the sidecar,
	// so the emission may live there instead.
	defaulted := t.TempDir()
	writeManifest(t, defaulted, `{ "name": "pkg" }`)
	writeSidecar(t, defaulted, `{ "typefor": { "emit": "inline" } }`)
	if got, err := readEmission(defaulted); err != nil || got != EmissionInline {
		t.Fatalf("want inline from the sidecar, got %q (%v)", got, err)
	}

	// A marker present at all is authoritative: it no longer extends the sidecar
	// unless it says so, and what it declares wins what it extends.
	authoritative := t.TempDir()
	writeManifest(t, authoritative, `{ "name": "pkg", "rhombus-std": { "inline": { "entries": [] } } }`)
	writeSidecar(t, authoritative, `{ "typefor": { "emit": "inline" } }`)
	if got, err := readEmission(authoritative); err != nil || got != EmissionHoisted {
		t.Fatalf("a marker that extends nothing ignores the sidecar, got %q (%v)", got, err)
	}

	overriding := t.TempDir()
	writeManifest(
		t,
		overriding,
		`{ "name": "pkg", "rhombus-std": { "extends": "./rhombus-std.json", "typefor": { "emit": "hoisted" } } }`,
	)
	writeSidecar(t, overriding, `{ "typefor": { "emit": "inline" } }`)
	if got, err := readEmission(overriding); err != nil || got != EmissionHoisted {
		t.Fatalf("the local block wins what it extends, got %q (%v)", got, err)
	}
}

// The config schema owns the grammar, so an ungrammatical emission never
// reaches emissionFor: resolution rejects it first, naming the file and the
// offending key. Each case pins that the read really does sit behind that
// validation rather than re-implementing it.
func TestSchemaRejectsAnUngrammaticalEmission(t *testing.T) {
	for name, marker := range map[string]string{
		"an unrecognized value": `{ "typefor": { "emit": "hoist" } }`,
		"a non-object block":    `{ "typefor": "hoisted" }`,
		"a non-string emission": `{ "typefor": { "emit": 1 } }`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeManifest(t, dir, `{ "name": "pkg", "rhombus-std": `+marker+` }`)
			_, err := readEmission(dir)
			if err == nil {
				t.Fatal("want a hard error")
			}
			if !strings.Contains(err.Error(), "INLINE_CONFIG_SCHEMA") || !strings.Contains(err.Error(), "/typefor") {
				t.Fatalf("want a schema rejection naming the key, got %v", err)
			}
		})
	}
}

// If the schema ever admits a value this reader does not, the disagreement is
// loud rather than a silent fall back to the default — the two emissions are
// not interchangeable output. Only a direct call can reach it, since resolution
// rejects every such value today.
func TestAReaderSchemaDisagreementIsLoud(t *testing.T) {
	for name, resolved := range map[string]map[string]any{
		"a value outside the enum": {"typefor": map[string]any{"emit": "hoist"}},
		"a non-object block":       {"typefor": "hoisted"},
		"a non-string emission":    {"typefor": map[string]any{"emit": 1.0}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := emissionFor(resolved, "/pkg")
			if err == nil || !strings.Contains(err.Error(), "TYPEFOR_EMISSION_UNGRAMMATICAL") {
				t.Fatalf("want a named disagreement, got %v", err)
			}
		})
	}
}

func TestHoistedModuleIsWrittenAndCleanedUp(t *testing.T) {
	dir := t.TempDir()
	roots := emitRoots{source: dir, out: filepath.Join(dir, "out")}
	path := filepath.Join(roots.out, typeforhoist.ModuleFile)

	registry := typeforhoist.NewRegistry(typeemit.HoistRef())
	if _, err := registry.Ref(typeforhoist.Named("IClock", "orders", nil)); err != nil {
		t.Fatal(err)
	}
	if err := writeHoistedModule(registry, roots); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), `Type.imported("IClock", "orders")`) {
		t.Fatalf("the module carries the const:\n%s", written)
	}

	// A later run that derives nothing takes the module with it rather than
	// leaving one describing types the project no longer names.
	if err := writeHoistedModule(typeforhoist.NewRegistry(typeemit.HoistRef()), roots); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("want the module removed, got %v", err)
	}
}
