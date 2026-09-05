package inlinetransform

import (
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// The impl source is parsed with NO program, NO checker, NO module graph — the
// exact "non-driver context" the inline stage extracts bodies from. It contains
// deliberately UNCHECKABLE code (`typefor<T>()`, a property access on `unknown`):
// body extraction is syntax-only, and the consumer program's checker takes over
// only after substitution.
const implSource = `export const ServiceManifestExtensions = {
  isService(receiver: IServiceManifest) {
    return receiver.isService(typefor<T>());
  },
  install(receiver: IServiceManifest) {
    receiver.prepare();
    return receiver.finish();
  },
};
`

// TestSideParseOutsideProgram proves shim/parser parses a standalone .ts source
// from a non-driver context, yielding a walkable AST.
func TestSideParseOutsideProgram(t *testing.T) {
	sf := SideParse("/virtual/impl.ts", implSource)
	if sf == nil {
		t.Fatal("SideParse returned nil for a well-formed source")
	}
	if sf.Statements == nil || len(sf.Statements.Nodes) == 0 {
		t.Fatal("side-parsed source file has no statements")
	}
	// The parse is usable: a top-level const declaration is reachable.
	if findTopLevelDeclaration(sf, "ServiceManifestExtensions") == nil {
		t.Fatal("could not locate the impl declaration in the side-parsed AST")
	}
}

// TestExtractSingleReturnBody proves the body-extraction foundation: a
// single-return-expression member yields its expression, and a multi-statement
// member is rejected by the hygiene shape check (SingleReturnExpression -> nil).
func TestExtractSingleReturnBody(t *testing.T) {
	sf := SideParse("/virtual/impl.ts", implSource)
	if sf == nil {
		t.Fatal("SideParse returned nil")
	}

	body := FindMemberBody(sf, "ServiceManifestExtensions", "isService")
	if body == nil {
		t.Fatal("FindMemberBody did not find the isService member body")
	}
	expr := SingleReturnExpression(body)
	if expr == nil {
		t.Fatal("SingleReturnExpression returned nil for a single-return body")
	}
	got := shimast.NodeText(expr)
	if !strings.Contains(got, "typefor<T>()") || !strings.Contains(got, "receiver.isService") {
		t.Fatalf("extracted expression = %q, want the `receiver.isService(typefor<T>())` body", got)
	}

	// The multi-statement member violates the single-return hygiene rule and must
	// extract to nil rather than silently taking the first statement.
	install := FindMemberBody(sf, "ServiceManifestExtensions", "install")
	if install == nil {
		t.Fatal("FindMemberBody did not find the install member body")
	}
	if SingleReturnExpression(install) != nil {
		t.Fatal("a two-statement body must not yield a single return expression")
	}
}
