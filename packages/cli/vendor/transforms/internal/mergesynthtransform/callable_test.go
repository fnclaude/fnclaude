package mergesynthtransform

// A callable position's guard reads the signature KIND, not just callability:
// a construct-only type is discriminated as a constructor, while any type with
// call signatures keeps the bare typeof check — an ordinary function
// declaration is itself constructible, so rejecting constructibles there would
// reject genuine values.

import (
	"strings"
	"testing"
)

// A construct-only parameter adds the IsConstructor probe over the typeof
// check, so an arrow function or a method no longer satisfies a
// constructor-typed slot.
func TestConstructOnlyParameterDiscriminatesAConstructor(t *testing.T) {
	for name, paramType := range map[string]string{
		"constructor-type literal": "new () => Inner",
		"class statics type":       "typeof Inner",
	} {
		out, diags := run(t, setOptionsFixture(`
export class Inner { public v: number = 0; }
`, paramType))
		if len(diags) != 0 {
			t.Errorf("%s: unexpected diagnostics: %+v", name, diags)
		}
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, `typeof input === "function"`) {
			t.Errorf("%s: the constructor guard lost its typeof floor:\n%s", name, guard)
		}
		if !strings.Contains(guard, "Reflect.construct(Boolean, [], input)") {
			t.Errorf("%s: a construct-only type is not discriminated as a constructor:\n%s", name, guard)
		}
	}
}

// A call-signature parameter keeps the bare typeof check and never carries the
// constructor probe — a plain function declaration is constructible, so the
// probe would be a clause genuine values fail nothing by, and non-constructible
// genuine values (arrows, methods) would fail it wrongly.
func TestCallOnlyParameterKeepsTheTypeofGuard(t *testing.T) {
	out, diags := run(t, setOptionsFixture("", "(x: string) => void"))
	if len(diags) != 0 {
		t.Errorf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, `typeof input === "function"`) {
		t.Errorf("the callable guard lost its typeof check:\n%s", guard)
	}
	if strings.Contains(guard, "Reflect.construct") {
		t.Errorf("a call-signature type must not carry the constructor probe:\n%s", guard)
	}
}

// A hybrid carrying BOTH kinds stays on the typeof check: the call signatures
// make it a function value first, and the probe adds nothing dispatch can use.
func TestHybridCallableParameterKeepsTheTypeofGuard(t *testing.T) {
	out, diags := run(t, setOptionsFixture(`
export interface Hybrid {
  (x: string): void;
  new (x: string): Inner;
}
export class Inner { public v: number = 0; }
`, "Hybrid"))
	if len(diags) != 0 {
		t.Errorf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, `typeof input === "function"`) {
		t.Errorf("the hybrid guard lost its typeof check:\n%s", guard)
	}
	if strings.Contains(guard, "Reflect.construct") {
		t.Errorf("a hybrid callable must not carry the constructor probe:\n%s", guard)
	}
}
