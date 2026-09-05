package mergesynthtransform

// A mapped type — `Partial<T>`, `Readonly<T>`, `{ [K in keyof T]: T[K] }` —
// remints every member as a plain property symbol while KEEPING the original
// declaration node. Two opposite mistakes follow from reading the symbol instead:
// an accessor behind a mapping looks like a property (so typia's fast path is
// taken for a type typia renders as a constant `true`), and a standard-library
// mapping looks like a nominal built-in (so a wholly checkable type is left
// unchecked). These pin both directions.

import (
	"strings"
	"testing"
)

// The reported shape, one mapping removed: typia skips the member because its
// DECLARATION is an accessor, so admitting the type emits `_io0 = () => true`.
func TestMappedAccessorLeavesTheFastPath(t *testing.T) {
	out, diags := run(t, setOptionsFixture(divergingInner+`
export type MInner = { [K in keyof Inner]: Inner[K] };
`, "MInner"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the accessor behind the mapping contributes no clause:\n%s", guard)
	}
	assertNoConstantTrue(t, guard)
}

// The partial-guard variant is worse than the collapse, because it reads like a
// whole guard: the plain member is checked and the accessor silently is not.
func TestMappedTypeMixingAccessorAndPropertyChecksBoth(t *testing.T) {
	out, diags := run(t, setOptionsFixture(`
export class Mix {
  #h = 0;
  public p: string = "";
  public get g(): number { return this.#h; }
}
export type ROMix = { [K in keyof Mix]: Mix[K] };
`, "ROMix"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	for _, member := range []string{"input.p", "input.g"} {
		if !strings.Contains(guard, member) {
			t.Errorf("%s absent from the guard:\n%s", member, guard)
		}
	}
}

// An interface accessor reaches the same blind spot.
func TestMappedInterfaceAccessorIsChecked(t *testing.T) {
	out, _ := run(t, setOptionsFixture(`
export interface IAcc { get v(): number; label: string; }
export type ROIface = { [K in keyof IAcc]: IAcc[K] };
`, "ROIface"))
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.v") {
		t.Errorf("the mapped interface accessor contributes no clause:\n%s", guard)
	}
}

// The blind spot propagated through every container the composer decomposes,
// each emitting an inner constant `true` of its own.
func TestMappedAccessorInsideContainersIsChecked(t *testing.T) {
	for name, paramType := range map[string]string{
		"union":        "MInner | string",
		"array":        "MInner[]",
		"record":       "Record<string, MInner>",
		"tuple":        "[MInner, string]",
		"intersection": "MInner & { label: string }",
		"member":       "Holder2",
	} {
		out, _ := run(t, setOptionsFixture(divergingInner+`
export type MInner = { [K in keyof Inner]: Inner[K] };
export interface Holder2 { ro: MInner; label: string; }
`, paramType))
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, "input.v") {
			t.Errorf("%s: the mapped accessor is unchecked:\n%s", name, guard)
		}
		assertNoConstantTrue(t, guard)
	}
}

// A set-only accessor behind a mapping must not produce a readable clause
// either: the directional filter has to follow the declaration too.
func TestMappedSetOnlyAccessorContributesNoReadableClause(t *testing.T) {
	out, _ := run(t, setOptionsFixture(`
export class WriteOnly { #v = 0; public set v(x: number) { this.#v = x; } }
export type ROW = { [K in keyof WriteOnly]: WriteOnly[K] };
`, "ROW"))
	guard := strategyText(t, out, "setOptions")
	if strings.Contains(guard, "input.v") {
		t.Errorf("a set-only accessor behind a mapping produced a clause that can never pass:\n%s", guard)
	}
}

// The other direction: a standard-library mapping over an ordinary all-public
// type is as checkable as its argument, and dropping its guard widened dispatch
// for nothing.
func TestStandardMappedUtilitiesAreGuarded(t *testing.T) {
	for name, paramType := range map[string]string{
		"Partial":  "Partial<Opts>",
		"Readonly": "Readonly<Opts>",
		"Required": "Required<Opts>",
		"Pick":     "Pick<Opts, 'host'>",
		"Omit":     "Omit<Opts, 'port'>",
		"Record":   "Record<'host' | 'port', string>",
	} {
		out, diags := run(t, setOptionsFixture(`
export interface Opts { host: string; port: number; }
`, paramType))
		if len(diags) != 0 {
			t.Errorf("%s: unexpected diagnostics: %+v", name, diags)
		}
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, "input.host") {
			t.Errorf("%s: lost its guard entirely:\n%s", name, guard)
		}
	}
}

// A refused member used to poison the whole enclosing guard; a standard mapping
// is not refused at all, so nothing around it is at risk either.
func TestStandardMappedUtilityNestedInsideATypeIsGuarded(t *testing.T) {
	for name, paramType := range map[string]string{
		"member": "Outer",
		"array":  "Partial<Opts>[]",
		"union":  "string | Partial<Opts>",
	} {
		out, _ := run(t, setOptionsFixture(`
export interface Opts { host: string; port: number; }
export interface Outer { name: string; opts: Partial<Opts>; }
`, paramType))
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, "host") {
			t.Errorf("%s: the enclosing guard lost the utility's clauses:\n%s", name, guard)
		}
	}
}

// A type an external consumer imports from an installed package is a shape like
// any other. Treating `node_modules` as "library" disabled synthesis for every
// published consumer, which in-repo fixtures could never show.
func TestVendorTypeFromNodeModulesIsGuarded(t *testing.T) {
	out, diags := runWith(t, `
import type { VendorOptions } from "@vendor/opts";
export const AlphaExtensions = {
  setOptions(o: VendorOptions): void {},
};
registerAugmentations("t:IAlpha", AlphaExtensions);
`, map[string]string{
		"node_modules/@vendor/opts/package.json": `{"name":"@vendor/opts","version":"1.0.0","types":"index.d.ts"}`,
		"node_modules/@vendor/opts/index.d.ts":   "export interface VendorOptions { a: string; b: number; }\n",
	})
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input.a") || !strings.Contains(guard, "input.b") {
		t.Errorf("an installed package's type lost its guard:\n%s", guard)
	}
}

// A brand's object half is phantom: a value of `string & { __brand }` IS a
// string at runtime. typia drops the branded arm outright, leaving a guard that
// rejects every genuine value — the never-TRUE mirror of the never-FALSE clause.
func TestBrandedPrimitiveArmSurvives(t *testing.T) {
	for name, decls := range map[string]string{
		"string": `export type UserId = string & { readonly __brand: "UserId" };
export type Probe = UserId | number;`,
		"number": `export type Port = number & { readonly __brand: "Port" };
export type Probe = Port | string;`,
	} {
		out, _ := run(t, setOptionsFixture(decls, "Probe"))
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, `"string" === typeof input`) || !strings.Contains(guard, `"number" === typeof input`) {
			t.Errorf("%s: the branded arm was dropped, so a genuine value is rejected:\n%s", name, guard)
		}
		if strings.Contains(guard, "__brand") {
			t.Errorf("%s: the guard checks a phantom member no value carries:\n%s", name, guard)
		}
	}
}

// A brand beside an object arm loses neither.
func TestBrandedPrimitiveBesideAnObjectArm(t *testing.T) {
	out, _ := run(t, setOptionsFixture(`
export type UserId = string & { readonly __brand: "UserId" };
`, "UserId | { host: string }"))
	guard := strategyText(t, out, "setOptions")
	// The `input is string` predicate is the branded arm's own rendering — the
	// bare typeof text also occurs inside the object arm's `input.host` clause.
	if !strings.Contains(guard, "input is string") {
		t.Errorf("the branded arm was dropped:\n%s", guard)
	}
	if !strings.Contains(guard, "input.host") {
		t.Errorf("the object arm was dropped:\n%s", guard)
	}
}

// assertNoConstantTrue pins the failure mode the whitelist exists to keep out: a
// clause that can never be false, whatever it is named.
func assertNoConstantTrue(t *testing.T, guard string) {
	t.Helper()
	if strings.Contains(guard, "=> true") {
		t.Errorf("the guard contains a clause that can never be false:\n%s", guard)
	}
}
