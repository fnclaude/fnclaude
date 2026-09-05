package schemaoftransform

// The expansion covers a type's PUBLIC instance surface only: public properties
// and accessors. A `#`-named field is not a string-keyed property at runtime and
// a `private`/`protected` member is not one a caller can supply, so a key emitted
// for either can never be satisfied. A type with nothing else left is refused,
// not emitted as an empty object type.

import (
	"strings"
	"testing"
)

// literalFor expands `schemaof<C>()` over src and returns the emitted tree, or ""
// plus the diagnostic codes when the walk refused.
func literalFor(t *testing.T, src string) (string, []string) {
	t.Helper()
	prog, sf := loadProgram(t, src)
	defer func() { _ = prog.Close() }()

	out, diags := lowerSchemaof(t, prog, sf)
	codes := make([]string, 0, len(diags))
	for _, d := range diags {
		codes = append(codes, d.Code)
	}
	if len(codes) != 0 {
		return "", codes
	}
	return expressionAfter(t, out, "s = Type.object"), nil
}

func TestPrivateNamedFieldBehindAccessor(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  #value: number = 0;
  public get value(): number { return this.#value; }
  public set value(v: number) { this.#value = v; }
}
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if strings.Contains(tree, "#value") {
		t.Errorf("emitted a key for the #private backing field — unmatchable at runtime:\n%s", tree)
	}
	if !strings.Contains(tree, `value: Type.global("number")`) {
		t.Errorf("public accessor `value` missing from the schema:\n%s", tree)
	}
}

func TestPrivateModifierMemberIsNotInTheSchema(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  private secret: string = "";
  public host: string = "";
}
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if strings.Contains(tree, "secret") {
		t.Errorf("emitted a key for a `private` member:\n%s", tree)
	}
	if !strings.Contains(tree, `host: Type.global("string")`) {
		t.Errorf("public member `host` missing from the schema:\n%s", tree)
	}
}

func TestProtectedModifierMemberIsNotInTheSchema(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  protected shared: string = "";
  public host: string = "";
}
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if strings.Contains(tree, "shared") {
		t.Errorf("emitted a key for a `protected` member:\n%s", tree)
	}
}

func TestStaticMemberIsNotInTheSchema(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  static defaultHost: string = "";
  public host: string = "";
}
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if strings.Contains(tree, "defaultHost") {
		t.Errorf("emitted a key for a `static` member:\n%s", tree)
	}
}

// Coercion assigns into the field, so a get-only accessor is no more of a target
// than a `#`-named field. Its counterpart in the guard walk drops a SET-only
// accessor, which cannot be read; each consumer filters by the direction it
// actually uses.
func TestGetOnlyAccessorIsNotInTheSchema(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  #a: number = 0;
  public get derived(): number { return this.#a; }
  public host: string = "";
}
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if strings.Contains(tree, "derived") {
		t.Errorf("emitted a key for a get-only accessor — coercion cannot assign to it:\n%s", tree)
	}
	if !strings.Contains(tree, `host: Type.global("string")`) {
		t.Errorf("public member `host` missing from the schema:\n%s", tree)
	}
}

// Nothing writable at all leaves nothing to coerce into.
func TestGetOnlyAccessorOnlySurfaceIsRefused(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  #a: number = 0;
  public get derived(): number { return this.#a; }
}
export const s = schemaof<C>();
`)
	if len(codes) == 0 {
		t.Fatalf("a surface with nothing writable must refuse, not emit %s", tree)
	}
	if codes[0] != CodePrivateOnlySurface {
		t.Errorf("diagnostic codes = %v; want %s", codes, CodePrivateOnlySurface)
	}
}

// A class whose ONLY members are `#private` fields has an empty public surface.
// Expanding it would produce an object type with no members, which describes
// nothing.
func TestPrivateOnlySurfaceIsRefused(t *testing.T) {
	tree, codes := literalFor(t, `class C {
  #a: number = 0;
  #b: string = "";
}
export const s = schemaof<C>();
`)
	if len(codes) == 0 {
		t.Fatalf("an empty public surface must refuse, not emit %s", tree)
	}
	if codes[0] != CodePrivateOnlySurface {
		t.Errorf("diagnostic codes = %v; want %s", codes, CodePrivateOnlySurface)
	}
}

// The refusal only ever reaches a type the walk OPENS UP. A member naming a class
// keeps its address, so that class's own surface is never consulted — whatever it
// hides is the business of whoever expands it, not of this member.
func TestNamedMemberSurfaceIsNotConsulted(t *testing.T) {
	tree, codes := literalFor(t, `class Inner {
  #a: number = 0;
}
interface C { inner: Inner; }
export const s = schemaof<C>();
`)
	if len(codes) != 0 {
		t.Fatalf("unexpected diagnostics %v", codes)
	}
	if !strings.Contains(tree, `inner: Type.imported("Inner", "./main")`) {
		t.Errorf("a named member must stay an address:\n%s", tree)
	}
}
