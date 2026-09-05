// Package tokentext holds the pure, checker-independent string machinery behind
// token derivation: POSIX path normalization, the package.json export-graph
// flattening, the closed-generic token grammar, and literal rendering. Nothing
// here touches the TypeScript type system, so every function is exercised by a
// plain table-driven Go test without loading a program or a checker.
//
// The checker-driven derivation (in the sibling tokens package) composes these
// helpers with type/symbol queries. Keeping the pure layer separate is what lets
// the byte-sensitive path/grammar logic be pinned down independently of the
// heavier toolchain build.
package tokentext

import "strings"

// Normalize converts backslashes to forward slashes so every downstream helper
// operates on a single POSIX shape.
func Normalize(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// Dirname is a POSIX dirname over a normalized path; it returns the input when
// already at the root, and "/" for a first-level entry.
func Dirname(p string) string {
	n := strings.TrimRight(Normalize(p), "/")
	idx := strings.LastIndex(n, "/")
	if idx <= 0 {
		if idx == 0 {
			return "/"
		}
		return n
	}
	return n[:idx]
}

// StripExt removes a trailing declaration or source/JS extension, mirroring the
// order the reference derivation strips them (a `.d.ts` first, then any single
// module extension).
func StripExt(p string) string {
	for _, ext := range []string{".d.ts", ".d.mts", ".d.cts"} {
		if strings.HasSuffix(p, ext) {
			return p[:len(p)-len(ext)]
		}
	}
	for _, ext := range []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"} {
		if strings.HasSuffix(p, ext) {
			return p[:len(p)-len(ext)]
		}
	}
	return p
}

// PosixRelative returns to's path relative to from, or ("", false) when to is
// not contained under from. An exact match yields ("", true).
func PosixRelative(from, to string) (string, bool) {
	a := strings.TrimRight(Normalize(from), "/")
	b := Normalize(to)
	if b == a {
		return "", true
	}
	if strings.HasPrefix(b, a+"/") {
		return b[len(a)+1:], true
	}
	return "", false
}

// PackagePrivateToken renders the tier-2 (app-internal) base token
// `packageName/<decl path relative to package root, ext stripped>:<exportName>`,
// with a leading `src/` segment rewritten to `private/` so the token equals the
// package's `./private/*` white-box import specifier (the source-referenced token
// surface a non-barrel type is reached through).
func PackagePrivateToken(pkgName, pkgDir, declPath, exportName string) string {
	from, name := PackagePrivateTokenParts(pkgName, pkgDir, declPath, exportName)
	return from + ":" + name
}

// PackagePrivateTokenParts is PackagePrivateToken split into the FROM/NAME pair
// it joins with `:` — the source specifier a structural `Type.imported` call takes
// as its first two arguments, rather than the flat token string.
func PackagePrivateTokenParts(pkgName, pkgDir, declPath, exportName string) (from, name string) {
	rel, ok := PosixRelative(pkgDir, declPath)
	var base string
	if ok {
		base = StripExt(rel)
	} else {
		base = StripExt(strings.TrimLeft(Normalize(declPath), "/"))
	}
	if strings.HasPrefix(base, "src/") {
		base = "private/" + base[len("src/"):]
	}
	return pkgName + "/" + base, exportName
}

// RootlessToken renders the tier-3 (rootless) base token
// `./<decl path relative to project root, ext stripped>:<exportName>` for a
// declaration with no owning package.json up-tree.
func RootlessToken(declPath, exportName, projectRoot string) string {
	from, name := RootlessTokenParts(declPath, exportName, projectRoot)
	return from + ":" + name
}

// RootlessTokenParts is RootlessToken split into the FROM/NAME pair it joins
// with `:`.
func RootlessTokenParts(declPath, exportName, projectRoot string) (from, name string) {
	rel, ok := PosixRelative(projectRoot, declPath)
	var base string
	if ok {
		base = StripExt(rel)
	} else {
		base = StripExt(strings.TrimLeft(Normalize(declPath), "/"))
	}
	return "./" + base, exportName
}
