package tokentext

import (
	"encoding/json"
	"strings"
)

// PackageJSON is the subset of a package manifest the export-graph flattening
// reads. `Exports` stays untyped because it may be a string, a conditions
// object, or a subpath map.
type PackageJSON struct {
	Name    string          `json:"name"`
	Main    string          `json:"main"`
	Module  string          `json:"module"`
	Types   string          `json:"types"`
	Typings string          `json:"typings"`
	Exports json.RawMessage `json:"exports"`
}

// ExportEntry is one flattened public entry point: a public `Subpath` ("" for
// the root, else e.g. "contracts") paired with the on-disk `TargetRel` it
// resolves to, relative to the package dir (leading "./" stripped). `Public`
// marks the entry as reachable by any consumer — its target is a bare string
// (all conditions resolve to it) or is reached through a `default` condition —
// which is the tier-1 candidate signal in publicImportSpecifier's derivation.
type ExportEntry struct {
	Subpath   string
	TargetRel string
	Public    bool
}

// EntrySourceStems returns, in resolution-priority order, the extension-stripped
// absolute path stems an export entry's on-disk target may resolve to in the
// program. It is the single shared convention both Go token-derivation call
// sites use — publicImportSpecifier's entrySourceFile (the general token
// derivation) and dioptionstransform's isRootExportTarget (the Options<T> base
// scan) — so the two cannot drift (parity, decisions §41). The candidates are:
//
//  1. The LITERAL target stem (`<pkgDir>/dist/bundle/index` from
//     `./dist/bundle/index.js`, or `<pkgDir>/index` from a raw `./index.js`) —
//     what a CONSUMER of the built dist, or a src-referenced package compiling
//     itself, loads.
//  2. The `src/` TWIN of a `dist/`-rooted target — what a DIST-referenced package
//     compiling ITSELF loads, its own dist not yet built. The rolled bundle lives
//     at `dist/bundle/<X>` whose source is `src/<X>` (the `bundle/` build-role
//     segment has no src counterpart), so that longer prefix is stripped first;
//     a plain `dist/<X>` target still twins to `src/<X>`.
func EntrySourceStems(pkgDir string, entry ExportEntry) []string {
	literalStem := StripExt(entry.TargetRel)
	stems := []string{pkgDir + "/" + literalStem}
	for _, prefix := range []string{"dist/bundle/", "dist/"} {
		if strings.HasPrefix(literalStem, prefix) {
			if rest := literalStem[len(prefix):]; rest != "" {
				stems = append(stems, pkgDir+"/src/"+rest)
			}
			break
		}
	}
	return stems
}

// ParsePackageJSON decodes the manifest subset, returning ok=false for malformed
// JSON or a nameless package (both treated as "no owning package" up-tree).
func ParsePackageJSON(text string) (PackageJSON, bool) {
	var pkg PackageJSON
	if err := json.Unmarshal([]byte(text), &pkg); err != nil {
		return PackageJSON{}, false
	}
	if pkg.Name == "" {
		return PackageJSON{}, false
	}
	return pkg, true
}

// CollectExportEntries flattens a package's public entry points into
// (subpath, targetRel) pairs. It reads `exports` (string / conditions / subpath
// map) and falls back to `main` / `module` / `types` / `typings`, finally to the
// conventional `index` when nothing else is declared.
func CollectExportEntries(pkg PackageJSON) []ExportEntry {
	out := []ExportEntry{}

	pushTarget := func(subKey string, target any) {
		subpath := subKey
		if subKey == "." {
			subpath = ""
		} else {
			subpath = trimDotSlash(subKey)
		}
		for _, t := range resolveConditionTargets(target) {
			out = append(out, ExportEntry{Subpath: subpath, TargetRel: trimDotSlash(t.target), Public: t.public})
		}
	}

	if len(pkg.Exports) > 0 {
		var raw any
		if err := json.Unmarshal(pkg.Exports, &raw); err == nil && raw != nil {
			switch exp := raw.(type) {
			case string:
				pushTarget(".", exp)
			case map[string]any:
				looksLikeSubpathMap := false
				for k := range exp {
					if k == "." || strings.HasPrefix(k, "./") {
						looksLikeSubpathMap = true
						break
					}
				}
				if looksLikeSubpathMap {
					for key, val := range exp {
						pushTarget(key, val)
					}
				} else {
					// A bare conditions object at the top level is the root entry.
					pushTarget(".", exp)
				}
			}
		}
	}

	// The classic `main`/`module`/`types`/`typings` fields are bare-string public
	// entry points — a consumer without any special condition set resolves them.
	for _, field := range []string{pkg.Main, pkg.Module, pkg.Types, pkg.Typings} {
		if field != "" {
			out = append(out, ExportEntry{Subpath: "", TargetRel: trimDotSlash(field), Public: true})
		}
	}
	if len(out) == 0 {
		out = append(out, ExportEntry{Subpath: "", TargetRel: "index", Public: true})
	}
	return out
}

// conditionTarget is one resolved string leaf of an exports condition, tagged
// with whether it is publicly reachable — a bare string (any condition set
// resolves to it) or a leaf reached through a `default` condition key.
type conditionTarget struct {
	target string
	public bool
}

// resolveConditionTargets resolves an exports condition value to its concrete
// string target(s), preferring the type/import channels and collecting every
// string leaf recursively. Each leaf carries a `public` flag: a bare string is
// public outright, and a leaf reached through a `default` condition (at any
// nesting level) is public because `default` matches unconditionally.
func resolveConditionTargets(target any) []conditionTarget {
	switch v := target.(type) {
	case string:
		return []conditionTarget{{target: v, public: true}}
	case map[string]any:
		out := []conditionTarget{}
		for _, key := range []string{"types", "import", "module", "default", "require", "node", "bun"} {
			leaf, ok := v[key]
			if !ok {
				continue
			}
			viaDefault := key == "default"
			switch inner := leaf.(type) {
			case string:
				out = append(out, conditionTarget{target: inner, public: viaDefault})
			case map[string]any:
				for _, ct := range resolveConditionTargets(inner) {
					out = append(out, conditionTarget{target: ct.target, public: ct.public || viaDefault})
				}
			}
		}
		return out
	}
	return nil
}

func trimDotSlash(s string) string {
	s = strings.TrimPrefix(s, ".")
	s = strings.TrimPrefix(s, "/")
	return s
}
