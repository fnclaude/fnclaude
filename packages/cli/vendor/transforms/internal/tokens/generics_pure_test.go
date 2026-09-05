package tokens

import "testing"

// isInternalSymbolName is the pure guard behind DeriveTokenF's rejection of the
// anonymous / synthesized symbol family (`"\xFEtype"`, `"\xFEobject"`, …): the
// 0xFE prefix byte is an invalid UTF-8 sequence typescript-go stores internal
// names behind, so a real source identifier never carries it. DeriveTokenF treats
// the empty name as ok=false through a separate branch, so "" is NOT internal here.
func TestIsInternalSymbolName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"anonymous type literal", "\xFEtype", true},
		{"anonymous object literal", "\xFEobject", true},
		{"bare prefix byte", "\xFE", true},
		{"ordinary interface name", "IFoo", false},
		{"empty is not internal", "", false},
		{"prefix byte only mid-string is not a prefix", "I\xFEFoo", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isInternalSymbolName(tc.in); got != tc.want {
				t.Fatalf("isInternalSymbolName(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
