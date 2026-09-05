package mergesynthtransform

// A synthesized guard must key on a type's PUBLIC surface. A `#`-named field is
// not a string-keyed property at runtime, so a clause reading one can never be
// false — a guard built from such keys accepts objects that are not of the type
// at all. These pin that the guard keys on the accessors instead, and that the
// cases composition cannot reach are refused loudly rather than approximated.

import (
	"strings"
	"testing"

	shimprinter "github.com/microsoft/typescript-go/shim/printer"
)

const accessorClassFixture = `
export class Opts {
  #value: number | undefined = undefined;
  public get value(): number | undefined { return this.#value; }
  public set value(v: number | undefined) { this.#value = v; }
  public plain: string = "x";
  private tsPriv: number = 1;
}
export const AlphaExtensions = {
  setOptions(o: Opts | number): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`

// strategyText returns the emitted text from a member's strategy onward.
func strategyText(t *testing.T, out, memberName string) string {
	t.Helper()
	idx := strings.Index(out, memberName+":")
	if idx < 0 {
		t.Fatalf("no synthesized %s strategy:\n%s", memberName, out)
	}
	return out[idx:]
}

func TestGuardKeysOnPublicAccessorNotBackingField(t *testing.T) {
	out, diags := run(t, accessorClassFixture)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")

	if !strings.Contains(guard, "input.value") {
		t.Errorf("public accessor `value` absent from the guard:\n%s", guard)
	}
	if !strings.Contains(guard, "input.plain") {
		t.Errorf("public property `plain` absent from the guard:\n%s", guard)
	}
	if strings.Contains(guard, "tsPriv") {
		t.Errorf("guard keys on a `private`-modifier member:\n%s", guard)
	}
	// The union's other arm still dispatches.
	if !strings.Contains(guard, `"number" === typeof input`) {
		t.Errorf("the `number` arm of the union is not guarded:\n%s", guard)
	}
}

// A `#`-named key reaches the emit as the checker's mangled internal name, whose
// leading byte prints as the Unicode replacement character. No emitted artifact
// may ever carry one.
func TestNoMangledPrivateKeyReachesTheEmit(t *testing.T) {
	out, _ := run(t, accessorClassFixture)
	assertNoMangledKey(t, out)
}

func TestAccessorOnlyClassContributesRealClauses(t *testing.T) {
	out, diags := run(t, `
export class AccessorOnly {
  public get a(): number { return 1; }
  public get b(): string { return "x"; }
}
export const AlphaExtensions = {
  setOptions(o: AccessorOnly): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.a") || !strings.Contains(guard, "input.b") {
		t.Errorf("accessors contribute no guard clause — the object branch accepts anything:\n%s", guard)
	}
}

// An accessor-bearing class nested inside a plain interface composes through.
func TestNestedAccessorClassComposesThrough(t *testing.T) {
	out, diags := run(t, `
export class Opts {
  #value: number = 0;
  public get value(): number { return this.#value; }
}
export interface Wrapper { opts: Opts; label: string; }
export const AlphaExtensions = {
  setOptions(w: Wrapper): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.opts") || !strings.Contains(guard, "input.value") {
		t.Errorf("the nested accessor class did not compose:\n%s", guard)
	}
	assertNoMangledKey(t, guard)
}

// An array of an accessor-bearing class composes element-wise.
func TestAccessorClassArrayComposesElementWise(t *testing.T) {
	out, diags := run(t, `
export class Opts {
  #value: number = 0;
  public get value(): number { return this.#value; }
}
export const AlphaExtensions = {
  setOptions(all: Opts[]): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "Array.isArray(input)") || !strings.Contains(guard, ".every(") {
		t.Errorf("the array was not decomposed element-wise:\n%s", guard)
	}
	if !strings.Contains(guard, "input.value") {
		t.Errorf("the element's accessor is not guarded:\n%s", guard)
	}
}

// A class with no public members at all has no clause to key on: report it, and
// keep the object floor rather than emit either a guard that passes everything or
// no guard at all.
func TestPrivateOnlyClassKeepsTheObjectFloorWithADiagnostic(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, `
export class Sealed {
  #a: number = 0;
  #b: string = "";
}
export const AlphaExtensions = {
  setOptions(o: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	assertObjectFloor(t, guard)
	assertNoMangledKey(t, out)
}

// A Map is checked the way a hand-written guard checks one — `instanceof` plus
// its entries — so a diverging value type costs neither the container's check nor
// the entry walk.
func TestDivergingTypeInsideAMapComposes(t *testing.T) {
	out, diags := run(t, `
export class Opts {
  #value: number = 0;
  public get value(): number { return this.#value; }
}
export const AlphaExtensions = {
  setOptions(all: Map<string, Opts>): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input instanceof Map") {
		t.Errorf("the Map is not checked nominally:\n%s", guard)
	}
	if !strings.Contains(guard, "input.value") {
		t.Errorf("the diverging value type's accessor is not guarded:\n%s", guard)
	}
	assertNoMangledKey(t, out)
}

// The fast path is untouched: a type with a wholly ordinary public surface still
// goes straight to typia, with no diagnostic.
func TestAllPublicClassTakesTheUnchangedFastPath(t *testing.T) {
	out, diags := run(t, `
export class Plain {
  public host: string = "";
  public port: number = 0;
}
export const AlphaExtensions = {
  setOptions(o: Plain): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	// typia's own object programmer names its per-object helper `_io0`; the
	// composed path never emits one.
	if !strings.Contains(guard, "_io0") {
		t.Errorf("the fast path did not run for an all-public class:\n%s", guard)
	}
}

func assertNoMangledKey(t *testing.T, out string) {
	t.Helper()
	if strings.ContainsRune(out, '�') || strings.Contains(out, `�`) {
		t.Errorf("a mangled private-identifier key reached the emit:\n%s", out)
	}
	if strings.Contains(out, "@#") {
		t.Errorf("a private-identifier index key reached the emit:\n%s", out)
	}
}

// assertObjectFloor pins the weakest honest check a guard over an object type
// keeps whatever it had to leave unchecked: a value of the wrong runtime kind
// still falls through to whatever held the member name before.
//
// Both `typeof` alternatives are required. A function is a value of an object
// type, so a floor that admits only `"object"` is FALSE for genuine values —
// which does not weaken dispatch, it inverts it.
func assertObjectFloor(t *testing.T, guard string) {
	t.Helper()
	if !strings.Contains(guard, `typeof input === "object"`) || !strings.Contains(guard, "input !== null") {
		t.Errorf("the guard dropped the object floor, so a non-object now dispatches to the extension:\n%s", guard)
	}
	if !strings.Contains(guard, `typeof input === "function"`) {
		t.Errorf("the floor rejects a function, which is a value of an object type:\n%s", guard)
	}
}

func assertPrivateSurfaceWarning(t *testing.T, diags []Diagnostic) {
	t.Helper()
	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			if d.Category != Warning {
				t.Errorf("MERGESYNTH_PRIVATE_SURFACE is %v; want Warning", d.Category)
			}
			return
		}
	}
	t.Errorf("no MERGESYNTH_PRIVATE_SURFACE diagnostic; got %+v", diags)
}

// A COMPUTED name is not a symbol name. `["a-b"]` evaluates to an ordinary
// string, so the member has a key to read and belongs in the guard; only a name
// that evaluates to a symbol has none.
func TestStringComputedNameKeepsItsClause(t *testing.T) {
	out, diags := run(t, `
export class CK { ["a-b"]: string = ""; tag: string = ""; }
export const AlphaExtensions = {
  setOptions(o: CK): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, `input["a-b"]`) {
		t.Errorf("a string-named member was dropped as symbol-keyed:\n%s", guard)
	}
	if !strings.Contains(guard, "input.tag") {
		t.Errorf("the sibling member lost its clause:\n%s", guard)
	}
}

// The symbol case it has to stay distinct from: a `unique symbol` name carries
// no string key, so the member is skipped and the refusal reported.
func TestSymbolComputedNameIsStillRefused(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, `
const MARK: unique symbol = Symbol("m");
export class SK { [MARK]: string = ""; tag: string = ""; }
export const AlphaExtensions = {
  setOptions(o: SK): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "MARK") || strings.Contains(guard, "@@") {
		t.Errorf("a symbol-named member reached the emit as a key:\n%s", guard)
	}
	if !strings.Contains(guard, "input.tag") {
		t.Errorf("the sibling member lost its clause:\n%s", guard)
	}
}

// TestPrivateSurfaceDefaultIsSilent: the default (no TTSC_MERGESYNTH_VERBOSE)
// path reports NOTHING for a weakened guard — no per-member diagnostic and no
// summary either, per the owner's ruling that build output must carry no
// mergesynth private-surface noise by default.
func TestPrivateSurfaceDefaultIsSilent(t *testing.T) {
	_, diags := run(t, `
const MARK: unique symbol = Symbol("m");
export class SK { [MARK]: string = ""; tag: string = ""; }
export class Sealed { #a: number = 0; #b: string = ""; }
export const AlphaExtensions = {
  setOptions(o: SK): void {},
  setOther(o: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)

	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			t.Errorf("default path must emit no MERGESYNTH_PRIVATE_SURFACE diagnostic, got %+v", d)
		}
	}
}

// TestPrivateSurfaceVerboseEmitsPerMemberDetail: TTSC_MERGESYNTH_VERBOSE=1
// restores the per-member diagnostics, one per weakened member, each labeled
// with its declaring receiver type and naming its own weakened arg position
// and type spelling rather than bare unattributed prose.
func TestPrivateSurfaceVerboseEmitsPerMemberDetail(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	_, diags := run(t, `
const MARK: unique symbol = Symbol("m");
export class SK { [MARK]: string = ""; tag: string = ""; }
export class Sealed { #a: number = 0; #b: string = ""; }
export const AlphaExtensions = {
  setOptions(o: SK): void {},
  setOther(o: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)

	var surface []Diagnostic
	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			surface = append(surface, d)
		}
	}
	if len(surface) != 2 {
		t.Fatalf("want 2 per-member MERGESYNTH_PRIVATE_SURFACE diagnostics under verbose mode, got %d: %+v", len(surface), surface)
	}
	for _, d := range surface {
		if !strings.Contains(d.Message, "merge guard for ") || !strings.Contains(d.Message, "cannot fully check: ") {
			t.Errorf("verbose diagnostic did not use the per-member wording: %q", d.Message)
		}
		if !strings.Contains(d.Message, "arg 0 (") {
			t.Errorf("verbose diagnostic did not name the weakened arg's position: %q", d.Message)
		}
	}
	if !strings.Contains(surface[0].Message, `"setOptions"`) && !strings.Contains(surface[1].Message, `"setOptions"`) {
		t.Errorf("no diagnostic named setOptions: %+v", surface)
	}
	if !strings.Contains(surface[0].Message, `"setOther"`) && !strings.Contains(surface[1].Message, `"setOther"`) {
		t.Errorf("no diagnostic named setOther: %+v", surface)
	}
}

// TestPrivateSurfaceVerboseNamesEveryWeakenedPosition: a member with MORE
// THAN ONE weakened parameter gets one diagnostic listing every one of them —
// not just the first, the way a single `guard.reason` string would collapse
// to — each tagged with its own arg index and declared type spelling.
func TestPrivateSurfaceVerboseNamesEveryWeakenedPosition(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	_, diags := run(t, `
export class SK { #a: number = 0; }
export class Sealed { #b: string = ""; }
export interface IAlphaExt { setBoth(a: SK, b: Sealed): void; }
export const AlphaExtensions: IAlphaExt = {
  setBoth(a: SK, b: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)

	var surface []Diagnostic
	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			surface = append(surface, d)
		}
	}
	if len(surface) != 1 {
		t.Fatalf("want exactly 1 diagnostic for the whole member, got %d: %+v", len(surface), surface)
	}
	msg := surface[0].Message
	if !strings.Contains(msg, `"setBoth"`) {
		t.Errorf("diagnostic does not name the member: %q", msg)
	}
	if !strings.Contains(msg, "arg 0 (SK)") {
		t.Errorf("diagnostic does not name arg 0's position and type: %q", msg)
	}
	if !strings.Contains(msg, "arg 1 (Sealed)") {
		t.Errorf("diagnostic does not name arg 1's position and type: %q", msg)
	}
}

// TestPrivateSurfaceVerboseLabelsTheDeclaringReceiver: a member whose
// implementation declares an explicit `this` parameter — the shape every
// real registerAugmentations body takes — labels its diagnostic
// "Receiver.member", not just the bare member name.
func TestPrivateSurfaceVerboseLabelsTheDeclaringReceiver(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	_, diags := run(t, `
export class Sealed { #a: number = 0; }
export const AlphaExtensions = {
  setOptions(this: IAlpha, o: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)

	var surface []Diagnostic
	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			surface = append(surface, d)
		}
	}
	if len(surface) != 1 {
		t.Fatalf("want exactly 1 diagnostic, got %d: %+v", len(surface), surface)
	}
	if !strings.Contains(surface[0].Message, `"IAlpha.setOptions"`) {
		t.Errorf("diagnostic does not label the declaring receiver: %q", surface[0].Message)
	}
}

// TestPrivateSurfaceVerboseDedupedAcrossRepeatedCompiles: the same file
// transformed twice in one host process — mirroring a multi-entrypoint build
// or a cache-warmed envelope replaying a prior file's diagnostics — reports a
// weakened member's line only once, not once per compile.
func TestPrivateSurfaceVerboseDedupedAcrossRepeatedCompiles(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	prog, sf := loadFixture(t, `
export class Sealed {
  #a: number = 0;
  #b: string = "";
}
export const AlphaExtensions = {
  setOptions(o: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	defer func() { _ = prog.Close() }()

	var diags []Diagnostic
	addDiagnostic := func(d Diagnostic) { diags = append(diags, d) }
	for range 2 {
		transform := New(prog, addDiagnostic)
		transform(shimprinter.NewEmitContext(), sf)
	}

	var surface []Diagnostic
	for _, d := range diags {
		if d.Code == "MERGESYNTH_PRIVATE_SURFACE" {
			surface = append(surface, d)
		}
	}
	if len(surface) != 1 {
		t.Fatalf("want exactly 1 MERGESYNTH_PRIVATE_SURFACE diagnostic across 2 compiles of the same file, got %d: %+v", len(surface), surface)
	}
}

// A `declare`d const in an implementation file emits no binding, so the member it
// keys is one no value ever carries. There is nothing for a caller to act on:
// refusing over it would report a gap that cannot be closed, while the clauses
// beside it are complete on their own.
func TestPhantomSymbolNameIsNotRefused(t *testing.T) {
	out, diags := run(t, `
declare const BRAND: unique symbol;
export interface Branded { readonly [BRAND]: void; tag: string; }
export const AlphaExtensions = {
  setOptions(o: Branded): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "BRAND") || strings.Contains(guard, "@@") {
		t.Errorf("a symbol-named member reached the emit as a key:\n%s", guard)
	}
	assertNoMangledKey(t, guard)
	if !strings.Contains(guard, "input.tag") {
		t.Errorf("the sibling member lost its clause:\n%s", guard)
	}
}
