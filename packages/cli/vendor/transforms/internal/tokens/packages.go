package tokens

import (
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"

	"github.com/fnioc/std/transforms/internal/tokentext"
)

// nearestPackage walks up from a declaration path to the nearest readable, named
// package.json, caching the result per directory.
func nearestPackage(ctx *Context, fromPath string) *packageInfo {
	if ctx.ReadFile == nil {
		return nil
	}
	cache := ctx.cache()
	dir := tokentext.Dirname(fromPath)
	for {
		if cached, seen := cache[dir]; seen {
			if cached != nil {
				return cached
			}
		} else {
			var resolved *packageInfo
			if text, ok := ctx.ReadFile(dir + "/package.json"); ok {
				if json, ok := tokentext.ParsePackageJSON(text); ok {
					resolved = &packageInfo{name: json.Name, dir: dir, json: json}
				}
			}
			cache[dir] = resolved
			if resolved != nil {
				return resolved
			}
		}
		parent := tokentext.Dirname(dir)
		if parent == dir {
			return nil
		}
		dir = parent
	}
}

// publicImportSpecifier returns the exact import specifier a consumer writes for
// a symbol reachable through a package's public exports. Derivation is tiered:
//
//  1. PUBLIC tier — the candidate entries are those whose target is a bare string
//     or is reached through a `default` condition (either way, any consumer can
//     resolve them). Among the public candidates that REACH the declaration file,
//     the SHORTEST subpath wins (lexicographic tiebreak on equal length), so the
//     root barrel `.` (→ bare `pkg`) is preferred and a public `./sub` mints
//     `pkg/sub`. Multiple public matches are not an error — shortest wins.
//  2. No public match, but a `./private/*` subpath reaches it → ok=false with no
//     diagnostic, so baseTokenFor's fallback mints the `pkg/private/<path>` token
//     over the source-referenced white-box surface.
//  3. Reached ONLY through some other named subpath (a friendly deep-import alias
//     that is neither public nor `./private/*`) → a hard diagnostic (via ctx.Diag),
//     because that alias must not silently become part of a token.
//
// ok=false with no diagnostic also covers a type not publicly reachable at all —
// it falls to the app-internal token. The match is against the checker export
// graph, not file-path stems.
func publicImportSpecifier(ctx *Context, pkg *packageInfo, symbol *shimast.Symbol, _ *shimast.SourceFile) (string, bool) {
	if ctx.SourceFileAtStem == nil {
		return "", false
	}
	target := topLevelAncestor(symbol)
	targetDecls := map[*shimast.Node]bool{}
	for _, d := range target.Declarations {
		targetDecls[d] = true
	}
	if len(targetDecls) == 0 {
		return "", false
	}
	var declFile *shimast.SourceFile
	if primary := primaryDeclaration(target); primary != nil {
		declFile = shimast.GetSourceFileOfNode(primary)
	}

	// Gather every export subpath whose module re-exports the target, tagged with
	// whether the export made it publicly reachable. The tier selection over this
	// set is pure (selectSpecifier), so it is unit-tested without a checker.
	var reaching []reachingEntry
	for _, entry := range tokentext.CollectExportEntries(pkg.json) {
		sf := entrySourceFile(pkg, entry, ctx.SourceFileAtStem)
		if sf == nil {
			continue
		}
		mod := ctx.Checker.GetSymbolAtLocation(sf.AsNode())
		if mod == nil {
			continue
		}
		if moduleReExports(ctx, mod, targetDecls) {
			reaching = append(reaching, reachingEntry{subpath: entry.Subpath, public: entry.Public})
		}
	}

	decision := selectSpecifier(reaching)
	if decision.found {
		if decision.subpath == "" {
			return pkg.name, true
		}
		return pkg.name + "/" + decision.subpath, true
	}
	if decision.diagSubpath != "" {
		reportNonPublicSubpath(ctx, target, declFile, pkg, decision.diagSubpath)
	}
	return "", false
}

// moduleReExports reports whether a resolved module symbol exports a member that
// shares a declaration with the target (aliases resolved) — the "this entry
// reaches the declaration file" check, run against the checker export graph.
func moduleReExports(ctx *Context, mod *shimast.Symbol, targetDecls map[*shimast.Node]bool) bool {
	for _, exp := range ctx.Checker.GetExportsOfModule(mod) {
		resolved := exp
		if exp.Flags&shimast.SymbolFlagsAlias != 0 {
			if aliased := ctx.Checker.GetAliasedSymbol(exp); aliased != nil {
				resolved = aliased
			}
		}
		for _, d := range resolved.Declarations {
			if targetDecls[d] {
				return true
			}
		}
	}
	return false
}

// reachingEntry is one export entry that reaches a target's declaration file,
// carrying just what the tier selection needs: the public subpath and whether the
// export made it publicly reachable (a `default` condition or bare-string target).
type reachingEntry struct {
	subpath string
	public  bool
}

// specifierDecision is the outcome of the three-tier rule over the entries that
// reach a target's declaration file.
type specifierDecision struct {
	// subpath is the winning public subpath ("" for the bare barrel); meaningful
	// only when found is true.
	subpath string
	found   bool
	// diagSubpath, when non-empty, is the non-public, non-private named subpath that
	// forces the hard diagnostic (no public or `./private/*` entry reached the file).
	diagSubpath string
}

// selectSpecifier applies the three-tier public-specifier rule to the export
// entries that reach a target's declaration file (see publicImportSpecifier). It
// is pure — no checker, no package identity — so the tier ordering and the
// shortest-subpath tiebreak are pinned by plain unit tests.
func selectSpecifier(reaching []reachingEntry) specifierDecision {
	bestPublic := ""
	havePublic := false
	havePrivate := false
	bestOther := ""
	haveOther := false
	for _, e := range reaching {
		switch {
		case e.public:
			if !havePublic || shorterSubpath(e.subpath, bestPublic) {
				bestPublic = e.subpath
				havePublic = true
			}
		case e.subpath == "private" || strings.HasPrefix(e.subpath, "private/"):
			havePrivate = true
		default:
			if !haveOther || shorterSubpath(e.subpath, bestOther) {
				bestOther = e.subpath
				haveOther = true
			}
		}
	}
	if havePublic {
		return specifierDecision{subpath: bestPublic, found: true}
	}
	if havePrivate {
		return specifierDecision{}
	}
	if haveOther {
		return specifierDecision{diagSubpath: bestOther}
	}
	return specifierDecision{}
}

// shorterSubpath reports whether a is the canonical choice over b: shorter first,
// then lexicographically smaller on equal length. The root "" is shortest of all.
func shorterSubpath(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

// reportNonPublicSubpath fires ctx.Diag for a type reachable only via a named
// export subpath that is neither the barrel nor `./private/*`. Anchored at the
// type's own declaration so the message points at the file whose exports must
// change. Naming both fixes keeps the remedy unambiguous.
func reportNonPublicSubpath(ctx *Context, target *shimast.Symbol, declFile *shimast.SourceFile, pkg *packageInfo, subpath string) {
	if ctx.Diag == nil || declFile == nil {
		return
	}
	primary := primaryDeclaration(target)
	if primary == nil {
		return
	}
	ctx.Diag(
		declFile.FileName(),
		primary.Pos(),
		"TOKEN_SUBPATH_NOT_PUBLIC",
		"cannot derive a token for \""+target.Name+"\": it is reachable from \""+pkg.name+
			"\" only through the \"./"+subpath+"\" export subpath, which is neither the package "+
			"barrel nor \"./private/*\". Export it from the barrel (the package's main index), or "+
			"expose its file through a \"./private/*\" subpath, so the derived token has a stable "+
			"public import specifier.",
	)
}

// entrySourceFile resolves an export entry's on-disk target to the source file
// the PROGRAM actually loaded for it — the load-bearing fix for
// build-state-independent tokens. The candidate stems (literal target first,
// then the `dist/<X> -> src/<X>` twin) come from tokentext.EntrySourceStems, the
// shared convention this and dioptionstransform's isRootExportTarget both key on
// so the two Go call sites cannot drift; see that helper for the full rationale.
//
// Because the SAME GetExportsOfModule membership check then runs against the
// resolved entry module either way, the derived token is byte-identical in every
// compilation context. The literal stem is always tried first, so any context in
// which the literal target is loaded is unaffected.
// Mirrors the TS engine's entrySourceFile (libraries/primitives.extras/src/tokens.ts).
func entrySourceFile(
	pkg *packageInfo,
	entry tokentext.ExportEntry,
	sourceFileAtStem func(stem string) *shimast.SourceFile,
) *shimast.SourceFile {
	for _, stem := range tokentext.EntrySourceStems(pkg.dir, entry) {
		if sf := sourceFileAtStem(stem); sf != nil {
			return sf
		}
	}
	return nil
}
