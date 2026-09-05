package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/fnioc/std/transforms/internal/valueimport"
)

// oneImplPackage writes a minimal declaring package: a package.json (no exports,
// so resolveEntryFile defaults to src/index.ts), the given src/index.ts, and —
// when non-empty — a src/inline.ts holding the impl (the conventional fallback
// locateImpl searches after the entry file).
func oneImplPackage(t *testing.T, indexSrc, inlineSrc string) string {
	t.Helper()
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), `{ "name": "@scope/pkg", "version": "1.0.0" }`)
	write(t, filepath.Join(dir, "src", "index.ts"), indexSrc)
	if inlineSrc != "" {
		write(t, filepath.Join(dir, "src", "inline.ts"), inlineSrc)
	}
	return dir
}

const indexStub = `export {};
`

// TestExtractRejects is the Go body-hygiene defense-in-depth: the enforced twin
// of the authoring lint that stops a drifted or never-linted published body.
// Each case is a one-package fixture whose impl violates one rule; Extract must
// reject it with the matching INLINE_* code.
func TestExtractRejects(t *testing.T) {
	member := Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"}

	cases := []struct {
		name    string
		inline  string
		entry   Entry
		wantErr string
	}{
		{
			name: "free identifier in the body",
			inline: `export const QueryInline = {
  bar<T>(this: any): boolean { return helper(); },
};
`,
			entry:   member,
			wantErr: "INLINE_BODY_FREE_IDENTIFIER",
		},
		{
			name: "two-statement body is not a single return",
			inline: `export const QueryInline = {
  bar<T>(this: any): boolean { const x = 1; return x > 0; },
};
`,
			entry:   member,
			wantErr: "INLINE_BODY_SHAPE",
		},
		{
			name: "arrow with an expression body (no block)",
			inline: `export const QueryInline = {
  bar: <T>(): boolean => this.isService(),
};
`,
			entry:   member,
			wantErr: "INLINE_BODY_SHAPE",
		},
		{
			name: "member absent from the impl",
			inline: `export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(); },
};
`,
			entry:   Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "nonexistent"},
			wantErr: "INLINE_IMPL_NOT_FOUND",
		},
		{
			// An aliased primitive is NOT recorded as a primitive import
			// (primitiveImports keeps only unaliased bindings), so referencing the
			// alias in the body is a free identifier. The alias is the outer callee
			// here so the free-identifier walk reaches it directly.
			name: "aliased primitive reference fails the free-identifier walk",
			inline: `import { typefor as n } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): string { return n<T>(); },
};
`,
			entry:   member,
			wantErr: "INLINE_BODY_FREE_IDENTIFIER",
		},
		{
			// The same aliased free identifier, but now as a call ARGUMENT after a
			// property-access callee (`this.isService(n<T>())`). This is the shape
			// the property-access short-circuit used to skip: aborting at the
			// callee halted the sibling walk before the argument was ever checked.
			// The skip-set fix keeps siblings walking, so `n` is caught here too.
			name: "free identifier as an argument after a property-access callee",
			inline: `import { typefor as n } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(n<T>()); },
};
`,
			entry:   member,
			wantErr: "INLINE_BODY_FREE_IDENTIFIER",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := oneImplPackage(t, indexStub, c.inline)
			_, err := newBodyExtractor().Extract(dir, c.entry)
			if err == nil {
				t.Fatalf("expected %s, got no error", c.wantErr)
			}
			if !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want %s, got %v", c.wantErr, err)
			}
		})
	}
}

// TestLocateImplFollowsReExports: the impl lives in src/impls.ts and the entry
// file only re-exports it via `export * from './impls.js'`. Extract must follow
// the intra-package re-export (stripping the .js the source-lib convention
// writes) to find the body.
func TestLocateImplFollowsReExports(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), `{ "name": "@scope/pkg", "version": "1.0.0" }`)
	write(t, filepath.Join(dir, "src", "index.ts"), `export * from './impls.js';
`)
	write(t, filepath.Join(dir, "src", "impls.ts"), `export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(); },
};
`)

	rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err != nil {
		t.Fatalf("Extract should follow the re-export hop: %v", err)
	}
	if rb == nil || rb.Body == nil {
		t.Fatalf("expected a resolved body, got %+v", rb)
	}
	if !strings.HasSuffix(rb.File, filepath.Join("src", "impls.ts")) {
		t.Fatalf("body resolved from %q, want src/impls.ts", rb.File)
	}
}

// TestExtractPropertyAssignmentAndArrowForms: the impl-member shapes beyond a
// plain method. A property-assignment function expression and an arrow with a
// BLOCK body both extract; an arrow with an EXPRESSION body is rejected
// INLINE_BODY_SHAPE — pinning the current rejection as intended.
func TestExtractPropertyAssignmentAndArrowForms(t *testing.T) {
	inline := `import { typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar: function<T>(this: any): boolean { return this.isService(typefor<T>()); },
  baz: <T>(): boolean => { return this.isService(typefor<T>()); },
  qux: <T>(): boolean => this.isService(typefor<T>()),
};
`
	dir := oneImplPackage(t, indexStub, inline)

	for _, member := range []string{"bar", "baz"} {
		t.Run(member+" extracts", func(t *testing.T) {
			rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: member})
			if err != nil {
				t.Fatalf("Extract(%s): %v", member, err)
			}
			if rb == nil || rb.Body == nil {
				t.Fatalf("Extract(%s) returned no body", member)
			}
		})
	}

	t.Run("qux arrow-expression-body is rejected", func(t *testing.T) {
		_, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "qux"})
		if err == nil || !strings.Contains(err.Error(), "INLINE_BODY_SHAPE") {
			t.Fatalf("want INLINE_BODY_SHAPE for an arrow with an expression body, got %v", err)
		}
	})
}

// TestExtractIgnoresAuthoringMarker: an impl file carrying the module-level
// `registerInlineBodies(QueryInline)` marker (the in-code statement of the
// package.json "rhombus-std" inline registration) extracts exactly as it would without
// it. The extra import must not land in the body-external VALUE-import map — the
// marker is never referenced from inside a body — and the extra top-level
// statement must not disturb the declaration lookup or the free-identifier walk,
// which read only the impl's own declaration.
func TestExtractIgnoresAuthoringMarker(t *testing.T) {
	inline := `import { registerInlineBodies, typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(typefor<T>()); },
};
registerInlineBodies(QueryInline);
`
	dir := oneImplPackage(t, indexStub, inline)

	rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err != nil {
		t.Fatalf("Extract with an authoring marker present: %v", err)
	}
	if rb.PrimitiveImports["typefor"] != "typefor" {
		t.Fatalf("typefor should still be a recorded primitive import, got %+v", rb.PrimitiveImports)
	}
	if ref, recorded := rb.ValueImports["registerInlineBodies"]; recorded {
		t.Fatalf("the authoring marker must not be recorded as a value import, got %+v", ref)
	}
}

// TestExtractRejectsMarkerInsideBody: the marker is MODULE LEVEL ONLY. Referenced
// from inside a body it is just an unknown identifier, and the free-identifier walk
// refuses it like any other — there is no allowance that would let a body call it.
func TestExtractRejectsMarkerInsideBody(t *testing.T) {
	inline := `import { registerInlineBodies } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(registerInlineBodies); },
};
`
	dir := oneImplPackage(t, indexStub, inline)

	_, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err == nil || !strings.Contains(err.Error(), "INLINE_BODY_FREE_IDENTIFIER") {
		t.Fatalf("want INLINE_BODY_FREE_IDENTIFIER for a marker reference inside a body, got %v", err)
	}
}

// TestExtractRecordsImportedValue: a body may call a value its file imports, and
// Extract records the import's (module, export) so the inline stage can materialize
// it at the call site. The import declaration is the whole declaration — nothing
// else names the callee.
func TestExtractRecordsImportedValue(t *testing.T) {
	inline := `import { merge } from '@scope/runtime';
import { typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): boolean { return merge(this.isService(typefor<T>())); },
};
`
	dir := oneImplPackage(t, indexStub, inline)

	rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err != nil {
		t.Fatalf("a body calling an imported value must extract: %v", err)
	}
	want := valueimport.Ref{Module: "@scope/runtime", Export: "merge"}
	if got := rb.ValueImports["merge"]; got != want {
		t.Fatalf("ValueImports[merge] = %+v, want %+v", got, want)
	}
}

// TestExtractRecordsAliasedImportedValue: an alias binds the LOCAL name to the
// EXPORTED one. The body references the alias; the recorded Export is the property
// name, so the import materialized into a consumer names the real export.
func TestExtractRecordsAliasedImportedValue(t *testing.T) {
	inline := `import { overrideSignatures as merge } from '@scope/runtime';
export const QueryInline = {
  bar<T>(this: any): boolean { return merge(this.isService()); },
};
`
	dir := oneImplPackage(t, indexStub, inline)

	rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err != nil {
		t.Fatalf("an aliased imported value must extract: %v", err)
	}
	want := valueimport.Ref{Module: "@scope/runtime", Export: "overrideSignatures"}
	if got := rb.ValueImports["merge"]; got != want {
		t.Fatalf("ValueImports[merge] = %+v, want %+v", got, want)
	}
}

// TestExtractRecordsOnlyTheBodysOwnImports: a shared impl file's imports are
// file-wide, so a body records only what IT references. A sibling body's callee
// must not follow it to its call sites.
func TestExtractRecordsOnlyTheBodysOwnImports(t *testing.T) {
	inline := `import { merge, unrelated } from '@scope/runtime';
export const QueryInline = {
  bar<T>(this: any): boolean { return merge(this.isService()); },
  other<T>(this: any): boolean { return unrelated(this.isService()); },
};
`
	dir := oneImplPackage(t, indexStub, inline)

	rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if _, recorded := rb.ValueImports["unrelated"]; recorded {
		t.Fatalf("a sibling body's import must not be recorded, got %+v", rb.ValueImports)
	}
	if len(rb.ValueImports) != 1 {
		t.Fatalf("want exactly the one referenced import, got %+v", rb.ValueImports)
	}
}

// TestExtractConsumedTypeParams: a body's ConsumedTypeParams names exactly the
// type parameters its own primitive calls spell as a type argument
// (`typefor<T>()`) — never one fed only as a value argument (`typefor(value)`),
// and never a concrete type unrelated to the body's own declared parameters.
func TestExtractConsumedTypeParams(t *testing.T) {
	cases := []struct {
		name   string
		inline string
		want   map[string]bool
	}{
		{
			name: "a type-argument use consumes its type parameter",
			inline: `import { typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any): boolean { return this.isService(typefor<T>()); },
};
`,
			want: map[string]bool{"T": true},
		},
		{
			name: "a value-argument use consumes nothing",
			inline: `import { typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T>(this: any, value: T): boolean { return this.isService(typefor(value)); },
};
`,
			want: map[string]bool{},
		},
		{
			name: "a mixed body consumes only the type-argument parameter",
			inline: `import { typefor } from '@rhombus-std/primitives.extras';
export const QueryInline = {
  bar<T, U>(this: any, value: U): boolean {
    return this.isService(typefor<T>(), typefor(value));
  },
};
`,
			want: map[string]bool{"T": true},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := oneImplPackage(t, indexStub, c.inline)
			rb, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
			if err != nil {
				t.Fatalf("Extract: %v", err)
			}
			if len(rb.ConsumedTypeParams) != len(c.want) {
				t.Fatalf("ConsumedTypeParams = %+v, want %+v", rb.ConsumedTypeParams, c.want)
			}
			for name := range c.want {
				if !rb.ConsumedTypeParams[name] {
					t.Fatalf("ConsumedTypeParams = %+v, want %q consumed", rb.ConsumedTypeParams, name)
				}
			}
		})
	}
}

// TestExtractRejectsUnresolvableValues pins the boundary of "the file's imports are
// the declarations": every shape that does NOT put a resolvable bare value in the
// body's scope stays the free-identifier authoring error.
func TestExtractRejectsUnresolvableValues(t *testing.T) {
	cases := []struct {
		name   string
		inline string
	}{
		{
			// Nothing imports it, so nothing declares it.
			name: "callee the file never imports",
			inline: `export const QueryInline = {
  bar<T>(this: any): boolean { return merge(this.isService()); },
};
`,
		},
		{
			// An imported value is reachable as a bare identifier only. The head of a
			// property chain is the body's receiver or a parameter, never an import.
			name: "imported name as the head of a property chain",
			inline: `import { Marker } from '@scope/runtime';
export const QueryInline = {
  bar<T>(this: any): boolean { return Marker.stringify(this.isService()); },
};
`,
		},
		{
			// A relative specifier addresses a file inside the declaring package, which
			// a consumer's program cannot resolve, so it declares nothing portable.
			name: "value imported through a relative specifier",
			inline: `import { merge } from './helpers.js';
export const QueryInline = {
  bar<T>(this: any): boolean { return merge(this.isService()); },
};
`,
		},
		{
			// A type-only binding has no runtime value to reference.
			name: "type-only specifier referenced as a value",
			inline: `import { type Merge } from '@scope/runtime';
export const QueryInline = {
  bar<T>(this: any): boolean { return Merge(this.isService()); },
};
`,
		},
		{
			name: "type-only clause referenced as a value",
			inline: `import type { Merge } from '@scope/runtime';
export const QueryInline = {
  bar<T>(this: any): boolean { return Merge(this.isService()); },
};
`,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := oneImplPackage(t, indexStub, c.inline)
			_, err := newBodyExtractor().Extract(dir, Entry{Type: "p:Foo", Impl: "@scope/pkg:QueryInline", Member: "bar"})
			if err == nil || !strings.Contains(err.Error(), "INLINE_BODY_FREE_IDENTIFIER") {
				t.Fatalf("want INLINE_BODY_FREE_IDENTIFIER, got %v", err)
			}
		})
	}
}
