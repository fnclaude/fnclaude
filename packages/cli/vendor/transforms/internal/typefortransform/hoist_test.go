package typefortransform

import (
	"strings"
	"testing"

	shimprinter "github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/fnioc/std/transforms/internal/plugin"
	"github.com/fnioc/std/transforms/internal/typeemit"
	"github.com/fnioc/std/transforms/internal/typeforhoist"
)

// hoistTypefor runs the typefor stage over main.ts in HOISTED mode and returns
// the reprinted file alongside the project table every call site drew from.
func hoistTypefor(t *testing.T, prog *driver.Program, app string) (string, *typeforhoist.Registry) {
	t.Helper()
	ctx := plugin.NewContext(prog, app)
	registry := typeforhoist.NewRegistry(typeemit.HoistRef())
	hoist := &Hoist{Registry: registry, SourceRoot: app}
	transform := New(prog, ctx, nil, hoist, func(d plugin.Diagnostic) {
		t.Fatalf("unexpected diagnostic: %s %s", d.Code, d.Message)
	})
	ec := shimprinter.NewEmitContext()
	out := transform(ec, mainSF(t, prog))
	return reprint(ec, out), registry
}

func TestHoistedCallSiteIsAConstReference(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
export const clock = typefor<IClock>();
`)
	defer prog.Close()
	out, registry := hoistTypefor(t, prog, app)

	if strings.Contains(out, "Type.") {
		t.Fatalf("a hoisted call site spells no factory of its own:\n%s", out)
	}
	if registry.Len() != 1 {
		t.Fatalf("want 1 interned node, got %d", registry.Len())
	}
	module := registry.Module()
	if !strings.Contains(module, `Type.imported("IClock", "@scope/app/main")`) {
		t.Fatalf("the const carries the derived spelling:\n%s", module)
	}
	name := constNameIn(t, module)
	if !strings.Contains(out, "export const clock = "+name) {
		t.Fatalf("the call site references %s:\n%s", name, out)
	}
	if !strings.Contains(out, `import { `+name+` } from "./`+typeforhoist.ModuleFile+`"`) {
		t.Fatalf("the file imports %s from the generated module:\n%s", name, out)
	}
}

func TestHoistedSharesOneConstPerDistinctType(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
export const first = typefor<IClock>();
export const second = typefor<IClock>();
export const promised = typefor<Promise<IClock>>();
`)
	defer prog.Close()
	out, registry := hoistTypefor(t, prog, app)

	// IClock and Promise<IClock> — the promise's argument reuses the IClock const
	// rather than re-spelling it.
	if registry.Len() != 2 {
		t.Fatalf("want 2 interned nodes, got %d:\n%s", registry.Len(), registry.Module())
	}
	if got := strings.Count(registry.Module(), "\nexport const "); got != 2 {
		t.Fatalf("want 2 consts rendered, got %d:\n%s", got, registry.Module())
	}
	if strings.Count(registry.Module(), `Type.imported("IClock"`) != 1 {
		t.Fatalf("IClock is spelled exactly once:\n%s", registry.Module())
	}
	// One import declaration carrying both names, not one per reference.
	if got := strings.Count(out, "import {"); got != 1 {
		t.Fatalf("want 1 injected import, got %d:\n%s", got, out)
	}
}

func TestHoistedNestedTypeIsReferencedByName(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
export const promised = typefor<Promise<IClock>>();
`)
	defer prog.Close()
	_, registry := hoistTypefor(t, prog, app)

	module := registry.Module()
	inner := constNameIn(t, module)
	// Promise is declared by the ambient scope, so it spells as a global and
	// carries no specifier — only its argument, by name.
	if !strings.Contains(module, `Type.global("Promise", [`+inner+`])`) {
		t.Fatalf("the composite references the member const:\n%s", module)
	}
}

func TestHoistedRerunIsAFixedPoint(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
export const clock = typefor<IClock>();
`)
	defer prog.Close()
	ctx := plugin.NewContext(prog, app)
	hoist := &Hoist{Registry: typeforhoist.NewRegistry(typeemit.HoistRef()), SourceRoot: app}
	transform := New(prog, ctx, nil, hoist, func(plugin.Diagnostic) {})
	ec := shimprinter.NewEmitContext()
	first := transform(ec, mainSF(t, prog))
	second := transform(ec, first)
	if second != first {
		t.Fatal("a second pass over an already-hoisted file must return the same file")
	}
	if hoist.Registry.Len() != 1 {
		t.Fatalf("a second pass interns nothing new, got %d", hoist.Registry.Len())
	}
}

func TestHoistedAccessorFoldsToTheMemberConst(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
declare class Clock implements IClock {}
export const instance = typefor<typeof Clock>().instance;
export const kind = typefor<IClock>().kind;
`)
	defer prog.Close()
	out, registry := hoistTypefor(t, prog, app)

	if !strings.Contains(out, `export const kind = "imported"`) {
		t.Fatalf("`.kind` folds to its discriminant, hoisted or not:\n%s", out)
	}
	// Only what SURVIVES the fold is interned: the class's instance type, never
	// the constructor wrapper the fold discarded, and nothing at all for `.kind`.
	if registry.Len() != 1 {
		t.Fatalf("want 1 interned node (Clock), got %d:\n%s", registry.Len(), registry.Module())
	}
	if strings.Contains(registry.Module(), "Type.ctor(") {
		t.Fatalf("a folded accessor interns no wrapper:\n%s", registry.Module())
	}
}

// constNameIn is the name of the first const the module declares — the deepest
// node, since the module is written children first.
func constNameIn(t *testing.T, module string) string {
	t.Helper()
	marker := "\nexport const "
	i := strings.Index(module, marker)
	if i < 0 {
		t.Fatalf("no const in:\n%s", module)
	}
	rest := module[i+len(marker):]
	end := strings.Index(rest, " = ")
	if end < 0 {
		t.Fatalf("malformed const line in:\n%s", module)
	}
	return rest[:end]
}

// TestHoistedTupleReferencesItsSlotsByName: a tuple's slots are CHILD nodes,
// so each earns its own const — shared with any other derivation of the same
// type — and the tuple's const is one factory call over their names.
func TestHoistedTupleReferencesItsSlotsByName(t *testing.T) {
	prog, app := buildTypeforWorkspace(t, `
import { typefor } from "@rhombus-std/primitives.extras";
interface IClock {}
interface IStore {}
export const pair = typefor<[IClock, IStore]>();
export const clock = typefor<IClock>();
`)
	defer prog.Close()
	_, registry := hoistTypefor(t, prog, app)

	module := registry.Module()
	// IClock, IStore and the tuple over them — the tuple's first slot reuses the
	// const the bare IClock derivation earned.
	if registry.Len() != 3 {
		t.Fatalf("want 3 interned nodes, got %d:\n%s", registry.Len(), module)
	}
	for _, line := range strings.Split(module, "\n") {
		if !strings.Contains(line, "Type.tuple(") {
			continue
		}
		if strings.Contains(line, "Type.imported(") {
			t.Fatalf("the tuple const re-spells its slots instead of naming them:\n%s", line)
		}
		return
	}
	t.Fatalf("no tuple const was rendered:\n%s", module)
}
