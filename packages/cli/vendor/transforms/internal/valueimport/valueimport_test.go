package valueimport

// Binding resolution, reference construction, and import injection. All pure AST
// — SideParse + a factory, no checker. The Ref is DATA supplied by the test,
// mirroring the config OPTIONAL marker the schema walk threads in.

import (
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimcore "github.com/microsoft/typescript-go/shim/core"
	shimparser "github.com/microsoft/typescript-go/shim/parser"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	shimtspath "github.com/microsoft/typescript-go/shim/tspath"
)

// optionalRef is the (module, export) identity these tests materialize — the same
// one the schema walk uses for the config OPTIONAL wrapper.
var optionalRef = Ref{Module: "@rhombus-std/config", Export: "OPTIONAL"}

// newFactory returns a node factory of the kind the transforms use internally.
func newFactory() *shimast.NodeFactory {
	return shimprinter.NewEmitContext().Factory.AsNodeFactory()
}

// sideParse side-parses standalone TS (no checker) into a SourceFile through an
// absolute virtual name (a non-absolute name panics NewSourceFile). It parses via
// the shim directly rather than through inlinetransform.SideParse — valueimport is
// a lower engine layer than inlinetransform, so it must not import back into it.
func sideParse(t *testing.T, text string) *shimast.SourceFile {
	t.Helper()
	const fileName = "/virtual/x.ts"
	opts := shimast.SourceFileParseOptions{
		FileName: fileName,
		Path:     shimtspath.ToPath(fileName, filepath.Dir(fileName), true),
	}
	sf := shimparser.ParseSourceFile(opts, text, shimcore.ScriptKindTS)
	if sf == nil {
		t.Fatal("ParseSourceFile returned nil")
	}
	return sf
}

// reprint prints a source file back to text, fixing parent pointers first.
func reprint(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	shimast.SetParentInChildrenUnset(sf.AsNode())
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

// TestResolve covers each binding shape the resolver honors: a named import
// (alias honored), a namespace import, and the two "no binding here" cases
// (absent, and imported from a SUBPATH rather than the exact module).
func TestResolve(t *testing.T) {
	cases := []struct {
		name          string
		src           string
		wantLocalName string
		wantNamespace string
		wantInject    bool
	}{
		{
			name:          "named-import",
			src:           `import { OPTIONAL } from '@rhombus-std/config';`,
			wantLocalName: "OPTIONAL",
			wantInject:    false,
		},
		{
			name:          "aliased-named-import",
			src:           `import { OPTIONAL as Opt } from '@rhombus-std/config';`,
			wantLocalName: "Opt",
			wantInject:    false,
		},
		{
			name:          "namespace-import",
			src:           `import * as cfg from '@rhombus-std/config';`,
			wantNamespace: "cfg",
			wantInject:    false,
		},
		{
			name:          "no-module-import",
			src:           `export const x = 1;`,
			wantLocalName: "OPTIONAL",
			wantInject:    true,
		},
		{
			name:          "subpath-not-module",
			src:           `import { OPTIONAL } from '@rhombus-std/config/sub';`,
			wantLocalName: "OPTIONAL",
			wantInject:    true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sf := sideParse(t, tc.src)
			b := Resolve(sf, optionalRef)
			if b.localName != tc.wantLocalName {
				t.Errorf("localName = %q, want %q", b.localName, tc.wantLocalName)
			}
			if b.namespace != tc.wantNamespace {
				t.Errorf("namespace = %q, want %q", b.namespace, tc.wantNamespace)
			}
			if b.injectNamed != tc.wantInject {
				t.Errorf("injectNamed = %v, want %v", b.injectNamed, tc.wantInject)
			}
		})
	}
}

// TestExprNamespace: a namespace binding yields `<ns>.OPTIONAL`, a fresh
// PropertyAccessExpression per call.
func TestExprNamespace(t *testing.T) {
	f := newFactory()
	b := &Binding{namespace: "cfg", ref: optionalRef}

	e1 := b.Expr(f)
	if e1.Kind != shimast.KindPropertyAccessExpression {
		t.Fatalf("Expr.Kind = %v, want PropertyAccessExpression", e1.Kind)
	}
	access := e1.AsPropertyAccessExpression()
	if access.Expression.Text() != "cfg" {
		t.Errorf("namespace identifier = %q, want cfg", access.Expression.Text())
	}
	if access.Name().Text() != optionalRef.Export {
		t.Errorf("member = %q, want OPTIONAL", access.Name().Text())
	}

	e2 := b.Expr(f)
	if e1 == e2 {
		t.Error("Expr must return a FRESH node per call (no aliasing)")
	}
}

// TestExprBare: a non-namespace binding yields a bare Identifier with the local
// name, a fresh node per call.
func TestExprBare(t *testing.T) {
	f := newFactory()
	b := &Binding{localName: "Opt", ref: optionalRef}

	e1 := b.Expr(f)
	if e1.Kind != shimast.KindIdentifier {
		t.Fatalf("Expr.Kind = %v, want Identifier", e1.Kind)
	}
	if e1.Text() != "Opt" {
		t.Errorf("identifier = %q, want Opt", e1.Text())
	}

	e2 := b.Expr(f)
	if e1 == e2 {
		t.Error("Expr must return a FRESH node per call (no aliasing)")
	}
}

// TestEnsureInjects: Used && injectNamed prepends exactly one named import as
// statement[0].
func TestEnsureInjects(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	f := ec.Factory.AsNodeFactory()
	sf := sideParse(t, `export const x = 1;`)
	b := &Binding{Used: true, injectNamed: true, localName: optionalRef.Export, ref: optionalRef}

	out := Ensure(f, sf, b)
	if out.Statements.Nodes[0].Kind != shimast.KindImportDeclaration {
		t.Fatalf("statement[0].Kind = %v, want ImportDeclaration", out.Statements.Nodes[0].Kind)
	}
	text := reprint(ec, out)
	if !strings.Contains(text, `import { OPTIONAL } from "@rhombus-std/config"`) {
		t.Errorf("injected import missing:\n%s", text)
	}
	if got := strings.Count(text, "import {"); got != 1 {
		t.Errorf("expected exactly one injected import, got %d:\n%s", got, text)
	}
}

// TestEnsureNotUsed: !Used returns the file unchanged (same pointer).
func TestEnsureNotUsed(t *testing.T) {
	f := newFactory()
	sf := sideParse(t, `export const x = 1;`)
	b := &Binding{Used: false, injectNamed: true, localName: optionalRef.Export, ref: optionalRef}

	if out := Ensure(f, sf, b); out != sf {
		t.Error("unused binding must leave the file unchanged (same pointer)")
	}
}

// TestEnsureExistingBinding: Used && !injectNamed (an existing binding was found)
// returns the file unchanged.
func TestEnsureExistingBinding(t *testing.T) {
	f := newFactory()
	sf := sideParse(t, `import { OPTIONAL } from '@rhombus-std/config';`)
	b := &Binding{Used: true, injectNamed: false, localName: optionalRef.Export, ref: optionalRef}

	if out := Ensure(f, sf, b); out != sf {
		t.Error("an existing binding must not trigger injection (same pointer)")
	}
}

// TestEnsureMultiple: two Used && injectNamed bindings inject both, in order, and
// a nil / unused binding is skipped.
func TestEnsureMultiple(t *testing.T) {
	ec := shimprinter.NewEmitContext()
	f := ec.Factory.AsNodeFactory()
	sf := sideParse(t, `export const x = 1;`)
	a := &Binding{Used: true, injectNamed: true, ref: Ref{Module: "@scope/a", Export: "A"}}
	skip := &Binding{Used: false, injectNamed: true, ref: Ref{Module: "@scope/b", Export: "B"}}
	c := &Binding{Used: true, injectNamed: true, ref: Ref{Module: "@scope/c", Export: "C"}}

	out := Ensure(f, sf, a, skip, nil, c)
	text := reprint(ec, out)
	if !strings.Contains(text, `import { A } from "@scope/a"`) {
		t.Errorf("A import missing:\n%s", text)
	}
	if !strings.Contains(text, `import { C } from "@scope/c"`) {
		t.Errorf("C import missing:\n%s", text)
	}
	if strings.Contains(text, `@scope/b`) {
		t.Errorf("unused B binding must not inject:\n%s", text)
	}
}
