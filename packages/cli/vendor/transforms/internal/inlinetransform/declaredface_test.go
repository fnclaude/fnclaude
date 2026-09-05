package inlinetransform

import (
	"strings"
	"testing"

	shimprinter "github.com/microsoft/typescript-go/shim/printer"

	"github.com/fnioc/std/transforms/internal/plugin"
)

// The core surface every case here shares: the token-taking primitive AND an
// overload that has nothing to do with the sugar yet carries the same
// type-parameter and value-parameter counts as the sugar's face. Neither is
// publisher-owned, so neither can ever claim the body — the checker's own
// resolution is what routes a call to them untouched.
const declaredFaceCoreIndex = `export interface IQuery {
  isService(token: string, extra: number): boolean;
  isService<X>(mismatched: string): boolean;
}
export declare const provider: IQuery;
`

const declaredFaceSugarDTS = `declare module '@scope/core' {
  interface IQuery {
    isService<T>(extra: number): boolean;
  }
}
export {};
`

// TestUnrelatedOverloadIsNotClaimed: a call the checker binds, unambiguously, to
// a declaration outside the publisher's own — the primitive, or an unrelated
// overload sharing the sugar face's counts — must be left alone: ownership keeps
// it out of the inline plan, and the call emerges untouched with no diagnostic.
func TestUnrelatedOverloadIsNotClaimed(t *testing.T) {
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T>(this: IQuery, extra: number): boolean {
    return this.isService(typefor<T>(), extra);
  }
}
`
	// A string argument and no type argument: only the unrelated core overload
	// accepts this call, and the publisher does not own it.
	mainSrc := `import { provider } from '@scope/core';
export const bad = provider.isService('x');
`
	prog, app := buildWorkspace(t, declaredFaceCoreIndex, inlineBody, declaredFaceSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	artifacts := NewArtifacts()
	var diags []plugin.Diagnostic
	transform := Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { diags = append(diags, d) })

	ec := shimprinter.NewEmitContext()
	main := sourceFileWithSuffix(t, prog, "main.ts")
	out := reprint(ec, transform(ec, main))

	if !strings.Contains(out, "provider.isService('x')") {
		t.Errorf("expected the unrelated overload's call to survive untouched, got:\n%s\ndiagnostics: %+v", out, diags)
	}
	if len(diags) != 0 {
		t.Errorf("a call the implementation never served must draw no diagnostic, got %+v", diags)
	}
}

// TestRestShapedImplementationBlanketsTheFace: a rest-shaped body serves as the
// blanket for every publisher-owned face no exact-signature body claims. The
// call's arguments past the named parameters splice in as a group, so the
// emitted call is the one a hand author writes.
func TestRestShapedImplementationBlanketsTheFace(t *testing.T) {
	inlineBody := `import { typefor } from '@rhombus-std/primitives.extras';
import type { IQuery } from '@scope/core';
export namespace QueryInline {
  export function isService<T>(this: IQuery, ...rest: any[]): boolean {
    return this.isService(typefor<T>(), ...rest);
  }
}
`
	mainSrc := `import { provider } from '@scope/core';
interface Foo { readonly brand: 'foo'; }
export const ok = provider.isService<Foo>(5);
`
	prog, app := buildWorkspace(t, declaredFaceCoreIndex, inlineBody, declaredFaceSugarDTS, mainSrc)
	defer func() { _ = prog.Close() }()

	artifacts := NewArtifacts()
	var diags []plugin.Diagnostic
	transform := Build(prog, bodiesFor(t, app), artifacts, func(d plugin.Diagnostic) { diags = append(diags, d) })
	if len(diags) != 0 {
		t.Fatalf("Build raised diagnostics: %+v", diags)
	}

	ec := shimprinter.NewEmitContext()
	main := sourceFileWithSuffix(t, prog, "main.ts")
	out := reprint(ec, transform(ec, main))

	if strings.Contains(out, "isService<") {
		t.Errorf("sugar form isService<> survived:\n%s", out)
	}
	if !strings.Contains(out, "provider.isService(typefor(), 5)") && !strings.Contains(out, ", 5)") {
		t.Errorf("expected the rest group spliced after the token argument:\n%s", out)
	}
	if shape := artifacts.SugarMembers["isService"]; len(shape) != 1 || !shape[0].Unbounded {
		t.Errorf("a rest-bodied shape must publish an unbounded arity, got %+v", shape)
	}
}
