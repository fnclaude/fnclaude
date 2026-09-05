package tokens

import (
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/tokentext"
)

// entrySourceFile is the load-bearing half of the build-state-independent token
// fix (mirrors the TS engine's entrySourceFile in
// libraries/primitives.extras/src/tokens.ts): it maps an export entry's
// on-disk target to the source file the program actually loaded, trying the
// LITERAL target stem first and the `dist/<X> -> src/<X>` twin only when the
// literal is absent. These are pure stem-selection assertions; the alias /
// membership / multi-subpath decisions the fix pins are checker-level and ride
// the *.ttsc.e2e parity suites against the real packages, byte-for-byte with the
// TS engine.
func TestEntrySourceFile(t *testing.T) {
	pkg := &packageInfo{name: "my-lib", dir: "/proj/node_modules/my-lib"}
	sentinel := &shimast.SourceFile{}

	// stemIndex returns a fake sourceFileAtStem that resolves only the listed
	// stems to the shared sentinel, and records every stem it was asked for.
	stemIndex := func(present ...string) (func(string) *shimast.SourceFile, *[]string) {
		set := map[string]bool{}
		for _, s := range present {
			set[s] = true
		}
		var queried []string
		fn := func(stem string) *shimast.SourceFile {
			queried = append(queried, stem)
			if set[stem] {
				return sentinel
			}
			return nil
		}
		return fn, &queried
	}

	contains := func(xs []string, want string) bool {
		for _, x := range xs {
			if x == want {
				return true
			}
		}
		return false
	}

	t.Run("literal target present is returned; twin never consulted", func(t *testing.T) {
		// A src-referenced self-compile / a consumer of built dist: the literal
		// stem loads, so it wins and no twin lookup happens.
		fn, queried := stemIndex("/proj/node_modules/my-lib/dist/index")
		entry := tokentext.ExportEntry{Subpath: "", TargetRel: "dist/index.js"}
		if got := entrySourceFile(pkg, entry, fn); got != sentinel {
			t.Fatalf("expected sentinel from literal stem, got %v", got)
		}
		if contains(*queried, "/proj/node_modules/my-lib/src/index") {
			t.Fatalf("twin stem must not be consulted when literal resolves: %v", *queried)
		}
	})

	t.Run("dist literal absent falls back to the src twin (root)", func(t *testing.T) {
		// A dist-referenced package compiling ITSELF: its dist is not built, so
		// the literal `dist/index` is absent and the `src/index` twin resolves.
		fn, queried := stemIndex("/proj/node_modules/my-lib/src/index")
		entry := tokentext.ExportEntry{Subpath: "", TargetRel: "dist/index.js"}
		if got := entrySourceFile(pkg, entry, fn); got != sentinel {
			t.Fatalf("expected sentinel from src twin, got %v", got)
		}
		if !contains(*queried, "/proj/node_modules/my-lib/dist/index") {
			t.Fatalf("literal stem must be tried first: %v", *queried)
		}
		if !contains(*queried, "/proj/node_modules/my-lib/src/index") {
			t.Fatalf("src twin must be consulted after literal miss: %v", *queried)
		}
	})

	t.Run("dist literal absent falls back to the src twin (subpath)", func(t *testing.T) {
		// The subpath-only export case: `dist/extras` -> `src/extras`.
		fn, _ := stemIndex("/proj/node_modules/my-lib/src/extras")
		entry := tokentext.ExportEntry{Subpath: "extras", TargetRel: "dist/extras.js"}
		if got := entrySourceFile(pkg, entry, fn); got != sentinel {
			t.Fatalf("expected sentinel from src/extras twin, got %v", got)
		}
	})

	t.Run(".d.ts dist target maps to the same src twin", func(t *testing.T) {
		// A `types` condition pointing at `dist/index.d.ts` strips to the same
		// `dist/index` stem and thus the same `src/index` twin.
		fn, _ := stemIndex("/proj/node_modules/my-lib/src/index")
		entry := tokentext.ExportEntry{Subpath: "", TargetRel: "dist/index.d.ts"}
		if got := entrySourceFile(pkg, entry, fn); got != sentinel {
			t.Fatalf("expected sentinel from src twin for .d.ts target, got %v", got)
		}
	})

	t.Run("non-dist literal absent yields nil with no twin lookup", func(t *testing.T) {
		// A raw `./index.js` target (no dist prefix): the twin fallback does not
		// apply, so a missing literal is simply not found.
		fn, queried := stemIndex()
		entry := tokentext.ExportEntry{Subpath: "", TargetRel: "index.js"}
		if got := entrySourceFile(pkg, entry, fn); got != nil {
			t.Fatalf("expected nil for absent non-dist target, got %v", got)
		}
		if len(*queried) != 1 {
			t.Fatalf("only the literal stem should be queried for a non-dist target: %v", *queried)
		}
	})

	t.Run("bare dist/ prefix with empty remainder does not consult a twin", func(t *testing.T) {
		// Guard on the `(.+)` remainder: `dist/` with nothing after it never maps
		// to `src/` (mirrors the TS `^dist\/(.+)$` requirement).
		fn, queried := stemIndex()
		entry := tokentext.ExportEntry{Subpath: "", TargetRel: "dist/"}
		if got := entrySourceFile(pkg, entry, fn); got != nil {
			t.Fatalf("expected nil for empty dist remainder, got %v", got)
		}
		if contains(*queried, "/proj/node_modules/my-lib/src/") {
			t.Fatalf("empty-remainder dist target must not consult a twin: %v", *queried)
		}
	})
}

// finalSpecifier renders selectSpecifier's decision the way publicImportSpecifier
// does: the bare package for the root subpath, else `pkg/<subpath>`. ok=false when
// no public specifier was found (the `./private/*` / app-internal / diagnostic
// tiers, which fall through to baseTokenFor's own fallback).
func finalSpecifier(pkgName string, d specifierDecision) (string, bool) {
	if !d.found {
		return "", false
	}
	if d.subpath == "" {
		return pkgName, true
	}
	return pkgName + "/" + d.subpath, true
}

// reachingFromEntries treats every export entry as reaching the declaration file —
// the checker membership check is stubbed out so the pure tier selection is what's
// under test. It preserves each entry's public classification.
func reachingFromEntries(entries []tokentext.ExportEntry) []reachingEntry {
	out := make([]reachingEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, reachingEntry{subpath: e.Subpath, public: e.Public})
	}
	return out
}

// The three-tier public-specifier rule (selectSpecifier) is checker-independent,
// so the tier ordering and the shortest-subpath tiebreak are pinned here without
// loading a program. The checker-level membership half rides the *.ttsc.e2e parity
// suites against the real packages.
func TestSelectSpecifier(t *testing.T) {
	t.Run("public non-root subpath via a default condition mints pkg/sub", func(t *testing.T) {
		// A `./sub` whose target carries `default` is a public candidate; reaching
		// the decl file through it alone mints `your-lib/sub` (→ `your-lib/sub:Type`).
		pkg, ok := tokentext.ParsePackageJSON(`{
			"name": "your-lib",
			"exports": { "./sub": { "types": "./sub/index.d.ts", "default": "./sub/index.js" } }
		}`)
		if !ok {
			t.Fatal("ParsePackageJSON failed")
		}
		decision := selectSpecifier(reachingFromEntries(tokentext.CollectExportEntries(pkg)))
		spec, ok := finalSpecifier("your-lib", decision)
		if !ok || spec != "your-lib/sub" || decision.diagSubpath != "" {
			t.Fatalf("spec = %q ok = %v diag = %q, want your-lib/sub true \"\"", spec, ok, decision.diagSubpath)
		}
	})

	t.Run("two public entries reaching one file: shortest wins, no error", func(t *testing.T) {
		// Root `.` and a public `./contracts` both reach the file — the shorter
		// subpath (the root, → bare package) wins and NO diagnostic is raised.
		reaching := []reachingEntry{{subpath: "contracts", public: true}, {subpath: "", public: true}}
		decision := selectSpecifier(reaching)
		spec, ok := finalSpecifier("your-lib", decision)
		if !ok || spec != "your-lib" || decision.diagSubpath != "" {
			t.Fatalf("spec = %q ok = %v diag = %q, want your-lib true \"\"", spec, ok, decision.diagSubpath)
		}
		// Two non-root public subpaths of equal length break the tie
		// lexicographically; unequal length prefers the shorter.
		reaching = []reachingEntry{{subpath: "zeta", public: true}, {subpath: "beta", public: true}, {subpath: "a/b", public: true}}
		if got, _ := finalSpecifier("your-lib", selectSpecifier(reaching)); got != "your-lib/a/b" {
			t.Fatalf("shortest-then-lexicographic = %q, want your-lib/a/b", got)
		}
	})

	t.Run("a bare-string entry is counted as public", func(t *testing.T) {
		// `".": "./index.js"` is a bare string — any consumer resolves it — so the
		// root entry is public and the type derives the bare `your-lib` specifier.
		pkg, ok := tokentext.ParsePackageJSON(`{
			"name": "your-lib",
			"exports": { ".": "./index.js" }
		}`)
		if !ok {
			t.Fatal("ParsePackageJSON failed")
		}
		entries := tokentext.CollectExportEntries(pkg)
		if len(entries) != 1 || !entries[0].Public {
			t.Fatalf("bare-string root entry = %+v, want one Public entry", entries)
		}
		spec, ok := finalSpecifier("your-lib", selectSpecifier(reachingFromEntries(entries)))
		if !ok || spec != "your-lib" {
			t.Fatalf("spec = %q ok = %v, want your-lib true", spec, ok)
		}
	})

	t.Run("no public match but a private subpath reaches: fall through, no diagnostic", func(t *testing.T) {
		// A `./private/*` reach (the source-referenced white-box surface) is not a
		// public specifier and is NOT a violation: selectSpecifier yields no
		// specifier and no diagnostic, so baseTokenFor mints the `pkg/private/<path>`
		// app-internal token.
		decision := selectSpecifier([]reachingEntry{{subpath: "private/foo", public: false}})
		if _, ok := finalSpecifier("your-lib", decision); ok {
			t.Fatalf("private-only reach should not resolve a public specifier: %+v", decision)
		}
		if decision.diagSubpath != "" {
			t.Fatalf("private-only reach must not raise a diagnostic, got %q", decision.diagSubpath)
		}
	})

	t.Run("reached only through a non-public named subpath raises the diagnostic", func(t *testing.T) {
		// A friendly deep-import alias that is neither public nor `./private/*` is the
		// strict-rule violation: no specifier, and diagSubpath names the offending
		// subpath so publicImportSpecifier fires TOKEN_SUBPATH_NOT_PUBLIC.
		decision := selectSpecifier([]reachingEntry{{subpath: "contracts", public: false}})
		if _, ok := finalSpecifier("your-lib", decision); ok {
			t.Fatalf("non-public subpath must not resolve a specifier: %+v", decision)
		}
		if decision.diagSubpath != "contracts" {
			t.Fatalf("diagSubpath = %q, want contracts", decision.diagSubpath)
		}
	})

	t.Run("public alongside private and a non-public other: public wins, no diagnostic", func(t *testing.T) {
		// Mixed-tier precedence: a type reachable through the public barrel AND a
		// `./private/*` white-box subpath AND a non-public `./contracts` alias resolves
		// to the public barrel with no diagnostic — the public tier dominates.
		decision := selectSpecifier([]reachingEntry{
			{subpath: "contracts", public: false},
			{subpath: "private/foo", public: false},
			{subpath: "", public: true},
		})
		spec, ok := finalSpecifier("your-lib", decision)
		if !ok || spec != "your-lib" || decision.diagSubpath != "" {
			t.Fatalf("spec = %q ok = %v diag = %q, want your-lib true \"\"", spec, ok, decision.diagSubpath)
		}
	})

	t.Run("private alongside a non-public other: private rescues, no diagnostic", func(t *testing.T) {
		// havePrivate short-circuits BEFORE haveOther, so a type exported via both a
		// `./private/*` subpath and a non-public `./contracts` alias must NOT diagnose —
		// the private reach rescues it to the app-internal fallback token.
		decision := selectSpecifier([]reachingEntry{
			{subpath: "contracts", public: false},
			{subpath: "private/foo", public: false},
		})
		if _, ok := finalSpecifier("your-lib", decision); ok {
			t.Fatalf("private+other must not resolve a public specifier: %+v", decision)
		}
		if decision.diagSubpath != "" {
			t.Fatalf("private short-circuit must suppress the diagnostic, got %q", decision.diagSubpath)
		}
	})

	t.Run("multiple non-public others: shortest-then-lexicographic wins into diagSubpath", func(t *testing.T) {
		// Only a single-entry `other` set was tested before; with two equal-length
		// non-public aliases the lexicographic tiebreak selects the offending subpath.
		decision := selectSpecifier([]reachingEntry{
			{subpath: "other", public: false},
			{subpath: "alias", public: false},
		})
		if decision.diagSubpath != "alias" {
			t.Fatalf("diagSubpath = %q, want alias (equal length, lexicographically first)", decision.diagSubpath)
		}
		// Unequal length prefers the shorter regardless of lexicographic order.
		decision = selectSpecifier([]reachingEntry{
			{subpath: "aaaa", public: false},
			{subpath: "zz", public: false},
		})
		if decision.diagSubpath != "zz" {
			t.Fatalf("diagSubpath = %q, want zz (shorter length)", decision.diagSubpath)
		}
	})
}

// shorterSubpath is the pure canonical-choice comparator selectSpecifier drives:
// shorter length first, lexicographic on equal length, with the root "" shortest of
// all. Only asserted transitively through selectSpecifier before; pinned directly
// here.
func TestShorterSubpath(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"a", "bb", true},        // shorter length wins
		{"bb", "a", false},       // longer loses
		{"alias", "other", true}, // equal length, lexicographically smaller wins
		{"other", "alias", false},
		{"", "a", true},     // root is shortest of all
		{"a", "", false},    // ...and never beats the root
		{"ab", "ab", false}, // equal strings: not strictly shorter
	}
	for _, tc := range cases {
		if got := shorterSubpath(tc.a, tc.b); got != tc.want {
			t.Errorf("shorterSubpath(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
