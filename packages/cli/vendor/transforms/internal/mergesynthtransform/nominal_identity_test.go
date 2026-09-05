package mergesynthtransform

// A built-in is decided by IDENTITY, never by the name a type happens to carry.
// A first-party `interface Set` is not the global `Set`, and handing one to a
// check written for the built-in — typia's fast path, or an `instanceof` — is how
// a clause that can never decide anything reaches the emit.

import (
	"strings"
	"testing"
)

// The name-collision fixtures. Each declares a first-party type whose name is a
// built-in's and whose member is an accessor over a `#`-named field — the shape
// typia keys on a name no object carries.
func TestFirstPartyTypeNamedLikeABuiltInIsComposed(t *testing.T) {
	for name, decl := range map[string]string{
		"Set":  "export interface Set { bag: Inner }",
		"Map":  "export interface Map { bag: Inner }",
		"Date": "export interface Date { bag: Inner }",
	} {
		out, diags := run(t, setOptionsFixture(divergingInner+decl+"\n", name))
		if len(diags) != 0 {
			t.Errorf("%s: unexpected diagnostics: %+v", name, diags)
		}
		assertNoMangledKey(t, out)
		guard := strategyText(t, out, "setOptions")
		if !strings.Contains(guard, "input.bag") || !strings.Contains(guard, "input.v") {
			t.Errorf("%s: the first-party type was not composed over its public surface:\n%s", name, guard)
		}
		if strings.Contains(guard, "instanceof") {
			t.Errorf("%s: a first-party type is tested against the global constructor:\n%s", name, guard)
		}
	}
}

// The genuine built-in still takes the nominal path, so the identity gate did not
// cost the case it exists to serve.
func TestGenuineBuiltInStillTestsNominally(t *testing.T) {
	out, diags := run(t, setOptionsFixture("", "Map<string, number>"))
	if len(diags) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", diags)
	}
	guard := strategyText(t, out, "setOptions")
	if !strings.Contains(guard, "input instanceof Map") {
		t.Errorf("the global Map is no longer tested nominally:\n%s", guard)
	}
}

// `instanceof` is only honest for a type whose values cannot exist without its
// constructor. `Error`'s whole declared surface is plain strings, so an object
// literal is a legal value of it and `instanceof Error` REJECTS one.
func TestStructurallySatisfiableBuiltInIsNotTestedByInstanceof(t *testing.T) {
	t.Setenv("TTSC_MERGESYNTH_VERBOSE", "1")
	for _, name := range []string{"Error", "TypeError", "RangeError"} {
		out, diags := run(t, setOptionsFixture("", name))
		assertPrivateSurfaceWarning(t, diags)
		guard := strategyText(t, out, "setOptions")
		if strings.Contains(guard, "instanceof") {
			t.Errorf("%s is tested by instanceof, which rejects an object literal the type admits:\n%s", name, guard)
		}
		assertObjectFloor(t, guard)
		assertArityGate(t, guard, "1", "1")
	}
}
