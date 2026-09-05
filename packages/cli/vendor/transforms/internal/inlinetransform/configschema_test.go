package inlinetransform

import (
	"os"
	"strings"
	"testing"
)

// TestEmbeddedSchemaMatchesCanonical: the embedded rhombus-std.schema.json
// (go:embed can't reach outside this module, so a copy lives here) must stay
// byte-identical to the canonical schema/rhombus-std.schema.json at the repo
// root — the one every other consumer (ajv, docs, a future release asset)
// reads.
func TestEmbeddedSchemaMatchesCanonical(t *testing.T) {
	canonical, err := os.ReadFile("../../../schema/rhombus-std.schema.json")
	if err != nil {
		t.Fatalf("reading the canonical schema: %v", err)
	}
	if string(canonical) != string(rhombusStdSchemaBytes) {
		t.Fatal("transforms/internal/inlinetransform/rhombus-std.schema.json has drifted from schema/rhombus-std.schema.json — copy the canonical file over it")
	}
}

func TestValidateConfigNodeAcceptsEveryEntryRow(t *testing.T) {
	rows := []map[string]any{
		{"type": "p:T", "impl": "p:Impl", "member": "m"}, // instance member, ambient
		{"type": "p:T", "member": "m"},                   // instance member, own body
		{"impl": "p:Impl", "member": "m"},                // static member
		{"impl": "p:Impl"},                               // floater
	}
	for _, row := range rows {
		node := map[string]any{"inline": map[string]any{"entries": []any{row}}}
		if err := validateConfigNode(node, "test"); err != nil {
			t.Fatalf("expected %+v to validate, got %v", row, err)
		}
	}
}

func TestValidateConfigNodeRejectsUnknownEntryShape(t *testing.T) {
	node := map[string]any{"inline": map[string]any{"entries": []any{
		map[string]any{"type": "p:T", "impl": "p:Impl"}, // no member: no row matches
	}}}
	err := validateConfigNode(node, "test.json")
	if err == nil {
		t.Fatal("expected a schema validation error")
	}
	if !strings.Contains(err.Error(), "INLINE_CONFIG_SCHEMA") || !strings.Contains(err.Error(), "test.json") {
		t.Fatalf("want an INLINE_CONFIG_SCHEMA error naming test.json, got %v", err)
	}
}
