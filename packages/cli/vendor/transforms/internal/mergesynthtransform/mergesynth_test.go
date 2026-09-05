package mergesynthtransform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

// fixturePrelude declares local stand-ins for the primitives install functions.
// The stage matches the callee's resolved symbol NAME (alias-followed), so a
// local declaration anchors identically to the real import — no workspace
// linkage needed to exercise the rewrite.
const fixturePrelude = `type MergeStrategy = (original: (...a: unknown[]) => unknown, extension: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown;
export function registerAugmentations(token: string, set: object, merge?: Record<string, MergeStrategy>): void {}
export function applyAugmentations(Ctor: object, set: object, merge?: Record<string, MergeStrategy>): void {}
export interface IAlpha { id: number; }
`

// loadFixture writes a one-file strict project and loads it.
func loadFixture(t *testing.T, source string) (*driver.Program, *shimast.SourceFile) {
	return loadFixtureWith(t, source, nil)
}

// loadFixtureWith writes the same project plus extra files, keyed by their path
// relative to the project root — a `node_modules/...` entry makes the fixture an
// installed package rather than project source.
func loadFixtureWith(t *testing.T, source string, extra map[string]string) (*driver.Program, *shimast.SourceFile) {
	t.Helper()
	root := t.TempDir()
	for path, content := range extra {
		write(t, filepath.Join(root, filepath.FromSlash(path)), content)
	}
	write(t, filepath.Join(root, "app.ts"), fixturePrelude+source)
	write(t, filepath.Join(root, "tsconfig.json"), `{
  "compilerOptions": {
    "target": "ES2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "files": ["app.ts"]
}`)
	prog, diags, err := driver.LoadProgram(root, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("LoadProgram: %v", err)
	}
	if len(diags) != 0 {
		t.Fatalf("config diagnostics: %v", diags)
	}
	for _, sf := range prog.SourceFiles() {
		if strings.HasSuffix(sf.FileName(), "app.ts") {
			return prog, sf
		}
	}
	t.Fatal("app.ts not in program")
	return nil, nil
}

// run applies the stage to the fixture and reprints, mirroring the host's emit
// pipeline (parent fixup + printer bound to the same EmitContext).
func run(t *testing.T, source string) (string, []Diagnostic) {
	return runWith(t, source, nil)
}

func runWith(t *testing.T, source string, extra map[string]string) (string, []Diagnostic) {
	t.Helper()
	prog, sf := loadFixtureWith(t, source, extra)
	defer func() { _ = prog.Close() }()
	var diags []Diagnostic
	transform := New(prog, func(d Diagnostic) { diags = append(diags, d) })
	ec := shimprinter.NewEmitContext()
	out := transform(ec, sf)
	if out == nil {
		out = sf
	}
	shimast.SetParentInChildrenUnset(out.AsNode())
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(out.AsNode(), out, writer, nil)
	return writer.String(), diags
}

func TestSynthesizesGuardedStrategyFromUnionParameter(t *testing.T) {
	out, diags := run(t, `
export const AlphaExtensions = {
  describe(opts: { verbose: boolean } | number): string {
    return String(opts);
  },
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, `registerAugmentations("t:IAlpha", AlphaExtensions, {`) {
		t.Fatalf("no synthesized third argument:\n%s", out)
	}
	if !strings.Contains(out, "describe: function (original, extension)") {
		t.Fatalf("no describe strategy in output:\n%s", out)
	}
	// The typia guard is inlined plain JS: a structural typeof check on the
	// union, with no typia reference of any kind surviving.
	if !strings.Contains(out, "typeof") {
		t.Fatalf("no structural guard emitted:\n%s", out)
	}
	for _, forbidden := range []string{"typia", "createIs"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("emitted output mentions %q:\n%s", forbidden, out)
		}
	}
	// Dispatch shape: guard hit -> extension, miss -> original.
	if !strings.Contains(out, "extension.call(this, ...args)") || !strings.Contains(out, "original.call(this, ...args)") {
		t.Fatalf("dispatcher does not route between extension and original:\n%s", out)
	}
}

func TestHandAuthoredStrategyWinsAndIsNotSynthesized(t *testing.T) {
	out, diags := run(t, `
export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
  tag(name: string): string { return name; },
};
const handMerge = {
  describe(original: (...a: unknown[]) => unknown, extension: (...a: unknown[]) => unknown) {
    return original;
  },
} satisfies Record<string, MergeStrategy>;
registerAugmentations("t:IAlpha", AlphaExtensions, handMerge);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	// Only the uncovered member is synthesized...
	if !strings.Contains(out, "tag: function (original, extension)") {
		t.Fatalf("uncovered member tag not synthesized:\n%s", out)
	}
	if strings.Contains(out, "describe: function (original, extension)") {
		t.Fatalf("hand-covered member describe was synthesized anyway:\n%s", out)
	}
	// ...and the hand-authored object is spread LAST, so it wins at runtime too.
	spread := strings.Index(out, "...handMerge")
	synthesized := strings.Index(out, "tag: function")
	if spread < 0 || synthesized < 0 || spread < synthesized {
		t.Fatalf("hand merge is not spread after the synthesized entries:\n%s", out)
	}
}

func TestFullyCoveredCallIsLeftUntouched(t *testing.T) {
	source := `
export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
};
const handMerge = {
  describe(original: (...a: unknown[]) => unknown, extension: (...a: unknown[]) => unknown) {
    return original;
  },
} satisfies Record<string, MergeStrategy>;
registerAugmentations("t:IAlpha", AlphaExtensions, handMerge);
`
	out, diags := run(t, source)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, `registerAugmentations("t:IAlpha", AlphaExtensions, handMerge);`) {
		t.Fatalf("fully hand-covered call was rewritten:\n%s", out)
	}
}

func TestUnDerivableMemberFallsBackToAlwaysPass(t *testing.T) {
	for name, decl := range map[string]string{
		"generic": `pick<T>(value: T): T { return value; }`,
		"unknown": `pick(value: unknown): unknown { return value; }`,
		"any":     `pick(value: any): unknown { return value; }`,
		"untyped": `pick(value = 1): unknown { return value; }`,
	} {
		out, diags := run(t, `
export const AlphaExtensions = { `+decl+` };
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
		if len(diags) != 0 {
			t.Fatalf("%s: unexpected diagnostics: %+v", name, diags)
		}
		if !strings.Contains(out, "pick: function (original, extension)") {
			t.Fatalf("%s: no pick strategy:\n%s", name, out)
		}
		// The always-pass form: the dispatcher unconditionally runs the
		// extension — no arity or guard conjuncts at all.
		if strings.Contains(out, "args.length") {
			t.Fatalf("%s: un-derivable member gained arity conjuncts:\n%s", name, out)
		}
		if strings.Contains(out, "original.call") {
			t.Fatalf("%s: un-derivable member routes to original:\n%s", name, out)
		}
		if !strings.Contains(out, "extension.call(this, ...args)") {
			t.Fatalf("%s: extension not invoked:\n%s", name, out)
		}
	}
}

func TestOptionalParameterAndArityBounds(t *testing.T) {
	out, diags := run(t, `
export const AlphaExtensions = {
  fmt(a: string, b?: number): string { return a + String(b); },
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, "args.length >= 1") || !strings.Contains(out, "args.length <= 2") {
		t.Fatalf("arity bounds missing:\n%s", out)
	}
	if !strings.Contains(out, "g0(args[0])") {
		t.Fatalf("required-parameter guard missing:\n%s", out)
	}
	if !strings.Contains(out, "args[1] === undefined || g1(args[1])") {
		t.Fatalf("optional-parameter guard missing its absent short-circuit:\n%s", out)
	}
}

func TestRestParameterGuardsTheSliceWithoutUpperBound(t *testing.T) {
	out, diags := run(t, `
export const AlphaExtensions = {
  store(...rest: [key: string] | [key: string, ttl: number]): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, "g0(args.slice(0))") {
		t.Fatalf("rest guard does not validate the slice:\n%s", out)
	}
	if strings.Contains(out, "args.length <=") {
		t.Fatalf("rest member must not carry an upper arity bound:\n%s", out)
	}
}

func TestApplyAugmentationsIsRewrittenToo(t *testing.T) {
	out, diags := run(t, `
export class Alpha implements IAlpha { id = 1; }
export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
};
applyAugmentations(Alpha, AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, "applyAugmentations(Alpha, AlphaExtensions, {") {
		t.Fatalf("applyAugmentations not rewritten:\n%s", out)
	}
}

func TestOpaqueSetExpressionIsLeftUntouched(t *testing.T) {
	out, diags := run(t, `
declare function makeSet(): object;
registerAugmentations("t:IAlpha", makeSet());
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	if !strings.Contains(out, `registerAugmentations("t:IAlpha", makeSet());`) {
		t.Fatalf("opaque set call was rewritten:\n%s", out)
	}
}

func TestGuardValidatesDeepObjectShape(t *testing.T) {
	// The scope contract: object-interface props validate deep. The guard for
	// a MemoryCacheEntryOptions-like bag must check its property types, not
	// just typeof input === "object".
	out, diags := run(t, `
interface EntryOptions { size?: number; sliding?: number; tag: string; }
export const AlphaExtensions = {
  configure(options: EntryOptions): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	for _, needle := range []string{"tag", "size", "sliding"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("deep guard does not mention property %q:\n%s", needle, out)
		}
	}
}

// TestRewrittenInstallSettlesOnSecondPass pins the settle condition that lets
// mergesynth run inside the fixed-point loop: a second pass over a call the
// first pass rewrote is a POINTER-IDENTITY no-op. The delicate shape is the
// hand-merge install — the first pass emits the synthesized entries with the
// hand-authored object spread LAST, and strategyNames recurses through that
// spread, so the second pass reads every member as covered instead of
// re-wrapping the call forever.
func TestRewrittenInstallSettlesOnSecondPass(t *testing.T) {
	prog, sf := loadFixture(t, `
export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
  tag(name: string): string { return name; },
};
const handMerge = {
  describe(original: (...a: unknown[]) => unknown, extension: (...a: unknown[]) => unknown) {
    return original;
  },
} satisfies Record<string, MergeStrategy>;
registerAugmentations("t:IAlpha", AlphaExtensions, handMerge);
`)
	defer func() { _ = prog.Close() }()

	transform := New(prog, func(Diagnostic) {})
	ec := shimprinter.NewEmitContext()

	first := transform(ec, sf)
	if first == nil || first == sf {
		t.Fatal("first pass did not rewrite the hand-merge install")
	}
	shimast.SetParentInChildrenUnset(first.AsNode())
	if strings.Contains(reprintMerge(ec, first), "describe: function (original, extension)") {
		t.Fatal("first pass synthesized the hand-covered describe — hand-authored strategy should win")
	}

	second := transform(ec, first)
	if second != first {
		t.Fatalf("second pass rewrote an already-covered install — the loop would never settle:\n%s", reprintMerge(ec, second))
	}
}

// The plain no-hand-merge install settles the same way: the first pass's fully
// synthesized map covers every member, so the second pass changes nothing.
func TestPlainRewrittenInstallSettlesOnSecondPass(t *testing.T) {
	prog, sf := loadFixture(t, `
export const AlphaExtensions = {
  describe(opts: number): string { return String(opts); },
  tag(name: string): string { return name; },
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	defer func() { _ = prog.Close() }()

	transform := New(prog, func(Diagnostic) {})
	ec := shimprinter.NewEmitContext()

	first := transform(ec, sf)
	if first == nil || first == sf {
		t.Fatal("first pass did not rewrite the install")
	}
	shimast.SetParentInChildrenUnset(first.AsNode())

	second := transform(ec, first)
	if second != first {
		t.Fatalf("second pass rewrote an already-covered install — the loop would never settle:\n%s", reprintMerge(ec, second))
	}
}

// reprintMerge prints a source file through the emit pipeline, matching run's
// printer setup, without reloading a fresh program.
func reprintMerge(ec *shimprinter.EmitContext, sf *shimast.SourceFile) string {
	writer := shimprinter.NewTextWriter("\n", 0)
	printer := shimprinter.NewPrinter(shimprinter.PrinterOptions{}, shimprinter.PrintHandlers{}, ec)
	printer.Write(sf.AsNode(), sf, writer, nil)
	return writer.String()
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIdenticalGuardsReported(t *testing.T) {
	_, diags := run(t, `
export const SetA = {
  read(this: IAlpha, items: Iterable<string>): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetA);

export const SetB = {
  read(this: IAlpha, items: Iterable<number>): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetB);
`)
	found := false
	for _, d := range diags {
		if d.Code == "MERGESYNTH_INDISTINGUISHABLE_GUARDS" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected MERGESYNTH_INDISTINGUISHABLE_GUARDS, got %+v", diags)
	}
}

func TestDifferentGuardsNotReported(t *testing.T) {
	_, diags := run(t, `
export const SetA = {
  read(this: IAlpha, items: Iterable<string>): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetA);

export const SetB = {
  read(this: IAlpha, items: string): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetB);
`)
	for _, d := range diags {
		if d.Code == "MERGESYNTH_INDISTINGUISHABLE_GUARDS" {
			t.Fatalf("should not report MERGESYNTH_INDISTINGUISHABLE_GUARDS for different parameter types, got %+v", diags)
		}
	}
}

func TestLoneIterableNotReported(t *testing.T) {
	_, diags := run(t, `
export const SetA = {
  read(this: IAlpha, items: Iterable<string>): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetA);
`)
	for _, d := range diags {
		if d.Code == "MERGESYNTH_INDISTINGUISHABLE_GUARDS" {
			t.Fatalf("should not report MERGESYNTH_INDISTINGUISHABLE_GUARDS for a lone iterable overload, got %+v", diags)
		}
	}
}

func TestIterableGuardChecksSymbolIterator(t *testing.T) {
	out, _ := run(t, `
export const SetA = {
  read(this: IAlpha, items: Iterable<string>): void {},
} satisfies Record<string, (...a: any[]) => any>;
registerAugmentations("t:IAlpha", SetA);
`)
	if !strings.Contains(out, "Symbol.iterator") {
		t.Fatalf("iterable guard must check Symbol.iterator:\n%s", out)
	}
}
