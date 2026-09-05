package tokens

// The two property walks in generics.go — the phantom-brand detector (isBrandObject)
// and the brand-payload reader (brandLiteralFor) — consume the whole property
// list with no accessibility filter. Both only ever ACCEPT a computed-symbol
// property signature, so a non-public member (a `#`-named field, a
// `private`-modifier member) is inert to either verdict. These pin that.

import (
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
)

// brandFixture pairs the self-contained brands with classes carrying
// non-public members: a `#private` field behind a public accessor, a
// `private`-modifier member, and a class whose ENTIRE member list is `#private`.
const brandFixture = `declare const KEY: unique symbol;
type Keyed<T, K extends string> = T & { readonly [KEY]?: K };
declare const TOK: unique symbol;
type Inject<T, K extends string> = T & { readonly [TOK]?: K };

class WithPrivate {
  #value: number = 0;
  public get value(): number { return this.#value; }
  private secret: string = "";
  public host: string = "";
}
class OnlyPrivate {
  #a: number = 0;
  #b: string = "";
}

declare const keyedWithPrivate: Keyed<WithPrivate, "redis">;
declare const keyedOnlyPrivate: Keyed<OnlyPrivate, "redis">;
declare const injectedWithPrivate: Inject<WithPrivate, "tok">;
declare const plainWithPrivate: WithPrivate;
`

// The KEY / TOK brand payloads are still read off a branded class that carries a
// `#private` field and a `private`-modifier member — the extra property symbols
// in the walk are skipped, not mistaken for a brand.
func TestBrandReadsIgnoreNonPublicMembers(t *testing.T) {
	prog, main := loadFixtureProgram(t, brandFixture, false)
	defer func() { _ = prog.Close() }()
	checker := prog.Checker

	if key, ok := KeyLiteralFor(typeOfDecl(t, checker, main, "keyedWithPrivate"), checker); !ok || key != "redis" {
		t.Errorf("KeyLiteralFor(Keyed<WithPrivate,\"redis\">) = %q, %v; want \"redis\", true", key, ok)
	}
	if key, ok := KeyLiteralFor(typeOfDecl(t, checker, main, "keyedOnlyPrivate"), checker); !ok || key != "redis" {
		t.Errorf("KeyLiteralFor(Keyed<OnlyPrivate,\"redis\">) = %q, %v; want \"redis\", true", key, ok)
	}
	if tok, ok := InjectTokenFor(typeOfDecl(t, checker, main, "injectedWithPrivate"), checker); !ok || tok != "tok" {
		t.Errorf("InjectTokenFor(Inject<WithPrivate,\"tok\">) = %q, %v; want \"tok\", true", tok, ok)
	}
	// An unbranded class must not be read as branded by its non-public members.
	if _, ok := KeyLiteralFor(typeOfDecl(t, checker, main, "plainWithPrivate"), checker); ok {
		t.Errorf("KeyLiteralFor(WithPrivate) reported a key on an unbranded type")
	}
}

// stripBrandMembers (via KeyedTokenFor) must recover the underlying class from
// the branded intersection. A class constituent whose members are ALL `#private`
// must still be classified as the real type, never as a phantom-brand object to
// drop.
func TestBrandStripRecoversUnderlyingType(t *testing.T) {
	prog, main := loadFixtureProgram(t, brandFixture, false)
	defer func() { _ = prog.Close() }()
	ctx := &Context{
		Checker:      prog.Checker,
		ProjectRoot:  "",
		IsDefaultLib: func(*shimast.SourceFile) bool { return true },
	}

	cases := []struct {
		decl string
		want string
	}{
		{"keyedWithPrivate", "WithPrivate#redis"},
		{"keyedOnlyPrivate", "OnlyPrivate#redis"},
	}
	for _, tc := range cases {
		got, ok := KeyedTokenFor(ctx, typeOfDecl(t, ctx.Checker, main, tc.decl))
		if !ok || got != tc.want {
			t.Errorf("KeyedTokenFor(%s) = %q, %v; want %q, true", tc.decl, got, ok, tc.want)
		}
	}
}
