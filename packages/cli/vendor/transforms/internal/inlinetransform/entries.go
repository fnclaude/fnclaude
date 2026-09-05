package inlinetransform

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// EntryKind classifies a publish-list entry by field KIND, not just presence:
// type names a TYPE (a TypeIdentifier reference — an interface/class the
// member is declared on); impl names a VALUE (a fully-qualified export); member
// is the member name, shared by both member shapes.
type EntryKind int

const (
	// KindMember is an instance-member sugar entry: type + member, with impl
	// present when the member's declaration is ambient (a bodyless interface
	// member — the body lives on impl's member-named property; every member
	// entry in the workspace today is this shape, CERTIFIED) or absent when the
	// declaration IS its own body (a class method; recognized, not yet
	// certified — no current entry is this shape).
	KindMember EntryKind = iota
	// KindFloater is a free-standing sugar entry: impl only, no type, no
	// member — the impl function's own source is the body. CERTIFIED.
	KindFloater
	// KindStaticMember is a static / namespace-const member sugar entry: impl +
	// member, no type — the impl value is both the call-base anchor and the
	// body holder. SPECCED but NOT CERTIFIED — recognized only so it can be
	// rejected distinctly; no current entry is this shape.
	KindStaticMember
)

// KindStatus is the certification verdict for an entry's recognized shape.
type KindStatus int

const (
	// StatusMalformed: the field-presence pattern fits no shape (type without
	// member, member without type or impl, the empty entry), or a present
	// type/impl reference fails to deserialize. The caller raises
	// INLINE_ENTRY_SHAPE.
	StatusMalformed KindStatus = iota
	// StatusCertified: an inlineable shape — an ambient instance member or a
	// floater.
	StatusCertified
	// StatusUncertified: a recognized shape that is specced but not yet
	// certified — an own-body instance member or a static member. The caller
	// raises INLINE_KIND_UNCERTIFIED.
	StatusUncertified
)

// Kind classifies e by field KIND and presence into one of four rows and
// returns the row's kind plus its certification status:
//
//	type + member + impl  → instance member, ambient   (certified)
//	type + member         → instance member, own body  (uncertified)
//	impl  + member         → static member              (uncertified)
//	impl only              → floater                    (certified)
//
// type is present only paired with member (a lone type is malformed); every
// other combination requires member alongside type or impl (a lone member, or
// the empty entry, is malformed). A present type or impl must deserialize
// through ParseTypeRef — an absent package qualifier or any other malformed
// reference is malformed, loudly, never a silent skip.
func (e Entry) Kind() (EntryKind, KindStatus) {
	hasType := e.Type != ""
	hasImpl := e.Impl != ""
	hasMember := e.Member != ""

	switch {
	case hasType && hasMember && hasImpl:
		if !parsesCleanly(e.Type) || !parsesCleanly(e.Impl) {
			return 0, StatusMalformed
		}
		return KindMember, StatusCertified
	case hasType && hasMember && !hasImpl:
		if !parsesCleanly(e.Type) {
			return 0, StatusMalformed
		}
		return KindMember, StatusUncertified
	case hasImpl && hasMember && !hasType:
		if !parsesCleanly(e.Impl) {
			return 0, StatusMalformed
		}
		return KindStaticMember, StatusUncertified
	case hasImpl && !hasMember && !hasType:
		if !parsesCleanly(e.Impl) {
			return 0, StatusMalformed
		}
		return KindFloater, StatusCertified
	default:
		// type without member, member without type or impl, or the empty entry.
		return 0, StatusMalformed
	}
}

// parsesCleanly reports whether ref deserializes through ParseTypeRef — the
// grammar-row certification gate every present type/impl reference must clear.
func parsesCleanly(ref string) bool {
	_, err := ParseTypeRef(ref)
	return err == nil
}

// rawInlineBlock is the "inline" key's own object: entries is the publish
// list.
type rawInlineBlock struct {
	Entries []Entry `json:"entries"`
}

// extendsKey is the "rhombus-std" config's own file-composition directive.
const extendsKey = "extends"

// ResolveConfig returns the fully-resolved "rhombus-std" config for
// packageDir's package.json: local keys deep-merged OVER the (recursively
// resolved) "extends" chain — a local key wins any leaf collision against the
// extended base, an object recurses key-by-key, and an array concatenates as
// base-then-local with each element left atomic (an inline entry never merges
// field-by-field with another).
//
// A package.json with no "rhombus-std" key at all resolves as though it read
// exactly {"extends": "<the first sibling default file that exists>"} —
// FIRST-MATCH-STOP, not a fold: rhombus-std.json, then .yaml, then .yml,
// then .toml, in that priority order, and the moment one is found the rest
// are never even consulted, so two sibling defaults never cross-format
// merge (defaultExtendsPath). A "rhombus-std" key present with ANY value,
// including {}, is authoritative on its own; the default probe never runs
// once the key exists. An explicit "extends" — written by hand, or reached
// partway down an "extends" chain — keeps full fold semantics regardless;
// first-match-stop is a property of the implicit default alone.
//
// Resolution is BLIND: an "extends" path that isn't a readable file
// contributes nothing, silently, whether the directive was defaulted or
// explicitly written. A chain may be arbitrarily long; a cycle (a path
// already in the chain) also contributes nothing rather than looping. A
// present file that fails to parse, or whose content doesn't match
// schema/rhombus-std.schema.json, is still a hard error — blindness covers
// absence, not corruption or an invalid shape.
//
// This is the one entry point every rhombus-std config reader (the inline
// publish list, and any future feature block) resolves through.
//
// This build has no incremental input-tracking seam: every file this and
// resolveNode read, including a resolved rhombus-std config, is re-read fresh
// on every build rather than registered against a cache key.
func ResolveConfig(packageDir string) (map[string]any, error) {
	packageDir = filepath.Clean(packageDir)
	pkgPath := filepath.Join(packageDir, "package.json")
	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return nil, fmt.Errorf("inline: cannot read %s: %w", pkgPath, err)
	}
	var pkg struct {
		RhombusStd json.RawMessage `json:"rhombus-std"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil, fmt.Errorf("inline: malformed package.json %s: %w", pkgPath, err)
	}
	var raw map[string]any
	if pkg.RhombusStd == nil {
		raw = map[string]any{extendsKey: defaultExtendsPath(packageDir)}
	} else if err := json.Unmarshal(pkg.RhombusStd, &raw); err != nil {
		return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %s %q must be an object: %w", pkgPath, "rhombus-std", err)
	}
	resolved, err := resolveNode(raw, pkgPath, map[string]bool{pkgPath: true})
	if err != nil {
		return nil, err
	}
	if err := validateConfigNode(resolved, fmt.Sprintf("%s (fully resolved)", pkgPath)); err != nil {
		return nil, err
	}
	return resolved, nil
}

// defaultExtendsPath returns the sibling default file a package.json with no
// "rhombus-std" key implicitly extends: the first candidate that exists, in
// priority order (JSON, then YAML, then .yml, then TOML) — a first-match-stop
// probe, not a fold, so a later candidate is never even consulted once an
// earlier one is found and two sibling defaults never cross-format merge.
// When none exist, the name returned is still whichever the probe would have
// preferred, and the ordinary blind "extends" resolution treats it exactly
// like any other missing path: silently nothing.
func defaultExtendsPath(packageDir string) string {
	for _, name := range []string{
		"rhombus-std.json",
		"rhombus-std.yaml",
		"rhombus-std.yml",
		"rhombus-std.toml",
	} {
		if fileExists(filepath.Join(packageDir, name)) {
			return "./" + name
		}
	}
	return "./rhombus-std.json"
}

// resolveNode resolves node's "extends" (if present) against fromFile's own
// directory and deep-merges node's remaining keys (deepMerge) over the
// recursively resolved extended base. "extends" is a string or an array of
// strings; an array applies LEFT TO RIGHT — each path's recursively resolved
// content deep-merges over everything accumulated from the paths before it,
// so a later path wins a leaf collision against an earlier one — and node's
// own keys merge over that whole accumulated result last, winning every
// collision against anything extended. visited is the set of absolute paths
// already in the ANCESTOR chain reaching this node; a path already in it
// contributes nothing rather than being re-read, so a cycle resolves clean
// instead of looping. Two unrelated branches (e.g. two "extends" array
// entries that happen to reach the same file by different routes) never
// falsely collide: each path's recursive call starts from the ancestor set
// at THIS node, never from a sibling's descendants.
func resolveNode(node map[string]any, fromFile string, visited map[string]bool) (map[string]any, error) {
	if err := validateConfigNode(node, fromFile); err != nil {
		return nil, err
	}
	local := make(map[string]any, len(node))
	var paths []string
	hasExtends := false
	for k, v := range node {
		if k != extendsKey {
			local[k] = v
			continue
		}
		hasExtends = true
		switch val := v.(type) {
		case string:
			paths = []string{val}
		case []any:
			paths = make([]string, len(val))
			for i, item := range val {
				s, ok := item.(string)
				if !ok {
					return nil, fmt.Errorf("INLINE_ENTRY_IMPORT: %s %q array entry %d must be a string", fromFile, extendsKey, i)
				}
				paths[i] = s
			}
		default:
			return nil, fmt.Errorf("INLINE_ENTRY_IMPORT: %s %q must be a string or array of strings", fromFile, extendsKey)
		}
	}
	if !hasExtends {
		return local, nil
	}

	accumulated := map[string]any{}
	for _, p := range paths {
		abs := filepath.Clean(filepath.Join(filepath.Dir(fromFile), p))
		real, rerr := filepath.EvalSymlinks(abs)
		if rerr != nil {
			real = abs
		}
		if visited[real] {
			continue
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		extended, err := parseConfigFile(abs, data)
		if err != nil {
			return nil, err
		}

		nextVisited := make(map[string]bool, len(visited)+1)
		for k := range visited {
			nextVisited[k] = true
		}
		nextVisited[real] = true
		resolved, err := resolveNode(extended, abs, nextVisited)
		if err != nil {
			return nil, err
		}
		accumulated = deepMerge(accumulated, resolved)
	}
	return deepMerge(accumulated, local), nil
}

// deepMerge merges local OVER base: an object recurses key-by-key (local
// wins a leaf collision), an array concatenates as base-then-local, and any
// other value — including a base/local type mismatch — replaces with
// local's. An array's own elements are never merged into each other; they are
// concatenated as opaque values.
func deepMerge(base, local map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(local))
	for k, v := range base {
		out[k] = v
	}
	for k, lv := range local {
		bv, inBase := out[k]
		if !inBase {
			out[k] = lv
			continue
		}
		if bArr, ok := bv.([]any); ok {
			if lArr, ok := lv.([]any); ok {
				merged := make([]any, 0, len(bArr)+len(lArr))
				merged = append(merged, bArr...)
				merged = append(merged, lArr...)
				out[k] = merged
				continue
			}
		}
		if bObj, ok := bv.(map[string]any); ok {
			if lObj, ok := lv.(map[string]any); ok {
				out[k] = deepMerge(bObj, lObj)
				continue
			}
		}
		out[k] = lv
	}
	return out
}

// LoadInlineEntries resolves packageDir's rhombus-std config (ResolveConfig)
// and returns its "inline" object's "entries" list, validated entry by entry,
// in resolved order. A resolved config with no "inline" key returns
// (nil, nil) — absence is not an error. Malformed JSON reached through
// "extends", or a non-certified entry shape, are hard errors.
func LoadInlineEntries(packageDir string) ([]Entry, error) {
	packageDir = filepath.Clean(packageDir)
	resolved, err := ResolveConfig(packageDir)
	if err != nil {
		return nil, err
	}
	pkgPath := filepath.Join(packageDir, "package.json")
	return entriesFromResolved(resolved, packageDir, pkgPath)
}

// entriesFromResolved extracts and validates the "inline.entries" list from a
// resolved config. from names the resolved config's origin, for diagnostics.
// Every entry's impl (when present) must self-reference packageDir's own
// package — the side-parser only ever reads files inside it, so an impl
// naming any other package cannot resolve and is rejected here, loudly, at
// load time rather than as a confusing not-found later.
func entriesFromResolved(resolved map[string]any, packageDir, from string) ([]Entry, error) {
	inlineVal, ok := resolved["inline"]
	if !ok {
		return nil, nil
	}
	data, err := json.Marshal(inlineVal)
	if err != nil {
		return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %s: %w", from, err)
	}
	var block rawInlineBlock
	if err := json.Unmarshal(data, &block); err != nil {
		return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %s \"inline\" must be an object with an \"entries\" array: %w", from, err)
	}
	out := make([]Entry, 0, len(block.Entries))
	for i, e := range block.Entries {
		switch _, status := e.Kind(); status {
		case StatusMalformed:
			return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %s entry %d matches no grammar row (type=%q impl=%q member=%q)", from, i, e.Type, e.Impl, e.Member)
		case StatusUncertified:
			return nil, fmt.Errorf("INLINE_KIND_UNCERTIFIED: %s entry %d is a specced-but-not-yet-certified shape (own-body instance members and static members are not certified) (type=%q impl=%q member=%q)", from, i, e.Type, e.Impl, e.Member)
		}
		if e.Impl != "" {
			implRef, err := ParseTypeRef(e.Impl)
			if err != nil {
				return nil, fmt.Errorf("INLINE_ENTRY_SHAPE: %s entry %d has a malformed impl %q: %w", from, i, e.Impl, err)
			}
			if declaringPkg := packageName(packageDir); implRef.From != declaringPkg {
				return nil, fmt.Errorf("INLINE_ENTRY_IMPL_FOREIGN: %s entry %d impl %q names package %q, but must self-reference the declaring package %q — the side-parser only reads files inside it", from, i, e.Impl, implRef.From, declaringPkg)
			}
		}
		out = append(out, e)
	}
	return out, nil
}
