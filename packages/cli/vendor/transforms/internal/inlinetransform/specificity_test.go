package inlinetransform

import "testing"

func disc(typeParams int, params ...string) Discriminator {
	return Discriminator{TypeParamCount: typeParams, Params: params}
}

// The implementation is the declared face, so a body serves a declaration only
// by naming the very same value parameters in the very same order. Nothing is
// absorbed, stretched or relaxed, and type-parameter count is never negotiable.
func TestDiscriminatorMatches(t *testing.T) {
	cases := []struct {
		name string
		body Discriminator
		decl Discriminator
		want bool
	}{
		{"exact", disc(1, "ctor", "signatures"), disc(1, "ctor", "signatures"), true},
		{"both empty", disc(1), disc(1), true},
		{"a rest absorbs nothing", disc(1, "...rest"), disc(1, "ctor", "signatures", "scope", "key"), false},
		{"a named lead plus a rest absorbs nothing", disc(1, "ctor", "...rest"), disc(1, "ctor", "signatures"), false},
		{"names must agree", disc(1, "factory", "signatures"), disc(1, "ctor", "signatures"), false},
		{"order must agree", disc(1, "signatures", "ctor"), disc(1, "ctor", "signatures"), false},
		{"a body does not stretch", disc(1, "ctor"), disc(1, "ctor", "signatures"), false},
		{"a body does not shrink", disc(1, "ctor", "signatures"), disc(1, "ctor"), false},
		{"type-parameter count is never absorbed", disc(1, "ctor"), disc(0, "ctor"), false},
	}
	for _, c := range cases {
		if got := c.body.Matches(c.decl); got != c.want {
			t.Errorf("%s: Matches = %v, want %v", c.name, got, c.want)
		}
	}
}
