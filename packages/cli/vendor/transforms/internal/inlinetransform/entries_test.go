package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestEntryKindInference(t *testing.T) {
	cases := []struct {
		name   string
		e      Entry
		kind   EntryKind
		status KindStatus
	}{
		// The four grammar rows.
		{"instance member, ambient", Entry{Type: "@rhombus-std/di.core:IServiceQuery", Impl: "p:ServiceQueryInline", Member: "isService"}, KindMember, StatusCertified},
		{"instance member, own body", Entry{Type: "@rhombus-std/di.core:Foo", Member: "bar"}, KindMember, StatusUncertified},
		{"static member", Entry{Impl: "p:FooBase", Member: "bar"}, KindStaticMember, StatusUncertified},
		{"floater", Entry{Impl: "p:tokenOf"}, KindFloater, StatusCertified},

		// A malformed type token on the ambient-member row is malformed.
		{"ambient member: type no colon", Entry{Type: "nocolon", Impl: "p:x", Member: "m"}, 0, StatusMalformed},
		{"ambient member: type empty package", Entry{Type: ":T", Impl: "p:x", Member: "m"}, 0, StatusMalformed},
		{"ambient member: type empty name", Entry{Type: "p:", Impl: "p:x", Member: "m"}, 0, StatusMalformed},
		// A malformed impl token on the ambient-member row is malformed too.
		{"ambient member: impl no colon", Entry{Type: "p:T", Impl: "nocolon", Member: "m"}, 0, StatusMalformed},
		// A malformed type token on the own-body member row is malformed.
		{"own-body member: type no colon", Entry{Type: "nocolon", Member: "m"}, 0, StatusMalformed},
		// A malformed impl token on the static-member row is malformed.
		{"static member: impl no colon", Entry{Impl: "nocolon", Member: "m"}, 0, StatusMalformed},
		// A malformed impl token on the floater row is malformed.
		{"floater: impl no colon", Entry{Impl: "nocolon"}, 0, StatusMalformed},

		// Both+neither mixtures and lone fields fit no row.
		{"empty entry", Entry{}, 0, StatusMalformed},
		{"type only (no member)", Entry{Type: "p:T"}, 0, StatusMalformed},
		{"member only (no type, no impl)", Entry{Member: "m"}, 0, StatusMalformed},
		{"type+impl, no member", Entry{Type: "p:T", Impl: "p:V"}, 0, StatusMalformed},

		// Empty-string fields are treated as absent.
		{"empty-string type is absent → static member", Entry{Type: "", Impl: "p:fn", Member: "m"}, KindStaticMember, StatusUncertified},
		{"empty-string member is absent → floater", Entry{Impl: "p:fn", Member: ""}, KindFloater, StatusCertified},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kind, status := c.e.Kind()
			if status != c.status {
				t.Fatalf("Kind() status = %v, want %v", status, c.status)
			}
			if status != StatusMalformed && kind != c.kind {
				t.Fatalf("Kind() kind = %v, want %v", kind, c.kind)
			}
		})
	}
}

// TestLoadInlineEntriesDefaultWithNoFile: a package.json with no
// "rhombus-std" key at all resolves as though it read exactly
// {"extends": "./rhombus-std.json"} — and since no such file exists here,
// that resolves blindly to an empty config, silently.
func TestLoadInlineEntriesDefaultWithNoFile(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "pkg" }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entries != nil {
		t.Fatalf("expected nil entries for a package with no rhombus-std marker and no default file, got %+v", entries)
	}
}

// TestResolveConfigDefaultWithFile: no "rhombus-std" key, but a sibling
// rhombus-std.json exists — the default import loads it.
func TestResolveConfigDefaultWithFile(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "pkg" }`)
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "inline": { "entries": [ { "impl": "pkg:fromDefault" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 1 || entries[0].Impl != "pkg:fromDefault" {
		t.Fatalf("expected the default rhombus-std.json to load, got %+v", entries)
	}
}

// TestResolveConfigEmptyKeyKillsDefault: "rhombus-std": {} is a PRESENT
// value — the package owns its whole config, and the default file never
// participates, even though one exists on disk.
func TestResolveConfigEmptyKeyKillsDefault(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "pkg", "rhombus-std": {} }`)
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "inline": { "entries": [ { "impl": "pkg:ignored" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if entries != nil {
		t.Fatalf("expected the sibling rhombus-std.json to be ignored once \"rhombus-std\" is present, got %+v", entries)
	}
}

// TestResolveConfigExplicitExtendsMissingIsSilent: an explicitly written
// "extends" naming a file that doesn't exist resolves blindly to nothing —
// the same silence as the defaulted case, no diagnostic.
func TestResolveConfigExplicitExtendsMissingIsSilent(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./missing.json", "inline": { "entries": [ { "impl": "pkg:local" } ] } }
}`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 1 || entries[0].Impl != "pkg:local" {
		t.Fatalf("expected only the local entry, the missing extends contributing nothing, got %+v", entries)
	}
}

// TestResolveConfigChainOfTwo: an "extends" chain two files deep resolves
// the deepest (most-base) file's entries first, each subsequent local layer
// appended after.
func TestResolveConfigChainOfTwo(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./a.json" }
}`)
	write(t, filepath.Join(root, "a.json"), `{ "extends": "./b.json", "inline": { "entries": [ { "impl": "pkg:fromA" } ] } }`)
	write(t, filepath.Join(root, "b.json"), `{ "inline": { "entries": [ { "impl": "pkg:fromB" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 2 || entries[0].Impl != "pkg:fromB" || entries[1].Impl != "pkg:fromA" {
		t.Fatalf("expected [fromB, fromA] (base before the local layer that imported it), got %+v", entries)
	}
}

// TestResolveConfigCycleResolvesClean: a chain that loops back to a file
// already in the chain resolves that hop as nothing rather than looping or
// erroring — the rest of the chain still resolves normally.
func TestResolveConfigCycleResolvesClean(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./a.json" }
}`)
	write(t, filepath.Join(root, "a.json"), `{ "extends": "./b.json", "inline": { "entries": [ { "impl": "pkg:fromA" } ] } }`)
	write(t, filepath.Join(root, "b.json"), `{ "extends": "./a.json", "inline": { "entries": [ { "impl": "pkg:fromB" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 2 || entries[0].Impl != "pkg:fromB" || entries[1].Impl != "pkg:fromA" {
		t.Fatalf("expected the cycle back to a.json to resolve as nothing rather than loop, got %+v", entries)
	}
}

// TestResolveConfigExtendsArrayLaterWinsOverEarlier: "extends" as an array
// applies left to right — each path's resolved content deep-merges over
// everything accumulated from the paths before it, so a later path wins a
// leaf collision against an earlier one, and the local block (present here
// too) wins over both.
func TestResolveConfigExtendsArrayLaterWinsOverEarlier(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": {
    "extends": ["./a.json", "./b.json"],
    "$schema": "local"
  }
}`)
	write(t, filepath.Join(root, "a.json"), `{ "typefor": { "emit": "hoisted" }, "$schema": "from-a" }`)
	write(t, filepath.Join(root, "b.json"), `{ "typefor": { "emit": "inline" }, "$schema": "from-b" }`)
	resolved, err := ResolveConfig(root)
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	typefor, ok := resolved["typefor"].(map[string]any)
	if !ok || typefor["emit"] != "inline" {
		t.Fatalf("expected the later extends entry (b) to win over the earlier one (a) on \"typefor.emit\", got %+v", resolved)
	}
	if resolved["$schema"] != "local" {
		t.Fatalf("expected the local block to win over both extended files on \"$schema\", got %+v", resolved)
	}
}

// TestResolveConfigLocalOverridesExtendedLeaf: an object nested under a
// resolved config key merges recursively, with a local scalar leaf winning
// over the same leaf in the imported base.
func TestResolveConfigLocalOverridesExtendedLeaf(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./base.json", "typefor": { "emit": "hoisted" } }
}`)
	write(t, filepath.Join(root, "base.json"), `{ "typefor": { "emit": "inline" } }`)
	resolved, err := ResolveConfig(root)
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	typefor, ok := resolved["typefor"].(map[string]any)
	if !ok {
		t.Fatalf("expected a \"typefor\" object in the resolved config, got %+v", resolved)
	}
	if typefor["emit"] != "hoisted" {
		t.Fatalf("expected the local \"typefor.emit\" to win over the imported base, got %+v", typefor)
	}
}

// TestResolveConfigEntriesConcatOrder: a single extends hop concatenates
// the imported entries first, the local entries appended after.
func TestResolveConfigEntriesConcatOrder(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": {
    "extends": "./rhombus-std.json",
    "inline": { "entries": [ { "impl": "pkg:local" } ] }
  }
}`)
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "inline": { "entries": [ { "impl": "pkg:imported" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 2 || entries[0].Impl != "pkg:imported" || entries[1].Impl != "pkg:local" {
		t.Fatalf("expected [imported, local] concatenation order, got %+v", entries)
	}
}

// TestResolveConfigEntriesConcatUndeduped: the same entry text arriving via
// both the imported base and the local block is concatenated verbatim,
// never deduplicated.
func TestResolveConfigEntriesConcatUndeduped(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": {
    "extends": "./rhombus-std.json",
    "inline": { "entries": [ { "impl": "pkg:dup" } ] }
  }
}`)
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "inline": { "entries": [ { "impl": "pkg:dup" } ] } }`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 2 || entries[0].Impl != "pkg:dup" || entries[1].Impl != "pkg:dup" {
		t.Fatalf("expected both dup entries concatenated undeduped, got %+v", entries)
	}
}

// TestLoadInlineEntriesBadShape: a type+impl, no-member entry fits no
// grammar row, and the schema gate — which mirrors the same four rows — now
// catches it before entriesFromResolved's own Kind() check ever runs.
func TestLoadInlineEntriesBadShape(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "inline": { "entries": [ { "type": "p:A", "impl": "pkg:AImpl" } ] } }
}`)
	_, err := LoadInlineEntries(root)
	if err == nil {
		t.Fatal("expected INLINE_CONFIG_SCHEMA error for a type+impl, no-member entry")
	}
	if !strings.Contains(err.Error(), "INLINE_CONFIG_SCHEMA") {
		t.Fatalf("want INLINE_CONFIG_SCHEMA, got %v", err)
	}
}

func TestLoadInlineEntriesUncertifiedShape(t *testing.T) {
	// An own-body instance member (type+member, no impl) and a static member
	// (impl+member, no type) are recognized-but-not-certified shapes: they must
	// be rejected with the distinct INLINE_KIND_UNCERTIFIED error, never the
	// malformed-shape error.
	ownBody := `{ "name": "pkg", "rhombus-std": { "inline": { "entries": [ { "type": "p:A", "member": "m" } ] } } }`
	static := `{ "name": "pkg", "rhombus-std": { "inline": { "entries": [ { "impl": "pkg:AImpl", "member": "m" } ] } } }`
	for name, body := range map[string]string{"own-body member": ownBody, "static member": static} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			write(t, filepath.Join(root, "package.json"), body)
			_, err := LoadInlineEntries(root)
			if err == nil {
				t.Fatal("expected INLINE_KIND_UNCERTIFIED error")
			}
			if !strings.Contains(err.Error(), "INLINE_KIND_UNCERTIFIED") {
				t.Fatalf("want INLINE_KIND_UNCERTIFIED, got %v", err)
			}
		})
	}
}

func TestLoadInlineEntriesCertifiedShapes(t *testing.T) {
	// Both certified rows load without error.
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "inline": { "entries": [
    { "type": "p:A", "impl": "pkg:AImpl", "member": "m" },
    { "impl": "pkg:freeFn" }
  ] } }
}`)
	entries, err := LoadInlineEntries(root)
	if err != nil {
		t.Fatalf("LoadInlineEntries: %v", err)
	}
	if len(entries) != 2 || entries[0].Member != "m" || entries[1].Impl != "pkg:freeFn" {
		t.Fatalf("unexpected entries: %+v", entries)
	}
}

// TestLoadInlineEntriesImplMustSelfReference: an impl naming a package OTHER
// than the declaring one is rejected at load time — the side-parser only ever
// reads files inside the declaring package, so a foreign impl can never
// resolve, and staying silent about it would surface later as a confusing
// not-found instead of a named authoring error.
func TestLoadInlineEntriesImplMustSelfReference(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "inline": { "entries": [ { "impl": "@other/pkg:tokenOf" } ] } }
}`)
	_, err := LoadInlineEntries(root)
	if err == nil {
		t.Fatal("expected INLINE_ENTRY_IMPL_FOREIGN error")
	}
	if !strings.Contains(err.Error(), "INLINE_ENTRY_IMPL_FOREIGN") {
		t.Fatalf("want INLINE_ENTRY_IMPL_FOREIGN, got %v", err)
	}
}

// TestLoadInlineEntriesMalformedExtendedJSON: a syntactically-broken file
// reached through "extends" is a loud INLINE_ENTRY_IMPORT error (not a bare
// JSON parse error) — blindness covers absence, not corruption. The JS twin
// (inline-entries.mjs) is aligned to wrap parse failures the same way.
func TestLoadInlineEntriesMalformedExtendedJSON(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./bad.json" }
}`)
	write(t, filepath.Join(root, "bad.json"), `{ "inline": [ this is not json `)
	_, err := LoadInlineEntries(root)
	if err == nil {
		t.Fatal("expected INLINE_ENTRY_IMPORT error for malformed imported JSON")
	}
	if !strings.Contains(err.Error(), "INLINE_ENTRY_IMPORT") {
		t.Fatalf("want INLINE_ENTRY_IMPORT, got %v", err)
	}
}

// TestLoadInlineEntriesNonStringExtends: an "extends" value that isn't a
// string or array of strings fails the schema gate — extends is typed
// `oneOf: [string, array of strings]` there too — before resolveNode's own
// extends-shape check ever runs.
func TestLoadInlineEntriesNonStringExtends(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": 42 }
}`)
	_, err := LoadInlineEntries(root)
	if err == nil {
		t.Fatal("expected INLINE_CONFIG_SCHEMA error for a non-string extends")
	}
	if !strings.Contains(err.Error(), "INLINE_CONFIG_SCHEMA") {
		t.Fatalf("want INLINE_CONFIG_SCHEMA, got %v", err)
	}
}
