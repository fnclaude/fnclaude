package schemaoftransform

// Behavior tests for the schemaof primitive stage: the expanded `Type` tree it
// emits for each shape, the stage wiring around it (artifacts vs source-written
// anchoring, the call-node replacement, `Type` import materialization), the
// targeted failure diagnostics, and loop stability.
//
// The expansion goldens are the parity oracle: each is exactly what an author
// would have written by hand with the Type factories for the same interface.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/inlinetransform"
	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/tokens"
)

// ambient declares the `schemaof` primitive so a source-written `schemaof<T>()`
// resolves to a symbol of that name.
const ambient = `declare function schemaof<T>(): unknown;
`

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// loadProgram writes the ambient declaration + a main.ts and loads a checked
// program.
func loadProgram(t *testing.T, mainSrc string) (*driver.Program, *shimast.SourceFile) {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "lib": ["ES2022"], "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["ambient.d.ts", "main.ts"]
}
`)
	writeFile(t, filepath.Join(root, "ambient.d.ts"), ambient)
	writeFile(t, filepath.Join(root, "main.ts"), mainSrc)

	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("program diagnostics: %v", diags)
	}
	if prog.Checker == nil {
		t.Fatal("no checker")
	}
	var main *shimast.SourceFile
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), "main.ts") {
			main = sf
		}
	}
	if main == nil {
		t.Fatal("main.ts not found")
	}
	return prog, main
}

func reprint(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	shimast.SetParentInChildrenUnset(sf.AsNode())
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

// tokenContext is the derivation context the stage threads into the expansion.
// The project root is the temp dir the fixture lives under, so a type declared in
// main.ts derives a rootless `./main` source.
func tokenContext(prog *driver.Program, sf *shimast.SourceFile) *tokens.Context {
	return &tokens.Context{
		Checker:     prog.Checker,
		ProjectRoot: filepath.Dir(sf.FileName()),
		IsDefaultLib: func(f *shimast.SourceFile) bool {
			return strings.Contains(f.FileName(), "lib.")
		},
	}
}

// lowerSchemaof runs the schemaof stage (source-written anchoring, artifacts=nil)
// over main.ts and returns the reprinted output plus diagnostics.
func lowerSchemaof(t *testing.T, prog *driver.Program, sf *shimast.SourceFile) (string, []plugin.Diagnostic) {
	t.Helper()
	var diags []plugin.Diagnostic
	transform := New(prog, tokenContext(prog, sf), nil, nil, func(d plugin.Diagnostic) { diags = append(diags, d) })
	ec := shimprinter.NewEmitContext()
	return reprint(ec, transform(ec, sf)), diags
}

// expressionAfter extracts the balanced parenthesized expression that follows
// marker in s — the whole `Type.object(...)` tree, free of its surrounding
// syntax — with runs of whitespace collapsed so the printer's line breaking does
// not enter the comparison.
func expressionAfter(t *testing.T, s, marker string) string {
	t.Helper()
	i := strings.Index(s, marker)
	if i < 0 {
		t.Fatalf("marker %q not found in:\n%s", marker, s)
	}
	rest := s[i+len(marker):]
	open := strings.IndexByte(rest, '(')
	if open < 0 {
		t.Fatalf("no `(` after %q in:\n%s", marker, s)
	}
	depth := 0
	for j := open; j < len(rest); j++ {
		switch rest[j] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return strings.Join(strings.Fields(rest[open:j+1]), " ")
			}
		}
	}
	t.Fatalf("unbalanced parentheses after %q in:\n%s", marker, s)
	return ""
}

// TestSchemaofExpansion pins the tree each shape expands to — byte-for-byte what
// a hand-writer would spell with the Type factories.
func TestSchemaofExpansion(t *testing.T) {
	cases := []struct {
		name  string
		iface string
		want  string
	}{
		{
			name:  "flat-leaves",
			iface: `s: string; n: number; b: boolean`,
			want:  `({ s: Type.global("string"), n: Type.global("number"), b: Type.global("boolean") })`,
		},
		{
			name:  "nested-casing",
			iface: `Server: { Host: string; Port: number }`,
			want:  `({ Server: Type.object({ Host: Type.global("string"), Port: Type.global("number") }) })`,
		},
		{
			name:  "optional-boolean",
			iface: `ssl?: boolean`,
			want:  `({ ssl: Type.union(Type.global("boolean"), Type.typeLiteral(undefined)) })`,
		},
		{
			name:  "literal-union",
			iface: `mode: "fast" | "slow"`,
			want:  `({ mode: Type.union(Type.typeLiteral("fast"), Type.typeLiteral("slow")) })`,
		},
		{
			name:  "array",
			iface: `tags: string[]`,
			want:  `({ tags: Type.global("Array", [Type.global("string")]) })`,
		},
		{
			name:  "tuple",
			iface: `pair: [string, number]`,
			want:  `({ pair: Type.tuple(Type.global("string"), Type.global("number")) })`,
		},
		{
			name:  "non-identifier-key",
			iface: `"content-root": string`,
			want:  `({ "content-root": Type.global("string") })`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := `interface C { ` + tc.iface + ` }
export const s = schemaof<C>();
`
			prog, sf := loadProgram(t, src)
			defer func() { _ = prog.Close() }()

			out, diags := lowerSchemaof(t, prog, sf)
			if len(diags) != 0 {
				t.Fatalf("unexpected diagnostics: %v\n%s", diags, out)
			}
			if got := expressionAfter(t, out, "s = Type.object"); got != tc.want {
				t.Errorf("expansion mismatch:\n got: %s\nwant: %s", got, tc.want)
			}
			if strings.Contains(out, "schemaof<") {
				t.Errorf("schemaof call not lowered:\n%s", out)
			}
		})
	}
}

// TestSchemaofStopsAtNamedMembers is the expansion's terminating rule: a member
// whose type has a name of its own keeps it — the type is NOT opened up, so a
// self-referential shape terminates by construction.
func TestSchemaofStopsAtNamedMembers(t *testing.T) {
	src := `interface Inner { deep: string }
interface C { inner: Inner; self?: C }
export const s = schemaof<C>();
`
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	out, diags := lowerSchemaof(t, prog, sf)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %v\n%s", diags, out)
	}
	tree := expressionAfter(t, out, "s = Type.object")
	if !strings.Contains(tree, `inner: Type.imported("Inner", "./main")`) {
		t.Errorf("a named member must stay an address:\n%s", tree)
	}
	if strings.Contains(tree, "deep") {
		t.Errorf("expansion ran past a name:\n%s", tree)
	}
	if !strings.Contains(tree, `Type.imported("C", "./main")`) {
		t.Errorf("a self-reference must stay an address:\n%s", tree)
	}
}

// TestSchemaofInjectsTypeImport: the tree is spelled through the runtime `Type`
// namespace object, so the stage materializes its import.
func TestSchemaofInjectsTypeImport(t *testing.T) {
	src := `interface C { host: string }
export const s = schemaof<C>();
`
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	out, diags := lowerSchemaof(t, prog, sf)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %v", diags)
	}
	if !strings.Contains(out, `import { Type } from "@rhombus-std/primitives"`) {
		t.Errorf("named Type import not injected:\n%s", out)
	}
}

// TestSchemaofHonorsExistingTypeBinding: an existing aliased `Type` import is
// honored (referenced by its local name), and no second import is injected.
func TestSchemaofHonorsExistingTypeBinding(t *testing.T) {
	src := `import { Type as T } from "@rhombus-std/primitives";
void T;
interface C { host: string }
export const s = schemaof<C>();
`
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	out, _ := lowerSchemaof(t, prog, sf)
	if !strings.Contains(out, `s = T.object(`) {
		t.Errorf("aliased Type binding not honored:\n%s", out)
	}
	if strings.Contains(out, `import { Type }`) {
		t.Errorf("must not inject a second Type import:\n%s", out)
	}
}

// TestSchemaofRejections walks the shapes the Type grammar cannot spell and the
// non-object root: each raises its targeted code and leaves the `schemaof<T>()`
// call UN-LOWERED — never a silent partial, never the generic sweep error.
func TestSchemaofRejections(t *testing.T) {
	cases := []struct {
		name     string
		iface    string
		root     string
		wantCode string
	}{
		{"callable-member", `fn: () => void`, "C", CodeUnsupportedType},
		{"index-signature-member", `bag: { [k: string]: string }`, "C", CodeUnsupportedType},
		{"non-object-root", ``, "string", CodeNonObjectRoot},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var src string
			if tc.root == "string" {
				src = "export const s = schemaof<string>();\n"
			} else {
				src = `interface C { ` + tc.iface + ` }
export const s = schemaof<C>();
`
			}
			prog, sf := loadProgram(t, src)
			defer func() { _ = prog.Close() }()

			out, diags := lowerSchemaof(t, prog, sf)
			if len(diags) == 0 {
				t.Fatalf("expected a diagnostic for %s, got none:\n%s", tc.name, out)
			}
			if diags[0].Code != tc.wantCode {
				t.Errorf("code = %q, want %q", diags[0].Code, tc.wantCode)
			}
			if !strings.Contains(out, "schemaof<") {
				t.Errorf("unsupported shape must leave the call un-lowered:\n%s", out)
			}
			if strings.Contains(out, "Type.object(") {
				t.Errorf("no partial rewrite allowed:\n%s", out)
			}
		})
	}
}

// TestSchemaofFailureEmitsOncePerNode pins the loop-dedupe contract: re-running
// the stage over its own un-lowered output (the shape the fixed-point loop hands
// back every pass) must NOT re-emit the failure diagnostic — a per-run set keyed
// on the surviving call node emits exactly once.
func TestSchemaofFailureEmitsOncePerNode(t *testing.T) {
	src := `interface C { fn: () => void }
export const s = schemaof<C>();
`
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	var diags []plugin.Diagnostic
	transform := New(prog, tokenContext(prog, sf), nil, nil, func(d plugin.Diagnostic) { diags = append(diags, d) })
	ec := shimprinter.NewEmitContext()

	first := transform(ec, sf)
	if got := len(diags); got != 1 {
		t.Fatalf("pass 1 emitted %d diagnostics, want 1", got)
	}
	shimast.SetParentInChildrenUnset(first.AsNode())
	second := transform(ec, first)
	if got := len(diags); got != 1 {
		t.Errorf("pass 2 re-emitted the failure (total %d), want 1 — the loop-dedupe failed", got)
	}
	if second != first {
		t.Errorf("stage re-fired on its own un-lowered output (returned %p, want %p)", second, first)
	}
}

// TestSchemaofSettlesUnderLoop drives the stage through the real fixed-point
// runner and asserts it settles (does not exhaust) with the tree fully expanded
// and the `Type` import injected once, then is a no-op on the settled tree.
func TestSchemaofSettlesUnderLoop(t *testing.T) {
	src := `interface C { host: string; ssl?: boolean }
export const s = schemaof<C>();
`
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	ec := shimprinter.NewEmitContext()
	stage := New(prog, tokenContext(prog, sf), nil, nil, func(plugin.Diagnostic) {})
	settled, passes, exhausted := plugin.RunToFixedPoint(ec, []plugin.FileTransform{stage}, sf, 16)
	if exhausted {
		t.Fatal("schemaof stage exhausted maxPasses — not identity-preserving on a no-op")
	}
	if passes > 3 {
		t.Errorf("settled in %d passes, expected <= 3", passes)
	}
	out := reprint(ec, settled)
	if strings.Contains(out, "schemaof<") {
		t.Errorf("schemaof not expanded after settle:\n%s", out)
	}
	if strings.Count(out, `import { Type }`) != 1 {
		t.Errorf("expected exactly one injected Type import:\n%s", out)
	}
	// Re-run once over the settled tree: identical pointer (no-op).
	if again := stage(ec, settled); again != settled {
		t.Errorf("schemaof re-fired on settled output (returned %p, want %p)", again, settled)
	}
}

// TestSchemaofArtifactsAnchoringMatchesSourceWritten proves the PRIMARY (inline)
// anchoring path: the same `schemaof<T>()` node expanded via the artifacts branch
// (a registered PrimitiveUse carrying the bound type) produces output identical to
// the source-written branch. This is the branch the inline `.withType` body
// exercises in production, where the substituted callee carries no checker symbol.
func TestSchemaofArtifactsAnchoringMatchesSourceWritten(t *testing.T) {
	src := `interface C { host: string; ssl?: boolean }
export const s = schemaof<C>();
`
	prog, sfSource := loadProgram(t, src)
	defer func() { _ = prog.Close() }()
	sourceOut, _ := lowerSchemaof(t, prog, sfSource)

	// Reload a fresh program so the artifacts run starts from an un-lowered tree.
	prog2, sf2 := loadProgram(t, src)
	defer func() { _ = prog2.Close() }()

	call := findCall(sf2.AsNode(), func(c *shimast.CallExpression) bool {
		return c.Expression.Kind == shimast.KindIdentifier && c.Expression.Text() == "schemaof"
	})
	if call == nil {
		t.Fatal("schemaof call not found in fixture")
	}
	typeArg := call.AsCallExpression().TypeArguments.Nodes[0]
	boundType := prog2.Checker.GetTypeFromTypeNode(typeArg)

	artifacts := inlinetransform.NewArtifacts()
	artifacts.Active = true
	artifacts.PrimitiveCalls[call] = inlinetransform.PrimitiveUse{
		Name:     "schemaof",
		TypeArgs: []*shimchecker.Type{boundType},
	}

	var diags []plugin.Diagnostic
	transform := New(prog2, tokenContext(prog2, sf2), artifacts, nil, func(d plugin.Diagnostic) { diags = append(diags, d) })
	ec := shimprinter.NewEmitContext()
	artifactsOut := reprint(ec, transform(ec, sf2))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics on artifacts path: %v", diags)
	}
	want := expressionAfter(t, sourceOut, "s = Type.object")
	if got := expressionAfter(t, artifactsOut, "s = Type.object"); got != want {
		t.Errorf("artifacts-anchored tree differs from source-written:\n got: %s\nwant: %s", got, want)
	}
}

// findCall returns the first CallExpression (pre-order) satisfying pred, or nil.
func findCall(root *shimast.Node, pred func(*shimast.CallExpression) bool) *shimast.Node {
	var found *shimast.Node
	var walk func(n *shimast.Node)
	walk = func(n *shimast.Node) {
		if n == nil || found != nil {
			return
		}
		if n.Kind == shimast.KindCallExpression && pred(n.AsCallExpression()) {
			found = n
			return
		}
		n.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return found != nil
		})
	}
	walk(root)
	return found
}
