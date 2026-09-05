package tokentext

import (
	"reflect"
	"testing"
)

func TestParseToken(t *testing.T) {
	cases := []struct {
		token    string
		wantBase string
		wantArgs []string
		ok       bool
	}{
		{"Promise<your-lib/contracts:IFoo>", "Promise", []string{"your-lib/contracts:IFoo"}, true},
		{"Array<pkg:IFoo>", "Array", []string{"pkg:IFoo"}, true},
		{"Map<pkg:K,pkg:V>", "Map", []string{"pkg:K", "pkg:V"}, true},
		{"Wrap<Outer<pkg:X>>", "Wrap", []string{"Outer<pkg:X>"}, true},
		{`Holder<"a,b">`, "Holder", []string{`"a,b"`}, true},
		{"pkg:IFoo", "", nil, false},
		{"<bad>", "", nil, false},
		{"Base<>", "", nil, false},
		{"Base<X", "", nil, false},
		{"Base<X>trailing", "", nil, false},
	}
	for _, c := range cases {
		got, ok := ParseToken(c.token)
		if ok != c.ok {
			t.Errorf("ParseToken(%q) ok = %v, want %v", c.token, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.Base != c.wantBase || !reflect.DeepEqual(got.Args, c.wantArgs) {
			t.Errorf("ParseToken(%q) = {%q %v}, want {%q %v}", c.token, got.Base, got.Args, c.wantBase, c.wantArgs)
		}
	}
}

func TestIsOpenToken(t *testing.T) {
	cases := []struct {
		token string
		want  bool
	}{
		{"$1", true},
		{"$12", true},
		// Hole labels are 1-based with no leading zero. di.core's tree parser
		// states the same grammar (§129), so the two engines agree on every
		// spelling, not just the ones a transform emits.
		{"$0", false},
		{"$01", false},
		{"$007", false},
		{"Promise<$1>", true},
		{"Promise<$01>", false},
		{"Array<pkg:IFoo>", false},
		{"pkg:IFoo", false},
		{`Holder<"$1">`, false},
		{"Outer<Inner<$2>>", true},
	}
	for _, c := range cases {
		if got := IsOpenToken(c.token); got != c.want {
			t.Errorf("IsOpenToken(%q) = %v, want %v", c.token, got, c.want)
		}
	}
}
