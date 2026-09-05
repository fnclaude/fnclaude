package typefortransform

import (
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
)

// parseImportFixture side-parses standalone TS source into a SourceFile AST — no
// program, no checker — for the pure-AST import-elision cases below. It routes
// through an absolute filename (shim derives a canonical Path from it).
func parseImportFixture(t *testing.T, text string) *shimast.SourceFile {
	t.Helper()
	sf := inlinetransform.SideParse("/elide.ts", text)
	if sf == nil {
		t.Fatal("SideParse returned nil")
	}
	return sf
}

// reprintSF prints a source file back to text through the same emit pipeline the
// host uses, after fixing up parent pointers on the mixed original/synthetic tree.
func reprintSF(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	shimast.SetParentInChildrenUnset(sf.AsNode())
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

// TestElideTypeforImports covers the whole-file elision pass over each import
// shape: a `typefor` binding is dropped (whole decl when sole, the specifier
// alone otherwise, aliased or not), while a type-position binding — a `type`
// specifier modifier or an `import type` phase modifier — is preserved (it has
// no runtime reference to strip).
func TestElideTypeforImports(t *testing.T) {
	cases := []struct {
		name    string
		src     string
		absent  []string
		present []string
	}{
		{
			name:    "sole-binding-drops-whole-decl",
			src:     "import { typefor } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{"typefor", "@rhombus-std/primitives.extras"},
			present: []string{"export const x = 1"},
		},
		{
			name:    "partial-keeps-sibling",
			src:     "import { typefor, schemaof } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{"typefor"},
			present: []string{"schemaof", "@rhombus-std/primitives.extras"},
		},
		{
			name:    "aliased-exported-name-drops",
			src:     "import { typefor as tf } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{"typefor", "tf"},
			present: []string{"export const x = 1"},
		},
		{
			name:    "type-only-specifier-kept",
			src:     "import { type typefor } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{},
			present: []string{"typefor"},
		},
		{
			name:    "import-type-phase-modifier-kept",
			src:     "import type { typefor } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{},
			present: []string{"typefor"},
		},
		{
			name:    "default-plus-named-drops-named-keeps-default",
			src:     "import def, { typefor } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n",
			absent:  []string{"typefor"},
			present: []string{"def", "@rhombus-std/primitives.extras"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ec := shimprinter.NewEmitContext()
			sf := parseImportFixture(t, tc.src)
			out := elideTypeforImports(ec.Factory.AsNodeFactory(), sf)
			got := reprintSF(ec, out)
			for _, s := range tc.absent {
				if strings.Contains(got, s) {
					t.Errorf("expected %q to be elided, got:\n%s", s, got)
				}
			}
			for _, s := range tc.present {
				if !strings.Contains(got, s) {
					t.Errorf("expected %q to survive, got:\n%s", s, got)
				}
			}
		})
	}
}

// TestElideTypeforImportsPassthrough: a file with no `typefor` value binding is
// returned UNCHANGED — same source-file pointer (changed==false), covering both
// a non-import statement and an import without the binding.
func TestElideTypeforImportsPassthrough(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	sf := parseImportFixture(t, "import { schemaof } from '@rhombus-std/primitives.extras';\nexport const x = 1;\n")
	out := elideTypeforImports(ec.Factory.AsNodeFactory(), sf)
	if out != sf {
		t.Fatal("a file with no typefor binding must be returned unchanged (same pointer)")
	}
}

// firstNamedImportSpecifiers returns the named-import specifier element nodes of
// the first import declaration in sf.
func firstNamedImportSpecifiers(t *testing.T, sf *shimast.SourceFile) []*shimast.Node {
	t.Helper()
	for _, stmt := range sf.Statements.Nodes {
		if stmt.Kind != shimast.KindImportDeclaration {
			continue
		}
		clause := stmt.AsImportDeclaration().ImportClause
		if clause == nil {
			continue
		}
		bindings := clause.AsImportClause().NamedBindings
		if bindings == nil || bindings.Kind != shimast.KindNamedImports {
			continue
		}
		return bindings.AsNamedImports().Elements.Nodes
	}
	t.Fatal("no named-import specifiers found")
	return nil
}

// TestExportedName: the exported name of a specifier is its PROPERTY name when
// aliased (`typefor as tf` -> "typefor"), else its local name.
func TestExportedName(t *testing.T) {
	sf := parseImportFixture(t, "import { typefor as tf, schemaof } from '@rhombus-std/primitives.extras';\n")
	specs := firstNamedImportSpecifiers(t, sf)
	if len(specs) != 2 {
		t.Fatalf("expected 2 specifiers, got %d", len(specs))
	}
	if got := exportedName(specs[0]); got != "typefor" {
		t.Errorf("aliased specifier exportedName = %q, want typefor", got)
	}
	if got := exportedName(specs[1]); got != "schemaof" {
		t.Errorf("plain specifier exportedName = %q, want schemaof", got)
	}
}
