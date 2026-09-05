package stdhost

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
)

// Emission names how a project spells the types typefor derives.
type Emission string

const (
	// EmissionHoisted collects every derived type into one generated module of
	// named consts and leaves a reference at each call site. It is the default.
	EmissionHoisted Emission = "hoisted"
	// EmissionInline writes each `Type.*` factory tree out at the call site it
	// was derived for.
	EmissionInline Emission = "inline"
)

// typeforKey is the resolved config's block naming the emission:
//
//	{ "rhombus-std": { "typefor": { "emit": "hoisted" } } }
//
// The choice rides the PROJECT, never the shared ttsc descriptor — the
// descriptor is what every consumer dedupes to one spawn and one cache key, so
// nothing that varies per consumer may live there. Within the project it may
// come from the package.json marker or from any file that marker extends;
// resolution flattens the difference away before this reads it.
const typeforKey = "typefor"

// emitKey names the emission inside that block.
const emitKey = "emit"

// emissionFor classifies the typefor block of a project's RESOLVED rhombus-std
// config. An absent block, or one naming no emission, is the default.
//
// SHAPE IS NOT THIS FUNCTION'S JOB: resolution validates the config against
// schema/rhombus-std.schema.json, which already rejects a non-object block, a
// non-string emission, and a value outside the enum — with a message naming the
// file and the offending key. So a value here that is not what the schema
// permits means the schema and this reader disagree about the grammar, which is
// an engine bug and says so; it is never a silent fall back to the default,
// since the two emissions are not interchangeable output. packageDir names the
// project the config resolved for.
func emissionFor(resolved map[string]any, packageDir string) (Emission, error) {
	value, present := resolved[typeforKey]
	if !present {
		return EmissionHoisted, nil
	}
	block, ok := value.(map[string]any)
	if !ok {
		return "", disagreement(packageDir, typeforKey, value)
	}
	emit, present := block[emitKey]
	if !present {
		return EmissionHoisted, nil
	}
	name, ok := emit.(string)
	if !ok {
		return "", disagreement(packageDir, typeforKey+"."+emitKey, emit)
	}
	switch emission := Emission(name); emission {
	case EmissionHoisted, EmissionInline:
		return emission, nil
	default:
		return "", disagreement(packageDir, typeforKey+"."+emitKey, name)
	}
}

// disagreement reports a resolved value the config schema should have rejected
// before this reader ever saw it.
func disagreement(packageDir, key string, value any) error {
	return fmt.Errorf(
		`TYPEFOR_EMISSION_UNGRAMMATICAL: %s resolves "rhombus-std".%s to %#v, which the config schema `+
			`should have rejected — the schema and this reader disagree about the grammar (an engine bug)`,
		packageDir, key, value,
	)
}

// readEmission is emissionFor over cwd's resolved rhombus-std config — the one
// entry point every reader of that config shares, so a project may declare the
// emission in its package.json marker or in a file the marker extends. A
// project with no package.json at all takes the default, matching what the
// dependency scan does with the same absence.
func readEmission(cwd string) (Emission, error) {
	path := filepath.Join(cwd, "package.json")
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return EmissionHoisted, nil
		}
		return "", fmt.Errorf("typefor emission: cannot read %s: %w", path, err)
	}
	resolved, err := inlinetransform.ResolveConfig(cwd)
	if err != nil {
		return "", fmt.Errorf("typefor emission: %w", err)
	}
	return emissionFor(resolved, cwd)
}

// emitRoots are the two directories hoisted emission is anchored to: the root of
// the SOURCE tree, which every call site spells its relative specifier against,
// and the root of the EMITTED tree, where the generated module is written. The
// emitted tree mirrors the source tree, so the module being a direct child of
// each root makes one specifier correct in both.
type emitRoots struct {
	source string
	out    string
}

// resolveEmitRoots reads the roots off the program's compiler options, falling
// back to the common directory of the project's own files when rootDir is unset
// and to the source root when outDir is (a project that emits in place).
func resolveEmitRoots(prog *driver.Program, cwd string) emitRoots {
	options := prog.TSProgram.Options()
	source := options.RootDir
	if source == "" {
		source = commonSourceDirectory(prog, cwd)
	}
	source = absoluteAgainst(cwd, source)
	out := options.OutDir
	if out == "" {
		return emitRoots{source: source, out: source}
	}
	return emitRoots{source: source, out: absoluteAgainst(cwd, out)}
}

func absoluteAgainst(cwd, dir string) string {
	if filepath.IsAbs(dir) {
		return filepath.Clean(dir)
	}
	return filepath.Join(cwd, dir)
}

// commonSourceDirectory is the deepest directory containing every one of the
// project's own non-declaration files — what an emit roots its output tree at
// when no rootDir says otherwise.
func commonSourceDirectory(prog *driver.Program, cwd string) string {
	var dirs []string
	for _, sf := range prog.SourceFiles() {
		if sf.IsDeclarationFile {
			continue
		}
		file := filepath.FromSlash(sf.FileName())
		rel, err := filepath.Rel(cwd, file)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		dirs = append(dirs, filepath.Dir(file))
	}
	if len(dirs) == 0 {
		return cwd
	}
	sort.Strings(dirs)
	common := dirs[0]
	for _, dir := range dirs[1:] {
		common = commonPrefixDirectory(common, dir)
	}
	return common
}

func commonPrefixDirectory(left, right string) string {
	leftParts := strings.Split(left, string(filepath.Separator))
	rightParts := strings.Split(right, string(filepath.Separator))
	shared := 0
	for shared < len(leftParts) && shared < len(rightParts) && leftParts[shared] == rightParts[shared] {
		shared++
	}
	return strings.Join(leftParts[:shared], string(filepath.Separator))
}

// writeHoistedModule materializes the project's const table beside the emitted
// files, or removes a module left by an earlier build when this one derived
// nothing. The whole project is re-read and re-derived on every run, so the file
// is always written from scratch — there is no incremental path that could leave
// it describing a stale set of types.
func writeHoistedModule(registry *typeforhoist.Registry, roots emitRoots) error {
	path := filepath.Join(roots.out, typeforhoist.ModuleFile)
	source := registry.Module()
	if source == "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("typefor emission: cannot remove stale %s: %w", path, err)
		}
		return nil
	}
	if err := os.MkdirAll(roots.out, 0o755); err != nil {
		return fmt.Errorf("typefor emission: cannot create %s: %w", roots.out, err)
	}
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		return fmt.Errorf("typefor emission: cannot write %s: %w", path, err)
	}
	return nil
}
