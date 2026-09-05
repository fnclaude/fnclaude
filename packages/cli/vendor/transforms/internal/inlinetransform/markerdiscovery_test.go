package inlinetransform

import (
	"path/filepath"
	"strings"
	"testing"
)

// markerPackage lays out a package whose source carries the given entry file,
// returning its directory.
func markerPackage(t *testing.T, name, indexSrc string) string {
	t.Helper()
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), `{
  "name": "`+name+`",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } }
}`)
	write(t, filepath.Join(dir, "src", "index.ts"), indexSrc)
	return dir
}

func TestMarkerDiscoveryNamespaceForm(t *testing.T) {
	dir := markerPackage(t, "@scope/sugar", `import type { IQuery } from '@scope/core';
import { registerInlineBodies, typefor } from '@rhombus-std/primitives.extras';
export namespace QueryInline {
  export function isService<T>(this: IQuery): boolean {
    return this.isService(typefor<T>());
  }
  export function pick<T>(this: IQuery, extra: number): boolean {
    return this.isService(typefor<T>());
  }
  function helper(): void {}
}
registerInlineBodies<IQuery>(QueryInline);
`)
	entries, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err != nil {
		t.Fatalf("discoverMarkerEntries: %v", err)
	}
	want := []Entry{
		{Type: "@scope/core:IQuery", Impl: "@scope/sugar:QueryInline", Member: "isService"},
		{Type: "@scope/core:IQuery", Impl: "@scope/sugar:QueryInline", Member: "pick"},
	}
	if len(entries) != len(want) {
		t.Fatalf("entries = %+v, want %+v — the unexported helper must not publish", entries, want)
	}
	for i := range want {
		if entries[i] != want[i] {
			t.Fatalf("entry %d = %+v, want %+v", i, entries[i], want[i])
		}
	}
}

func TestMarkerDiscoveryConstFormAndStrippedTypeArgs(t *testing.T) {
	dir := markerPackage(t, "@scope/sugar", `import type { Manifest } from '@scope/core';
import { registerInlineBodies, typefor } from '@rhombus-std/primitives.extras';
export const ManifestInline = {
  add<T>(this: Manifest<any>): Manifest<any> {
    return this.add(typefor<T>());
  },
};
registerInlineBodies<Manifest<any>>(ManifestInline);
`)
	entries, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err != nil {
		t.Fatalf("discoverMarkerEntries: %v", err)
	}
	if len(entries) != 1 || entries[0] != (Entry{Type: "@scope/core:Manifest", Impl: "@scope/sugar:ManifestInline", Member: "add"}) {
		t.Fatalf("entries = %+v — the receiver's own type arguments must strip", entries)
	}
}

func TestMarkerDiscoveryNonImportedTypeArgIsAnError(t *testing.T) {
	dir := markerPackage(t, "@scope/sugar", `import { registerInlineBodies } from '@rhombus-std/primitives.extras';
interface Local {}
export const SetInline = { m(this: Local): void { return; } };
registerInlineBodies<Local>(SetInline);
`)
	_, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err == nil || !strings.Contains(err.Error(), "INLINE_MARKER_TYPE") {
		t.Fatalf("want INLINE_MARKER_TYPE for a non-imported type argument, got %v", err)
	}
}

func TestMarkerDiscoveryUnresolvableSetIsAnError(t *testing.T) {
	dir := markerPackage(t, "@scope/sugar", `import type { IQuery } from '@scope/core';
import { registerInlineBodies } from '@rhombus-std/primitives.extras';
registerInlineBodies<IQuery>(NothingHere);
`)
	_, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err == nil || !strings.Contains(err.Error(), "INLINE_MARKER_SET") {
		t.Fatalf("want INLINE_MARKER_SET for an unresolvable set identifier, got %v", err)
	}
}

func TestMarkerDiscoveryFollowsReExports(t *testing.T) {
	dir := markerPackage(t, "@scope/sugar", `export * from './augment';
`)
	write(t, filepath.Join(dir, "src", "augment.ts"), `import type { IQuery } from '@scope/core';
import { registerInlineBodies } from '@rhombus-std/primitives.extras';
export namespace QueryInline {
  export function isService<T>(this: IQuery): boolean {
    return this.isService();
  }
}
registerInlineBodies<IQuery>(QueryInline);
`)
	entries, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err != nil {
		t.Fatalf("discoverMarkerEntries: %v", err)
	}
	if len(entries) != 1 || entries[0].Member != "isService" {
		t.Fatalf("entries = %+v — the barrel's re-export target was not scanned", entries)
	}
}

// TestCollectMergesMarkerAndJSONEntries: a package carrying both a JSON instance
// entry and the equivalent marker yields one deduplicated entry, and a
// marker-only sibling member still publishes.
func TestCollectMergesMarkerAndJSONEntries(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "package.json"), `{
  "name": "@scope/sugar",
  "version": "1.0.0",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "rhombus-std": { "inline": { "entries": [
    { "type": "@scope/core:IQuery", "impl": "@scope/sugar:QueryInline", "member": "isService" }
  ] } }
}`)
	write(t, filepath.Join(dir, "src", "index.ts"), `import type { IQuery } from '@scope/core';
import { registerInlineBodies } from '@rhombus-std/primitives.extras';
export namespace QueryInline {
  export function isService<T>(this: IQuery): boolean {
    return this.isService();
  }
  export function pick<T>(this: IQuery): boolean {
    return this.isService();
  }
}
registerInlineBodies<IQuery>(QueryInline);
`)
	owned, err := Collect(dir)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	members := map[string]int{}
	for _, oe := range owned {
		members[oe.Entry.Member]++
	}
	if members["isService"] != 1 {
		t.Fatalf("isService published %d times, want 1 — JSON and marker naming one body must deduplicate", members["isService"])
	}
	if members["pick"] != 1 {
		t.Fatalf("pick published %d times, want 1 — the marker-only member must still publish", members["pick"])
	}
}

// TestMarkerDiscoveryNoMarkersIsSilent: a package with no marker calls
// contributes nothing and raises nothing.
func TestMarkerDiscoveryNoMarkersIsSilent(t *testing.T) {
	dir := markerPackage(t, "@scope/plain", `export const x = 1;
`)
	entries, err := discoverMarkerEntries(newBodyExtractor(), dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("entries=%v err=%v, want empty and nil", entries, err)
	}
}
