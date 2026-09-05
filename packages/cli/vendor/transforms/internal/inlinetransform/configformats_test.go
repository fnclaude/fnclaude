package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveConfigExtendsEachFormat: an explicit "extends" entry parses by
// its target's extension — JSON, YAML, and TOML each resolve the same
// content.
func TestResolveConfigExtendsEachFormat(t *testing.T) {
	cases := map[string]string{
		"a.json": `{ "typefor": { "emit": "inline" } }`,
		"a.yaml": "typefor:\n  emit: inline\n",
		"a.toml": "[typefor]\nemit = \"inline\"\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./`+name+`" }
}`)
			write(t, filepath.Join(root, name), content)
			resolved, err := ResolveConfig(root)
			if err != nil {
				t.Fatalf("ResolveConfig: %v", err)
			}
			typefor, ok := resolved["typefor"].(map[string]any)
			if !ok || typefor["emit"] != "inline" {
				t.Fatalf("expected typefor.emit=inline from %s, got %+v", name, resolved)
			}
		})
	}
}

// TestResolveConfigDefaultProbeEachFormat: with no "rhombus-std" key, a lone
// sibling in any one of the default probe's formats is picked up.
func TestResolveConfigDefaultProbeEachFormat(t *testing.T) {
	cases := map[string]string{
		"rhombus-std.toml": "[typefor]\nemit = \"inline\"\n",
		"rhombus-std.yml":  "typefor:\n  emit: inline\n",
		"rhombus-std.yaml": "typefor:\n  emit: inline\n",
		"rhombus-std.json": `{ "typefor": { "emit": "inline" } }`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			write(t, filepath.Join(root, "package.json"), `{ "name": "pkg" }`)
			write(t, filepath.Join(root, name), content)
			resolved, err := ResolveConfig(root)
			if err != nil {
				t.Fatalf("ResolveConfig: %v", err)
			}
			typefor, ok := resolved["typefor"].(map[string]any)
			if !ok || typefor["emit"] != "inline" {
				t.Fatalf("expected the lone sibling %s to be picked up, got %+v", name, resolved)
			}
		})
	}
}

// TestResolveConfigDefaultProbeJSONWinsConflict: with no "rhombus-std" key
// and every sibling format present, JSON — first in the probe's priority
// order — is the one taken; the probe stops there, so the other three are
// never even read.
func TestResolveConfigDefaultProbeJSONWinsConflict(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "pkg" }`)
	write(t, filepath.Join(root, "rhombus-std.toml"), "[typefor]\nemit = \"inline\"\n")
	write(t, filepath.Join(root, "rhombus-std.yml"), "typefor:\n  emit: inline\n")
	write(t, filepath.Join(root, "rhombus-std.yaml"), "typefor:\n  emit: inline\n")
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "typefor": { "emit": "hoisted" } }`)
	resolved, err := ResolveConfig(root)
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	typefor, ok := resolved["typefor"].(map[string]any)
	if !ok || typefor["emit"] != "hoisted" {
		t.Fatalf("expected rhombus-std.json to win the conflict, got %+v", resolved)
	}
}

// TestResolveConfigDefaultProbeStopsAtFirstMatch: with rhombus-std.json AND
// rhombus-std.toml both present (no yaml/yml), the probe takes json and
// never reads toml at all — proven by a toml-only marker key that must be
// absent from the result, not merely overridden.
func TestResolveConfigDefaultProbeStopsAtFirstMatch(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "package.json"), `{ "name": "pkg" }`)
	write(t, filepath.Join(root, "rhombus-std.json"), `{ "typefor": { "emit": "hoisted" } }`)
	write(t, filepath.Join(root, "rhombus-std.toml"), "typefor.emit = \"inline\"\n$schema = \"toml-marker\"\n")
	resolved, err := ResolveConfig(root)
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	typefor, ok := resolved["typefor"].(map[string]any)
	if !ok || typefor["emit"] != "hoisted" {
		t.Fatalf("expected rhombus-std.json to be taken, got %+v", resolved)
	}
	if _, ok := resolved["$schema"]; ok {
		t.Fatalf("expected rhombus-std.toml to never be read (no cross-format merge), got %+v", resolved)
	}
}

// TestResolveConfigSchemaInvalidFileIsNamed: a present extends target that
// parses cleanly but doesn't match the rhombus-std config schema is a hard
// INLINE_CONFIG_SCHEMA error naming the offending file, in every format.
func TestResolveConfigSchemaInvalidFileIsNamed(t *testing.T) {
	cases := map[string]string{
		"bad.json": `{ "notAKnownKey": true }`,
		"bad.yaml": "notAKnownKey: true\n",
		"bad.toml": "notAKnownKey = true\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			write(t, filepath.Join(root, "package.json"), `{
  "name": "pkg",
  "rhombus-std": { "extends": "./`+name+`" }
}`)
			write(t, filepath.Join(root, name), content)
			_, err := ResolveConfig(root)
			if err == nil {
				t.Fatal("expected an INLINE_CONFIG_SCHEMA error")
			}
			if !strings.Contains(err.Error(), "INLINE_CONFIG_SCHEMA") || !strings.Contains(err.Error(), name) {
				t.Fatalf("want an INLINE_CONFIG_SCHEMA error naming %s, got %v", name, err)
			}
		})
	}
}

// TestParseConfigFileUnparseable: syntactically broken YAML and TOML are both
// loud INLINE_ENTRY_IMPORT errors, the same code malformed JSON already uses.
func TestParseConfigFileUnparseable(t *testing.T) {
	cases := map[string]string{
		"bad.yaml": "typefor:\n  emit: [unterminated\n",
		"bad.toml": "typefor = { emit = \n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseConfigFile(name, []byte(content))
			if err == nil {
				t.Fatal("expected a parse error")
			}
			if !strings.Contains(err.Error(), "INLINE_ENTRY_IMPORT") {
				t.Fatalf("want INLINE_ENTRY_IMPORT, got %v", err)
			}
		})
	}
}

// TestParseConfigFileYAMLNonStringKeyForcedToString: a YAML mapping key that
// isn't a bare string (here, an unquoted boolean-shaped key) still lands in
// the canonical model as a string key.
func TestParseConfigFileYAMLNonStringKeyForcedToString(t *testing.T) {
	obj, err := parseConfigFile("a.yaml", []byte("true: value\n"))
	if err != nil {
		t.Fatalf("parseConfigFile: %v", err)
	}
	if obj["true"] != "value" {
		t.Fatalf("expected the boolean-shaped key to normalize to the string \"true\", got %+v", obj)
	}
}

// TestParseConfigFileYAMLAnchorCycleRejected: a YAML mapping that anchors
// itself through its own alias is a hard error rather than an unbounded
// decode.
func TestParseConfigFileYAMLAnchorCycleRejected(t *testing.T) {
	_, err := parseConfigFile("a.yaml", []byte("a: &anchor\n  self: *anchor\n"))
	if err == nil {
		t.Fatal("expected a cycle error")
	}
	if !strings.Contains(err.Error(), "INLINE_ENTRY_IMPORT") {
		t.Fatalf("want INLINE_ENTRY_IMPORT, got %v", err)
	}
}

// TestParseConfigFileTOMLDatetimeNormalizesToString: every TOML temporal
// shape — offset datetime, local datetime, local date, local time — comes out
// of parseConfigFile as a plain string rather than a Go time type, so it
// merges and validates like any other scalar.
func TestParseConfigFileTOMLDatetimeNormalizesToString(t *testing.T) {
	content := "offset = 1979-05-27T07:32:00Z\n" +
		"local = 1979-05-27T07:32:00\n" +
		"date = 1979-05-27\n" +
		"time = 07:32:00\n"
	obj, err := parseConfigFile("a.toml", []byte(content))
	if err != nil {
		t.Fatalf("parseConfigFile: %v", err)
	}
	for key, val := range obj {
		if _, ok := val.(string); !ok {
			t.Fatalf("expected %q to normalize to a string, got %T (%v)", key, val, val)
		}
	}
	if obj["offset"] != "1979-05-27T07:32:00Z" {
		t.Fatalf("expected the offset datetime to render as RFC3339, got %v", obj["offset"])
	}
}

// TestParseConfigFileTOMLIntegerNormalizesToFloat64: a TOML integer widens to
// float64, the same Go type encoding/json.Unmarshal produces for every JSON
// number — so a TOML-sourced value validates identically to a JSON one.
func TestParseConfigFileTOMLIntegerNormalizesToFloat64(t *testing.T) {
	obj, err := parseConfigFile("a.toml", []byte("count = 3\n"))
	if err != nil {
		t.Fatalf("parseConfigFile: %v", err)
	}
	if _, ok := obj["count"].(float64); !ok {
		t.Fatalf("expected count to normalize to float64, got %T (%v)", obj["count"], obj["count"])
	}
}
