package mergesynthtransform

// A synthesized guard may be weaker than the type it checks, never narrower — and
// never weaker than the dispatcher it replaces. Whatever the composer cannot
// decompose costs its own clause and nothing else: the runtime-kind floor the
// type still implies stands, so does every clause beside it, and so do the arity
// bounds. These pin the shapes where dropping more than that let a wrong-shaped
// argument reach the extension.

import (
	"strings"
	"testing"
)

// The container cases, one per runtime kind. Each parameter type is one the
// composer cannot fully decompose; a value of the WRONG KIND must still fall
// through to whatever held the member name before.
func TestUndecomposableParameterKeepsItsRuntimeKindFloor(t *testing.T) {
	for name, paramType := range map[string]string{
		"promise":           "Promise<string>",
		"readonly map":      "ReadonlyMap<string, Inner>",
		"iterable":          "Iterable<Inner>",
		"number index":      "N1",
		"all-private class": "P2",
	} {
		out, _ := run(t, setOptionsFixture(divergingInner+`
export interface N1 { [key: number]: Inner }
export class P2 { private a: number = 1; private b: string = ""; }
`, paramType))
		guard := strategyText(t, out, "setOptions")
		assertObjectFloor(t, guard)
		assertArityGate(t, guard, "1", "1")
		if strings.Contains(guard, "=> true") {
			t.Errorf("%s: the guard contains a clause that can never be false:\n%s", name, guard)
		}
	}
}

// A whole guard used to be lost to one undecomposable member. The clauses beside
// it are unaffected by it.
func TestUndecomposableMemberCostsOnlyItsOwnClause(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture(divergingInner+`
export interface Holder { label: string; p: Promise<Inner>; }
`, "Holder"))
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.label") {
		t.Errorf("a checkable member lost its clause to an undecomposable sibling:\n%s", guard)
	}
}

// Same at the parameter level: one refused parameter must not disarm the guard
// on the parameter beside it.
func TestRefusedParameterDoesNotDisarmItsSibling(t *testing.T) {
	out, _ := run(t, `
export class Sealed { #a: number = 0; }
export const AlphaExtensions = {
  setOptions(a: string, b: Sealed): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "g0(args[0])") {
		t.Errorf("the checkable parameter lost its guard:\n%s", guard)
	}
	if !strings.Contains(guard, "g1(args[1])") {
		t.Errorf("the undecomposable parameter lost even its runtime-kind floor:\n%s", guard)
	}
}

// A rest parameter has no arity bounds to fall back on — it is never required and
// never caps the count — so its guard is the only thing narrowing dispatch. It is
// composed from the ELEMENT type, which is what carries the information.
func TestRestParameterKeepsAGuardOverItsElements(t *testing.T) {
	out, diags := run(t, divergingInner+`
export const AlphaExtensions = {
  setOptions(...o: Map<string, Inner>[]): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "g0(args.slice(0))") {
		t.Errorf("the rest slice is unguarded, so a call of any shape dispatches to the extension:\n%s", guard)
	}
	if !strings.Contains(guard, "input instanceof Map") {
		t.Errorf("the rest element type is not checked:\n%s", guard)
	}
	if !strings.Contains(guard, "original.call(this, ...args)") {
		t.Errorf("the dispatcher never falls through to original:\n%s", guard)
	}
}

// Even an element the composer can only floor narrows the rest slice: an
// argument of the wrong runtime kind still falls through. What must NOT be
// emitted is the floor over the SLICE — `Array.isArray(args.slice(0))` can never
// be false, the slice being an array by construction.
func TestRestParameterOverAFlooredElementStillNarrows(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, `
export class Sealed { #a: number = 0; }
export const AlphaExtensions = {
  setOptions(...o: Sealed[]): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "g0(args.slice(0))") || !strings.Contains(guard, "input.every") {
		t.Errorf("the rest slice is unguarded, so a call of any shape dispatches to the extension:\n%s", guard)
	}
	if !strings.Contains(guard, `typeof input === "object"`) {
		t.Errorf("the rest element lost its runtime-kind floor:\n%s", guard)
	}
}

// A floor asserts only what is TRUE of every value the declared type admits.
// These are the shapes where a tighter-looking clause is false for genuine
// values: a function is a value of an object type, and an array is a value of
// several.
func TestFloorAdmitsEveryRuntimeKindItsTypeAdmits(t *testing.T) {
	for name, paramType := range map[string]string{
		"callable interface":  "Function",
		"array of callables":  "Function[]",
		"record of callables": "Record<string, Function>",
		"member of one":       "FH",
		"array-like":          "ArrayLike<string>",
	} {
		out, _ := run(t, setOptionsFixture(`
export interface FH { fn: Function; label: string }
`, paramType))
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, `typeof input === "function"`) {
			t.Errorf("%s: the guard rejects a function, which the type admits:\n%s", name, guard)
		}
		if strings.Contains(guard, "!Array.isArray(input)") {
			t.Errorf("%s: the guard rejects an array, which the type admits:\n%s", name, guard)
		}
	}
}

// The `object` keyword used to reach no arm at all and lose its guard outright,
// which let a number, a string and `null` dispatch to the extension. Its floor is
// exactly its meaning — not a primitive, not null — and it has to survive every
// position a type reaches through.
func TestObjectKeywordKeepsItsFloor(t *testing.T) {
	for name, paramType := range map[string]string{
		"bare":     "object",
		"in union": "object | string",
		"in array": "object[]",
	} {
		out, diags := run(t, setOptionsFixture("", paramType))
		if len(diags) != 0 {
			t.Errorf("%s: unexpected diagnostics: %+v", name, diags)
		}
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, `typeof input === "object"`) || !strings.Contains(guard, `typeof input === "function"`) {
			t.Errorf("%s: `object` carries no runtime-kind clause, so a primitive dispatches to the extension:\n%s", name, guard)
		}
		if !strings.Contains(guard, "input !== null") {
			t.Errorf("%s: `object` admits null:\n%s", name, guard)
		}
	}
}

// The rest position over `object` keeps a guard because the ELEMENT carries one:
// the slice itself is an array by construction and would decide nothing.
func TestObjectKeywordRestParameterNarrowsByItsElements(t *testing.T) {
	out, diags := run(t, `
export const AlphaExtensions = {
  setOptions(...o: object[]): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "g0(args.slice(0))") || !strings.Contains(guard, "input.every") {
		t.Errorf("the rest slice is unguarded, so a call of any shape dispatches to the extension:\n%s", guard)
	}
	if !strings.Contains(guard, `typeof e === "object"`) && !strings.Contains(guard, `typeof input === "object"`) {
		t.Errorf("the rest element lost its runtime-kind floor:\n%s", guard)
	}
}

// The report has to describe what the emit CONTAINS. Calling a position
// "unchecked" when a clause was emitted for it is the same class of defect as
// emitting a clause that decides nothing.
func TestDiagnosticDoesNotCallAnEmittedClauseUnchecked(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture("", "Function"))
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, `typeof input === "object"`) {
		t.Fatalf("expected a floored guard to report on:\n%s", guard)
	}
	assertPrivateSurfaceWarning(t, diags)
	for _, d := range diags {
		if strings.Contains(d.Message, "unchecked") {
			t.Errorf("a position carrying a clause is reported as unchecked: %s", d.Message)
		}
	}
}
