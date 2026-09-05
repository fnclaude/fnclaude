// Package tokens derives the stable string token that identifies a type across a
// codebase, using the TypeScript-go checker exposed through the ttsc shims. It is
// the Go port of the shared token-derivation core: every token is
// `<source>:<exportName>`, where the export name is the module-qualified declared
// name and the source is one of three tiers (package-public import specifier,
// app-internal `pkg/path`, or rootless `./path`).
//
// The byte-sensitive string machinery (path shapes, export-graph flattening,
// grammar) lives in the sibling tokentext package and is unit-tested without a
// checker; this file wires it to type/symbol queries.
package tokens

import (
	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"

	"github.com/fnioc/std/transforms/internal/tokentext"
)

// Context carries everything token derivation needs beyond a bare checker:
// the project root for the rootless fallback, a stem index resolving an export
// entry's on-disk target to the declaration file the program loaded, a
// default-lib predicate, and a package.json reader for owning-package discovery.
type Context struct {
	Checker     *shimchecker.Checker
	ProjectRoot string
	// ReadFile returns a file's text for package.json discovery, ok=false if
	// absent.
	ReadFile func(path string) (string, bool)
	// SourceFileAtStem maps an extension-stripped absolute path to the program
	// source file at that stem, or nil. Enables package-public detection.
	SourceFileAtStem func(stem string) *shimast.SourceFile
	// IsDefaultLib reports whether a source file is a TypeScript default lib, in
	// which case its declared types tokenize by bare name.
	IsDefaultLib func(sf *shimast.SourceFile) bool
	// Diag emits a hard token-derivation diagnostic (File is an absolute path,
	// Start a node offset). It fires when a type is reachable through the package
	// exports but only via a subpath that is neither the barrel nor `./private/*`,
	// so no stable public specifier can be spelled for it. Optional: nil in unit
	// tests and whenever no host wired a sink; a nil sink degrades the strict case
	// to the app-internal fallback token. Wired by the plugin host to its envelope
	// diagnostic collector.
	Diag func(file string, start int, code, message string)

	packageCache map[string]*packageInfo
}

type packageInfo struct {
	name string
	dir  string
	json tokentext.PackageJSON
}

func (ctx *Context) cache() map[string]*packageInfo {
	if ctx.packageCache == nil {
		ctx.packageCache = map[string]*packageInfo{}
	}
	return ctx.packageCache
}
