package mergesynthtransform

// The fast path is taken only for a type typia renders FAITHFULLY. These pin the
// positions where an unfaithful type used to slip through — a mapped/index-signature
// value type, a symbol-keyed member, a wholly hidden surface — each of which emitted
// a clause that could never be false, and the two shapes where a refusal must not
// cost more than it buys: the arity gate, and a member that cannot be read.

import (
	"strings"
	"testing"
)

// divergingInner is a class whose only public member is an accessor over a
// `#`-named backing field — the shape typia keys on a name no object carries.
const divergingInner = `
export class Inner {
  #v: number | undefined;
  public get v(): number | undefined { return this.#v; }
  public set v(x: number | undefined) { this.#v = x; }
}
`

func setOptionsFixture(decls, paramType string) string {
	return decls + `
export const AlphaExtensions = {
  setOptions(o: ` + paramType + `): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`
}

// assertArityGate pins that a refusal still narrows dispatch by argument count:
// a member declaring exactly one parameter must not answer a 0- or 3-argument
// call.
func assertArityGate(t *testing.T, guard string, min, max string) {
	t.Helper()
	if !strings.Contains(guard, "args.length >= "+min) || !strings.Contains(guard, "args.length <= "+max) {
		t.Errorf("refusal dropped the arity gate (want >= %s and <= %s):\n%s", min, max, guard)
	}
	if !strings.Contains(guard, "original.call(this, ...args)") {
		t.Errorf("refusal produced a dispatcher that never falls through to original:\n%s", guard)
	}
}

// A mapped type's value type is reachable only through its index info: neither
// the property walk nor the type-argument walk sees it.
func TestRecordValueTypeIsNotWavedThrough(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner+`
export interface R1 { label: string; bag: Record<string, Inner>; }
`, "R1"))
	assertNoMangledKey(t, out)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the record value type's public accessor is not guarded:\n%s", guard)
	}
	if !strings.Contains(guard, "Object.values(input)") {
		t.Errorf("the record was not decomposed value-wise:\n%s", guard)
	}
}

// The same hole through a bare index signature rather than a mapped type alias.
func TestIndexSignatureValueTypeIsNotWavedThrough(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner+`
export interface P4 { [key: string]: Inner }
`, "P4"))
	assertNoMangledKey(t, out)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the index-signature value type's public accessor is not guarded:\n%s", guard)
	}
}

// A record nested under an array: the element walk must reach the value type too.
func TestRecordInsideAnArrayIsNotWavedThrough(t *testing.T) {
	out, _ := run(t, setOptionsFixture(divergingInner, "Record<string, Inner>[]"))
	assertNoMangledKey(t, out)
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the array element's record value type is not guarded:\n%s", guard)
	}
}

// A symbol-keyed member has no string key to read it by, so it contributes no
// clause — but the members beside it are still checkable, and dropping them too
// would widen dispatch for nothing.
func TestSymbolKeyedMemberCostsOnlyItsOwnClause(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture(`
const MARK: unique symbol = Symbol("m");
export class R2 { public [MARK]: string = "t"; public host: string = ""; }
`, "R2"))
	assertNoMangledKey(t, out)
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.host") {
		t.Errorf("the string-keyed member lost its clause to the symbol-keyed one:\n%s", guard)
	}
	assertObjectFloor(t, guard)
	assertArityGate(t, guard, "1", "1")
}

// A built-in whose membership is an identity no structural clause can test keeps
// the object floor: a value of the wrong runtime kind must still fall through.
func TestPromiseParameterKeepsTheObjectFloor(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture("", "Promise<string>"))
	assertNoMangledKey(t, out)
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	assertObjectFloor(t, guard)
	assertArityGate(t, guard, "1", "1")
}

// Every member hidden by a `private` modifier leaves nothing to name. typia
// filters those members correctly and so emits a guard that is simply `true` —
// which accepts every value. The floor accepts only an object.
func TestModifierHiddenOnlyClassKeepsTheObjectFloor(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture(`
export class P2 { private a: number = 1; private b: string = ""; }
`, "P2"))
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "input.a") || strings.Contains(guard, "input.b") {
		t.Errorf("a clause was emitted for a member no caller can supply:\n%s", guard)
	}
	assertObjectFloor(t, guard)
	assertArityGate(t, guard, "1", "1")
}

// An intersection composes as the conjunction of its constituents, so a
// diverging one no longer costs the whole guard.
func TestIntersectionComposes(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner, "Inner & { label: string }"))
	assertNoMangledKey(t, out)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.label") {
		t.Errorf("the plain constituent is not guarded:\n%s", guard)
	}
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the diverging constituent's accessor is not guarded:\n%s", guard)
	}
}

// A tuple decomposes positionally rather than costing the guard.
func TestTupleComposes(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner, "[Inner, string]"))
	assertNoMangledKey(t, out)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.length >= 2") || !strings.Contains(guard, "input.length <= 2") {
		t.Errorf("the tuple's length is not pinned:\n%s", guard)
	}
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the tuple element's accessor is not guarded:\n%s", guard)
	}
}

// A trailing optional element narrows the length range rather than costing the
// whole guard.
func TestTupleWithOptionalElementComposes(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner, "[Inner, string?]"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.length >= 1") || !strings.Contains(guard, "input.length <= 2") {
		t.Errorf("the optional element did not widen the length range:\n%s", guard)
	}
	if !strings.Contains(guard, "input[1] === undefined") {
		t.Errorf("the optional element's clause does not admit an absent value:\n%s", guard)
	}
}

// A self-referencing type whose whole surface is ordinary is rendered faithfully
// by typia, cycle detection and all — it must stay on the fast path.
func TestRecursiveAllPublicTypeStaysOnTheFastPath(t *testing.T) {
	out, diags := run(t, setOptionsFixture(`
export interface Branch { name: string; child?: Branch; }
`, "Branch"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "_io0") {
		t.Errorf("a recursive all-public type lost its guard entirely:\n%s", guard)
	}
}

// A set-only accessor is not readable, so a `typeof input.x` clause on it can
// never pass on a genuine instance. It contributes nothing.
func TestSetOnlyAccessorContributesNoClause(t *testing.T) {
	out, diags := run(t, setOptionsFixture(`
export class Half {
  #v = 0;
  public set v(x: number) { this.#v = x; }
  public plain: string = "";
}
`, "Half"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "input.v") {
		t.Errorf("a set-only accessor produced a readable clause that can never pass:\n%s", guard)
	}
	if !strings.Contains(guard, "input.plain") {
		t.Errorf("the readable member is not guarded:\n%s", guard)
	}
}

// Nothing readable at all means no member clause — and the object floor, which
// is the whole of what such a type can still be checked for.
func TestSetOnlyAccessorOnlyClassKeepsTheObjectFloor(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	out, diags := run(t, setOptionsFixture(`
export class AllWrite {
  #v = 0;
  public set v(x: number) { this.#v = x; }
}
`, "AllWrite"))
	assertPrivateSurfaceWarning(t, diags)
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "input.v") {
		t.Errorf("a set-only accessor produced a readable clause that can never pass:\n%s", guard)
	}
	assertObjectFloor(t, guard)
	assertArityGate(t, guard, "1", "1")
}

// A type parameter has no closed shape at build time, so nothing about it can be
// asserted faithfully.
func TestTypeParameterInsideAContainerRefuses(t *testing.T) {
	out, diags := run(t, `
export interface Box<T> { item: T; }
export const AlphaExtensions = {
  setOptions(o: Box<Inner>): void {},
};
export class Inner {
  #v: number = 0;
  public get v(): number { return this.#v; }
}
registerAugmentations("t:IAlpha", AlphaExtensions);
`)
	assertNoMangledKey(t, out)
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the instantiated type argument's accessor is not guarded:\n%s", guard)
	}
}
