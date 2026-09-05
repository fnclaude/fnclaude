package tokens

import "testing"

// nearestPackage is pure over ctx.ReadFile: it walks up from a declaration path to
// the nearest readable, named package.json and caches every dir it resolves —
// including the negatives (a dir with no package.json is remembered so a later walk
// through it does not re-read). These properties are checker-independent, so a fake
// ReadFile backed by a map pins them without loading a program.
func TestNearestPackage(t *testing.T) {
	// fakeReadFile serves package.json text from files and records a per-path read
	// count so the caching behavior is observable.
	fakeReadFile := func(files map[string]string, reads map[string]int) func(string) (string, bool) {
		return func(path string) (string, bool) {
			reads[path]++
			text, ok := files[path]
			return text, ok
		}
	}

	t.Run("walks up parent dirs to the nearest package.json", func(t *testing.T) {
		files := map[string]string{
			"/proj/a/package.json": `{ "name": "pkg-a" }`,
		}
		ctx := &Context{ReadFile: fakeReadFile(files, map[string]int{})}
		pkg := nearestPackage(ctx, "/proj/a/b/thing.ts")
		if pkg == nil {
			t.Fatal("nearestPackage returned nil, want pkg-a")
		}
		if pkg.name != "pkg-a" || pkg.dir != "/proj/a" {
			t.Fatalf("nearestPackage = {name:%q dir:%q}, want {pkg-a /proj/a}", pkg.name, pkg.dir)
		}
	})

	t.Run("caches negative lookups", func(t *testing.T) {
		files := map[string]string{
			"/proj/a/package.json": `{ "name": "pkg-a" }`,
		}
		reads := map[string]int{}
		ctx := &Context{ReadFile: fakeReadFile(files, reads)}
		// Two walks from the same file: the miss at /proj/a/b must be remembered so
		// its package.json is read exactly once across both walks.
		nearestPackage(ctx, "/proj/a/b/thing.ts")
		nearestPackage(ctx, "/proj/a/b/thing.ts")
		if got := reads["/proj/a/b/package.json"]; got != 1 {
			t.Fatalf("negative lookup re-read %d times, want 1 (cached)", got)
		}
		if got := reads["/proj/a/package.json"]; got != 1 {
			t.Fatalf("positive lookup re-read %d times, want 1 (cached)", got)
		}
	})

	t.Run("returns nil at the filesystem root when none found", func(t *testing.T) {
		ctx := &Context{ReadFile: fakeReadFile(map[string]string{}, map[string]int{})}
		if pkg := nearestPackage(ctx, "/proj/a/b/thing.ts"); pkg != nil {
			t.Fatalf("nearestPackage found %+v with no package.json anywhere, want nil", pkg)
		}
	})

	t.Run("returns nil when ReadFile is nil", func(t *testing.T) {
		if pkg := nearestPackage(&Context{}, "/proj/a/b/thing.ts"); pkg != nil {
			t.Fatalf("nearestPackage = %+v with nil ReadFile, want nil", pkg)
		}
	})
}
